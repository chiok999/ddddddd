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
const { relayConfig, relayUrl, relayHeaders, sign, createRelayRemote } = require('./relay');

// Fixed port numbers made these tests collide with a relay left over from the
// previous run (or with a parallel file). Ask the OS for a free one instead; a
// fixed number is a claim about the machine, not about the code.
const freePort = async () => {
  const net = require('node:net');
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};
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
async function fixture({ drop = false, rateLimit = 0, requireBrowser = true } = {}) {
  // rateLimit: refuse this many requests with 427 before serving, the way an
  // nginx `limit_req_status 427` does when the bucket is full.
  let limited = 0;
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
    if (limited < rateLimit) {
      limited++;
      // No retry-after: the worker's own backoff is what must be measured here.
      res.writeHead(427, { 'content-type': 'text/plain' });
      return res.end('rate limited');
    }
    if (requireBrowser && !/Mozilla\/5\.0/.test(req.headers['user-agent'] || '')) {
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
  // The browser gate is off here so the provider's own User-Agent can be checked.
  const cdn = await fixture({ requireBrowser: false });
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

test('a rate limit is waited out, not reported as a failure', async () => {
  // Two 427s then bytes: this is the production symptom, and it must play.
  const cdn = await fixture({ rateLimit: 2 });
  otherBase = cdn.base;
  try {
    const handler = await loadWorker({ allowPrivate: true });
    const remote = createRelayRemote({ config: { origin: 'http://worker', path: '', secret: SECRET }, send: (url) => handler(new Request(url)), direct: null });
    const started = Date.now();
    const response = await remote(`${cdn.base}/movie.mp4`, { 'accept-encoding': 'identity' }, undefined);
    assert.equal(response.status, 200, 'two refusals, then the file');
    assert.equal(response.retried, false, 'a successful retry is not marked as exhausted');
    assert.deepEqual(await drain(response), BYTES);
    assert.ok(Date.now() - started >= 400, 'it actually waited rather than hammering');
    assert.equal(cdn.requests.filter((request) => request.headers.range === undefined).length, 3, 'one attempt per refusal plus the success');
  } finally { await cdn.close(); }
});

test('a rate limit that never clears is reported as a rate limit', async () => {
  const cdn = await fixture({ rateLimit: 99 });
  otherBase = cdn.base;
  try {
    const handler = await loadWorker({ allowPrivate: true });
    const remote = createRelayRemote({ config: { origin: 'http://worker', path: '', secret: SECRET }, send: (url) => handler(new Request(url)), direct: null });
    // A health problem is thrown with the real status, so the router can decide
    // to use another route instead of showing a failure.
    await assert.rejects(remote(`${cdn.base}/movie.mp4`, { 'accept-encoding': 'identity' }, undefined), (error) => {
      assert.equal(error.status, 427, 'the status survives, not turned into 502');
      assert.equal(error.relayFailure, true);
      return true;
    });
    // Bounded: one original plus four waits, not an unbounded loop.
    assert.equal(cdn.requests.length, 5, `attempts: ${cdn.requests.length}`);
  } finally { await cdn.close(); }
});

test('429 is treated as the same answer as 427', async () => {
  let seen = 0;
  const server = http.createServer((req, res) => {
    seen++;
    if (seen === 1) {
      res.writeHead(429, { 'retry-after': '0' });
      return res.end();
    }
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes 0-1/${BYTES.length}`, 'content-length': '2' });
    res.end(BYTES.subarray(0, 2));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const handler = await loadWorker({ allowPrivate: true });
    const remote = createRelayRemote({ config: { origin: 'http://worker', path: '', secret: SECRET }, send: (url) => handler(new Request(url)), direct: null });
    const response = await remote(`http://127.0.0.1:${server.address().port}/movie.mp4`, { range: 'bytes=0-1' }, undefined);
    assert.equal(response.status, 206);
    assert.equal(seen, 2);
    await response.body.cancel();
  } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});

test('the retry loop is bounded even when the CDN keeps asking for longer', async () => {
  let seen = 0;
  const server = http.createServer((req, res) => {
    seen++;
    // retry-after is clamped, so this must still give up quickly.
    res.writeHead(427, { 'retry-after': '3600' });
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const handler = await loadWorker({ allowPrivate: true });
    const remote = createRelayRemote({ config: { origin: 'http://worker', path: '', secret: SECRET }, send: (url) => handler(new Request(url)), direct: null });
    const started = Date.now();
    await assert.rejects(remote(`http://127.0.0.1:${server.address().port}/movie.mp4`, {}, undefined), (error) => error.status === 427);
    assert.ok(Date.now() - started < 30000, 'honoured the retry-after clamp rather than an hour');
    assert.ok(seen >= 1 && seen <= 5, `attempts: ${seen}`);
  } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
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
  assert.equal(relayConfig({ CINEMA_RELAY_URL: 'http://localhost:4180', CINEMA_RELAY_KEY: SECRET }).inQuery, false, 'plain http is allowed, with the signature in a header');
  assert.equal(relayConfig({ CINEMA_RELAY_URL: 'http://192.168.1.50:4180', CINEMA_RELAY_KEY: SECRET }).inQuery, false, 'and for another box of your own');
  assert.equal(relayConfig({ CINEMA_RELAY_URL: 'https://w.dev', CINEMA_RELAY_KEY: SECRET }).inQuery, true, 'https keeps the Worker-compatible query form');
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

test('the bot-keep relay serves the same contract over real HTTP', async () => {
  // This is the file that runs on the bot host: no dependencies, no disk, just
  // bytes passing through. Driven over a real socket, not in-process.
  const { createRelayServer } = require('./troy-relay-server');
  const key = 'bot-keep-secret-'.padEnd(32, 'k');
  const bytes = Buffer.alloc(12000);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  let limited = 0;
  const cdn = http.createServer((req, res) => {
    if (!/Mozilla\/5\.0/.test(req.headers['user-agent'] || '')) {
      res.writeHead(426, { 'content-type': 'text/plain' });
      return res.end('upgrade');
    }
    if (limited < 1) {
      limited++;
      res.writeHead(427, { 'content-type': 'text/plain' });
      return res.end('slow down');
    }
    const headers = { 'content-type': 'video/mp4', etag: '"bk"', 'accept-ranges': 'bytes', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] === '' ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1);
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': String(end - start + 1) });
      return res.end(bytes.subarray(start, end + 1));
    }
    res.writeHead(200, { ...headers, 'content-length': String(bytes.length) });
    res.end(bytes);
  });
  cdn.listen(0, '127.0.0.1');
  await once(cdn, 'listening');
  const relay = createRelayServer({ secret: key, allowPrivate: true });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const target = `http://127.0.0.1:${cdn.address().port}/movie.mp4`;
  try {
    // The client is the real one, configured exactly as the panel would be.
    const config = relayConfig({ CINEMA_RELAY_URL: `http://127.0.0.1:${relay.address().port}`, CINEMA_RELAY_KEY: key });
    assert.equal(config.inQuery, false, 'plain http puts the signature in a header, not the URL');
    const remote = createRelayRemote({ config, send: (url, headers, signal) => fetch(url, { headers, signal }), direct: null });
    const full = await remote(target, { 'accept-encoding': 'identity' }, undefined);
    assert.equal(full.status, 200, 'the 427 was waited out and the file arrived');
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('etag'), '"bk"');
    assert.deepEqual(await drain(full), bytes);
    const part = await remote(target, { range: 'bytes=100-199', 'accept-encoding': 'identity' }, undefined);
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 100-199/${bytes.length}`);
    assert.deepEqual(await drain(part), bytes.subarray(100, 200));
    // The secret never appears in a URL that could be logged.
    const built = relayUrl(config, target, {});
    assert.ok(!built.includes(sign(key, target)), 'no signature in the query');
    assert.equal(relayHeaders(config, target)['x-troy-sig'], sign(key, target));
  } finally {
    relay.close();
    cdn.closeAllConnections?.();
    await new Promise((resolve) => cdn.close(resolve));
  }
});

test('the bot-keep relay refuses what the Worker refuses', async () => {
  const { createRelayServer, checkTarget } = require('./troy-relay-server');
  const key = 'bot-keep-secret-'.padEnd(32, 'k');
  const relay = createRelayServer({ secret: key });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const base = `http://127.0.0.1:${relay.address().port}`;
  try {
    const target = 'https://cdn.example/film.mp4';
    assert.equal((await fetch(`${base}/?url=${encodeURIComponent(target)}`)).status, 403, 'unsigned');
    assert.equal((await fetch(`${base}/?url=${encodeURIComponent(target)}&sig=${'0'.repeat(64)}`)).status, 403, 'wrongly signed');
    const signed = (value) => `${base}/?url=${encodeURIComponent(value)}&sig=${sign(key, value)}`;
    for (const value of ['http://cdn.example/f.mp4', 'https://127.0.0.1/f.mp4', 'https://localhost/f.mp4', 'https://box.local/f.mp4', 'https://cdn.example:8443/f.mp4']) {
      assert.equal((await fetch(signed(value))).status, 400, value);
    }
    assert.throws(() => checkTarget('https://cdn.example:8443/f.mp4', false), /port/);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.signed, true);
    assert.equal(health.host, 'node');
    assert.match(await (await fetch(base)).text(), /Troy relay/);
  } finally {
    relay.close();
    await new Promise((resolve) => relay.close(resolve));
  }
});

test('the relay refuses to start without a usable secret, and says why', async () => {
  // Exit 78 (EX_CONFIG) rather than 1: a panel showing "crashed" is what sent the
  // operator looking in the wrong place last time.
  const { spawnSync } = require('node:child_process');
  const run = (env) => spawnSync(process.execPath, [path.join(__dirname, 'troy-relay-server.js')], {
    cwd: __dirname,
    env: { ...process.env, TROY_RELAY_KEY: '', PORT: '4199', ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
  const missing = run({});
  assert.equal(missing.status, 78, 'no key is a configuration refusal, not a crash');
  assert.match(missing.stderr, /TROY_RELAY_KEY is not set/);
  assert.match(missing.stderr, /open proxy/, 'and it says why refusing matters');
  const short = run({ TROY_RELAY_KEY: 'abc' });
  assert.equal(short.status, 78);
  assert.match(short.stderr, /too short \(3 characters\)/);
});

test('the relay can be started from a host entry file that already runs', async () => {
  const port = await freePort();
  // A panel that launches one file is the reason this exists: no second process,
  // no MAIN_FILE change. require(...).start() must come up and answer /health.
  const { spawn, spawnSync } = require('node:child_process');
  const entry = path.join(__dirname, 'tmp-entry-check.js');
  require('node:fs').writeFileSync(entry, "require('./troy-relay-server').start();\n");
  const child = spawn(process.execPath, [entry], {
    cwd: __dirname,
    env: { ...process.env, TROY_RELAY_KEY: 'entry-check-key-'.padEnd(32, 'e'), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const started = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      child.stdout.on('data', (chunk) => {
        if (/listening/.test(String(chunk))) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    assert.ok(started, 'start() announced itself');
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.signed, true);
    assert.equal(health.host, 'node');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('close', resolve));
    require('node:fs').rmSync(entry, { force: true });
  }
});

test('the relay says so when its port is already taken, instead of looping', async () => {
  const port = await freePort();
  const { spawn, spawnSync } = require('node:child_process');
  const net = require('node:net');
  const blocker = net.createServer(() => {});
  blocker.listen(port, '127.0.0.1');
  await once(blocker, 'listening');
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'troy-relay-server.js')], {
      cwd: __dirname,
      env: { ...process.env, TROY_RELAY_KEY: 'port-check-key-'.padEnd(32, 'p'), PORT: String(port), TROY_RELAY_HOST: '127.0.0.1' },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already in use/);
    assert.match(result.stderr, /already running/, 'and tells the operator to check before changing anything');
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('the relay listens on the port the panel assigned, never an invented one', async () => {
  const { detectPort } = require('./troy-relay-server');
  // Every name a panel might use. The value is what matters, not the spelling.
  assert.deepEqual(detectPort({ PORT: '57395' }), { port: 57395, from: 'PORT' });
  assert.deepEqual(detectPort({ SERVER_PORT: '57395' }), { port: 57395, from: 'SERVER_PORT' });
  assert.deepEqual(detectPort({ TROY_RELAY_PORT: '57395' }), { port: 57395, from: 'TROY_RELAY_PORT' });
  assert.deepEqual(detectPort({ TROY_PUBLIC_URL: 'http://node17.botkeep.cloud:57395' }), { port: 57395, from: 'TROY_PUBLIC_URL (its port)' });
  // PORT wins over the others, because that is the one the panel routes.
  assert.equal(detectPort({ PORT: '57395', TROY_RELAY_PORT: '4180' }).port, 57395);
  // Nothing assigned is null, not a guess.
  assert.equal(detectPort({}), null);
  assert.equal(detectPort({ PORT: '', SERVER_PORT: 'x' }), null);
  assert.equal(detectPort({ PORT: '70000' }), null, 'out of range');
  assert.equal(detectPort({ TROY_PUBLIC_URL: 'http://node17.botkeep.cloud' }), null, 'no port in the URL');

  // And the refusal is exit 78 with the panel's own example, not a silent 4180.
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'troy-relay-server.js')], {
    cwd: __dirname,
    env: { ...process.env, PORT: '', SERVER_PORT: '', TROY_RELAY_PORT: '', TROY_PUBLIC_URL: '', RELAY_URL: '', CINEMA_RELAY_URL: '', TROY_RELAY_KEY: 'port-check-key-'.padEnd(32, 'q') },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /no port was assigned/);
  assert.match(result.stderr, /57395/, 'and points at the panel, using its own example');
});

// Ports are fixed so the assertions are exact. Parallel test files in this suite
// run at once, so a busy port would be a flake rather than a bug in the relay.
test('the relay reads the panel .env file, which is the only place the panel puts variables', async () => {
  const port = await freePort();
  // Botkeep writes CINEMA_PASSWORD / PORT / TROY_RELAY_KEY to .env inside the
  // container and exports nothing. A relay that only looked at process.env said
  // "TROY_RELAY_KEY is not set" while the key was sitting in that file.
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'troy-env-'));
  fs.writeFileSync(require('node:path').join(dir, '.env'), [
    '# written by the panel',
    'CINEMA_PASSWORD=kunsauka123456789',
    `PORT=${port}`,
    `TROY_RELAY_KEY=${'panel-env-key-'.padEnd(32, 'e')}`,
  ].join('\n'));
  const child = spawn(process.execPath, [path.join(__dirname, 'troy-relay-server.js')], {
    cwd: dir,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PORT', 'TROY_RELAY_KEY', 'SERVER_PORT', 'TROY_RELAY_PORT'].includes(key))),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const output = await new Promise((resolve) => {
      let text = '';
      const timer = setTimeout(() => resolve(text), 8000);
      child.stdout.on('data', (chunk) => {
        text += String(chunk);
        if (/listening/.test(text)) {
          clearTimeout(timer);
          resolve(text);
        }
      });
      child.stderr.on('data', (chunk) => {
        text += String(chunk);
      });
    });
    assert.match(output, new RegExp(`listening: 0\\.0\\.0\\.0:${port}`), `output was:\n${output}`);
    assert.match(output, /port from PORT/, 'and it says the value came from the file');
    assert.match(output, /secret:    set/, 'the key was found without being exported');
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.signed, true);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('close', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real environment value still wins over the file', async () => {
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'troy-env2-'));
  fs.writeFileSync(require('node:path').join(dir, '.env'), 'TROY_RELAY_KEY=from-the-file-1234567890\nPORT=4195\n');
  try {
    // No port in the environment: the file's port is used, and the run fails for
    // the port already being... nothing. Just check the parse, quickly.
    const result = spawnSync(process.execPath, ['-e', `
      require(${JSON.stringify(path.join(__dirname, 'troy-relay-server.js'))});
      console.log(JSON.stringify({ key: process.env.TROY_RELAY_KEY, port: process.env.PORT }));
    `], { cwd: dir, env: { ...process.env, TROY_RELAY_KEY: 'from-the-environment-123456', PORT: '' }, encoding: 'utf8', timeout: 15000 });
    assert.match(result.stdout, /from-the-environment/, 'an exported value is not overwritten');
    assert.doesNotMatch(result.stdout, /from-the-file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
