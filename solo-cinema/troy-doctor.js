#!/usr/bin/env node
'use strict';
// Troy network doctor -- ONE self-contained file. No npm install, no server, no
// login, nothing to configure.
//
//   node troy-doctor.js
//
// On a box you cannot paste into, fetch and run it in one line instead:
//   curl -fsSL https://raw.githubusercontent.com/chiok999/ddddddd/main/solo-cinema/troy-doctor.js | node
//
// Copies into a file on the box that is misbehaving and runs there. It answers
// the only question that matters: can THIS machine reach the providers, and if
// not, is it the address family, a timeout, or a refusal by the CDN?

const dns = require('node:dns').promises;
const net = require('node:net');
const https = require('node:https');
const os = require('node:os');
const tls = require('node:tls');

const NL = '\n';
const out = [];
const say = line => { out.push(line); console.log(line); };

// Real hosts the app talks to, not invented ones.
const TARGETS = [
  ['MovieBox API', 'h5-api.aoneroom.com', '/'],
  ['MovieBox site', 'moviebox.ph', '/'],
  ['Movy', 'www.movy.sx', '/'],
  ['KissKh', 'kisskh.co', '/'],
  ['VidLink encryptor', 'enc-dec.app', '/'],
];

const pad = (label, width = 22) => String(label).padEnd(width);

function familyTag(address) { return net.isIPv6(address) ? 'v6' : 'v4'; }

async function resolve(host) {
  try {
    const rows = await dns.lookup(host, { all: true, verbatim: true });
    return {
      v4: rows.filter(r => r.family === 4).map(r => r.address),
      v6: rows.filter(r => r.family === 6).map(r => r.address),
      order: rows.map(r => r.address),
    };
  } catch (error) {
    return { error: error.code || error.message, v4: [], v6: [], order: [] };
  }
}

function tcpProbe(address, port = 443, timeoutMs = 7000) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.connect({ host: address, port });
    const finish = result => { socket.destroy(); resolve({ ...result, ms: Date.now() - started }); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: 'timeout' }));
    socket.once('error', error => finish({ ok: false, reason: error.code || error.message }));
  });
}

// Raw request with a chosen family, so IPv6 and IPv4 can be compared directly
// without any library deciding for us.
function httpsRequest(host, path, family, timeoutMs = 20000) {
  return new Promise(resolve => {
    const started = Date.now();
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve({ ...result, ms: Date.now() - started });
    };
    const options = {
      host, path, method: 'GET', family,
      headers: {
        // Deliberately honest: no browser User-Agent is impersonated here.
        accept: '*/*',
        'accept-encoding': 'identity',
      },
      signal: AbortSignal.timeout(timeoutMs),
    };
    let req;
    try {
      req = https.request(options, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          if (size < 256) chunks.push(chunk);
          size += chunk.length;
          if (size >= 256) res.destroy();
        });
        res.on('close', () => finish({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).subarray(0, 120).toString('utf8').replace(/[^\x20-\x7e]/g, '.'),
        }));
        res.on('error', () => finish({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).subarray(0, 120).toString('utf8').replace(/[^\x20-\x7e]/g, '.'),
        }));
      });
    } catch (error) { return finish({ error: error.code || error.message }); }
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ error: 'timeout' }); });
    req.on('error', error => finish({ error: error.code || error.message }));
    req.end();
  });
}

// How does this machine's TLS look? CDN edges fingerprint it, and a mismatch
// between what Node offers and what the edge expects shows up here.
function tlsProbe(host) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => { if (!settled) { settled = true; resolve(result); } };
    const socket = tls.connect({ host, port: 443, servername: host, ALPNProtocols: ['h2', 'http/1.1'], timeout: 12000 }, () => {
      const cert = socket.getPeerCertificate() || {};
      finish({
        protocol: socket.getProtocol(),
        alpn: socket.alpnProtocol || 'none',
        issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || 'unknown',
        days: cert.valid_to ? Math.round((new Date(cert.valid_to) - Date.now()) / 86400000) : null,
      });
      socket.destroy();
    });
    socket.once('timeout', () => { finish({ error: 'timeout' }); socket.destroy(); });
    socket.once('error', error => { finish({ error: error.code || error.message }); socket.destroy(); });
  });
}

