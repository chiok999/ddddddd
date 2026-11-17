'use strict';
// The relay is the only path that can read a source whose CDN refuses this
// machine's address, so it is tested against a fixture that reproduces that
// refusal, through the real worker file that gets deployed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { once } = require('node:events');
const { relayConfig, relayUrl, sign, createRelayRemote } = require('./relay');
const { resumableInput } = require('./resumable-input');

const WORKER = path.join(__dirname, 'worker', 'troy-relay.mjs');
const SECRET = 'test-secret-'.padEnd(32, 'x');
const BYTES = Buffer.alloc(40000);
for (let index = 0; index < BYTES.length; index++) BYTES[index] = (index * 7) % 251;

async function loadWorker(options) {
  const module = await import(pathToFileURL(WORKER).href);
  return module.createFetchHandler({ secret: SECRET, ...options });
}

// A provider CDN that behaves like the one in production: 426 to a client that
// does not look like a browser, real 206s to one that does, and a mid-body
// disconnect so resume logic can be exercised.
async function fixture({ drop = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/redirect-same') {
      res.writeHead(302, { location: '/movie.mp4' });
      return res.end();
    }
    if (url.pathname === '/redirect-other') {
      res.writeHead(302, { location: `${otherBase}/movie.mp4` });
      return res.end();
    }
    if (!/Mozilla\/5\.0/.test(req.headers['user-agent'] || '')) {
      res.writeHead(426, { 'content-type': 'text/plain' });
      return res.end('upgrade');
    }
    const headers = { 'content-type': 'video/mp4', etag: '"v1"', 'accept-ranges': 'bytes', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' };
    if (url.pathname === '/gzip') {
      res.writeHead(200, { ...headers, 'content-encoding': 'gzip' });
      return res.end('zipped');
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] === '' ? BYTES.length - 1 : Math.min(Number(range[2]), BYTES.length - 1);
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${BYTES.length}`, 'content-length': String(end - start + 1) });
      return res.end(BYTES.subarray(start, end + 1));
    }
    res.writeHead(200, { ...headers, 'content-length': String(BYTES.length) });
    if (drop) {
      res.write(BYTES.subarray(0, 25000));
      return setTimeout(() => res.destroy(), 50);
    }
    res.end(BYTES);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };
  return { base, requests, close };
}
let otherBase = '';
async function drain(response) { return Buffer.from(await new Response(response.body).arrayBuffer()); }

test('the relay reads a source the CDN refuses to this address', async () => {
  const cdn = await fixture();
  otherBase = cdn.base;
  try {
    const handler = await loadWorker({ allowPrivate: true });
    // The symptom: a direct request is refused.
    const direct = await fetch(`${cdn.base}/movie.mp4`, { headers: { 'accept-encoding': 'identity' } });
    assert.equal(direct.status, 426);
    await direct.body.cancel();
    // Through the worker, the same URL is served.
    const remote = createRelayRemote({
      config: { origin: 'http://worker', path: '', secret: SECRET },
      send: (url) => handler(new Request(url)),
      direct: null,
    });
    const response = await remote(`${cdn.base}/movie.mp4`, { 'accept-encoding': 'identity' }, undefined);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(BYTES.length));
    assert.equal(response.headers.get('etag'), '"v1"');
    assert.deepEqual(await drain(response), BYTES);
  } finally { await cdn.close(); }
});

test('the relay keeps range semantics, which is what seeking and resume need', async () => {
  const cdn = await fixture();
  otherBase = cdn.base;
  try {
    const handler = await loadWorker({ allowPrivate: true });
    const remote = createRelayRemote({ config: { origin: 'http://worker', path: '', secret: SECRET }, send: (url) => handler(new Request(url)), direct: null });
    const middle = await remote(`${cdn.base}/movie.mp4`, { range: 'bytes=100-199', 'accept-encoding': 'identity' }, undefined);
    assert.equal(middle.status, 206);
    assert.equal(middle.headers.get('content-range'), `bytes 100-199/${BYTES.length}`);
    assert.deepEqual(await drain(middle), BYTES.subarray(100, 200));
    const tail = await remote(`${cdn.base}/movie.mp4`, { range: 'bytes=39000-', 'accept-encoding': 'identity' }, undefined);
    assert.equal(tail.status, 206);
    assert.deepEqual(await drain(tail), BYTES.subarray(39000));
  } finally { await cdn.close(); }
});

test('provider headers reach the CDN through the relay and nothing else leaks', async () => {
  const cdn = await fixture();
  otherBase = cdn.base;
  try {
    const handler = await loadWorker({ allowPrivate: true });
    const remote = createRelayRemote({ config: { origin: 'http://worker', path: '', secret: SECRET }, send: (url) => handler(new Request(url)), direct: null });
    await drain(await remote(`${cdn.base}/movie.mp4`, {
      referer: 'https://nextgencloudfabric.com/embed/movie/tt1',
      origin: 'https://nextgencloudfabric.com',
      'user-agent': 'okhttp/4.12.0',
      'accept-encoding': 'identity',
      'if-range': '"v1"',
    }, undefined));
    const seen = cdn.requests.at(-1).headers;
    assert.equal(seen.referer, 'https://nextgencloudfabric.com/embed/movie/tt1');
    assert.equal(seen.origin, 'https://nextgencloudfabric.com');
    assert.equal(seen['user-agent'], 'okhttp/4.12.0');
    assert.equal(seen['if-range'], '"v1"');
    // The shared secret never travels as a header, and no cookie is invented.
    assert.equal(seen['x-relay-key'], undefined);
    assert.equal(seen.cookie, undefined);
  } finally { await cdn.close(); }
});

test('the worker follows redirects itself and drops credentials across origins', async () => {
  const other = await fixture();
  otherBase = other.base;
  const cdn = await fixture();
  try {
    const handler = await loadWorker({ allowPrivate: true });
    const config = { origin: 'http://worker', path: '', secret: SECRET };
    const remote = createRelayRemote({ config, send: (url) => handler(new Request(url)), direct: null });
    const same = await remote(`${cdn.base}/redirect-same`, { referer: 'https://provider.test/' }, undefined);
    assert.equal(same.status, 200);
    await drain(same);
    assert.equal(cdn.requests.at(-1).path, '/movie.mp4');
    assert.equal(cdn.requests.at(-1).headers.referer, 'https://provider.test/');
    // A cross-origin redirect is followed by the worker, not sent back to Troy,
    // which could not follow it without leaving the relay.
    const crossed = await remote(`${cdn.base}/redirect-other`, { referer: 'https://provider.test/' }, undefined);
    assert.equal(crossed.status, 200);
    await crossed.body.cancel();
    assert.equal(other.requests.at(-1).path, '/movie.mp4');
    assert.equal(other.requests.at(-1).headers.referer, 'https://provider.test/');
    assert.equal(other.requests.at(-1).headers.cookie, undefined);
  } finally { await cdn.close(); await other.close(); }
});

test('a dropped connection resumes through the relay without losing bytes', async () => {
  const cdn = await fixture({ drop: true });
  otherBase = cdn.base;
  try {
    const handler = await loadWorker({ allowPrivate: true });
    const remote = createRelayRemote({ config: { origin: 'http://worker', path: '', secret: SECRET }, send: (url) => handler(new Request(url)), direct: null });
    const signal = new AbortController().signal;
    const first = await remote(`${cdn.base}/movie.mp4`, { 'accept-encoding': 'identity' }, signal);
    assert.equal(first.status, 200);
    const stream = resumableInput(first, (offset, validator) => remote(`${cdn.base}/movie.mp4`, { range: `bytes=${offset}-`, 'if-range': validator, 'accept-encoding': 'identity' }, signal), signal, { backoffMs: 5 });
    const collected = [];
    for await (const chunk of stream) collected.push(chunk);
    assert.deepEqual(Buffer.concat(collected), BYTES);
    assert.ok(cdn.requests.length >= 2);
    assert.equal(cdn.requests.at(-1).headers.range, 'bytes=25000-');
    assert.equal(cdn.requests.at(-1).headers['if-range'], '"v1"');
  } finally { await cdn.close(); }
});

test('a compression the relay cannot verify is visible and refused upstream', async () => {
  const cdn = await fixture();
  otherBase = cdn.base;
  try {
    const handler = await loadWorker({ allowPrivate: true });
    const remote = createRelayRemote({ config: { origin: 'http://worker', path: '', secret: SECRET }, send: (url) => handler(new Request(url)), direct: null });
    const response = await remote(`${cdn.base}/gzip`, {}, undefined);
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    await response.body.cancel();
  } finally { await cdn.close(); }
});

test('the worker default refuses unsigned, private, plain-HTTP and IP targets', async () => {
  const handler = await loadWorker({});
  const target = 'https://cdn.example/movie.mp4';
  assert.equal((await handler(new Request(`https://w.dev/?url=${encodeURIComponent(target)}`))).status, 403);
  assert.equal((await handler(new Request(`https://w.dev/?url=${encodeURIComponent(target)}&sig=${'0'.repeat(64)}`))).status, 403);
  const sign_ = (value) => sign(SECRET, value);
  for (const [value, why] of [
    ['http://cdn.example/movie.mp4', 'plain HTTP'],
    ['https://127.0.0.1/movie.mp4', 'loopback IP'],
    ['https://93.184.216.34/movie.mp4', 'public IP'],
    ['https://localhost/movie.mp4', 'localhost'],
    ['https://box.local/movie.mp4', 'private suffix'],
    ['https://cdn.example:8443/movie.mp4', 'odd port'],
    ['https://user:pass@cdn.example/movie.mp4', 'credentials'],
  ]) {
    const response = await handler(new Request(`https://w.dev/?url=${encodeURIComponent(value)}&sig=${sign_(value)}`));
    assert.equal(response.status, 400, why);
  }
});

