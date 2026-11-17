#!/usr/bin/env node
'use strict';
// Server-side playback test. Runs the same provider calls the browser makes,
// then tries to actually READ the winning source, and reports exactly where it
// fails. Use it when the app shows an error you cannot read on a phone.
//
//   node troy-play.js "The Beast"
//   node troy-play.js "Breaking Bad" 1 1
//
// It writes nothing to disk and does not touch a running server.

const { safeUrl, publicLookup, getRemote, forceIPv4 } = require('./network');
const { Agent, fetch } = require('undici');
const { spawnSync } = require('node:child_process');
const { chooseFfmpeg, ffmpegCandidates, bundledFfmpeg } = require('./transcode');

const say = line => console.log(line);
const pad = (label, width = 20) => String(label).padEnd(width);
const agent = new Agent({ connect: { lookup: publicLookup() } });
// The server retries a 426 over HTTP/2, so test the same way it does.
const h2Agent = new Agent({ allowH2: true, connect: { lookup: publicLookup() } });

// Usage is a source URL, because that is the only thing that decides whether
// conversion can succeed.
const urlIndex = process.argv.indexOf('--url');
const target = urlIndex > 0 ? process.argv[urlIndex + 1] : null;

// Reuse the application's own provider stack so this tests what really runs.

(async () => {
  say('');
  say('Troy playback test');
  say('='.repeat(60));
  say(pad('outbound') + (forceIPv4 ? 'IPv4 preferred' : 'both families'));

  if (!process.argv.includes('--url')) {
    say('');
    say('Give a source URL to test it the way conversion does:');
    say('  node troy-play.js --url "https://..."');
    say('');
    say('Where to get one: open the app, play the title, and the player prints');
    say('the failing source under the video. Copy the link it names.');
    say('');
    return;
  }

  if (!target) {
    say('No URL given, so nothing else to test.');
    say('');
    return;
  }

  // Actually open the source, exactly as conversion does.
  say('Opening the source the way conversion does');
  say('-'.repeat(60));
  let safe;
  try { safe = safeUrl(target); } catch (error) { say(`  rejected by the URL policy: ${error.message}`); return; }
  say(pad('  url') + `${safe.host}${safe.pathname.slice(0, 40)}...`);

  const headers = { 'accept-encoding': 'identity' };
  let response;
  const started = Date.now();
  try {
    response = (await getRemote(safe.href, headers, AbortSignal.timeout(30000), fetch, agent, h2Agent)).response;
  } catch (error) {
    say(pad('  open') + `FAILED ${error.code || error.message} (${Date.now() - started}ms)`);
    say('');
    say('The connection itself failed. Run: node troy-doctor.js');
    return;
  }
  const ms = Date.now() - started;
  say(pad('  status') + `${response.status} (${ms}ms)`);
  say(pad('  content-type') + (response.headers.get('content-type') || 'none'));
  say(pad('  encoding') + (response.headers.get('content-encoding') || 'identity'));
  // Reporting the protocol matters: a 426 here means HTTP/2 was needed, and
  // seeing HTTP/2 accepted is how we know the retry is what fixed it.
  say(pad('  protocol') + (response.headers.get('x-troy-protocol') || (response.httpVersion ? `HTTP/${response.httpVersion}` : 'negotiated')));
  if (response.status === 426) {
    await response.body?.cancel().catch(() => {});
    say('');
    say('The host answered 426 (upgrade required) even after retrying over');
    say('HTTP/2. That means it is refusing this server\'s address or TLS');
    say('fingerprint, not asking for a protocol it did not get.');
    return;
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    say('');
    if (response.status === 426) {
      say('The CDN refused the connection with 426 (upgrade required).');
      say('That is this server\'s network path being refused, not a bad file.');
    } else if ([401, 403].includes(response.status)) {
      say('Access denied. The source needs a Referer or a fresh token.');
    } else if (response.status === 451) {
      say('451: blocked for legal reasons from this host/IP.');
    }
    return;
  }

  // Read real bytes and identify the container.
  const reader = response.body.getReader();
  const { value } = await reader.read();
  const head = Buffer.from(value || []);
  await reader.cancel().catch(() => {});
  const ascii = head.subarray(0, 16).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
  const isHls = head.toString('utf8').startsWith('#EXTM3U');
  const isMp4 = head.subarray(4, 8).toString('latin1').includes('ftyp');
  say(pad('  first bytes') + `${head.length} bytes  "${ascii}"`);
  say(pad('  container') + (isHls ? 'HLS playlist' : isMp4 ? 'MP4' : 'unrecognised'));
  if (!isHls && !isMp4) {
    say('');
    say('These are not video bytes. The provider returned an error page or');
    say('JSON even though the status was 200.');
    return;
  }

  // Does the local FFmpeg accept it? This is what playback depends on.
  say('');
  say('Can the local FFmpeg decode it?');
  say('-'.repeat(60));
  let binary;
  try { binary = await chooseFfmpeg(process.env.CINEMA_FFMPEG ? [{ label: 'Configured', path: process.env.CINEMA_FFMPEG }] : ffmpegCandidates()); }
  catch (error) { say(`  no usable FFmpeg: ${error.message}`); return; }
  say(pad('  ffmpeg') + binary);

  // Fetch a second time so FFmpeg gets a clean stream from the start.
  const second = (await getRemote(safe.href, headers, AbortSignal.timeout(30000), fetch, agent, h2Agent)).response;
  if (second.status !== 200) { say(`  could not refetch: HTTP ${second.status}`); await second.body?.cancel().catch(() => {}); return; }
  const { Readable } = require('node:stream');
  const input = Readable.fromWeb(second.body);
  const probe = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', '3', '-f', 'null', '-'], {
    input: await streamToBuffer(input, 12 * 1024 * 1024),
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (probe.status === 0) {
    say(pad('  decode') + 'OK (FFmpeg read 3 seconds of it)');
    say('');
    say('This source works on this server. If the browser still fails,');
    say('the problem is in the page, not the network.');
  } else {
    say(pad('  decode') + `FAILED (exit ${probe.status})`);
    const detail = (probe.stderr || '').trim().split('\n').slice(-3).join('\n            ');
    if (detail) say(`            ${detail}`);
    say('');
    say('FFmpeg could not read this source. If it is HLS, this build may lack');
    say('the demuxer; if it is MP4, it may not be fast-start.');
  }
})().catch(error => { console.error('test failed:', error.message); process.exit(1); })
  .finally(() => Promise.all([agent.close().catch(() => {}), h2Agent.close().catch(() => {})]));

async function streamToBuffer(stream, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk); size += chunk.length;
    if (size >= limit) break;
  }
  return Buffer.concat(chunks);
}
