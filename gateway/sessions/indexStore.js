'use strict';

// Keep the linked-account index next to its auth rows in SQLite. The JSON
// manifest remains a best-effort compatibility copy, not an authority after
// migration, so a stale backup cannot resurrect removed or logged-out links.
const path = require('node:path');
const sqlite = require('../../lib/sqlite');
const authStore = require('../../lib/authStore');
const { readJsonSafe, writeJsonAtomic } = require('../../lib/jsonStore');

function createIndexStore(sessionDir, log) {
  const file = path.join(sessionDir, 'linked', 'accounts.json');
  const key = `linked-session-index:${authStore.dirKey(sessionDir)}`;
  const readRow = () => sqlite.open().prepare('SELECT value FROM kv WHERE key = ?').get(key);
  const writeRow = data => sqlite.open().prepare(
    'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, JSON.stringify(data), Date.now());
  const invalid = error => ({ ok: false, exists: true, recovered: false, corrupt: true, data: null, error });
  return {
    read({ defaultValue, validate }) {
      try {
        const row = readRow();
        if (row) {
          let data;
          try { data = JSON.parse(row.value); } catch { return invalid(new Error('Linked-account database index is invalid')); }
          if (!validate(data)) return invalid(new Error('Linked-account database index is invalid'));
          return { ok: true, exists: true, recovered: false, corrupt: false, data };
        }
        // Migrate only a valid legacy manifest, including its validated backup.
        // Never replace a damaged manifest with a blank index.
        const legacy = readJsonSafe(file, { defaultValue, validate });
        if (legacy.ok && legacy.exists) writeRow(legacy.data);
        return legacy;
      } catch (error) { return invalid(error); }
    },
    write(data) {
      // Database is authoritative. A failure here must abort the state change.
      writeRow(data);
      try { writeJsonAtomic(file, data); }
      catch (error) { log.warn(`Linked-account file copy could not be saved; the database index remains available (${error.message}).`); }
    },
  };
}
module.exports = { createIndexStore };
