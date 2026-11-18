#!/usr/bin/env node
'use strict';
// Run the Cloudflare worker from worker/troy-relay.mjs on this machine, against
// a local fixture CDN, so the relay can be proven before it is deployed.
//
//   node troy-relay.js                        start the harness
//   node troy-relay.js --test                 run the assertions and exit
//   node troy-relay.js --worker-url <url>     also check a deployed worker
//
// Two servers are started:
//   :CDN_PORT  a stand-in provider CDN that answers 426 to any request without
//              a browser User-Agent, in both pass-through and artifact form,
//              and serves seekable bytes with the other.
//   :PORT      the worker itself, imported and driven through its real fetch
//              handler. This is the code you paste into Cloudflare.
//
// The same worker file runs on both, so what is proven here is what will run at
// the edge. Environment: CDN_PORT (default 3311), PORT (default 3312),
// RELAY_KEY (generated when absent, and printed so it can be set as the secret).
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const guard = require('./tool-guard');
if (guard.startServerIfPanelEntry('troy-relay.js', '--test')) process.exit(0);

const CDN_PORT = Number(process.env.CDN_PORT || 3311);
const PORT = Number(process.env.PORT || 3312);
const RELAY_KEY = process.env.RELAY_KEY || crypto.randomBytes(16).toString('hex');
const TEST = process.argv.includes('--test');
const deployedIndex = process.argv.indexOf('--worker-url');
const DEPLOYED = deployedIndex > -1 ? process.argv[deployedIndex + 1] : null;
const BROWSER = /Mozilla\/5\.0/;
const BODY = crypto.createHash('sha256').update('troy').digest().toString('hex').repeat(1024);

// ---------- fixture CDN ----------
// Deliberately reproduces the production symptom: address-based refusal of the
// unadorned request, acceptance of a browser-shaped one, and a real 206.
const cdn = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const base = { etag: '"fixture-v1"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT', 'accept-ranges': 'bytes' };
  if (!BROWSER.test(req.headers['user-agent'] || '')) {
    res.writeHead(426, { ...base, 'content-type': 'text/plain', 'content-length': '7' });
    return res.end('upgrade');
  }
  if (url.pathname === '/missing') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  if (url.pathname === '/compressed') {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-encoding': 'gzip' });
    return res.end('not-really-gzip');
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] === '' ? BODY.length - 1 : Math.min(Number(range[2]), BODY.length - 1);
    if (start >= BODY.length || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${BODY.length}` });
      return res.end();
    }
    const slice = BODY.slice(start, end + 1);
    res.writeHead(206, { ...base, 'content-type': 'video/mp4', 'content-length': String(slice.length), 'content-range': `bytes ${start}-${end}/${BODY.length}` });
    return res.end(slice);
  }
  res.writeHead(200, { ...base, 'content-type': 'video/mp4', 'content-length': String(BODY.length) });
  res.end(BODY);
});

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${port}`)));
}

async function loadWorker() {
  const module = await import(pathToFileURL(path.join(__dirname, 'worker', 'troy-relay.mjs')).href);
  return module.createFetchHandler({ secret: RELAY_KEY, allowPrivate: true });
}

