/**
 * ZaFar Bot — Reconnect scheduler with exponential backoff
 *
 * Ensures a transient failure inside `startBot()` (DNS hiccup, temporary file
 * lock, WhatsApp handshake error) schedules another retry with backoff instead
 * of leaving the bot permanently dead until a manual panel restart.
 *
 * The disconnect policy below is the per-code layer on top of the generic
 * scheduler: WhatsApp close codes are not interchangeable. A 440 conflict
 * retried every minute fights the other instance forever, a 503 retried
 * every minute hammers an already struggling WhatsApp, a stale-version 408
 * loop needs a fresh WA version rather than another identical attempt, and
 * a 401 that merely mentions a device conflict is not a logout. Each code
 * therefore gets its own counter, delay curve and — only for a real logout
 * or a repeated 403 refusal — a fatal verdict. Credentials are never
 * deleted by this policy; a fatal verdict only stops the retry loop.
 */

'use strict';

function computeBackoffMs(attempt, { baseMs = 3000, maxMs = 60_000 } = {}) {
  const exp = Math.max(0, Math.min(10, Number(attempt) || 0));
  return Math.min(maxMs, Math.round(baseMs * Math.pow(2, exp)));
}

function createReconnector({
  start,
  baseMs = 3000,
  maxMs = 60_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = null,
} = {}) {
  if (typeof start !== 'function') {
    throw new TypeError('createReconnector requires a start() function');
  }

  let attempts = 0;
  let timer = null;
  let stopped = false;

  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const reset = () => {
    stopped = false;
    attempts = 0;
    cancel();
  };

  const stop = () => {
    stopped = true;
    cancel();
  };

  const schedule = (overrideMs) => {
    if (stopped) return false;
    if (timer !== null) return false;

    const delayMs = overrideMs != null
      ? Math.max(0, Number(overrideMs) || 0)
      : computeBackoffMs(attempts, { baseMs, maxMs });
    const attemptNumber = ++attempts;

    timer = setTimer(async () => {
      timer = null;
      if (stopped) return;
      try {
        await start(attemptNumber);
      } catch (err) {
        if (typeof onError === 'function') {
          try { onError(err, attemptNumber, computeBackoffMs(attempts, { baseMs, maxMs })); } catch { /* ignore */ }
        }
        if (!stopped) schedule();
      }
    }, delayMs);
    // A pending reconnect is essential work. Keep Node alive until it fires;
    // reset() and stop() cancel the timer during normal shutdown.
    return delayMs;
  };

  return {
    schedule,
    reset,
    stop,
    cancel,
    get attempts() { return attempts; },
    get scheduled() { return timer !== null; },
  };
}

// ─── Per-code disconnect policy ─────────────────────────────────────────────

/** Fresh per-account counters. A successful `open` resets all of them. */
function createDisconnectCounters(source) {
  const counters = { timeout408: 0, forbidden403: 0, server500: 0, conflict: 0, unavailable503: 0 };
  if (source && typeof source === 'object') {
    for (const key of Object.keys(counters)) {
      const value = Math.floor(Number(source[key]));
      if (Number.isFinite(value) && value > 0) counters[key] = Math.min(value, 1_000_000);
    }
  }
  return counters;
}

function resetDisconnectCounters(counters) {
  if (!counters) return counters;
  for (const key of Object.keys(counters)) counters[key] = 0;
  return counters;
}

/**
 * Text of a disconnect error, for classification only. Callers must never
 * log the result: disconnect payloads can carry session details.
 */
function disconnectMessage(error) {
  const parts = [
    error?.message,
    error?.output?.payload?.message,
    error?.output?.payload?.error,
    error?.data?.message,
  ];
  return parts.filter((part) => typeof part === 'string').join(' ').toLowerCase();
}

/**
 * Decide what one close event means and when to retry.
 *
 * Mutates `counters` (the caller persists them so a panel restart does not
 * reset a 408 storm back to aggressive retries). Returns
 * `{ kind, fatal, delayMs, invalidateVersion, standDown }`; `delayMs: null`
 * means "use the caller's generic exponential backoff".
 */
