#!/usr/bin/env node
'use strict';
// Gets a working FFmpeg onto a panel container where you cannot install
// packages and cannot pass devices through.
//
//   node troy-ffmpeg.js
//
// Order of preference:
//   1. an FFmpeg already on the machine that passes the real capability probes;
//   2. the ffmpeg-static npm package, if it is installed;
//   3. a direct download of the same prebuilt binary into .troy-ffmpeg/ beside
//      the application, which survives restarts because it is in the app
//      directory rather than /tmp.
//
// No root. Nothing outside the application directory.

const fs = require('node:fs');
const fsp = require('node:fs').promises;
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ffmpegCandidates, probeFfmpeg, staticFfmpegExpectedPath } = require('./transcode');
const staticFfmpeg = require('./static-ffmpeg');

const say = line => console.log(line);

(async () => {
  say('');
  say('Troy FFmpeg setup');
  say('='.repeat(58));
  say(`platform   ${process.platform} ${process.arch}`);
  say(`target     ${staticFfmpegExpectedPath()}`);

  // 1. Anything already usable?
  say('');
  say('Checking what is already available:');
  const candidates = ffmpegCandidates();
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    try {
      await probeFfmpeg(candidate.path);
      say(`  OK        ${candidate.label}`);
      say(`            ${candidate.path}`);
      say('');
      say('Nothing to do. Pin it so the server always uses this one:');
      say(`  CINEMA_FFMPEG=${candidate.path}`);
      say('');
      return;
    } catch (error) {
      say(`  unusable  ${candidate.label}: ${error.message}`);
    }
  }

  // 2. The npm package, if present.
  const packaged = staticFfmpeg.fromNpmPackage();
  if (packaged) {
    say('');
    say(`Found the ffmpeg-static package: ${packaged}`);
    try {
      await probeFfmpeg(packaged);
      say('  verified');
      say('');
      say('Pin it:');
      say(`  CINEMA_FFMPEG=${packaged}`);
      say('');
      return;
    } catch (error) {
      say(`  unusable: ${error.message}`);
    }
  }

  // 3. Download the prebuilt binary.
  const target = staticFfmpegExpectedPath();
  say('');
  say('Downloading a prebuilt static FFmpeg.');
  say(`  from ${staticFfmpeg.downloadUrl()}`);
  say('  one-time, needs no root');
  try {
    await staticFfmpeg.download(target);
    const bytes = fs.statSync(target).size;
    say(`  saved ${(bytes / 1048576).toFixed(1)} MB to ${target}`);

    await probeFfmpeg(target);
    say('  verified: x264, AAC, HLS muxer, filters and readrate all present');
    say('');
    say('Done. The server picks this up automatically on the next start.');
    say('To pin it explicitly:');
    say(`  CINEMA_FFMPEG=${target}`);
    say('');
  } catch (error) {
    say(`  download failed: ${error.message}`);
    say('');
    say('Try the other route instead, which uses the panel\'s own npm install:');
    say('  npm install ffmpeg-static');
    say('');
    say('If npm also cannot reach the network, ask the host to allow');
    say('github.com and release-assets.githubusercontent.com, or install');
    say('FFmpeg through the panel.');
    process.exit(1);
  }
})().catch(error => {
  console.error('');
  console.error('setup failed:', error.message);
  process.exit(1);
});