test('the worker reports its own health and refuses a missing key', async () => {
  const handler = await loadWorker({});
  const health = await handler(new Request('https://w.dev/health'));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).signed, true);
  const landing = await handler(new Request('https://w.dev/'));
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Troy relay/);
  const unsignedWorker = await loadWorker({ secret: undefined });
  const refused = await unsignedWorker(new Request(`https://w.dev/?url=${encodeURIComponent('https://cdn.example/a.mp4')}`));
  assert.equal(refused.status, 500);
});

test('the paste-ready worker is the tested worker with a different header', async () => {
  const fs = require('node:fs');
  const body = (file) => fs.readFileSync(path.join(__dirname, 'worker', file), 'utf8').slice(fs.readFileSync(path.join(__dirname, 'worker', file), 'utf8').indexOf('const VERSION'));
  assert.equal(body('troy-relay-paste.js'), body('troy-relay.mjs'), 'the two worker files must not drift apart');
  // and it is the one that actually runs
  const pasted = await import(pathToFileURL(WORKER).href);
  assert.equal(typeof pasted.createFetchHandler, 'function');
  assert.equal(typeof pasted.default.fetch, 'function');
});

test('relay settings are validated instead of silently half-configured', () => {
  assert.equal(relayConfig({}), null);
  assert.equal(relayConfig({ CINEMA_RELAY_URL: '  ' }), null);
  assert.throws(() => relayConfig({ CINEMA_RELAY_URL: 'https://w.dev' }), /CINEMA_RELAY_KEY/);
  assert.throws(() => relayConfig({ CINEMA_RELAY_URL: 'https://w.dev', CINEMA_RELAY_KEY: 'short' }), /CINEMA_RELAY_KEY/);
  assert.throws(() => relayConfig({ CINEMA_RELAY_URL: 'http://w.dev', CINEMA_RELAY_KEY: SECRET }), /https/);
  assert.throws(() => relayConfig({ CINEMA_RELAY_URL: 'https://u:p@w.dev', CINEMA_RELAY_KEY: SECRET }), /credentials/);
  const parsed = relayConfig({ CINEMA_RELAY_URL: 'https://w.dev/relay/', CINEMA_RELAY_KEY: SECRET });
  assert.equal(parsed.origin, 'https://w.dev');
  assert.equal(parsed.path, '/relay');
});