// relay.js returns a plain object that reads like a response, not an actual
// Response, so buffer both shapes through the same path.
async function read(response) {
  if (typeof response.arrayBuffer === 'function') return Buffer.from(await response.arrayBuffer());
  return Buffer.from(await new Response(response.body).arrayBuffer());
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function workerUrl(base, target, extra = {}) {
  const params = new URLSearchParams({ url: target, sig: hmac(RELAY_KEY, target), ...extra });
  return `${base}/?${params}`;
}

async function runAssertions(workerBase, cdnBase) {
  const { createRelayRemote } = require('./relay');
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `  -- ${detail}` : ''}`);
  };
  const worker = await loadWorker();
  // A handler with the deployed default, where only public HTTPS is allowed.
  const strict = (await import(pathToFileURL(path.join(__dirname, 'worker', 'troy-relay.mjs')).href)).createFetchHandler({ secret: RELAY_KEY });
  // The worker reaches the fixture CDN through the same global fetch it uses at
  // the edge; Node provides one.
  const call = (url) => worker(new Request(url));
  const direct = (target, extra = {}) => fetch(workerUrl(workerBase, target, extra));
  const source = `${cdnBase}/movie.mp4`;

  // 1. the symptom, reproduced
  const raw = await fetch(source);
  check('fixture CDN refuses a plain client with 426', raw.status === 426, `got ${raw.status}`);
  await raw.body?.cancel();

  // 2. unsigned requests learn nothing
  const unsigned = await call(`${workerBase}/?url=${encodeURIComponent(source)}`);
  check('unsigned request is rejected with 403', unsigned.status === 403, `got ${unsigned.status}`);

  // 3. a private target is refused even when correctly signed
  const privateTarget = 'http://127.0.0.1/secret';
  const privateResponse = await strict(new Request(`${workerBase}/?url=${encodeURIComponent(privateTarget)}&sig=${hmac(RELAY_KEY, privateTarget)}`));
  const privateBody = await privateResponse.json();
  check('loopback target refused by default', privateResponse.status === 400 && /HTTPS|IP address/.test(privateBody.error), JSON.stringify(privateBody));
  const privateName = 'https://box.local/movie.mp4';
  const privateNameResponse = await strict(new Request(`${workerBase}/?url=${encodeURIComponent(privateName)}&sig=${hmac(RELAY_KEY, privateName)}`));
  check('private hostname refused by default', privateNameResponse.status === 400, String(privateNameResponse.status));
  const ipLiteral = 'https://93.184.216.34/movie.mp4';
  const ipResponse = await strict(new Request(`${workerBase}/?url=${encodeURIComponent(ipLiteral)}&sig=${hmac(RELAY_KEY, ipLiteral)}`));
  check('plain IP target refused by default', ipResponse.status === 400, String(ipResponse.status));

  // 4. artifact mode: 200 from the worker, truth in headers, unmodified bytes
  const artifact = await direct(source, { art: '1' });
  const artifactBody = await read(artifact);
  check('artifact mode always answers 200', artifact.status === 200, `got ${artifact.status}`);
  check('artifact reports the upstream status', artifact.headers.get('x-troy-status') === '200', artifact.headers.get('x-troy-status'));
  check('artifact carries the upstream length', artifact.headers.get('x-troy-length') === String(BODY.length), artifact.headers.get('x-troy-length'));
  check('artifact carries the upstream etag', artifact.headers.get('x-troy-etag') === '"fixture-v1"', artifact.headers.get('x-troy-etag'));
  check('artifact body is byte-identical', artifactBody.length === BODY.length && artifactBody.equals(Buffer.from(BODY)), `${artifactBody.length} vs ${BODY.length}`);

  // 5. range requests survive the round trip, which is what seeking needs
  const ranged = await direct(source, { art: '1', range: 'bytes=100-199' });
  const rangedBody = await read(ranged);
  check('range request returns 206 and 100 bytes', ranged.headers.get('x-troy-status') === '206' && rangedBody.length === 100, `${ranged.headers.get('x-troy-status')} ${rangedBody.length}`);
  check('range content-range is intact', ranged.headers.get('x-troy-range') === `bytes 100-199/${BODY.length}`, ranged.headers.get('x-troy-range'));
  check('range bytes are the requested bytes', rangedBody.equals(Buffer.from(BODY.slice(100, 200))));
  const openRange = await direct(source, { art: '1', range: 'bytes=1000-' });
  const openBody = await read(openRange);
  check('open-ended range works', openRange.headers.get('x-troy-status') === '206' && openBody.length === BODY.length - 1000, `${openBody.length}`);
  const ifRange = await direct(source, { art: '1', range: 'bytes=0-9', ifrange: '"fixture-v1"' });
  check('if-range is forwarded', ifRange.headers.get('x-troy-status') === '206', ifRange.headers.get('x-troy-status'));

  // 6. pass-through mode for checking a link by hand
  const passed = await direct(source);
  check('pass-through keeps the real upstream status', passed.status === 200, `got ${passed.status}`);
  await passed.body?.cancel();
  const passedRange = await direct(source, { range: 'bytes=0-4' });
  check('pass-through keeps 206', passedRange.status === 206, `got ${passedRange.status}`);
  await passedRange.body?.cancel();

  // 7. an upstream error is reported, not hidden
  const missing = await direct(`${cdnBase}/missing`, { art: '1' });
  check('upstream 404 is preserved in the artifact header', missing.headers.get('x-troy-status') === '404', missing.headers.get('x-troy-status'));
  await missing.body?.cancel();

  // 8. a compressed body is visible as such, so Troy can refuse it
  const compressed = await direct(`${cdnBase}/compressed`, { art: '1' });
  check('content-encoding is visible to Troy', compressed.headers.get('x-troy-encoding') === 'gzip', compressed.headers.get('x-troy-encoding'));
  await compressed.body?.cancel();

  // 9. the client in relay.js reads that as an ordinary Response
  const config = { origin: workerBase, path: '', secret: RELAY_KEY };
  const send = (url, extra) => fetch(url, { headers: extra });
  const remote = createRelayRemote({ config, send, direct: null });
  const viaRelay = await remote(source, { 'accept-encoding': 'identity', range: 'bytes=0-9' }, undefined);
  const viaBody = await read(viaRelay);
  check('relay.js exposes 206 as a normal status', viaRelay.status === 206, String(viaRelay.status));
  check('relay.js exposes content-range', viaRelay.headers.get('content-range') === `bytes 0-9/${BODY.length}`, viaRelay.headers.get('content-range'));
  check('relay.js exposes content-length', viaRelay.headers.get('content-length') === '10', viaRelay.headers.get('content-length'));
  check('relay.js body is the 10 requested bytes', viaBody.length === 10 && viaBody.equals(Buffer.from(BODY.slice(0, 10))));

  // 10. a worker that is not there is one clear error, not a silent retry storm
  let relayDown = null;
  try {
    const dead = createRelayRemote({ config: { origin: 'http://127.0.0.1:1', path: '', secret: RELAY_KEY }, send: (url) => fetch(url), direct: null });
    await dead(source, {}, undefined);
  } catch (error) {
    relayDown = error.message;
  }
  check('an unreachable relay produces one clear error', /Relay unreachable/.test(relayDown || ''), relayDown);

  // 11. a rate limit is waited out by the deployed worker, not reported
  let limited = 0;
  const polite = http.createServer((req, res) => {
    limited++;
    if (limited <= 2) {
      res.writeHead(427, { 'content-type': 'text/plain' });
      return res.end('rate limited');
    }
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes 0-1/${BODY.length}`, 'content-length': '2' });
    res.end(BODY.slice(0, 2));
  });
  const politeBase = await listen(polite, 3313);
  try {
    const startWait = Date.now();
    const response = await direct(`${politeBase}/movie.mp4`, { art: '1', range: 'bytes=0-1' });
    const elapsed = Date.now() - startWait;
    check('427 is retried inside the worker', response.headers.get('x-troy-status') === '206', response.headers.get('x-troy-status'));
    check('the retry waited instead of hammering', elapsed >= 400, `${elapsed}ms`);
    await response.body?.cancel();
  } finally {
    polite.closeAllConnections?.();
    await new Promise((resolve) => polite.close(resolve));
  }

  // 12. a bad signature fails closed through the client too
  let badSignature = null;
  try {
    const wrong = createRelayRemote({ config: { origin: workerBase, path: '', secret: 'x'.repeat(32) }, send, direct: null });
    await wrong(source, {}, undefined);
  } catch (error) {
    badSignature = error.message;
  }
  check('a wrong shared secret fails with 403', /403/.test(badSignature || ''), badSignature);

  // 13. the deployed worker, if one was named
  if (DEPLOYED) {
    const health = await fetch(`${DEPLOYED.replace(/\/$/, '')}/health`);
    const healthBody = await health.json();
    check('deployed worker answers /health', health.status === 200 && healthBody.signed === true, JSON.stringify(healthBody));
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0;
}

