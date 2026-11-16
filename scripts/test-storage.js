#!/usr/bin/env node
'use strict';

// SQLite storage: state documents (database/*.json → database/bot.sqlite)
// and WhatsApp login keys (session files → auth table). Runs in a fixture
// copy so the real database is never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-storage-'));
const ROOT = createBotFixture(TMP);
process.chdir(ROOT);
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const DB_DIR = path.join(ROOT, 'database');
fs.mkdirSync(DB_DIR, { recursive: true });
const store = require(path.join(ROOT, 'lib/jsonStore'));
const sqlite = require(path.join(ROOT, 'lib/sqlite'));
const authStore = require(path.join(ROOT, 'lib/authStore'));

test('state documents are saved in database/bot.sqlite, not as JSON files', () => {
  const file = path.join(DB_DIR, 'botstate.json');
  store.writeJsonAtomic(file, { on: false });
  assert.equal(fs.existsSync(file), false, 'no JSON file written');
  assert.equal(fs.existsSync(`${file}.bak`), false, 'no .bak copy written');
  assert.ok(fs.existsSync(path.join(DB_DIR, 'bot.sqlite')));
  assert.deepEqual(store.readJsonSafe(file).data, { on: false });
  assert.equal(store.documentExists(file), true);
  assert.equal(store.documentExists(path.join(DB_DIR, 'nothing.json')), false);
});

test('an existing JSON file (or its .bak when damaged) is imported once and kept as *.migrated', () => {
  const file = path.join(DB_DIR, 'whitelist.json');
  fs.writeFileSync(file, '{ broken');
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ users: [{ number: '265991111111' }] }));
  const first = store.readJsonSafe(file, { validate: (d) => Array.isArray(d?.users) });
  assert.equal(first.ok, true);
  assert.equal(first.data.users[0].number, '265991111111');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.migrated`), true, 'old file kept, never deleted');
  // Later reads come from the database even if an old file reappears.
  fs.writeFileSync(file, JSON.stringify({ users: [] }));
  assert.equal(store.readJsonSafe(file).data.users.length, 1);
});

test('database.js keeps migrated state instead of writing defaults over it', () => {
  fs.writeFileSync(path.join(DB_DIR, 'paper_log.json'), JSON.stringify({ chat: { 1: Date.now() } }));
  const result = spawnSync(process.execPath, ['-e', `
    const db = require(${JSON.stringify(path.join(ROOT, 'lib/database'))});
    console.log(JSON.stringify({ on: db.getBotState() }));
    const s = require(${JSON.stringify(path.join(ROOT, 'lib/jsonStore'))});
    console.log(JSON.stringify(s.readJsonSafe(${JSON.stringify(path.join(DB_DIR, 'paper_log.json'))}).data));
  `], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [state, log] = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(state, { on: false }, 'saved bot state survives a restart');
  assert.ok(log.chat, 'imported paper log is not replaced by defaults');
});

test('paths outside database/ keep the atomic JSON file behaviour', () => {
  const file = path.join(TMP, 'outside.json');
  store.writeJsonAtomic(file, { a: 1 });
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(`${file}.bak`));
  assert.deepEqual(store.readJsonSafe(file).data, { a: 1 });
});

test('main process and a worker can write at the same time without "database is locked"', async () => {
  const file = path.join(DB_DIR, 'concurrency.json');
  const script = (tag) => `
    const s = require(${JSON.stringify(path.join(ROOT, 'lib/jsonStore'))});
    for (let i = 0; i < 300; i++) s.writeJsonAtomic(${JSON.stringify(file)}.replace('.json', '-${tag}.json'), { i });
  `;
  const run = (tag) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script(tag)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, err }));
  });
  const results = await Promise.all([run('a'), run('b'), run('c')]);
  for (const r of results) assert.equal(r.code, 0, r.err);
  for (const tag of ['a', 'b', 'c']) assert.deepEqual(store.readJsonSafe(file.replace('.json', `-${tag}.json`)).data, { i: 299 });
});

test('a process killed mid-save never corrupts the database', async () => {
  const child = spawn(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(ROOT, 'lib/jsonStore'))});
    let i = 0; for (;;) s.writeJsonAtomic(${JSON.stringify(path.join(DB_DIR, 'killed.json'))}, { i: i++, pad: 'x'.repeat(5000) });
  `], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 700));
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  const check = sqlite.open().prepare('PRAGMA integrity_check').get();
  assert.equal(Object.values(check)[0], 'ok');
  const saved = store.readJsonSafe(path.join(DB_DIR, 'killed.json'));
  assert.equal(saved.ok, true);
  assert.ok(saved.data.i > 0);
});

