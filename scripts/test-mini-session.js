'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// A test-only standalone session process controlled over IPC. The network
// socket is deliberately simulated: this does not test WhatsApp's servers.
const worker = `
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require(${JSON.stringify(require.resolve('../gateway/sessions/manager'))});
const dir = process.argv[1];
let socket, generations = 0;
const manager = createSessionManager({
  sessionDir: dir, loggedOutCode: 401, reconnectBaseMs: 5, reconnectMaxMs: 10, recycleMs: 0,
  loadAuthState: async dir => {
    const creds = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json')));
    return { state: { creds }, saveCreds: async () => fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds)) };
  },
  getVersion: async () => [2, 0, 0],
  makeSocket: ({auth}) => {
    const s = socket = { ev: new EventEmitter(), user: auth.creds.me, end: async () => {} };
    const generation = ++generations;
    setImmediate(() => { s.ev.emit('connection.update', { connection: 'open' }); process.send({ event: 'open', generation, id: s.user.id }); });
    return s;
  },
  onMessage: async () => {}, log: { warn() {}, error() {}, debug() {}, info() {} }
});
process.on('message', async m => {
  if (m.type === 'close') {
    socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: m.code } } } });
    process.send({ event: 'closed', code: m.code });
  }
  if (m.type === 'status') process.send({ event: 'status', data: manager.status(), generations });
  if (m.type === 'stop') { await manager.stop(); process.exit(0); }
});
manager.start().catch(e => { console.error(e); process.exit(1); });
`;

function launch(dir) {
  const child = spawn(process.execPath, ['-e', worker, dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const queue = [];
  const waiters = [];
  child.on('message', message => {
    const waiter = waiters.find(w => w.event === message.event);
    if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); }
    else queue.push(message);
  });
  const wait = event => {
    const i = queue.findIndex(m => m.event === event);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { event, resolve, timer: null };
      waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`worker did not report ${event}`)); }, 2000);
      waiters.push(waiter);
    });
  };
  return { child, wait };
}

test('standalone controlled session process restarts from its own state and handles simulated disconnects', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mini-'));
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ registered: true, me: { id: '265991111111:1@s.whatsapp.net' } }));
  const workers = [];
  t.after(() => { for (const w of workers) if (w.child.exitCode === null) w.child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  let w = launch(dir); workers.push(w);
  assert.equal((await w.wait('open')).id, '265991111111:1@s.whatsapp.net');
  w.child.send({ type: 'close', code: 515 });
  await w.wait('closed');
  assert.equal((await w.wait('open')).generation, 2);
  const exited = new Promise(resolve => w.child.once('exit', resolve));
  w.child.send({ type: 'stop' });
  await exited;
  w = launch(dir); workers.push(w);
  assert.equal((await w.wait('open')).id, '265991111111:1@s.whatsapp.net');
  w.child.send({ type: 'close', code: 401 });
  await w.wait('closed');
  w.child.send({ type: 'status' });
  const status = await w.wait('status');
  assert.equal(status.generations, 1);
  assert.equal(status.data.accounts[0].state, 'logged_out');
});
