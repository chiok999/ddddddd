'use strict';

/**
 * WhatsApp login keys in SQLite.
 *
 * Baileys' `useMultiFileAuthState` keeps one small JSON file per key (often
 * thousands per account) and its own docs say it is not meant for long-term
 * production use. This module stores exactly the same entries as rows of the
 * `auth` table in database/bot.sqlite — one row per (account folder, name) —
 * so every save is a single transactional row write.
 *
 * Names are kept identical to the old files (`creds.json`,
 * `pre-key-1.json`, `lid-mapping-123.json`, …). That keeps the encrypted
 * session backup format unchanged and lets old files be imported as-is: the
 * first time an account folder is opened, its existing *.json files are
 * copied into the database in one transaction and moved into a
 * `.migrated-to-sqlite` sub-folder (never deleted).
 *
 * Folders stay the identity of an account (`session/`, `session/linked/<n>/<id>`),
 * keyed by their path relative to the bot folder so moving the bot keeps logins.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sqlite = require('./sqlite');

const NAME_RE = /^[A-Za-z0-9_@.+=-]{1,200}\.json$/;
const MIGRATED_DIR = '.migrated-to-sqlite';

const enabled = () => String(process.env.AUTH_STORE || '').toLowerCase() !== 'files';

function dirKey(dir) {
  const resolved = path.resolve(String(dir || ''));
  const rel = path.relative(sqlite.BOT_ROOT, resolved);
  // Folders outside the bot (tests, custom SESSION paths) keep their absolute path.
  return (!rel || rel.startsWith('..') || path.isAbsolute(rel)) ? resolved : rel.split(path.sep).join('/');
}

const fixName = (file) => String(file || '').replace(/\//g, '__').replace(/:/g, '-');

function rowsFor(dir) {
  return sqlite.open().prepare('SELECT name, value FROM auth WHERE dir = ?').all(dirKey(dir));
}

function hasRows(dir) {
  return Boolean(sqlite.open().prepare('SELECT 1 AS x FROM auth WHERE dir = ? LIMIT 1').get(dirKey(dir)));
}

const isLidMappingName = (name) => String(name || '').startsWith('lid-mapping-');

/**
 * Inspect every stored entry of an account without handing anything to
 * Baileys. Returns `{ ok, hasCreds, registered, keyRows, corrupt,
 * corruptLidMappings, totalRows }`, where `corrupt` lists entry names whose
 * stored JSON no longer parses (names only — never values). A single damaged
 * Signal key otherwise surfaces as endless Bad-MAC/decrypt errors and an
 * eventual WhatsApp logout; finding it here lets the caller stop with the
 * stored data preserved instead of letting Baileys improvise a blank login.
 */
function validateAuthState(dir) {
  const texts = enabled()
    ? Object.fromEntries(rowsFor(dir).map((row) => [row.name, row.value]))
    : Object.fromEntries(diskFiles(dir).map((name) => {
      try { return [name, fs.readFileSync(path.join(dir, name), 'utf8')]; } catch { return [name, null]; }
    }));
  const names = Object.keys(texts);
  const corrupt = [];
  const corruptLidMappings = [];
  let creds = null;
  for (const name of names) {
    let parsed = null;
    let parses = true;
    try { parsed = JSON.parse(texts[name]); } catch { parses = false; }
    if (!parses || (name === 'creds.json' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)))) {
      (isLidMappingName(name) ? corruptLidMappings : corrupt).push(name);
      continue;
    }
    if (name === 'creds.json') creds = parsed;
  }
  return {
    ok: corrupt.length === 0,
    hasCreds: Boolean(creds && !Array.isArray(creds)),
    registered: Boolean(creds && !Array.isArray(creds) && creds.registered),
    keyRows: names.filter((name) => name !== 'creds.json').length,
    corrupt,
    corruptLidMappings,
    totalRows: names.length,
  };
}

/**
 * Delete corrupt `lid-mapping-*` rows. LID mappings are rebuildable routing
 * hints, not credentials; June-X-style bots repair these instead of refusing
 * to start over them. Returns how many were removed.
 */