test('WhatsApp login: old session files are imported once into SQLite and archived', async () => {
  const dir = path.join(ROOT, 'session');
  fs.mkdirSync(dir, { recursive: true });
  const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
  const creds = initAuthCreds();
  creds.registered = true;
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds, BufferJSON.replacer));
  fs.writeFileSync(path.join(dir, 'pre-key-1.json'), JSON.stringify({ public: Buffer.from('pub'), private: Buffer.from('priv') }, BufferJSON.replacer));
  fs.writeFileSync(path.join(dir, 'lid-mapping-111_reverse.json'), JSON.stringify('265990000001'));

  const auth = await authStore.useSqliteAuthState(dir);
  assert.equal(auth.state.creds.registered, true);
  assert.equal(auth.state.creds.registrationId, creds.registrationId);
  const keys = await auth.state.keys.get('pre-key', ['1']);
  assert.equal(Buffer.from(keys['1'].private).toString(), 'priv');
  assert.equal(fs.existsSync(path.join(dir, 'creds.json')), false, 'files moved out of the way');
  assert.equal(fs.existsSync(path.join(dir, authStore.MIGRATED_DIR, 'creds.json')), true, 'originals archived, not deleted');
  assert.equal(require(path.join(ROOT, 'lib/jid')).normalizeJidWithLid('111@lid', dir), '265990000001@s.whatsapp.net');
});

test('WhatsApp login: keys and creds round-trip through SQLite like the file store', async () => {
  const dir = path.join(ROOT, 'session', 'linked', '265990000002', 'a'.repeat(24));
  const auth = await authStore.useSqliteAuthState(dir);
  auth.state.creds.me = { id: '265990000002:1@s.whatsapp.net' };
  await auth.saveCreds();
  await auth.state.keys.set({ session: { 'abc:1': { record: Buffer.from('r1') } }, 'pre-key': { 5: { public: Buffer.from('p') } } });
  await auth.state.keys.set({ 'pre-key': { 5: null } });
  const again = await authStore.useSqliteAuthState(dir);
  assert.equal(again.state.creds.me.id, '265990000002:1@s.whatsapp.net');
  const got = await again.state.keys.get('session', ['abc:1']);
  assert.equal(Buffer.from(got['abc:1'].record).toString(), 'r1');
  assert.deepEqual(await again.state.keys.get('pre-key', ['5']), { 5: null });
  // Same names as the old files.
  assert.deepEqual(Object.keys(authStore.listFiles(dir)).sort(), ['creds.json', 'session-abc-1.json']);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length, 0, 'no loose key files');
});

test('WhatsApp login: recovery install refuses to overwrite existing credentials', () => {
  const dir = path.join(ROOT, 'session', 'linked', '265990000003', 'b'.repeat(24));
  authStore.installFiles(dir, { 'creds.json': JSON.stringify({ registered: true }) });
  assert.throws(() => authStore.installFiles(dir, { 'creds.json': '{}' }), { code: 'EEXIST' });
  authStore.removeDir(dir);
  assert.equal(authStore.hasFiles(dir), false);
});

