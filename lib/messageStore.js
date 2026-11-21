'use strict';

/**
 * Bounded per-account connection stores.
 *
 * Baileys asks the application for three things that decide whether a
 * WhatsApp connection survives real traffic:
 *
 *   getMessage            — when a peer's phone asks WhatsApp to retry a
 *                           message, Baileys needs the original message from
 *                           us. Answering `undefined` (the old behaviour)
 *                           makes every retry fail and lets Signal session
 *                           errors accumulate until the socket is dropped.
 *   msgRetryCounterCache  — how many times a retry was already attempted;
 *                           without it Baileys cannot apply its retry limits.
 *   replay drain          — after a reconnect WhatsApp replays the offline
 *                           backlog. Executing minutes-old commands in one
 *                           burst re-triggers heavy jobs, rate limits and
 *                           the next disconnect. Messages older than `oldMs`
 *                           are dropped briefly after each `open`, exactly
 *                           long enough for the backlog to pass.
 *
 * Everything here is strictly bounded: an idle bot must not trade
 * "disconnects after some time" for "runs out of memory after some time".
 */

function createMessageStore({ maxPerChat = 20, maxChats = 300, maxMessages = 6000 } = {}) {
  const perChatCap = Math.max(1, Math.floor(Number(maxPerChat) || 20));
  const chatCap = Math.max(1, Math.floor(Number(maxChats) || 300));
  const messageCap = Math.max(perChatCap, Math.floor(Number(maxMessages) || 6000));
  const chats = new Map(); // jid -> Map(id -> msg), insertion ordered
  let total = 0;

  function dropChat(jid) {
    const chat = chats.get(jid);
    if (!chat) return 0;
    total -= chat.size;
    chats.delete(jid);
    return 1;
  }

  function evictOldestChats(count) {
    let removed = 0;
    for (const jid of [...chats.keys()]) {
      if (removed >= count) break;
      removed += dropChat(jid);
    }
    return removed;
  }

  function storeMessage(remoteJid, msg) {
    const jid = String(remoteJid || msg?.key?.remoteJid || '');
    const id = String(msg?.key?.id || '');
    if (!jid || !id || !msg?.message) return false;
    let chat = chats.get(jid);
    if (!chat) {
      if (chats.size >= chatCap) evictOldestChats(1);
      chat = new Map();
      chats.set(jid, chat);
    } else {
      // Refresh recency so active chats are evicted last.
      chats.delete(jid);
      chats.set(jid, chat);
    }
    if (!chat.has(id)) {
      if (chat.size >= perChatCap) {
        const oldest = chat.keys().next().value;
        chat.delete(oldest);
        total -= 1;
      }
      total += 1;
    }
    chat.set(id, msg);
    while (total > messageCap && chats.size) {
      const oldestJid = chats.keys().next().value;
      const oldest = chats.get(oldestJid);
      const oldestId = oldest.keys().next().value;
      oldest.delete(oldestId);
      total -= 1;
      if (!oldest.size) chats.delete(oldestJid);
    }
    return true;
  }

  function loadMessage(remoteJid, id) {
    const chat = chats.get(String(remoteJid || ''));
    return chat?.get(String(id || '')) || null;
  }

  /** Baileys `getMessage`: the stored message's content, or undefined. */
  function getMessage(key) {
    if (!key?.id) return undefined;
    const candidates = [key.remoteJid, key.remoteJidAlt, key.participantAlt, key.participant]
      .filter((value) => typeof value === 'string' && value);
    for (const jid of candidates) {
      const found = loadMessage(jid, key.id);
      if (found?.message) return found.message;
    }
    return undefined;
  }

  function prune(fraction = 0.5) {
    const count = Math.ceil(chats.size * Math.max(0, Math.min(1, Number(fraction) || 0)));
    return evictOldestChats(count);
  }

  function stats() {
    return { chats: chats.size, messages: total, maxChats: chatCap, maxPerChat: perChatCap, maxMessages: messageCap };
  }

  function clear() {
    chats.clear();
    total = 0;
  }

  return { storeMessage, loadMessage, getMessage, evictOldestChats, prune, stats, clear };
}