function repairCorruptLidMappings(dir) {
  if (!enabled()) return 0;
  let removed = 0;
  for (const row of rowsFor(dir)) {
    if (!isLidMappingName(row.name)) continue;
    let valid = true;
    try { valid = JSON.parse(row.value) !== null; } catch { valid = false; }
    if (!valid) {
      try { sqlite.open().prepare('DELETE FROM auth WHERE dir = ? AND name = ?').run(dirKey(dir), row.name); removed += 1; } catch { /* best effort */ }
    }
  }
  return removed;
}

/** Legacy *.json files still lying in the folder (not yet imported). */
function diskFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isFile() && !item.isSymbolicLink() && NAME_RE.test(item.name))
      .map((item) => item.name);
  } catch { return []; }
}

/**
 * Import a folder's old login files once. Returns how many were imported.
 * Unreadable/invalid files are left in place and skipped.
 */
function migrateDir(dir) {
  if (!enabled()) return 0;
  const names = diskFiles(dir);
  if (!names.length) return 0;
  const key = dirKey(dir);
  const entries = [];
  for (const name of names) {
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      JSON.parse(text);
      entries.push([name, text]);
    } catch { /* damaged key file: Baileys would ignore it too */ }
  }
  if (!entries.length) return 0;
  sqlite.transaction((db) => {
    // Never overwrite a newer database copy with an old file.
    const insert = db.prepare('INSERT OR IGNORE INTO auth (dir, name, value) VALUES (?, ?, ?)');
    for (const [name, text] of entries) insert.run(key, name, text);
  });
  const archive = path.join(dir, MIGRATED_DIR);
  try { fs.mkdirSync(archive, { recursive: true, mode: 0o700 }); } catch { /* read-only folder */ }
  for (const [name] of entries) {
    try { fs.renameSync(path.join(dir, name), path.join(archive, name)); } catch { /* left in place; database copy wins */ }
  }
  return entries.length;
}

/** Text of one entry (DB first, then a not-yet-imported file). */
function readText(dir, name) {
  if (enabled()) {
    try {
      const row = sqlite.open().prepare('SELECT value FROM auth WHERE dir = ? AND name = ?').get(dirKey(dir), name);
      if (row) return row.value;
    } catch { /* fall through to the file */ }
  }
  try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return null; }
}

function readJson(dir, name) {
  const text = readText(dir, name);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** All entries of a folder as { name: text } (DB rows + not-yet-imported files). */
function listFiles(dir) {
  const files = {};
  for (const name of diskFiles(dir)) {
    try { files[name] = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { /* skip */ }
  }
  if (enabled()) for (const row of rowsFor(dir)) files[row.name] = row.value;
  return files;
}

function hasFiles(dir) {
  if (enabled() && hasRows(dir)) return true;
  return diskFiles(dir).length > 0;
}

/**
 * Install a full set of entries for a folder (session recovery). Refuses to
 * replace existing entries, like the old `{ flag: 'wx' }` file writes.
 */
function installFiles(dir, files, { createDir = true } = {}) {
  if (!enabled()) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), value, { flag: 'wx', mode: 0o600 });
    return;
  }
  if (createDir) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (hasFiles(dir)) throw Object.assign(new Error('Session folder already has credentials.'), { code: 'EEXIST' });
  const key = dirKey(dir);
  sqlite.transaction((db) => {
    const insert = db.prepare('INSERT INTO auth (dir, name, value) VALUES (?, ?, ?)');
    for (const [name, value] of Object.entries(files)) {
      if (!NAME_RE.test(name)) throw new Error('Session entry name is invalid.');
      insert.run(key, name, String(value));
    }
  });
}

/** Forget every entry of a folder (used when an install must be rolled back). */
function removeDir(dir) {
  if (!enabled()) return;
  sqlite.open().prepare('DELETE FROM auth WHERE dir = ?').run(dirKey(dir));
}

