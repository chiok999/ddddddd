#!/usr/bin/env node
'use strict';
// Why is a source returning 426? Measures it instead of guessing.
//
//   node troy-426.js "https://<source url>"
//
// It makes the same request four ways and prints what each one gets:
//   1. HTTP/1.1, no extra headers
//   2. HTTP/2   (ALPN), no extra headers
//   3. HTTP/1.1 with a browser-like set of headers
//   4. HTTP/2   with the same headers
//
// If only the browser-like ones succeed, the host is fingerprinting headers.
// If only HTTP/2 succeeds, it wants the protocol. If all four return 426, the
// host is refusing this machine's address and no header will change that.

const { safeUrl, publicLookup, getRemote } = require('./network');
const { Agent, fetch } = require('undici');

const target = process.argv[2];
if (!target) {
  console.log('\nusage: node troy-426.js "https://<source url>"\n');
  process.exit(1);
}

let safe;
try { safe = safeUrl(target); } catch (error) { console.error(`rejected: ${error.message}`); process.exit(1); }

const plain = { 'accept-encoding': 'identity' };
const browser = {
  'accept-encoding': 'identity',
  'accept': '*/*',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-dest': 'video',
  'sec-fetch-mode': 'no-cors',
  'sec-fetch-site': 'cross-site',
};

function makeAgent(h2) {
  return new Agent({ ...(h2 ? { allowH2: true } : {}), connect: { lookup: publicLookup() } });
}

async function attempt(label, headers, h2) {
  const agent = makeAgent(h2);
  const started = Date.now();
  try {
    const { response } = await getRemote(safe.href, headers, AbortSignal.timeout(30000), fetch, agent, null);
    const ms = Date.now() - started;
    let head = '';
    try {
      const reader = response.body.getReader();
      const { value } = await reader.read();
      head = Buffer.from(value || []).subarray(0, 12).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
      await reader.cancel();
    } catch { /* empty body */ }
    return { label, status: response.status, ms, head, upgrade: response.headers.get('upgrade') || '-' };
  } catch (error) {
    return { label, error: error.code || error.message, ms: Date.now() - started };
  } finally {
    await agent.close().catch(() => {});
  }
}

(async () => {
  console.log('');
  console.log('Troy 426 investigation');
  console.log('='.repeat(64));
  console.log(`host  ${safe.host}`);
  console.log(`path  ${safe.pathname.slice(0, 60)}${safe.search ? '?…' : ''}`);
  console.log('');

  const rows = [];
  rows.push(await attempt('HTTP/1.1  plain  ', plain, false));
  rows.push(await attempt('HTTP/2    plain  ', plain, true));
  rows.push(await attempt('HTTP/1.1  browser', browser, false));
  rows.push(await attempt('HTTP/2    browser', browser, true));

  for (const row of rows) {
    const detail = row.error
      ? `ERROR ${row.error}`
      : `HTTP ${row.status}${row.upgrade !== '-' ? `  upgrade=${row.upgrade}` : ''}  head="${row.head}"`;
    console.log(`  ${row.label}  ${detail.padEnd(34)} ${String(row.ms).padStart(5)}ms`);
  }

  const ok = rows.filter(r => r.status === 200);
  console.log('');
  console.log('='.repeat(64));
  if (!ok.length) {
    const all426 = rows.every(r => r.status === 426);
    if (all426) {
      console.log('All four attempts got 426. The host is refusing this machine,');
      console.log('and nothing in a header or protocol choice will change that.');
      console.log('');
      console.log('Options, in order of effort:');
      console.log('  1. Compare with the browser: if the same link plays in a tab, the');
      console.log('     host accepts the browser path but not the server path.');
      console.log('  2. Run this file on bot-keep. If it succeeds there, the block is');
      console.log('     tied to hiddencloud\'s IP range, not to this code.');
      console.log('  3. If (2) is true, the only server-side answer left is to stop');
      console.log('     fetching from the server and let the browser fetch instead.');
    } else {
      console.log('Mixed results above: at least one variant differs, so the host');
      console.log('is selective about how the request is made rather than blocking');
      console.log('the IP outright.');
    }
  } else {
    const winners = ok.map(r => r.label.trim());
    console.log(`Works: ${winners.join(', ')}`);
    if (ok.some(r => r.label.includes('browser')) && !ok.some(r => r.label.startsWith('HTTP/1.1  plain') || r.label.startsWith('HTTP/2    plain'))) {
      console.log('');
      console.log('Only the browser-like requests succeed: the host is fingerprinting');
      console.log('headers. The fix is to send the headers a player would send.');
    }
  }
  console.log('');
})();