/** NodeCache-shaped retry counter cache with a hard size cap and TTL. */
function createRetryCounterCache({ maxEntries = 1000, ttlMs = 60 * 60_000 } = {}) {
  const cap = Math.max(1, Math.floor(Number(maxEntries) || 1000));
  const ttl = Math.max(1000, Number(ttlMs) || 60 * 60_000);
  const entries = new Map(); // key -> { value, expiresAt }

  const keyOf = (key) => String(key);
  function get(key) {
    const entry = entries.get(keyOf(key));
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      entries.delete(keyOf(key));
      return undefined;
    }
    return entry.value;
  }
  function set(key, value) {
    const name = keyOf(key);
    if (!entries.has(name) && entries.size >= cap) entries.delete(entries.keys().next().value);
    entries.set(name, { value, expiresAt: Date.now() + ttl });
    return true;
  }
  function del(key) {
    return entries.delete(keyOf(key));
  }
  function prune(fraction = 0.5) {
    const count = Math.ceil(entries.size * Math.max(0, Math.min(1, Number(fraction) || 0)));
    let removed = 0;
    for (const name of [...entries.keys()]) {
      if (removed >= count) break;
      entries.delete(name);
      removed += 1;
    }
    return removed;
  }
  return {
    get, set, del, delete: del, prune,
    flushAll: () => entries.clear(),
    clear: () => entries.clear(),
    stats: () => ({ entries: entries.size, maxEntries: cap }),
  };
}

/** Milliseconds since epoch for a Baileys messageTimestamp (number, string or Long-like). */
function messageTimestampMs(msg) {
  const raw = msg?.messageTimestamp;
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === 'object') {
    const low = Number(raw.low || 0) >>> 0;
    const high = Number(raw.high || 0);
    const value = high * 4294967296 + low;
    return Number.isFinite(value) && value > 0 ? value * 1000 : 0;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value * 1000 : 0;
}

/**
 * Post-reconnect replay drain. `markConnectionOpen()` starts a window in
 * which messages older than `oldMs` are treated as backlog and dropped.
 * Bursts of old messages extend the window (up to `maxMs`); several quiet
 * one-second windows end it early, so a bot that reconnects into silence is
 * fully live again within seconds.
 */
function createReplayDrain({
  initialMs = 45_000,
  maxMs = 180_000,
  oldMs = 30_000,
  burstThreshold = 15,
  burstExtensionMs = 8000,
  quietWindowsRequired = 3,
} = {}) {
  const initial = Math.max(1000, Number(initialMs) || 45_000);
  const hardCap = Math.max(initial, Number(maxMs) || 180_000);
  const old = Math.max(1000, Number(oldMs) || 30_000);
  const threshold = Math.max(1, Math.floor(Number(burstThreshold) || 15));
  const extension = Math.max(1000, Number(burstExtensionMs) || 8000);
  const quietNeeded = Math.max(1, Math.floor(Number(quietWindowsRequired) || 3));

  let active = false;
  let openedAt = 0;
  let drainEndsAt = 0;
  let hardCapAt = 0;
  let burstWindowAt = 0;
  let burstCount = 0;
  let quietWindows = 0;
  let dropped = 0;
  let passed = 0;

  function markConnectionOpen(now = Date.now()) {
    active = true;
    openedAt = now;
    drainEndsAt = now + initial;
    hardCapAt = now + hardCap;
    burstWindowAt = now;
    burstCount = 0;
    quietWindows = 0;
    dropped = 0;
    passed = 0;
  }

  function finish() {
    active = false;
  }

  function isReplayMessage(msg, now = Date.now()) {
    if (!active) return false;
    if (now >= drainEndsAt || now >= hardCapAt) {
      finish();
      return false;
    }
    const sentAt = messageTimestampMs(msg);
    if (!sentAt) return false;
    if (now - sentAt <= old) {
      passed += 1;
      quietWindows = 0;
      return false;
    }
    if (now - burstWindowAt >= 1000) {
      if (burstCount >= threshold) {
        drainEndsAt = Math.min(hardCapAt, Math.max(drainEndsAt, now + extension));
        quietWindows = 0;
      } else {
        quietWindows += 1;
        if (quietWindows >= quietNeeded) {
          finish();
          dropped += 1;
          return true;
        }
      }
      burstWindowAt = now;
      burstCount = 0;
    }
    burstCount += 1;
    dropped += 1;
    return true;
  }

  function stats(now = Date.now()) {
    return {
      active: active && now < Math.min(drainEndsAt, hardCapAt),
      openedAt,
      remainingMs: active ? Math.max(0, Math.min(drainEndsAt, hardCapAt) - now) : 0,
      dropped,
      passed,
    };
  }

  return { markConnectionOpen, isReplayMessage, stats, finish };
}

module.exports = { createMessageStore, createRetryCounterCache, createReplayDrain, messageTimestampMs };