// ─── Session recovery strings + remote auth mirror ───────────────────────────
//
// June-X survives a wiped container because its login lives somewhere else
// (a Session ID, or Postgres/Mongo). This bot runs many accounts in one
// process, so the equivalent has to work per account:
//
//  • Recovery string (SESSION_ID-style, upgraded): ONE string per account
//    holding credentials + Signal session keys (pre-keys are excluded —
//    WhatsApp replenishes those). June-X snapshots credentials only, which
//    restores a login that then has to rebuild every session. With
//    SESSION_RECOVERY_SECRET set the string is AES-256-GCM encrypted.
//    Treat an unencrypted string exactly like the login itself.
//  • Remote mirror: after credential/key writes, the same snapshot is
//    pushed (debounced, fire-and-forget) to Postgres or Mongo when
//    AUTH_MIRROR_URL is set, and pulled back automatically when an account
//    has no local credentials. The mirror is a safety net: it can be slow,
//    down, or unconfigured and connections never wait on it beyond one
//    bounded restore attempt.

const RECOVERY_PREFIX = 'ZAFAR~';
const RECOVERY_SECRET_REQUIRED = 'RECOVERY_SECRET_REQUIRED';

const recoverySecret = (secret) => String(secret ?? process.env.SESSION_RECOVERY_SECRET ?? '');
const mirrorSecret = () => String(process.env.AUTH_MIRROR_SECRET || process.env.SESSION_RECOVERY_SECRET || '');

/** Entries worth snapshotting (everything except replenishable pre-keys). */
function snapshotEntries(dir) {
  const entries = {};
  for (const [name, value] of Object.entries(listFiles(dir))) {
    if (!NAME_RE.test(name) || name.startsWith('pre-key-')) continue;
    entries[name] = String(value);
  }
  return entries;
}

function recoveryError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Build the recovery string for a linked account folder. Throws AUTH_MISSING
 * when the folder has no registered login yet — a string for a half-finished
 * pairing would restore nothing useful.
 */
function createRecoveryString(dir, { secret, account = '' } = {}) {
  const validation = validateAuthState(dir);
  if (!validation.registered) {
    throw recoveryError('AUTH_MISSING', 'That account has no saved login yet.');
  }
  if (validation.corrupt.length) {
    throw recoveryError('AUTH_CORRUPT', 'That account has damaged login data; refusing to snapshot it.');
  }
  const entries = snapshotEntries(dir);
  const payload = JSON.stringify({
    v: 1, kind: 'zafar-session', account: String(account || ''), createdAt: Date.now(), entries,
  });
  const compressed = zlib.gzipSync(Buffer.from(payload, 'utf8'));
  const key = recoverySecret(secret);
  let body;
  if (key) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const derived = crypto.scryptSync(key, salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
    const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
    body = Buffer.concat([Buffer.from([1]), salt, iv, cipher.getAuthTag(), encrypted]);
  } else {
    body = Buffer.concat([Buffer.from([0]), compressed]);
  }
  return {
    token: RECOVERY_PREFIX + body.toString('base64url'),
    encrypted: Boolean(key),
    entryCount: Object.keys(entries).length,
  };
}

