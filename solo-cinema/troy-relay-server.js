#!/usr/bin/env node
'use strict';
// Troy relay for bot-keep.
//
// bot-keep is already an address the provider CDNs accept, so it only has to
// fetch and hand over bytes. It is not the app: no database, no FFmpeg, no disk,
// no media kept in memory. Each request opens the CDN, streams the response out
// and forgets it. Memory use is one chunk at a time.
//
// RUN IT WITH NODE. A panel that says `troy-relay-server.js: not found` (exit
// code 127) ran the file as if it were a program: either the file is not in the
// directory the panel runs from, or the panel used `./troy-relay-server.js`
// instead of an interpreter. Use:
//
//   node troy-relay-server.js
//
// Exit codes on purpose:
//   0    stopped on a signal
//   1    an exception
//   78   no TROY_RELAY_KEY, or too short. Refusing to start is the point: an
//        unsigned relay is an open proxy. (EX_CONFIG)
//
//   TROY_RELAY_KEY=<the same secret Troy uses> node troy-relay-server.js
//
// Options (all optional):
//   PORT / TROY_RELAY_PORT=4180   listen port
//   TROY_RELAY_HOST=0.0.0.0       listen address
//   TROY_RELAY_ALLOW_PRIVATE=1    allow private/plain-http targets (tests only)
//
// The contract is ./worker/troy-relay.mjs. It is the same protocol, so a URL
// signed for the Cloudflare Worker works here unchanged and the same
// CINEMA_RELAY_KEY works for both.
//
// No dependencies -- not undici, not axios, nothing from npm -- so it runs on any
// Node 18+ the bot host already has.
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const VERSION = '1';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// A rate limit, not a refusal. Waiting and asking again is the documented cure.
const RATE_LIMITED = new Set([427, 429]);
const RETRY_DELAYS_MS = [400, 900, 1800, 3000];
const RETRY_BUDGET_MS = 12000;
const PASS_THROUGH_HEADERS = ['content-type', 'content-length', 'content-range', 'content-encoding', 'etag', 'last-modified', 'accept-ranges'];
const MIN_SECRET_LENGTH = 16;

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet'];
const isIpLiteral = (host) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':');

function checkTarget(value, allowPrivate) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.href.length > 8192) throw new Error('URL is too long');
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed');
  if (!allowPrivate) {
    if (url.protocol !== 'https:') throw new Error('Only HTTPS sources are allowed');
    if (url.port && url.port !== '443') throw new Error('Only the default HTTPS port is allowed');
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host) throw new Error('Missing host');
    if (host.length > 253) throw new Error('Host is too long');
    if (isIpLiteral(host)) throw new Error('IP address sources are not allowed');
    if (host === 'localhost' || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw new Error('Private hostnames are not allowed');
    if (!host.includes('.')) throw new Error('Host is not a public name');
  }
  return url;
}

const sign = (secret, message) => crypto.createHmac('sha256', secret).update(message).digest('hex');

function equalHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

const clean = (value) => (typeof value === 'string' && value ? value.replace(/[\r\n]+/g, ' ').trim() : null);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One GET, no redirect following, no decompression. Streams; never buffers. */
function requestOnce(target, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers,
        // A provider CDN behind its own CDN is common; the certificate is still
        // validated against the hostname we asked for.
        servername: url.hostname,
        timeout: 30000,
      },
      (response) => {
        const lowered = {};
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) lowered[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
        resolve({ status: response.statusCode || 0, headers: lowered, stream: response, raw: response });
      }
    );
    request.on('timeout', () => request.destroy(new Error('Upstream timed out')));
    request.on('error', reject);
    request.end();
  });
}

function retryAfterMs(headers) {
  const value = headers['retry-after'];
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 10000) : null;
}

