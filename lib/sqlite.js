'use strict';

/**
 * One shared SQLite database for the bot's state (node:sqlite, built into
 * Node 22). Replaces the old "rewrite a whole JSON file + .bak copy on every
 * change" approach and the many little WhatsApp login files.
 *
 *   database/bot.sqlite
 *     kv    — small state documents (whitelist, settings, counters, …)
 *     auth  — WhatsApp login keys, one row per key, per account folder
 *
 * WAL journaling + synchronous=NORMAL means a crash or power loss mid-save
 * can lose at most the last instant of writes, but never corrupts the file.
 * The download workers open the same file; busy_timeout lets the two
 * processes take turns instead of failing with "database is locked".
 */

const fs = require('fs');
const path = require('path');

const BOT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(BOT_ROOT, 'database', 'bot.sqlite');

let db = null;
let dbFile = null;

function quietExperimentalWarning() {
  // Node 22 prints a one-time "SQLite is an experimental feature" warning.
  // It is noise for panel users; every other warning still goes through.
  if (process.__zfSqliteWarningFilter) return;
  process.__zfSqliteWarningFilter = true;
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (/sqlite/i.test(String(text || '')) && /experimental/i.test(String(text || '') + String(rest[0] || '') + String(rest[0]?.type || ''))) return undefined;
    return original.call(this, warning, ...rest);
  };
}

function filePath() {
  return path.resolve(String(process.env.BOT_DB || DEFAULT_FILE));
}

function open() {
  const file = filePath();
  if (db && dbFile === file) return db;
  if (db) { try { db.close(); } catch { /* replaced */ } db = null; }
  quietExperimentalWarning();
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new DatabaseSync(file);
  handle.exec('PRAGMA busy_timeout = 8000');
  try { handle.exec('PRAGMA journal_mode = WAL'); } catch { /* some network filesystems refuse WAL; rollback journal still protects writes */ }
  handle.exec('PRAGMA synchronous = NORMAL');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth (
      dir   TEXT NOT NULL,
      name  TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (dir, name)
    ) WITHOUT ROWID;
  `);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on panels */ }
  db = handle;
  dbFile = file;
  return db;
}

/** Run `fn` inside one transaction (all-or-nothing). Nested calls join the outer one. */
let depth = 0;
function transaction(fn) {
  const handle = open();
  if (depth > 0) return fn(handle);
  depth++;
  handle.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(handle);
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    try { handle.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    depth--;
  }
}

function close() {
  if (!db) return;
  try { db.close(); } catch { /* already closed */ }
  db = null;
  dbFile = null;
}

// ─── Atomic whole-database backup ────────────────────────────────────────────
// WAL mode protects against corruption mid-write, but it cannot protect
// against a panel reinstall, a Git checkout overwriting the tracked database
// file, or a filesystem that loses the file entirely. A periodic `VACUUM
// INTO` snapshot (validated before it replaces the previous one) is the
// recovery layer underneath: auth rows and settings can be restored without
// re-pairing anyone.

function backupFilePath() {
  const configured = String(process.env.BOT_DB_BACKUP_FILE || '').trim();
  if (configured) return path.resolve(configured);
  const file = filePath();
  return path.join(path.dirname(file), `${path.basename(file)}.backup`);
}

/** Open `file` read-only and run an integrity check. Never throws. */
function validateDatabaseFile(file) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const handle = new DatabaseSync(file, { readOnly: true });
    try {
      const row = handle.prepare('PRAGMA integrity_check').get();
      const result = row ? String(Object.values(row)[0] || '') : '';
      return result.toLowerCase() === 'ok';
    } finally { try { handle.close(); } catch { /* ignore */ } }
  } catch { return false; }
}

/**
 * Snapshot the live database to `bot.sqlite.backup` (atomically: write to a
 * temp file, validate it, then rename over the previous backup). Returns
 * `{ ok, file, bytes }` or `{ ok: false, reason }`. Never throws.
 */