/** Parse (and decrypt) a recovery string back into { account, createdAt, entries }. */
function parseRecoveryString(token, { secret } = {}) {
  const text = String(token || '').replace(/\s+/g, '').replace(/^"|"$/g, '');
  if (!text.startsWith(RECOVERY_PREFIX)) throw recoveryError('RECOVERY_INVALID', 'That is not a ZaFar recovery string.');
  let body;
  try { body = Buffer.from(text.slice(RECOVERY_PREFIX.length), 'base64url'); } catch { /* handled below */ }
  if (!body || body.length < 2) throw recoveryError('RECOVERY_INVALID', 'That recovery string is damaged.');
  let compressed;
  if (body[0] === 1) {
    const key = recoverySecret(secret);
    if (!key) {
      throw recoveryError(RECOVERY_SECRET_REQUIRED, 'That recovery string is encrypted; set SESSION_RECOVERY_SECRET to the same secret used to create it.');
    }
    try {
      const salt = body.subarray(1, 17);
      const iv = body.subarray(17, 29);
      const tag = body.subarray(29, 45);
      const derived = crypto.scryptSync(key, salt, 32);
      const decipher = crypto.createDecipheriv('aes-256-gcm', derived, iv);
      decipher.setAuthTag(tag);
      compressed = Buffer.concat([decipher.update(body.subarray(45)), decipher.final()]);
    } catch {
      throw recoveryError('RECOVERY_INVALID', 'That recovery string could not be decrypted (wrong secret or damaged string).');
    }
  } else if (body[0] === 0) {
    compressed = body.subarray(1);
  } else {
    throw recoveryError('RECOVERY_INVALID', 'That recovery string is damaged.');
  }
  let payload;
  try { payload = JSON.parse(zlib.gunzipSync(compressed).toString('utf8')); } catch {
    throw recoveryError('RECOVERY_INVALID', 'That recovery string is damaged.');
  }
  if (!payload || payload.kind !== 'zafar-session' || !payload.entries || typeof payload.entries !== 'object') {
    throw recoveryError('RECOVERY_INVALID', 'That recovery string is damaged.');
  }
  const entries = {};
  for (const [name, value] of Object.entries(payload.entries)) {
    if (!NAME_RE.test(name) || typeof value !== 'string') throw recoveryError('RECOVERY_INVALID', 'That recovery string contains an invalid entry.');
    try { JSON.parse(value); } catch { throw recoveryError('RECOVERY_INVALID', 'That recovery string contains damaged login data.'); }
    entries[name] = value;
  }
  let creds = null;
  try { creds = JSON.parse(entries['creds.json'] || 'null'); } catch { /* checked below */ }
  if (!creds || typeof creds !== 'object' || Array.isArray(creds)) {
    throw recoveryError('RECOVERY_INVALID', 'That recovery string has no usable credentials.');
  }
  return { account: String(payload.account || ''), createdAt: Number(payload.createdAt) || 0, entries, encrypted: body[0] === 1 };
}

/**
 * Install a recovery string's entries, filling only what is missing. Existing
 * entries are never overwritten: restoring an old string over a newer login
 * would resurrect stale keys.
 */
function installRecoveryToken(dir, token, { secret } = {}) {
  const parsed = parseRecoveryString(token, { secret });
  if (!enabled()) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let installed = 0;
    for (const [name, value] of Object.entries(parsed.entries)) {
      try { fs.writeFileSync(path.join(dir, name), value, { flag: 'wx', mode: 0o600 }); installed += 1; } catch { /* exists: keep current */ }
    }
    return { ...parsed, installed };
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = dirKey(dir);
  let installed = 0;
  sqlite.transaction((db) => {
    const insert = db.prepare('INSERT OR IGNORE INTO auth (dir, name, value) VALUES (?, ?, ?)');
    for (const [name, value] of Object.entries(parsed.entries)) {
      if (insert.run(key, name, value).changes) installed += 1;
    }
  });
  return { ...parsed, installed };
}

/**
 * Parse the SESSION_IDS environment format into [{ key, token }]:
 *   SESSION_ID=<owner token>
 *   SESSION_IDS={"owner":"ZAFAR~...","265991111111":"ZAFAR~..."}
 *   SESSION_IDS=owner=ZAFAR~...;265991111111=ZAFAR~...
 * A bare token (no key) is treated as the owner's.
 */
function parseRecoveryEnv(combined, ownerToken = '') {
  const items = [];
  const seen = new Set();
  const push = (key, token) => {
    const cleanKey = String(key || 'owner').trim().toLowerCase();
    const cleanToken = String(token || '').replace(/\s+/g, '').replace(/^"|"$/g, '');
    if (!cleanToken || seen.has(cleanKey)) return;
    seen.add(cleanKey);
    items.push({ key: cleanKey, token: cleanToken });
  };
  push('owner', ownerToken);
  const text = String(combined || '').trim();
  if (!text) return items;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      for (const [key, token] of Object.entries(parsed || {})) push(key, token);
      return items;
    } catch { /* fall through to the delimited form */ }
  }
  if (!text.includes('=') && !text.includes(';')) { push('owner', text); return items; }
  for (const part of text.split(/[;\n]/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    push(part.slice(0, eq), part.slice(eq + 1));
  }
  return items;
}

