'use strict';
// Answers one question: why does this host fail where another does not?
//
// Run it on the box that fails:   node diagnose-host.js <provider-url>
// With no URL it exercises the MovieBox player endpoint used by real playback.
//
// It makes the same requests the app makes, in order, and prints what came
// back. Nothing here needs a login and nothing is written to disk.

const dns = require('node:dns').promises;
const net = require('node:net');
const { safeUrl, getRemote, forceIPv4 } = require('./network');
const { Agent, fetch } = require('undici');

const line = (label, value) => console.log(`${label.padEnd(22)} ${value}`);

function familyOf(address) {
  return net.isIPv6(address) ? 6 : 4;
}

async function resolveFamilies(host) {
  let rows = [];
  try { rows = await dns.lookup(host, { all: true, verbatim: true }); } catch (error) { return { error: error.code || error.message }; }
  const v4 = rows.filter(r => r.family === 4).map(r => r.address);
  const v6 = rows.filter(r => r.family === 6).map(r => r.address);
  return { v4, v6, order: rows.map(r => `${r.address} (v${familyOf(r.address)})`) };
}

async function tcpProbe(address, port = 443, timeoutMs = 6000) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.connect({ host: address, port });
    const done = result => { socket.destroy(); resolve({ ...result, ms: Date.now() - started }); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ ok: true }));
    socket.once('timeout', () => done({ ok: false, reason: 'timeout' }));
    socket.once('error', error => done({ ok: false, reason: error.code || error.message }));
  });
}

async function attempt(url, label, options = {}) {
  const agent = new Agent({ connect: { lookup: (host, opts, cb) => {
    dns.lookup(host, { all: true, verbatim: true }).then(rows => {
      let picks = opts.family ? rows.filter(r => r.family === opts.family) : rows;
      if (options.ipv4) {
        const v4 = picks.filter(r => r.family === 4);
        if (v4.length) picks = v4;
      }
      if (!picks.length) return cb(new Error('No address'));
      if (opts.all) cb(null, picks); else cb(null, picks[0].address, picks[0].family);
    }).catch(cb);
  } } });
  const started = Date.now();
  try {
    const { response } = await getRemote(url, { 'accept-encoding': 'identity', ...(options.headers || {}) }, AbortSignal.timeout(15000), fetch, agent);
    const ms = Date.now() - started;
    let bodyStart = '';
    try {
      const reader = response.body.getReader();
      const { value } = await reader.read();
      bodyStart = Buffer.from(value || []).subarray(0, 12).toString('utf8').replace(/[^\x20-\x7e]/g, '.');
      await reader.cancel();
    } catch { /* body may be empty */ }
    await agent.close();
    return { label, status: response.status, ms, bodyStart, upgrade: response.headers.get('upgrade') || '-' };
  } catch (error) {
    await agent.close().catch(() => {});
    return { label, error: error.code || error.message, ms: Date.now() - started };
  }
}

(async () => {
  const target = process.argv[2] || null;
  console.log('\nTroy host diagnostic\n' + '='.repeat(52));
  line('node', process.version);
  line('platform', `${process.platform} ${process.arch}`);
  line('CINEMA_IPV4', forceIPv4 ? 'on (IPv4 forced)' : 'auto (both families)');

  // 1. Is IPv6 actually routable from here?
  const external = await tcpProbe('2606:4700:4700::1111').catch(() => ({ ok: false, reason: 'error' }));
  line('IPv6 route', external.ok ? `reachable (${external.ms}ms)` : `NOT reachable (${external.reason})`);
  if (!external.ok) console.log('  -> This host publishes or receives IPv6 answers it cannot route. Set CINEMA_IPV4=1.\n');

  // 2. What does the media host actually resolve to?
  let host = null;
  try { host = target ? new URL(target).hostname : 'moviebox.ph'; } catch { host = 'moviebox.ph'; }
  const resolved = await resolveFamilies(host);
  if (resolved.error) line(`DNS (${host})`, `failed: ${resolved.error}`);
  else {
    line(`DNS (${host})`, `${resolved.v4.length} v4, ${resolved.v6.length} v6`);
    line('  order', resolved.order.slice(0, 4).join(', '));
    // 3. Can we actually open a connection to each answer?
    for (const address of [...resolved.v4.slice(0, 2), ...resolved.v6.slice(0, 2)]) {
      const probe = await tcpProbe(address);
      line(`  tcp ${address}`, probe.ok ? `open (${probe.ms}ms)` : `FAILED ${probe.reason}`);
    }
  }

  // 4. Same request, both family policies. This is the deciding comparison.
  console.log('');
  if (target) {
    const both = await attempt(target, 'both families', {});
    const v4 = await attempt(target, 'IPv4 only', { ipv4: true });
    for (const r of [both, v4]) {
      line(r.label, r.error ? `ERROR ${r.error} after ${r.ms}ms` : `HTTP ${r.status} in ${r.ms}ms  body="${r.bodyStart}"  upgrade=${r.upgrade}`);
    }
    if (both.error && !v4.error) console.log('\n  -> IPv4 works and the default does not. Set CINEMA_IPV4=1.\n');
    if (both.status === 426 || v4.status === 426) {
      console.log('\n  -> HTTP 426 means the edge refused this connection, not the file.');
      console.log('     A browser retry usually succeeds where this does not. The relay path');
      console.log('     in the app exists to give the browser the bytes instead.\n');
    }
  } else {
    console.log('Pass a provider URL to compare both family policies directly:');
    console.log('  node diagnose-host.js "https://<media-host>/path"\n');
  }
})().catch(error => { console.error('diagnostic failed:', error.message); process.exit(1); });