test('file auth mode refuses to replace missing or corrupt linked credentials', async () => {
  const prev = process.env.AUTH_STORE;
  process.env.AUTH_STORE = 'files';
  const dir = path.join(ROOT, 'file-auth-guard');
  fs.mkdirSync(dir, { recursive: true });
  try {
    await assert.rejects(authStore.useSqliteAuthState(dir, { requireExisting: true }), { code: 'AUTH_MISSING' });
    fs.writeFileSync(path.join(dir, 'creds.json'), '{broken');
    await assert.rejects(authStore.useSqliteAuthState(dir, { requireExisting: true }), { code: 'AUTH_CORRUPT' });
    assert.equal(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'), '{broken');
  } finally {
    if (prev === undefined) delete process.env.AUTH_STORE; else process.env.AUTH_STORE = prev;
  }
});

test('owner and linked auth remain isolated with identical key names across independent processes', async () => {
  const ownerDir = path.join(ROOT, 'isolation-session');
  const linkedDir = path.join(ownerDir, 'linked', '265991111111', 'c'.repeat(24));
  const owner = await authStore.useSqliteAuthState(ownerDir);
  const linked = await authStore.useSqliteAuthState(linkedDir);
  owner.state.creds.me = { id: '265990000000:1@s.whatsapp.net' };
  linked.state.creds.me = { id: '265991111111:1@s.whatsapp.net' };
  await owner.saveCreds();
  await linked.saveCreds();
  await owner.state.keys.set({ session: { same: { record: Buffer.from('owner-key') } } });
  await linked.state.keys.set({ session: { same: { record: Buffer.from('linked-key') } } });

  const worker = `
    (async () => {
      const auth = await require(${JSON.stringify(path.join(ROOT, 'lib/authStore'))}).useSqliteAuthState(process.argv[1], { requireExisting: true });
      const keys = await auth.state.keys.get('session', ['same']);
      process.stdout.write(JSON.stringify({ id: auth.state.creds.me.id, key: Buffer.from(keys.same.record).toString() }));
    })().catch(e => { console.error(e.message); process.exitCode = 1; });`;
  const readWorker = (dir) => {
    const child = spawnSync(process.execPath, ['-e', worker, dir], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AUTH_STORE: 'sqlite' } });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  assert.deepEqual(readWorker(ownerDir), { id: '265990000000:1@s.whatsapp.net', key: 'owner-key' });
  assert.deepEqual(readWorker(linkedDir), { id: '265991111111:1@s.whatsapp.net', key: 'linked-key' });
  // Destroy only the owner namespace; the child can still restart with linked state.
  authStore.removeDir(ownerDir);
  assert.deepEqual(readWorker(linkedDir), { id: '265991111111:1@s.whatsapp.net', key: 'linked-key' });
  // Destroy only the linked namespace; owner state recreated under the same name survives.
  await owner.saveCreds();
  await owner.state.keys.set({ session: { same: { record: Buffer.from('owner-key') } } });
  authStore.removeDir(linkedDir);
  assert.deepEqual(readWorker(ownerDir), { id: '265990000000:1@s.whatsapp.net', key: 'owner-key' });
});

test('SQLite index restores linked sessions when the file index is lost, without reviving removed accounts', async () => {
  const { EventEmitter } = require('node:events');
  const { createSessionManager } = require(path.join(ROOT, 'gateway/sessions/manager'));
  const session = path.join(ROOT, 'lost-index-session');
  const number = '265991111111';
  const attempt = 'd'.repeat(24);
  const linkedDir = path.join(session, 'linked', number, attempt);
  const auth = await authStore.useSqliteAuthState(linkedDir);
  auth.state.creds.registered = true;
  auth.state.creds.me = { id: `${number}:1@s.whatsapp.net` };
  await auth.saveCreds();
  const index = path.join(session, 'linked', 'accounts.json');
  fs.writeFileSync(index, JSON.stringify({ version: 1, accounts: { [number]: { attempt, state: 'active' } } }));
  const started = [];
  function manager() {
    return createSessionManager({
      sessionDir: session, loggedOutCode: 401, durableIndex: true,
      loadAuthState: authStore.useSqliteAuthState,
      getVersion: async () => [2, 0, 0],
      makeSocket: ({ auth }) => { const sock = { ev: new EventEmitter(), auth, end: async () => {} }; started.push(sock); return sock; },
      onMessage: async () => {}, log: { warn() {}, error() {}, info() {}, debug() {} },
    });
  }
  const first = manager();
  await first.start();
  assert.deepEqual(started.map(s => s.__sessionId).sort(), ['primary', `linked:${number}`].sort());
  await first.stop();
  // Model a deployment restoring the SQLite DB but not the session index.
  fs.rmSync(index);
  fs.rmSync(`${index}.bak`, { force: true });
  started.length = 0;
  const second = manager();
  try {
    await second.start();
    assert.deepEqual(started.map(s => s.__sessionId).sort(), ['primary', `linked:${number}`].sort());
    assert.equal((await authStore.useSqliteAuthState(linkedDir, { requireExisting: true })).state.creds.me.id, `${number}:1@s.whatsapp.net`);
    await second.removeAccount(number);
  } finally { await second.stop(); }
  // A stale file must never restore an explicitly removed account.
  fs.writeFileSync(index, JSON.stringify({ version: 1, accounts: { [number]: { attempt, state: 'active' } } }));
  started.length = 0;
  const third = manager();
  try { await third.start(); assert.deepEqual(started.map(s => s.__sessionId), ['primary']); }
  finally { await third.stop(); }
});

test('a compressed credentials-only session string restores a snapshot, not later Signal keys', async () => {
  const zlib = require('node:zlib');
  const { BufferJSON } = require('@whiskeysockets/baileys');
  const sourceDir = path.join(ROOT, 'session-token-source');
  const restoredDir = path.join(ROOT, 'session-token-restored');
  const source = await authStore.useSqliteAuthState(sourceDir);
  source.state.creds.registered = true;
  source.state.creds.me = { id: '265991111111:1@s.whatsapp.net' };
  source.state.creds.accountSyncCounter = 7;
  await source.saveCreds();
  const token = zlib.gzipSync(Buffer.from(JSON.stringify(source.state.creds, BufferJSON.replacer))).toString('base64');
  await source.state.keys.set({ session: { recipient: { record: Buffer.from('later-key') } } });
  source.state.creds.accountSyncCounter = 8;
  await source.saveCreds();
  const decoded = zlib.gunzipSync(Buffer.from(token, 'base64')).toString('utf8');
  authStore.installFiles(restoredDir, { 'creds.json': decoded });
  const restored = await authStore.useSqliteAuthState(restoredDir, { requireExisting: true });
  assert.equal(restored.state.creds.accountSyncCounter, 7, 'the token is an old credential snapshot');
  assert.equal((await restored.state.keys.get('session', ['recipient'])).recipient, null, 'Signal keys were not included in the token');
  assert.equal((await source.state.keys.get('session', ['recipient'])).recipient.record.toString(), 'later-key');
});

test('linked index refuses corrupt SQLite data instead of trusting a stale file copy', () => {
  const { createIndexStore } = require(path.join(ROOT, 'gateway/sessions/indexStore'));
  const session = path.join(ROOT, 'corrupt-durable-index');
  const file = path.join(session, 'linked', 'accounts.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = { version: 1, accounts: { '265991111111': { attempt: 'a'.repeat(24), state: 'active' } } };
  fs.writeFileSync(file, JSON.stringify(old));
  const index = createIndexStore(session, { warn() {} });
  const opts = { defaultValue: { version: 1, accounts: {} }, validate: data => data?.version === 1 && !!data.accounts };
  assert.deepEqual(index.read(opts).data, old);
  const key = `linked-session-index:${authStore.dirKey(session)}`;
  sqlite.open().prepare('UPDATE kv SET value = ? WHERE key = ?').run('{broken', key);
  const result = index.read(opts);
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(old));
});