/** Deterministic attempt id for a recovered linked account (24 hex chars). */
function recoveryAttemptFor(number) {
  return crypto.createHash('sha256').update(`zafar-recovery:${String(number || '')}`).digest('hex').slice(0, 24);
}

function withMirrorTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(recoveryError('MIRROR_TIMEOUT', 'Remote auth mirror timed out.')), Math.max(250, Number(ms) || 8000));
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Build a remote mirror adapter for a Postgres or Mongo URL. Drivers are
 * optional dependencies, loaded lazily; a missing driver throws
 * MIRROR_DRIVER_MISSING on first use so the caller can degrade to local-only.
 * Snapshots are stored as recovery strings keyed by account folder.
 */
function createRemoteMirror(urlValue, { drivers } = {}) {
  let parsed;
  try { parsed = new URL(String(urlValue || '')); } catch {
    throw recoveryError('MIRROR_URL_INVALID', 'AUTH_MIRROR_URL is not a valid URL.');
  }
  if (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') {
    let pool = null;
    const client = async () => {
      if (pool) return pool;
      let pg;
      try { pg = drivers?.pg || require('pg'); } catch {
        throw recoveryError('MIRROR_DRIVER_MISSING', 'The "pg" package is not installed, so the Postgres auth mirror is unavailable.');
      }
      pool = new pg.Pool({ connectionString: String(urlValue), max: 1, connectionTimeoutMillis: 5000 });
      await pool.query('CREATE TABLE IF NOT EXISTS zafar_auth_mirror (dir TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at BIGINT NOT NULL)');
      return pool;
    };
    return {
      kind: 'postgres',
      async load(dir) {
        const db = await client();
        const result = await db.query('SELECT snapshot FROM zafar_auth_mirror WHERE dir = $1', [String(dir)]);
        return result.rows?.[0]?.snapshot || null;
      },
      async save(dir, snapshot) {
        const db = await client();
        await db.query(
          'INSERT INTO zafar_auth_mirror (dir, snapshot, updated_at) VALUES ($1, $2, $3) ON CONFLICT (dir) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at',
          [String(dir), String(snapshot), Date.now()],
        );
      },
      async close() { if (pool) { const current = pool; pool = null; await current.end().catch(() => {}); } },
    };
  }
  if (parsed.protocol === 'mongodb:' || parsed.protocol === 'mongodb+srv:') {
    let clientPromise = null;
    const collection = async () => {
      if (!clientPromise) {
        let mongodb;
        try { mongodb = drivers?.mongodb || require('mongodb'); } catch {
          throw recoveryError('MIRROR_DRIVER_MISSING', 'The "mongodb" package is not installed, so the Mongo auth mirror is unavailable.');
        }
        clientPromise = new mongodb.MongoClient(String(urlValue), { serverSelectionTimeoutMS: 5000, maxPoolSize: 1 }).connect();
      }
      const client = await clientPromise;
      const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'zafar';
      return client.db(dbName).collection('zafar_auth_mirror');
    };
    return {
      kind: 'mongo',
      async load(dir) {
        const doc = await (await collection()).findOne({ _id: String(dir) });
        return doc?.snapshot || null;
      },
      async save(dir, snapshot) {
        await (await collection()).updateOne(
          { _id: String(dir) },
          { $set: { snapshot: String(snapshot), updatedAt: Date.now() } },
          { upsert: true },
        );
      },
      async close() {
        if (clientPromise) { const pending = clientPromise; clientPromise = null; const client = await pending.catch(() => null); await client?.close().catch(() => {}); }
      },
    };
  }
  throw recoveryError('MIRROR_URL_INVALID', 'AUTH_MIRROR_URL must be a postgres:// or mongodb:// URL.');
}

let remoteMirror = null;
let remoteMirrorResolved = false;
let mirrorWarned = false;

function mirrorUnavailable(err) {
  if (mirrorWarned) return;
  mirrorWarned = true;
  const reason = err?.code === 'MIRROR_DRIVER_MISSING' ? 'its database driver is not installed' : 'it could not be reached';
  try { console.warn(`Remote auth mirror unavailable (${reason}); continuing with local login storage only.`); } catch { /* non-fatal */ }
}

