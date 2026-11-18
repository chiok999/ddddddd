'use strict';
// Two routes to the same bytes, chosen automatically.
//
// A CDN can refuse this server's address (426) while accepting Cloudflare's, and
// Cloudflare's shared egress can be rate-limited for one title while this
// server's address is not. Which one is true changes per host and per minute, so
// asking the operator to choose is asking them to guess. This tries the route
// that is expected to work, and when it fails for a reason that might be about
// the route rather than the file, tries the other one.
//
// Everything here is about *route* failures. A 404 or a 403 means this route and
// every other route would get the same answer, so the second route is not tried
// and the real status reaches the player unchanged.

// Statuses that say something about the path to the file, not the file.
const ROUTE_FAILURES = new Set([426, 427, 428, 429, 451, 502, 503, 504]);
// Below this, no second attempt: a body that already started streaming cannot be
// replayed from the other route without a hole in it.
const REPLAYABLE = true;

function describe(error) {
  return String(error?.message || error).slice(0, 120);
}

// Whether a thrown error says "this path is unhealthy" rather than "this file is
// unavailable or this request is invalid". Everything that reaches here has
// already survived safeUrl and DNS pinning, so a plain transport failure -- no
// route to the host, TLS refused, the Worker unreachable -- is about the path.
// A status error is about the file, and only the route-failure statuses count.
function isRouteFailure(error) {
  if (!error) return false;
  if (error.routeStatus !== undefined) return ROUTE_FAILURES.has(error.routeStatus);
  const status = Number(error.status);
  if (Number.isInteger(status) && status >= 400) return ROUTE_FAILURES.has(status);
  // No status at all: thrown by fetch itself, i.e. nothing answered.
  return true;
}

/**
 * @param {object} options
 * @param {Function} options.direct  `(url, headers, signal) => Response`
 * @param {Function|null} options.relay
 * @param {string[]} [options.order]  preferred order, e.g. ['relay','direct']
 * @param {boolean} [options.remember] keep the winning route per host for a while
 */
function createRouter({ direct, relay, order = ['relay', 'direct'], remember = true, now = Date.now, ttlMs = 10 * 60 * 1000 } = {}) {
  const routes = { direct, relay };
  const usable = order.filter((name) => typeof routes[name] === 'function');
  // host -> { name, at }. A memory, not a lock: it only decides which route is
  // asked first.
  const preference = new Map();
  const lastUsed = new Map();
  const log = [];

  function preferredFor(host) {
    if (!remember) return usable;
    const chosen = preference.get(host);
    if (chosen && now() - chosen.at < ttlMs && usable.includes(chosen.name)) {
      return [chosen.name, ...usable.filter((name) => name !== chosen.name)];
    }
    return usable;
  }

  function remember0(host, name) {
    lastUsed.set(host, { name, at: now() });
    if (!remember) return;
    const current = preference.get(host);
    if (!current || current.name !== name) preference.set(host, { name, at: now() });
  }

  /**
   * @param {string} url
   * @param {object} headers
   * @param {AbortSignal} signal
   * @param {{replay?: boolean}} [options]
   */
  async function remote(url, headers, signal, options = {}) {
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return '';
      }
    })();
    const attempts = [];
    const sequence = preferredFor(host);
    for (let index = 0; index < sequence.length; index++) {
      const name = sequence[index];
      try {
        const response = await routes[name](url, headers, signal);
        // A route failure is not final: the other route may be the one the CDN
        // is currently accepting, and the body has not been read yet.
        if (index < sequence.length - 1 && ROUTE_FAILURES.has(response.status) && options.replay !== false && REPLAYABLE) {
          await response.body?.cancel().catch(() => {});
          attempts.push(`${name}:${response.status}`);
          lastUsed.set(host, { name: null, at: now() });
          continue;
        }
        if (!ROUTE_FAILURES.has(response.status)) remember0(host, name);
        if (attempts.length) response.routeTrail = attempts.concat(`${name}:${response.status}`);
        return response;
      } catch (error) {
        if (signal?.aborted) throw error;
        const retryable = isRouteFailure(error);
        attempts.push(`${name}:!${describe(error)}`);
        if (index < sequence.length - 1 && retryable) continue;
        // Report which routes were tried; a single failing route with no
        // alternative must still say why.
        const suffix = attempts.length > 1 ? ` (tried ${attempts.join(', ')})` : '';
        throw Error(`${describe(error)}${suffix}`);
      }
    }
    // Every route reported a route failure. Return the last one's status so the
    // player shows a real code rather than a generic failure.
    const last = attempts.at(-1) || '';
    throw Object.assign(Error(`No route could fetch this source (${attempts.join(', ')})`), {
      routeStatus: Number(/:(4\d\d|5\d\d)$/.exec(last)?.[1]) || 502,
    });
  }

  /**
   * Ask each distinct host once, in parallel, and learn which route answers.
   * Small reads only: the request stops as soon as headers arrive.
   */
  async function prefetch(urls = [], signal = AbortSignal.timeout(8000)) {
    const hosts = [...new Set(urls.map((url) => {
      try {
        return new URL(url).hostname;
      } catch {
        return null;
      }
    }).filter(Boolean))].slice(0, 6);
    await Promise.all(hosts.map(async (host) => {
      const url = urls.find((candidate) => {
        try {
          return new URL(candidate).hostname === host;
        } catch {
          return false;
        }
      });
      try {
        const response = await remote(url, { 'accept-encoding': 'identity', range: 'bytes=0-0' }, signal);
        await response.body?.cancel().catch(() => {});
      } catch { /* prefetch only improves the odds; it never fails a resolve */ }
    }));
  }

  remote.status = () => ({
    order: usable,
    working: [...lastUsed.entries()].map(([host, value]) => ({ host, route: value.name, at: value.at })),
    relayConfigured: typeof relay === 'function',
  });
  remote.log = () => log.slice();
  remote.preferredFor = preferredFor;
  return { remote, prefetch, status: remote.status, preferredFor };
}

module.exports = { createRouter, ROUTE_FAILURES, isRouteFailure };