function planDisconnect(counters, { statusCode, message = '', loggedOutCode = 401, random = Math.random } = {}) {
  const state = counters && typeof counters === 'object' ? counters : createDisconnectCounters();
  const code = Number.isInteger(statusCode) ? statusCode : null;
  const text = String(message || '').toLowerCase();
  const conflictText = text.includes('conflict') || text.includes('replaced');

  // Another instance holds this number (or WhatsApp says so in words). This
  // is explicitly not a logout, even when it arrives wearing a 401.
  if (code === 440 || code === 409 || (code === 401 && conflictText)) {
    state.conflict += 1;
    if (state.conflict >= 10) {
      state.conflict = 0;
      // Break the fight: two instances replacing each other every minute
      // keep both offline. A five-minute stand-down lets the other side win
      // or go away.
      return { kind: 'conflict', fatal: false, delayMs: 300_000, invalidateVersion: false, standDown: true };
    }
    return { kind: 'conflict', fatal: false, delayMs: Math.min(8000 + state.conflict * 5000, 120_000), invalidateVersion: false, standDown: false };
  }

  // WhatsApp refusing the account outright. Once is a retry; three in a row
  // is a ban, and retrying a banned number every minute helps nobody.
  if (code === 403) {
    state.forbidden403 += 1;
    if (state.forbidden403 >= 3) {
      return { kind: 'forbidden', fatal: true, delayMs: null, invalidateVersion: false, standDown: false };
    }
    return { kind: 'forbidden', fatal: false, delayMs: 60_000, invalidateVersion: false, standDown: false };
  }

  // The only ordinary fatal case: WhatsApp really logged this device out.
  if (code !== null && (code === loggedOutCode || code === 401)) {
    return { kind: 'logged_out', fatal: true, delayMs: null, invalidateVersion: false, standDown: false };
  }

  if (code === 408) {
    state.timeout408 += 1;
    if (state.timeout408 >= 10) {
      state.timeout408 = 0;
      // Ten timeouts in a row usually means WhatsApp moved on and our cached
      // WA version is stale. Tell the caller to throw the cache away, then
      // take one long breath instead of an eleventh identical attempt.
      return { kind: 'timeout', fatal: false, delayMs: 60_000, invalidateVersion: true, standDown: false };
    }
    const base = Math.min(5000 * Math.pow(2, Math.min(state.timeout408, 3)), 60_000);
    const jitter = Math.max(0, Math.min(999, Math.floor(random() * 1000)));
    return { kind: 'timeout', fatal: false, delayMs: Math.min(base + jitter, 60_000), invalidateVersion: false, standDown: false };
  }

  if (code === 503) {
    state.unavailable503 += 1;
    return { kind: 'unavailable', fatal: false, delayMs: Math.min(state.unavailable503 * 30_000, 300_000), invalidateVersion: false, standDown: false };
  }

  if (code === 500) {
    state.server500 += 1;
    if (state.server500 >= 3) {
      state.server500 = 0;
      // Persistent server errors are WhatsApp's problem, never a reason to
      // touch verified credentials. Retry sooner, keep everything.
      return { kind: 'server', fatal: false, delayMs: 8000, invalidateVersion: false, standDown: false };
    }
    return { kind: 'server', fatal: false, delayMs: 10_000, invalidateVersion: false, standDown: false };
  }

  // WhatsApp asked for a restart (515) or dropped the stream (428): come
  // back quickly, these are routine.
  if (code === 515) return { kind: 'restart', fatal: false, delayMs: 1000, invalidateVersion: false, standDown: false };
  if (code === 428) return { kind: 'closed', fatal: false, delayMs: 3000, invalidateVersion: false, standDown: false };

  return { kind: code === null ? 'unknown' : 'transient', fatal: false, delayMs: null, invalidateVersion: false, standDown: false };
}

module.exports = {
  computeBackoffMs,
  createReconnector,
  createDisconnectCounters,
  resetDisconnectCounters,
  disconnectMessage,
  planDisconnect,
};
