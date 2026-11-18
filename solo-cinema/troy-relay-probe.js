#!/usr/bin/env node
'use strict';
// Why is a source returning a 4xx through the relay? Measures it instead of
// guessing.
//
//   node troy-relay-probe.js "https://<source url>"
//   node troy-relay-probe.js "https://<source url>" --referer "https://moviebox.ph/"
//
// It asks the same URL four ways and prints what each one gets:
//   1. this server, directly
//   2. through the relay worker
//   3. through the relay worker, after a gap
//   4. through the relay worker, as a range request (what seeking uses)
//
// Reading the result:
//   direct 427 + relay 200      the address was the problem and the relay fixed it
//   direct 427 + relay 427      a rate limit on both: the CDN is counting requests
//   direct 426 + relay 427      the relay's shared address is rate-limited; retry later
//   direct 200 + relay 4xx      the relay is the problem, not the CDN
//   all 403/404                 the link itself is wrong (expired, wrong referer)
//
// The worker already waits out a rate limit four times before reporting one, so a
// 427 here means it waited and was still refused. Nothing about the file is wrong.
const guard = require('./tool-guard');
if (guard.startServerIfPanelEntry('troy-relay-probe.js', '"https://<source url>"')) return;

const { safeUrl } = require('./network');
const { relayConfig, createRelayRemote } = require('./relay');

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith('--'));
const flag = (name) => {
  const index = args.indexOf(name);
  return index > -1 ? args[index + 1] : null;
};
if (!target) {
  console.log('\nusage: node troy-relay-probe.js "https://<source url>" [--referer URL] [--origin URL] [--ua STRING]\n');
  process.exit(1);
}

const referer = flag('--referer');
const origin = flag('--origin');
const userAgent = flag('--ua');
const wait = Number(flag('--gap') || 4000);

async function direct(url, headers, signal) {
  return fetch(url, { headers, redirect: 'manual', signal });
}

function describe(status) {
  return {
    200: 'ok',
    206: 'ok (partial)',
    403: 'forbidden',
    404: 'not found',
    426: 'upgrade required',
    427: 'rate limited (nginx limit_req)',
    429: 'rate limited',
    451: 'unavailable for legal reasons',
    500: 'upstream error',
    502: 'upstream error',
    503: 'upstream unavailable',
  }[status] || '';
}

function baseHeaders() {
  const headers = { 'accept-encoding': 'identity' };
  if (referer) headers.referer = referer;
  if (origin) headers.origin = origin;
  if (userAgent) headers['user-agent'] = userAgent;
  return headers;
}

async function attempt(label, open, headers) {
  const started = Date.now();
  try {
    const response = await open(target, headers, AbortSignal.timeout(30000));
    const ms = Date.now() - started;
    const type = response.headers.get('content-type') || '-';
    const length = response.headers.get('content-length') || '-';
    const range = response.headers.get('content-range');
    const retried = response.retried ? '  [worker retried 4x]' : '';
    console.log(
      `  ${String(response.status).padEnd(4)} ${label.padEnd(26)} ${String(ms).padStart(6)}ms  ${type}` +
        `${length !== '-' ? `  ${length} bytes` : ''}${range ? `  ${range}` : ''}${retried}  ${describe(response.status)}`
    );
    await response.body?.cancel().catch(() => {});
    return response.status;
  } catch (error) {
    console.log(`  ---- ${label.padEnd(26)} ${String(Date.now() - started).padStart(6)}ms  failed: ${String(error?.message || error).slice(0, 120)}`);
    return null;
  }
}

(async () => {
  let safe;
  try {
    safe = safeUrl(target).href;
  } catch (error) {
    console.error(`rejected: ${error.message}`);
    process.exit(1);
  }
  let config = null;
  try {
    config = relayConfig();
  } catch (error) {
    console.error(`relay settings: ${error.message}`);
  }

  console.log(`\nsource: ${safe.slice(0, 120)}`);
  console.log(`relay:  ${config ? `${config.origin}${config.path}/` : 'off (CINEMA_RELAY_URL is not set)'}`);
  console.log(`\n  what   route                      took      upstream\n  ------ -------------------------- --------- -----------------------------------------`);

  await attempt('1. direct', direct, baseHeaders());
  if (!config) {
    console.log('\n  Set CINEMA_RELAY_URL and CINEMA_RELAY_KEY to test the relay.\n');
    return;
  }
  const remote = createRelayRemote({ config, send: (url, headers, signal) => fetch(url, { headers, signal, redirect: 'manual' }), direct: null });
  await attempt('2. relay', remote, baseHeaders());
  await attempt('3. relay after a gap', async (url, headers, signal) => {
    await new Promise((resolve) => setTimeout(resolve, wait));
    return remote(url, headers, signal);
  }, baseHeaders());
  await attempt('4. relay + range', remote, { ...baseHeaders(), range: 'bytes=0-1' });

  console.log(`
  Next:
    every route 403/404      the URL has expired or needs the provider's own Referer;
                             re-resolve the title (the player does this itself)
    direct 426/427, relay ok the relay is doing its job
    direct and relay 427     the CDN is counting requests faster than it allows.
                             One retry a minute later usually plays.
    relay slower than direct the wait-outs are working; expect playback to start late
`);
})();