(async () => {
  say('');
  say('Troy network doctor');
  say('='.repeat(58));
  say(pad('run at') + new Date().toISOString());
  say(pad('node') + process.version);
  say(pad('platform') + `${process.platform} ${process.arch}`);
  say(pad('hostname') + os.hostname());
  say(pad('FFmpeg env') + (process.env.CINEMA_FFMPEG || 'not set'));

  // 1. Can this machine route IPv6 at all?
  say('');
  say('1. Address family');
  say('-'.repeat(58));
  const v6 = await tcpProbe('2606:4700:4700::1111', 443, 6000);
  const v4 = await tcpProbe('1.1.1.1', 443, 6000);
  say(pad('IPv4 outbound') + (v4.ok ? `ok (${v4.ms}ms)` : `FAILED ${v4.reason}`));
  say(pad('IPv6 outbound') + (v6.ok ? `ok (${v6.ms}ms)` : `FAILED ${v6.reason}`));
  const ipv6Broken = !v6.ok;
  if (ipv6Broken) {
    say('');
    say('   IPv6 is not routable from this machine.');
    say('   If any provider publishes an AAAA record, DNS can still answer with');
    say('   one, and the connection will fail for a reason that has nothing to');
    say('   do with the video. This is the single most common cause of');
    say('   "works on one server, not the other".');
  }

  // 2. Per provider: DNS, TCP, then the same request on each family.
  say('');
  say('2. Providers');
  say('-'.repeat(58));
  const verdicts = [];

  for (const [label, host, path] of TARGETS) {
    const resolved = await resolve(host);
    say('');
    say(`${label}  (${host})`);
    if (resolved.error) {
      say(pad('  dns') + `failed: ${resolved.error}`);
      verdicts.push({ label, verdict: 'DNS FAILED' });
      continue;
    }
    say(pad('  dns') + `${resolved.v4.length} IPv4, ${resolved.v6.length} IPv6`);
    say(pad('  first answer') + `${resolved.order[0]} (${familyTag(resolved.order[0])})`);

    for (const address of [...resolved.v4.slice(0, 1), ...resolved.v6.slice(0, 1)]) {
      const probe = await tcpProbe(address);
      say(pad(`  tcp ${address}`) + (probe.ok ? `open (${probe.ms}ms)` : `FAILED ${probe.reason}`));
    }

    const tlsInfo = await tlsProbe(host);
    if (tlsInfo.error) say(pad('  tls') + `FAILED ${tlsInfo.error}`);
    else say(pad('  tls') + `${tlsInfo.protocol}, alpn=${tlsInfo.alpn}, cert ${tlsInfo.days}d left`);

    const asV4 = await httpsRequest(host, path, 4);
    const asV6 = resolved.v6.length ? await httpsRequest(host, path, 6) : null;
    const describe = r => r.error
      ? `ERROR ${r.error} (${r.ms}ms)`
      : `HTTP ${r.status} (${r.ms}ms)` + (r.headers && r.headers.upgrade ? ` upgrade=${r.headers.upgrade}` : '');
    say(pad('  request IPv4') + describe(asV4));
    if (asV6) say(pad('  request IPv6') + describe(asV6));

    let verdict;
    const reset = asV4.error && /ECONNRESET|EPROTO|ECONNREFUSED/.test(asV4.error);
    if (!asV4.error && asV4.status < 500) verdict = 'reachable';
    else if (asV4.status === 426) verdict = 'REFUSED (426) on IPv4';
    else if (asV4.error && asV6 && !asV6.error) verdict = 'IPv4 fails, IPv6 works';
    else if (!asV4.error && asV4.status >= 500) verdict = `server error ${asV4.status}`;
    else if (reset && ipv6Broken) verdict = 'TCP opens, TLS reset';
    else if (asV6 && asV6.error && !asV4.error) verdict = 'reachable (IPv6 unusable)';
    else verdict = 'UNREACHABLE';
    say(pad('  verdict') + verdict);
    verdicts.push({ label, verdict });
  }

  // 3. What to do about it.
  say('');
  say('3. What this means');
  say('-'.repeat(58));
  const blocked = verdicts.filter(v => v.verdict !== 'reachable');
  const reachable = verdicts.filter(v => v.verdict === 'reachable');

  say(pad('reachable') + `${reachable.length} of ${verdicts.length}`);
  if (reachable.length) say(pad('  ok') + reachable.map(v => v.label).join(', '));
  if (blocked.length) say(pad('  failing') + blocked.map(v => `${v.label} [${v.verdict}]`).join(', '));

  say('');
  if (ipv6Broken) {
    say('ACTION 1: force IPv4 and try playback again.');
    say('  CINEMA_IPV4=1 npm start');
    say('');
  }
  if (blocked.some(v => /REFUSED \(426\)/.test(v.verdict))) {
    say('ACTION 2: an edge returned 426 to this machine on IPv4 too.');
    say('  That host is refusing this server\'s address, not the file.');
    say('  Test whether the refusal is address-specific by sending the same');
    say('  request from the browser tab: if the browser plays it, the browser');
    say('  path is the one that works, so use the relay.');
    say('');
  }
  if (reachable.length === verdicts.length && ipv6Broken) {
    say('Every provider answered on IPv4. IPv6 was the only broken part,');
    say('so CINEMA_IPV4=1 is expected to fix playback.');
    say('');
  }
  if (blocked.some(v => /TCP opens, TLS reset/.test(v.verdict))) {
    say('ACTION 3: TCP connects but TLS is reset. That is not a dead host and');
    say('  not a missing file: something on the path is dropping the TLS');
    say('  handshake, typically an egress proxy or SNI filtering. Two things');
    say('  to try, in order:');
    say('    1) set HTTPS_PROXY / HTTP_PROXY if this host needs one to reach');
    say('       the internet at all;');
    say('    2) compare with the same file run on bot-keep. If bot-keep');
    say('       reaches these hosts and this one does not, the difference is');
    say('       the network, and the relay (browser fetching) is the way out.');
    say('');
  }
  if (reachable.length === 0 && !blocked.some(v => /TCP opens, TLS reset/.test(v.verdict))) {
    say('Nothing answered at all. That points at a firewall blocking egress');
    say('from this host, or a network that only has IPv6. Run the same file on');
    say('bot-keep and compare the two outputs.');
    say('');
  }

  say('='.repeat(58));
  say('Send this whole output back. It says exactly which layer fails.');
  say('');
})().catch(error => {
  console.error('doctor failed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