/** Follow redirects here, because Troy cannot: it would leave the relay. */
async function upstream(target, headers, allowPrivate) {
  let current = target;
  let requestHeaders = headers;
  let waited = 0;
  let attempt = 0;
  for (let hop = 0; hop <= 5; hop++) {
    let response = await requestOnce(current, requestHeaders);
    while (RATE_LIMITED.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
      const delay = retryAfterMs(response.headers) ?? RETRY_DELAYS_MS[attempt];
      if (waited + delay > RETRY_BUDGET_MS) break;
      response.raw.resume();
      await sleep(delay);
      waited += delay;
      attempt++;
      response = await requestOnce(current, requestHeaders);
    }
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.location;
    response.raw.resume();
    if (!location) throw new Error('Redirect without a location');
    const next = checkTarget(new URL(location, current).href, allowPrivate);
    if (next.origin !== new URL(current).origin) {
      requestHeaders = { ...requestHeaders };
      for (const name of ['authorization', 'proxy-authorization', 'cookie', 'cookie2']) delete requestHeaders[name];
    }
    current = next.href;
  }
  throw new Error('Too many redirects');
}

const LANDING = `<!doctype html>
<meta charset="utf-8"><title>Troy relay</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111}
code{background:#f2f2f2;padding:.15em .35em;border-radius:4px}</style>
<h1>Troy relay is running</h1>
<p>This host fetches media for Troy so the CDN sees an address it accepts.</p>
<p>It is not an open proxy: every request needs a signed <code>url</code>.</p>
<p>Health: <a href="/health">/health</a></p>`;

const json = (status, message, extra = {}) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...extra },
  body: JSON.stringify(message),
});

/**
 * @param {{secret?: string, allowPrivate?: boolean, log?: Function}} options
 */
