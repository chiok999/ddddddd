'use strict';
// Client for the Cloudflare relay in ./worker/troy-relay.mjs.
//
// Why this exists: some provider CDNs answer 426 to this machine's address for
// every header, protocol and retry (measured -- see troy-426.js). The refusal
// belongs to the address, not the request, so the bytes have to be read from a
// different one. A Worker does that. Nothing about the browser changes: Troy is
// still the only origin the player talks to, and Troy still hands FFmpeg a
// stream.
//
// Only the four things that cannot be forwarded any other way travel in the
// query string: the target, its signature, the provider headers a browser
// cannot set, and the range. Everything else is a normal response.
const crypto = require('node:crypto');

const MIN_SECRET_LENGTH = 16;
// Mirrors the worker: these are the response headers that decide whether a
// stream is playable, addressable, and resumable.
const RESPONSE_HEADERS = {
  'content-type': 'x-troy-type',
  'content-length': 'x-troy-length',
  'content-range': 'x-troy-range',
  'content-encoding': 'x-troy-encoding',
  'etag': 'x-troy-etag',
  'last-modified': 'x-troy-modified',
  'accept-ranges': 'x-troy-accept-ranges',
};
// Marks a response the worker retried and still saw rate-limited, so a slow
// source can be told apart from a blocked one without reading the status.
const RETRIED_HEADER = 'x-troy-retried';
// Statuses the relay reports as errors rather than as a response, so the route
// itself can be judged without waiting for a body.
const HEALTH_STATUSES = new Set([426, 427, 428, 429, 451, 502, 503, 504]);

/** Read the two settings that turn the relay on, or null when it is off. */
/**
 * Read the two settings. Unlike a strict config this does not throw: a panel
 * that lost its environment between restarts must not turn "the relay is
 * unconfigured" into "the server will not start".
 */
function relayStatus(env = process.env) {
  try {
    return { config: relayConfig(env), error: null };
  } catch (error) {
    return { config: null, error: String(error?.message || error) };
  }
}

function relayConfig(env = process.env) {
  const base = String(env.CINEMA_RELAY_URL || '').trim();
  if (!base) return null;
  const secret = String(env.CINEMA_RELAY_KEY || '');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw Error(`CINEMA_RELAY_KEY must be at least ${MIN_SECRET_LENGTH} characters when CINEMA_RELAY_URL is set`);
  }
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw Error('CINEMA_RELAY_URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:') throw Error('CINEMA_RELAY_URL must use https');
  if (parsed.username || parsed.password) throw Error('CINEMA_RELAY_URL must not contain credentials');
  const path = parsed.pathname.replace(/\/+$/, '');
  return { origin: parsed.origin, path, secret };
}

function sign(secret, target) {
  return crypto.createHmac('sha256', secret).update(target).digest('hex');
}

/**
 * The URL the server asks the worker for. Deterministic, so a test can assert
 * on it without a network: same inputs, same string.
 */
function relayUrl(config, target, context = {}) {
  const params = new URLSearchParams();
  params.set('url', target);
  params.set('sig', sign(config.secret, target));
  // Artifact mode: the worker answers 200 and reports the CDN's real status in
  // a header, so a CDN 426 stays distinguishable from a relay fault.
  params.set('art', '1');
  if (context.referer) params.set('r', context.referer);
  if (context.origin) params.set('o', context.origin);
  if (context.userAgent) params.set('u', context.userAgent);
  if (context.accept) params.set('accept', context.accept);
  if (context.range) params.set('range', context.range);
  if (context.ifRange) params.set('ifrange', context.ifRange);
  return `${config.origin}${config.path}/?${params}`;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? null : headers[key];
}

/** A response whose headers read like the CDN's own, because callers expect that. */
function relayResponse(response, status) {
  const values = new Map();
  for (const [name, artifact] of Object.entries(RESPONSE_HEADERS)) {
    const value = response.headers.get(artifact);
    if (value !== null) values.set(name, value);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: {
      get: (name) => values.get(String(name).toLowerCase()) ?? null,
      has: (name) => values.has(String(name).toLowerCase()),
      forEach: (callback) => values.forEach((value, name) => callback(value, name)),
    },
    body: response.body,
    url: response.url,
    relayed: true,
    retried: response.headers.get(RETRIED_HEADER) === 'exhausted',
  };
}

/**
 * Wrap a direct `remote(url, headers, signal) => Response` with the relay.
 *
 * @param {object} options
 * @param {object|null} options.config         from relayConfig(); null = relay off
 * @param {Function} options.send              (url, headers, signal) => Response, e.g. undici fetch
 * @param {Function} options.direct            the existing direct remote, used only when asked
 * @param {boolean} [options.fallback]         try direct when the relay itself fails
 */
function createRelayRemote({ config, send, direct, fallback = false }) {
  if (!config) return direct;
  return async function relayRemote(url, headers, signal) {
    const target = String(url);
    const request = relayUrl(config, target, {
      referer: headerValue(headers, 'referer'),
      origin: headerValue(headers, 'origin'),
      userAgent: headerValue(headers, 'user-agent'),
      accept: headerValue(headers, 'accept'),
      range: headerValue(headers, 'range'),
      ifRange: headerValue(headers, 'if-range'),
    });
    let response;
    try {
      response = await send(request, { accept: 'application/octet-stream' }, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (fallback && direct) return direct(url, headers, signal);
      throw Error(`Relay unreachable (${String(error?.message || error).slice(0, 120)})`);
    }
    if (response.status !== 200) {
      // The worker only answers non-200 for its own problems: bad signature,
      // rejected target, or a total failure to reach the CDN.
      const text = await response.text().catch(() => '');
      if (response.status === 502 && fallback && direct) return direct(url, headers, signal);
      let detail = text;
      try {
        detail = JSON.parse(text).error || text;
      } catch { /* keep the raw body */ }
      throw Error(`Relay error ${response.status}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`);
    }
    const status = Number(response.headers.get('x-troy-status'));
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      await response.body?.cancel().catch(() => {});
      throw Error('Relay returned no upstream status');
    }
    // Health problems are thrown with the real status attached, so a caller can
    // tell "this route is unhealthy, try another" from "this file is gone".
    // The router decides which of those it is; nothing needs the body.
    if (HEALTH_STATUSES.has(status)) {
      await response.body?.cancel().catch(() => {});
      const error = Error(`Relay upstream returned ${status}`);
      error.status = status;
      error.relayFailure = true;
      throw error;
    }
    return relayResponse(response, status);
  };
}

module.exports = { relayConfig, relayStatus, relayUrl, sign, createRelayRemote, relayResponse, MIN_SECRET_LENGTH, RETRIED_HEADER, HEALTH_STATUSES };