/** The configured remote mirror (AUTH_MIRROR_URL), or null. Never throws. */
function getRemoteMirror() {
  if (remoteMirrorResolved) return remoteMirror;
  remoteMirrorResolved = true;
  if (/^(0|false|no|off)$/i.test(String(process.env.AUTH_MIRROR || ''))) return null;
  const url = String(process.env.AUTH_MIRROR_URL || '').trim();
  if (!url) return null;
  try { remoteMirror = createRemoteMirror(url); } catch (err) { mirrorUnavailable(err); remoteMirror = null; }
  return remoteMirror;
}

const mirrorTimers = new Map();
const mirrorPending = new Map();
const mirrorFlights = new Set();

async function pushMirrorNow(key) {
  const job = mirrorPending.get(key);
  if (!job) return false;
  mirrorPending.delete(key);
  const flight = (async () => {
    try {
      const { token } = createRecoveryString(job.dir, { secret: mirrorSecret(), account: '' });
      await withMirrorTimeout(job.adapter.save(key, token), 8000);
      return true;
    } catch (err) {
      // Not linked yet is normal during pairing; anything else is reported once.
      if (err?.code !== 'AUTH_MISSING') mirrorUnavailable(err);
      return false;
    }
  })();
  mirrorFlights.add(flight);
  void flight.finally(() => mirrorFlights.delete(flight));
  return flight;
}

/** Queue a debounced mirror push for an account folder. False when no mirror. */
function scheduleMirrorPush(dir, { mirror, delayMs } = {}) {
  const adapter = mirror || getRemoteMirror();
  if (!adapter) return false;
  const key = dirKey(dir);
  mirrorPending.set(key, { dir, adapter });
  if (mirrorTimers.has(key)) return true;
  const delay = delayMs != null ? Math.max(0, Number(delayMs) || 0) : Math.max(0, Number(process.env.AUTH_MIRROR_DEBOUNCE_MS) || 5000);
  const timer = setTimeout(() => { mirrorTimers.delete(key); void pushMirrorNow(key); }, delay);
  timer.unref?.();
  mirrorTimers.set(key, timer);
  return true;
}

/** Run every queued mirror push now and wait for in-flight ones (shutdown/tests). */
async function flushMirrorPushes() {
  for (const [key, timer] of mirrorTimers) { clearTimeout(timer); mirrorTimers.delete(key); void pushMirrorNow(key); }
  await Promise.allSettled([...mirrorFlights]);
  return mirrorFlights.size === 0;
}

function _resetMirrorForTests() {
  for (const timer of mirrorTimers.values()) clearTimeout(timer);
  mirrorTimers.clear();
  mirrorPending.clear();
  remoteMirror = null;
  remoteMirrorResolved = false;
  mirrorWarned = false;
}

/**
 * Baileys-compatible auth state backed by SQLite (drop-in replacement for
 * useMultiFileAuthState). Writes are synchronous single statements, so no
 * per-file mutexes are needed; key batches are one transaction.
 */
