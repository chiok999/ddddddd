'use strict';

/**
 * Process-level survival guards.
 *
 * A WhatsApp socket can be perfectly healthy and the bot still "disconnects
 * after some time" because the host went to sleep, an uptime monitor gave
 * up on it, or the process was OOM-killed by hours of unbounded caches.
 * These two guards cover that layer:
 *
 *   Keep-alive server — a tiny HTTP listener started before WhatsApp
 *   connects, with a `/health` route for the panel/uptime pinger and a
 *   periodic self-ping so an idle deployment keeps generating traffic.
 *   It only ever reports counts (connected accounts, uptime, memory) —
 *   never a phone number or session detail.
 *
 *   Memory watchdog — checks RSS on an interval; past the limit it asks
 *   the caller to shed caches and runs the GC when Node was started with
 *   `--expose-gc`. Shedding a cache is always cheaper than an OOM kill
 *   that drops every linked account at once.
 */

const http = require('http');
const https = require('https');

function sanitizedStatus(status) {
  const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
  const byState = {};
  for (const account of accounts) {
    const state = String(account?.state || 'unknown');
    byState[state] = (byState[state] || 0) + 1;
  }
  return {
    connectedAccounts: accounts.filter((account) => account?.state === 'connected').length,
    totalAccounts: accounts.length,
    byState,
  };
}

function startKeepAliveServer({
  ports = [5000, 3000, 8000, 4000],
  host = '0.0.0.0',
  status = null,
  log = console,
  selfPingUrl = '',
  selfPingIntervalMs = 240_000,
  startedAt = Date.now(),
} = {}) {
  let server = null;
  let boundPort = null;
  let pingTimer = null;
  let closed = false;

  const baseStatus = () => {
    let live = {};
    try { live = sanitizedStatus(typeof status === 'function' ? status() : null); } catch { live = {}; }
    return {
      ok: true,
      service: 'whatsapp',
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      memoryRssMb: Math.round(process.memoryUsage().rss / 1048576),
      ...live,
    };
  };

  function pingOnce() {
    if (closed || !boundPort) return;
    let target;
    try { target = new URL(selfPingUrl || `http://127.0.0.1:${boundPort}/health`); }
    catch { return; }
    if (!target.pathname || target.pathname === '/') target.pathname = '/health';
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.get(target, { timeout: 10_000 }, (response) => {
      response.resume();
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => { /* a failed self-ping is retried next cycle */ });
  }

  function startPinging() {
    if (pingTimer || !(selfPingIntervalMs > 0)) return;
    pingTimer = setInterval(pingOnce, Math.max(1000, Number(selfPingIntervalMs) || 240_000));
    pingTimer.unref?.();
  }

  const ready = (async () => {
    const candidates = [...new Set((ports || []).map((port) => Number(port)).filter((port) => Number.isInteger(port) && port >= 0 && port <= 65535))];
    for (const port of candidates) {
      if (closed) return null;
      const candidate = http.createServer((request, response) => {
        const url = String(request.url || '/').split('?')[0];
        if (request.method === 'GET' && (url === '/health' || url === '/health/details')) {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(JSON.stringify(baseStatus()));
          return;
        }
        if (request.method === 'GET' && url === '/') {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          response.end('WhatsApp service is running.\n');
          return;
        }
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: false, error: 'not found' }));
      });
      const listening = await new Promise((resolve) => {
        const onError = () => resolve(false);
        candidate.once('error', onError);
        candidate.listen(port, host, () => {
          candidate.removeListener('error', onError);
          resolve(true);
        });
      });
      if (!listening) continue;
      server = candidate;
      boundPort = Number(server.address()?.port || port);
      startPinging();
      return { port: boundPort };
    }
    try { log.warn?.('Keep-alive server could not bind any port; continuing without it.'); } catch { /* non-fatal */ }
    return null;
  })();

  function close() {
    closed = true;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (server) {
      try { server.close(); } catch { /* already closed */ }
      server = null;
    }
  }

  return {
    ready,
    close,
    port: () => boundPort,
    isListening: () => Boolean(server?.listening),
    pingOnce,
  };
}

function startMemoryWatchdog({
  intervalMs = 300_000,
  limitMb = Math.max(128, Number(process.env.BOT_RSS_LIMIT_MB || process.env.MEMORY_WARN_RSS_MB) || 440),
  onPressure = null,
  log = console,
} = {}) {
  const limit = Math.max(64, Number(limitMb) || 440);
  let timer = null;
  let stopped = false;

  function checkOnce() {
    const rssMb = process.memoryUsage().rss / 1048576;
    const info = { rssMb: Math.round(rssMb), limitMb: limit, pressured: rssMb >= limit };
    if (!info.pressured || stopped) return info;
    let shed = null;
    try { shed = typeof onPressure === 'function' ? onPressure(info) : null; }
    catch (err) { try { log.warn?.(`Memory pressure cleanup failed: ${err?.message || err}`); } catch { /* non-fatal */ } }
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch { /* GC is best effort */ }
    }
    info.rssAfterMb = Math.round(process.memoryUsage().rss / 1048576);
    info.shed = shed;
    try { log.warn?.(`Memory watchdog: RSS ${info.rssMb} MB ≥ ${limit} MB — shed caches${shed ? ` (${JSON.stringify(shed)})` : ''}, RSS now ${info.rssAfterMb} MB.`); } catch { /* non-fatal */ }
    return info;
  }

  timer = setInterval(() => { try { checkOnce(); } catch { /* the watchdog must never crash the bot */ } }, Math.max(1000, Number(intervalMs) || 300_000));
  timer.unref?.();

  return {
    checkOnce,
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
    limitMb: limit,
  };
}

module.exports = { startKeepAliveServer, startMemoryWatchdog, sanitizedStatus };