function createRelayServer({ secret, allowPrivate = false, log = () => {} } = {}) {
  return http.createServer(async (request, response) => {
    const reply = (result) => {
      response.writeHead(result.status, result.headers);
      if (result.stream) {
        // A CDN that hangs up mid-body must close this response too, not leave a
        // half-sent body that the player reads as corruption.
        result.stream.on('error', () => response.destroy());
        result.stream.on('aborted', () => response.destroy());
        response.on('close', () => result.stream.destroy());
        result.stream.pipe(response);
      } else response.end(result.body ?? '');
    };
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'local'}`);
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'range, if-range, accept, x-troy-sig',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-max-age': '86400',
        });
        return response.end();
      }
      if (request.method !== 'GET') return reply(json(405, { error: 'Only GET is supported' }));
      if (url.pathname === '/health' || url.searchParams.has('ping')) {
        return reply(json(200, { ok: true, relay: 'troy', version: VERSION, signed: Boolean(secret), host: 'node' }));
      }
      if (!url.searchParams.has('url')) {
        return reply({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: LANDING });
      }
      if (!secret) return reply(json(500, { error: 'TROY_RELAY_KEY is not set on this relay' }));

      const target = url.searchParams.get('url');
      // The signature comes from the query (https, Worker-compatible) or from a
      // header (plain HTTP, so the shared key is never in a URL).
      const presented = url.searchParams.get('sig') || String(request.headers['x-troy-sig'] || '');
      if (!equalHex(sign(secret, target), presented)) return reply(json(403, { error: 'Bad signature' }));
      let parsed;
      try {
        parsed = checkTarget(target, allowPrivate);
      } catch (error) {
        return reply(json(400, { error: error.message }));
      }

      const params = url.searchParams;
      const headers = {
        'accept-encoding': 'identity',
        accept: clean(params.get('accept')) || 'application/octet-stream, video/*, */*',
        'user-agent': clean(params.get('u')) || BROWSER_UA,
      };
      const referer = clean(params.get('r'));
      const origin = clean(params.get('o'));
      const range = clean(params.get('range'));
      const ifRange = clean(params.get('ifrange'));
      if (referer) headers.referer = referer;
      if (origin) headers.origin = origin;
      if (range) headers.range = range;
      if (ifRange) headers['if-range'] = ifRange;

      let result;
      try {
        result = await upstream(parsed.href, headers, allowPrivate);
      } catch (error) {
        log(`upstream failed: ${String(error?.message || error).slice(0, 160)}`);
        return reply(json(502, { error: `Relay could not fetch the source (${String(error?.message || error).slice(0, 120)})` }));
      }

      const contentType = result.headers['content-type'] || 'application/octet-stream';
      if (params.get('art') !== '1') {
        const passthrough = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
        for (const name of PASS_THROUGH_HEADERS) if (result.headers[name]) passthrough[name] = result.headers[name];
        return reply({ status: result.status, headers: passthrough, stream: result.status === 204 || result.status === 304 ? null : result.stream });
      }

      // Artifact mode: always 200, the truth in headers, bytes untouched.
      const artifact = {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'x-troy-status': String(result.status),
      };
      const mapping = {
        'content-type': 'x-troy-type',
        'content-length': 'x-troy-length',
        'content-range': 'x-troy-range',
        'content-encoding': 'x-troy-encoding',
        etag: 'x-troy-etag',
        'last-modified': 'x-troy-modified',
        'accept-ranges': 'x-troy-accept-ranges',
      };
      for (const [from, to] of Object.entries(mapping)) {
        const value = result.headers[from];
        if (value) artifact[to] = String(value).replace(/[\r\n]+/g, ' ');
      }
      if (RATE_LIMITED.has(result.status)) artifact['x-troy-retried'] = 'exhausted';
      log(`${result.status} ${contentType} ${result.headers['content-length'] || '-'}${range ? ` range=${range}` : ''}`);
      return reply({ status: 200, headers: artifact, stream: result.status === 204 || result.status === 304 ? null : result.stream });
    } catch (error) {
      log(`relay error: ${String(error?.message || error).slice(0, 160)}`);
      if (!response.headersSent) return reply(json(500, { error: 'Relay failure' }));
      response.destroy();
    }
  });
}

/**
 * Start the relay. Exported and callable so a host that already has a process can
 * start it from its own entry file:
 *
 *   require('./troy-relay-server').start();
 *
 * That is the surest way around a panel that will only launch one file: no second
 * process, no second panel, no MAIN_FILE to change.
 */
function start({ port = Number(process.env.PORT || process.env.TROY_RELAY_PORT || 4180), host = process.env.TROY_RELAY_HOST || '0.0.0.0', key = process.env.TROY_RELAY_KEY || '' } = {}) {
  const allowPrivate = ['1', 'true', 'yes'].includes(String(process.env.TROY_RELAY_ALLOW_PRIVATE || '').toLowerCase());
  const log = (line) => console.log(`[relay] ${line}`);
  if (typeof key !== 'string' || key.length < MIN_SECRET_LENGTH) {
    console.error('Troy relay will not start.');
    console.error(`  TROY_RELAY_KEY is ${key ? `too short (${key.length} characters)` : 'not set'}.`);
    console.error(`  Set it to at least ${MIN_SECRET_LENGTH} characters -- the same value as Troy's CINEMA_RELAY_KEY.`);
    console.error('  An unsigned relay is an open proxy, so refusing to start is deliberate.');
    process.exitCode = 78;
    return null;
  }
  const server = createRelayServer({ secret: key, allowPrivate, log });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Troy relay cannot start: port ${port} is already in use on this container.`);
      console.error('  Another copy is probably already running. Check:');
      console.error(`    node -e "fetch('http://127.0.0.1:${port}/health').then(r=>r.text()).then(console.log)"`);
      console.error('  If that answers, this relay is already up and nothing is wrong.');
    } else console.error(`Troy relay failed to listen: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log('Troy relay is running');
    console.log(`  listening: ${host}:${port}`);
    console.log(`  secret:    set (${key.length} characters)`);
    console.log(`  health:    http://${shown}:${port}/health`);
    console.log('');
    console.log('  In Troy, on the other server:');
    console.log(`    CINEMA_RELAY_URL=${process.env.TROY_PUBLIC_URL || `http://<this host>:${port}`}`);
    console.log('    CINEMA_RELAY_KEY=<the same secret>');
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
  return server;
}

module.exports = { createRelayServer, checkTarget, sign, upstream, start };

if (require.main === module) start();
