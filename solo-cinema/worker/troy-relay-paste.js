// ===========================================================================
// TROY RELAY -- Cloudflare Worker (single file, nothing to install)
//
// 1. Cloudflare -> Workers & Pages -> Create -> Worker
//    name it: troy-relay        (your preview shows troy-relay.troykunsauka6)
// 2. Deploy the Hello World it gives you.
// 3. Edit code -> select everything -> paste THIS ENTIRE FILE -> Deploy.
// 4. Settings -> Variables and Secrets -> Add -> type SECRET
//      name:  RELAY_KEY
//      value: <your RELAY_KEY on one line>  (generated and given to you separately)
// 5. Open https://troy-relay.troykunsauka6.workers.dev/health
//      must show  {"ok":true,...,"signed":true}
//    signed:false  ->  the secret is missing or named differently.
//
// Then on the panel, in Troy's environment:
//      CINEMA_RELAY_URL=https://troy-relay.troykunsauka6.workers.dev
//      CINEMA_RELAY_KEY=<the same secret>
//
// The worker only answers requests signed with RELAY_KEY, so nobody else can
// use it. It streams the body, so file size does not matter.
// ===========================================================================

const VERSION = '1';
// A browser is what these CDNs expect. Only a default: an explicit u= wins.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PASS_THROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'content-encoding',
  'etag',
  'last-modified',
  'accept-ranges',
];

function json(status, message) {
  return new Response(JSON.stringify(message), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

// One line of cleanup for every header value we accept from the query string:
// a header value cannot contain CR or LF, and a signed link may carry anything.
function clean(value) {
  return typeof value === 'string' && value ? value.replace(/[\r\n]+/g, ' ').trim() : null;
}

function isIpLiteral(host) {
  // The URL parser canonicalises IPv4 forms (0x7f.1, 2130706433) to dotted
  // quad before we see them, so a dotted test is enough for IPv4.
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':');
}

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet'];

/**
 * Reject anything that is not a plain public HTTPS media URL. This is an open
 * proxy otherwise, and a signed URL leaks by accident sooner or later.
 */
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
    if (host === 'localhost' || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      throw new Error('Private hostnames are not allowed');
    }
    if (!host.includes('.')) throw new Error('Host is not a public name');
  }
  return url;
}

const keyCache = new Map();
function hmacKey(secret) {
  if (!keyCache.has(secret)) {
    keyCache.set(
      secret,
      crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    );
  }
  return keyCache.get(secret);
}

async function sign(secret, message) {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function equalHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/** Follow redirects here, because Troy cannot: it would leave the relay. */
async function upstream(target, headers, fetchUpstream, allowPrivate) {
  let current = target;
  let request = headers;
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetchUpstream(current, { method: 'GET', headers: request, redirect: 'manual' });
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location) throw new Error('Redirect without a location');
    const next = checkTarget(new URL(location, current).href, allowPrivate);
    if (next.origin !== new URL(current).origin) {
      // Credentials are for the origin they were issued for.
      request = new Headers(request);
      for (const name of ['authorization', 'proxy-authorization', 'cookie', 'cookie2']) request.delete(name);
    }
    current = next.href;
  }
  throw new Error('Too many redirects');
}

function passthroughHeaders(response) {
  const headers = new Headers({ 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  for (const name of PASS_THROUGH_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function artifactHeaders(response) {
  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'x-troy-status': String(response.status),
  });
  const mapping = {
    'content-type': 'x-troy-type',
    'content-length': 'x-troy-length',
    'content-range': 'x-troy-range',
    'content-encoding': 'x-troy-encoding',
    'etag': 'x-troy-etag',
    'last-modified': 'x-troy-modified',
    'accept-ranges': 'x-troy-accept-ranges',
  };
  for (const [from, to] of Object.entries(mapping)) {
    const value = response.headers.get(from);
    if (value) headers.set(to, value.replace(/[\r\n]+/g, ' '));
  }
  return headers;
}

const LANDING = `<!doctype html>
<meta charset="utf-8"><title>Troy relay</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111}
code{background:#f2f2f2;padding:.15em .35em;border-radius:4px}</style>
<h1>Troy relay is running</h1>
<p>This worker fetches media for Troy from Cloudflare&rsquo;s addresses instead of the server&rsquo;s.</p>
<p>It is not an open proxy: every request needs a signed <code>url</code>.</p>
<p>Health: <a href="/health">/health</a></p>`;

/**
 * @param {{secret?: string, allowPrivate?: boolean, fetch?: typeof fetch}} options
 * @returns {(request: Request) => Promise<Response>}
 */
export function createFetchHandler({ secret, allowPrivate = false, fetch: fetchUpstream = fetch } = {}) {
  return async function handle(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'range, if-range, accept',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-max-age': '86400',
        },
      });
    }
    if (request.method !== 'GET') return json(405, { error: 'Only GET is supported' });
    if (url.pathname === '/health' || url.searchParams.has('ping')) {
      return json(200, { ok: true, relay: 'troy', version: VERSION, signed: Boolean(secret) });
    }
    if (!url.searchParams.has('url')) {
      return new Response(LANDING, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (!secret) return json(500, { error: 'RELAY_KEY is not set on this worker' });

    const target = url.searchParams.get('url');
    const signature = url.searchParams.get('sig');
    // Verify before parsing: an unsigned request learns nothing.
    if (!equalHex(await sign(secret, target), signature)) {
      return json(403, { error: 'Bad signature' });
    }
    let parsed;
    try {
      parsed = checkTarget(target, allowPrivate);
    } catch (error) {
      return json(400, { error: error.message });
    }

    const params = url.searchParams;
    const headers = new Headers();
    // Identity only: Troy refuses a compressed body, because it cannot verify a
    // range against a stream it must decompress first.
    headers.set('accept-encoding', 'identity');
    headers.set('accept', clean(params.get('accept')) || 'application/octet-stream, video/*, */*');
    headers.set('user-agent', clean(params.get('u')) || BROWSER_UA);
    const referer = clean(params.get('r'));
    const origin = clean(params.get('o'));
    const range = clean(params.get('range'));
    const ifRange = clean(params.get('ifrange'));
    if (referer) headers.set('referer', referer);
    if (origin) headers.set('origin', origin);
    if (range) headers.set('range', range);
    if (ifRange) headers.set('if-range', ifRange);

    let response;
    try {
      response = await upstream(parsed.href, headers, fetchUpstream, allowPrivate);
    } catch (error) {
      // The worker could not reach the CDN at all. Report it as an upstream
      // failure so Troy shows one clear error instead of silently falling back
      // to its own blocked address.
      return json(502, { error: `Relay could not fetch the source (${String(error?.message || error).slice(0, 120)})` });
    }

    if (params.get('art') !== '1') {
      // Pass-through, for checking a link by hand. HEAD-like and empty
      // responses may not carry a body.
      const body = response.status === 204 || response.status === 304 ? null : response.body;
      return new Response(body, { status: response.status, headers: passthroughHeaders(response) });
    }

    // Artifact mode: always 200, truth in headers, bytes untouched.
    if (response.status === 204 || response.status === 304) {
      return new Response(null, { status: 200, headers: artifactHeaders(response) });
    }
    return new Response(response.body, { status: 200, headers: artifactHeaders(response) });
  };
}

export default {
  async fetch(request, env) {
    return createFetchHandler({ secret: env?.RELAY_KEY })(request);
  },
};