async function useSqliteAuthState(dir, { requireExisting = false, mirror = null, mirrorTimeoutMs = 8000, mirrorDelayMs } = {}) {
  const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
  if (!enabled()) {
    // Baileys creates blank credentials when this file is absent or invalid.
    // Never silently replace a previously linked account with a fresh login.
    if (requireExisting) {
      let text;
      try { text = fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'); }
      catch (err) {
        if (err.code !== 'ENOENT') throw err;
        throw Object.assign(new Error('Saved WhatsApp login is missing.'), { code: 'AUTH_MISSING' });
      }
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid credentials');
      } catch { throw Object.assign(new Error('Saved WhatsApp login is damaged.'), { code: 'AUTH_CORRUPT' }); }
    }
    const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
    return useMultiFileAuthState(dir);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  migrateDir(dir);
  const key = dirKey(dir);
  const db = sqlite.open();
  const select = db.prepare('SELECT value FROM auth WHERE dir = ? AND name = ?');
  const upsert = db.prepare('INSERT INTO auth (dir, name, value) VALUES (?, ?, ?) ON CONFLICT(dir, name) DO UPDATE SET value = excluded.value');
  const remove = db.prepare('DELETE FROM auth WHERE dir = ? AND name = ?');

  const read = (name) => {
    const row = select.get(key, fixName(name));
    if (!row) return null;
    try { return JSON.parse(row.value, BufferJSON.reviver); } catch { return null; }
  };
  // A login that was already linked must never be replaced by a blank one: the
  // next save would overwrite the real login. Say what is wrong instead.
  let credsRow = select.get(key, fixName('creds.json'));
  // Remote mirror restore: this account has no local credentials (fresh or
  // wiped container), so pull its last mirrored snapshot before deciding
  // there is nothing to connect with. One bounded attempt; a slow or dead
  // mirror must never hang a connection.
  let mirrorRestored = false;
  if (!credsRow) {
    const adapter = mirror || getRemoteMirror();
    if (adapter) {
      try {
        const token = await withMirrorTimeout(adapter.load(key), mirrorTimeoutMs);
        if (token) {
          const restored = installRecoveryToken(dir, token, { secret: mirrorSecret() });
          mirrorRestored = restored.installed > 0;
          if (mirrorRestored) credsRow = select.get(key, fixName('creds.json'));
        }
      } catch (err) { mirrorUnavailable(err); }
    }
  }
  if (requireExisting) {
    if (!credsRow) throw Object.assign(new Error('Saved WhatsApp login is missing.'), { code: 'AUTH_MISSING' });
    if (!read('creds.json')) throw Object.assign(new Error('Saved WhatsApp login is damaged.'), { code: 'AUTH_CORRUPT' });
  }
  // Beyond credentials: validate every stored Signal key before Baileys sees
  // it. This now applies to the owner too — a corrupt creds row previously
  // fell through to `initAuthCreds()` and the next save silently overwrote
  // the real login with a blank one. Broken LID mappings are the one
  // exception: they are rebuildable, so they are repaired, not fatal.
  repairCorruptLidMappings(dir);
  const validation = validateAuthState(dir);
  if (validation.corrupt.length) {
    throw Object.assign(
      new Error(`Saved WhatsApp login data is damaged (${validation.corrupt.length} stored ${validation.corrupt.length === 1 ? 'entry' : 'entries'}).`),
      { code: 'AUTH_CORRUPT' },
    );
  }
  if (credsRow && !validation.hasCreds) {
    throw Object.assign(new Error('Saved WhatsApp login is damaged.'), { code: 'AUTH_CORRUPT' });
  }
  const write = (name, value) => upsert.run(key, fixName(name), JSON.stringify(value, BufferJSON.replacer));

  const creds = read('creds.json') || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = read(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          sqlite.transaction(() => {
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                const name = `${category}-${id}.json`;
                if (value) write(name, value);
                else remove.run(key, fixName(name));
              }
            }
          });
          try { sqlite.requestBackup('auth-keys'); } catch { /* backup is a safety net, never a blocker */ }
          try { scheduleMirrorPush(dir, { mirror, delayMs: mirrorDelayMs }); } catch { /* mirror is a safety net, never a blocker */ }
        },
      },
    },
    saveCreds: async () => {
      write('creds.json', creds);
      try { sqlite.requestBackup('auth-creds'); } catch { /* backup is a safety net, never a blocker */ }
      try { scheduleMirrorPush(dir, { mirror, delayMs: mirrorDelayMs }); } catch { /* mirror is a safety net, never a blocker */ }
    },
    mirrorRestored,
  };
}

module.exports = {
  useSqliteAuthState,
  validateAuthState,
  repairCorruptLidMappings,
  migrateDir,
  readText,
  readJson,
  listFiles,
  hasFiles,
  installFiles,
  removeDir,
  dirKey,
  enabled,
  MIGRATED_DIR,
  // Session recovery + remote auth mirror
  snapshotEntries,
  createRecoveryString,
  parseRecoveryString,
  installRecoveryToken,
  parseRecoveryEnv,
  recoveryAttemptFor,
  createRemoteMirror,
  getRemoteMirror,
  scheduleMirrorPush,
  flushMirrorPushes,
  _resetMirrorForTests,
};