test('the signed URL is deterministic and signs the target only', () => {
  const config = { origin: 'https://w.dev', path: '', secret: SECRET };
  const target = 'https://cdn.example/movie.mp4?token=a b';
  const first = new URL(relayUrl(config, target, { referer: 'https://p.test/' }));
  const second = new URL(relayUrl(config, target, {}));
  assert.equal(first.searchParams.get('sig'), second.searchParams.get('sig'));
  assert.equal(first.searchParams.get('url'), target);
  assert.equal(first.searchParams.get('art'), '1');
  assert.equal(first.searchParams.get('r'), 'https://p.test/');
  assert.equal(second.searchParams.get('r'), null);
  assert.equal(first.searchParams.get('sig'), crypto.createHmac('sha256', SECRET).update(target).digest('hex'));
  // Query strings on the target must not be able to break the surrounding URL.
  assert.ok(!first.href.includes('token=a b'));
});

test('a relay failure is one clear error, never a silent direct retry', async () => {
  const remote = createRelayRemote({ config: { origin: 'http://127.0.0.1:1', path: '', secret: SECRET }, send: (url) => fetch(url), direct: null });
  await assert.rejects(remote('https://cdn.example/movie.mp4', {}, undefined), /Relay unreachable/);
  const refused = createRelayRemote({ config: { origin: 'https://w.dev', path: '', secret: SECRET }, send: async () => new Response('{"error":"Bad signature"}', { status: 403 }), direct: null });
  await assert.rejects(refused('https://cdn.example/movie.mp4', {}, undefined), /Relay error 403/);
});