function createBackup() {
  const target = backupFilePath();
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const handle = open();
    handle.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
    const size = fs.statSync(temp).size;
    if (!size || !validateDatabaseFile(temp)) {
      try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
      return { ok: false, reason: 'backup-validation-failed' };
    }
    fs.renameSync(temp, target);
    try { fs.chmodSync(target, 0o600); } catch { /* best effort on panels */ }
    lastBackupSignature = fileSignature();
    return { ok: true, file: target, bytes: size };
  } catch (err) {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    return { ok: false, reason: String(err?.message || err) };
  }
}

/**
 * If the live database is missing or fails its integrity check and a valid
 * backup exists, put the backup back. A corrupt original is renamed to
 * `<file>.corrupt-<timestamp>`, never deleted. Must be called before the
 * database is first opened; afterwards it is a no-op.
 */
function restoreFromBackupIfNeeded() {
  const file = filePath();
  const backup = backupFilePath();
  if (db && dbFile === file) return { restored: false, reason: 'already-open' };
  if (!fs.existsSync(backup)) return { restored: false, reason: 'no-backup' };
  if (!validateDatabaseFile(backup)) return { restored: false, reason: 'backup-invalid' };
  if (fs.existsSync(file) && validateDatabaseFile(file)) return { restored: false, reason: 'healthy' };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      const stamp = Date.now();
      for (const suffix of ['', '-wal', '-shm']) {
        const sidecar = `${file}${suffix}`;
        if (fs.existsSync(sidecar)) {
          try { fs.renameSync(sidecar, `${file}.corrupt-${stamp}${suffix}`); } catch { /* keep going */ }
        }
      }
    }
    fs.copyFileSync(backup, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    return { restored: true, reason: fs.existsSync(file) ? 'restored' : 'restored' };
  } catch (err) {
    return { restored: false, reason: String(err?.message || err) };
  }
}

let backupTimer = null;
let backupInterval = null;
let backupLog = console;
let lastBackupSignature = '';

function fileSignature() {
  try {
    const stat = fs.statSync(filePath());
    return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch { return ''; }
}

/** Ask for a debounced backup (e.g. after credential writes). No-op until started. */
function requestBackup() {
  if (!backupInterval && !backupTimer) return false;
  if (backupTimer) return true;
  backupTimer = setTimeout(() => {
    backupTimer = null;
    if (fileSignature() !== lastBackupSignature) {
      const result = createBackup();
      if (!result.ok) { try { backupLog.warn?.(`Database backup failed: ${result.reason}`); } catch { /* non-fatal */ } }
    }
  }, Math.max(250, Number(process.env.BOT_DB_BACKUP_DEBOUNCE_MS) || 15_000));
  backupTimer.unref?.();
  return true;
}

function startBackupScheduler({ log } = {}) {
  if (log) backupLog = log;
  if (backupInterval) return { stop: stopBackupScheduler, flushBackup, requestBackup };
  lastBackupSignature = fs.existsSync(backupFilePath()) ? fileSignature() : '';
  backupInterval = setInterval(() => {
    if (fileSignature() !== lastBackupSignature) {
      const result = createBackup();
      if (!result.ok) { try { backupLog.warn?.(`Database backup failed: ${result.reason}`); } catch { /* non-fatal */ } }
    }
  }, Math.max(60_000, Number(process.env.BOT_DB_BACKUP_INTERVAL_MS) || 900_000));
  backupInterval.unref?.();
  return { stop: stopBackupScheduler, flushBackup, requestBackup };
}

function flushBackup() {
  if (backupTimer) { clearTimeout(backupTimer); backupTimer = null; }
  if (!fs.existsSync(filePath())) return { ok: false, reason: 'no-database' };
  if (fileSignature() === lastBackupSignature && fs.existsSync(backupFilePath())) return { ok: true, skipped: 'unchanged' };
  return createBackup();
}

function stopBackupScheduler() {
  if (backupTimer) { clearTimeout(backupTimer); backupTimer = null; }
  if (backupInterval) { clearInterval(backupInterval); backupInterval = null; }
}

module.exports = {
  open, close, transaction, filePath, BOT_ROOT, DEFAULT_FILE,
  backupFilePath, validateDatabaseFile, createBackup, restoreFromBackupIfNeeded,
  requestBackup, startBackupScheduler, flushBackup, stopBackupScheduler,
};
