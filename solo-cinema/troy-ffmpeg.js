#!/usr/bin/env node
'use strict';
// Gets a working FFmpeg onto a container where you cannot install packages.
//
//   node troy-ffmpeg.js
//
// It first tries the FFmpeg candidates already on the machine. Only if none of
// them satisfies the probes does it download a static build into the temp
// directory. Nothing needs root and nothing is written outside the temp dir.

const fs = require('node:fs');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const { ffmpegCandidates, probeFfmpeg, chooseFfmpeg, STATIC_FFMPEG, staticFfmpegExpectedPath } = require('./transcode');

const say = line => console.log(line);

function download(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'user-agent': 'troy-ffmpeg' }, timeout: 120000 }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, destination, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} from ${url}`)); }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0, lastReport = 0;
      const file = fs.createWriteStream(destination);
      res.on('data', chunk => {
        received += chunk.length;
        if (total && Date.now() - lastReport > 3000) {
          lastReport = Date.now();
          say(`  ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
        }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destination)));
      file.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('download timed out')); });
  });
}

(async () => {
  say('');
  say('Troy FFmpeg setup');
  say('='.repeat(58));
  say(`platform  ${process.platform} ${process.arch}`);

  // 1. Anything already here?
  const candidates = ffmpegCandidates();
  say('');
  say('Checking what is already installed:');
  for (const candidate of candidates) {
    try {
      await probeFfmpeg(candidate.path);
      say(`  OK        ${candidate.label}: ${candidate.path}`);
      say('');
      say('Nothing to do. Set this if the server does not find it on its own:');
      say(`  CINEMA_FFMPEG=${candidate.path}`);
      say('');
      return;
    } catch (error) {
      say(`  unusable  ${candidate.label}: ${error.message}`);
    }
  }

  // 2. Download a static build.
  const url = STATIC_FFMPEG[process.arch];
  if (!url) {
    say('');
    say(`No static build is available for ${process.arch}.`);
    say('Install FFmpeg with your panel, or set CINEMA_FFMPEG to a binary path.');
    process.exit(1);
  }

  say('');
  say(`Downloading a static build for ${process.arch}.`);
  say('This is a one-time download and needs no root.');
  const dir = path.dirname(staticFfmpegExpectedPath());
  await fsp.mkdir(dir, { recursive: true });
  const archive = path.join(dir, 'ffmpeg.tar.xz');

  try {
    await download(url, archive);
    say('  downloaded');
    const unpack = spawnSync('tar', ['-xJf', archive, '-C', dir, '--strip-components=1'], { encoding: 'utf8' });
    if (unpack.status !== 0) {
      say(`  could not unpack: ${(unpack.stderr || '').trim().slice(0, 200)}`);
      say('  the archive may use a format this container cannot extract;');
      say('  extract it manually and set CINEMA_FFMPEG to the ffmpeg binary.');
      process.exit(1);
    }
    const binary = staticFfmpegExpectedPath();
    await fsp.chmod(binary, 0o755);
    say(`  extracted to ${binary}`);

    await probeFfmpeg(binary);
    say('  verified: encoders, HLS muxer, filters and options all present');
    say('');
    say('Add this to the server environment and restart:');
    say(`  CINEMA_FFMPEG=${binary}`);
    say('');
    say('To make it permanent, place the binary somewhere under the');
    say('application directory and point CINEMA_FFMPEG at that copy,');
    say('because the temp directory may be cleared on restart.');
    say('');
  } finally {
    await fsp.rm(archive, { force: true }).catch(() => {});
  }
})().catch(error => {
  console.error('');
  console.error('setup failed:', error.message);
  process.exit(1);
});