(async () => {
  const cdnBase = await listen(cdn, CDN_PORT);
  const worker = await loadWorker();
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request(`http://relay.local${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const response = await worker(request);
      const headers = {};
      response.headers.forEach((value, name) => { headers[name] = value; });
      res.writeHead(response.status, headers);
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once('drain', resolve));
          }
        } catch { /* the client hung up; the response is already committed */ }
      }
      res.end();
    } catch (error) {
      // A response already committed cannot be turned into an error page.
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message || error) }));
      } else res.destroy();
    }
  });
  const workerBase = await listen(server, PORT);
  console.log(`relay harness\n  fixture CDN  ${cdnBase}\n  worker       ${workerBase}\n  RELAY_KEY    ${RELAY_KEY}\n`);
  if (TEST) {
    const ok = await runAssertions(workerBase, cdnBase);
    server.close(); cdn.close();
    process.exit(ok ? 0 : 1);
  }
  console.log('  Try a source by hand:');
  console.log(`    node -e "const c=require('./relay');const {relayUrl}=c;console.log(relayUrl({origin:'${workerBase}',path:'',secret:'${RELAY_KEY}'},'${cdnBase}/movie.mp4',{range:'bytes=0-99'}))"`);
  console.log('  Press Ctrl-C to stop.');
})();
