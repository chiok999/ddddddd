'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-subtitles-'));
const root = createBotFixture(temp);
process.chdir(root);
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
const config = require(path.join(root, 'config'));
const kisskh = require(path.join(root, 'lib/kisskh'));
const engine = require(path.join(root, 'lib/movies/adapter'));
const host = require(path.join(root, 'lib/movies/host'));
const disk = require(path.join(root, 'lib/diskSpace'));
const command = require(path.join(root, 'commands/kisskh'));

const srt = '1\n00:00:00,100 --> 00:00:01,900\nSubtitle fixture\n';

test('KissKh embeds the right subtitle for episodes and movies and falls back safely', async () => {
  const sample = path.join(temp, 'sample.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sample]);
  const originals = [];
  const replace = (obj, name, value) => { originals.push([obj, name, obj[name]]); obj[name] = value; };
  let delivered = [], sidecars = [], requested = [], reservations = 0, releases = 0, mode = 'embedded';
  replace(kisskh, 'stream', async () => ({ url: 'fixture', kind: 'http' }));
  replace(kisskh, 'subtitle', async id => { requested.push(id); return mode === 'absent' ? null : { text: srt, language: 'en' }; });
  replace(engine, 'targetFile', async () => path.join(root, 'temp', 'movie_test.mp4'));
  replace(engine, 'download', async (_source, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(sample, dest); return { file: dest }; });
  replace(host, 'defaultQuality', () => 720);
  replace(host, 'maxDownloadMB', () => 2000);
  replace(host, 'ffmpegPath', () => mode === 'no-ffmpeg' ? null : mode === 'broken' ? '/nonexistent-ffmpeg' : ffmpeg);
  replace(host, 'release', async () => true);
  const reserve = () => { reservations++; let done = false; return { release() { if (!done) { done = true; releases++; } } }; };
  replace(disk, 'reserveMovieSpace', reserve);
  replace(disk, 'reserveSpace', (...args) => { if (mode === 'no-space') throw Object.assign(new Error('disk full'), { code: 'NOT_ENOUGH_DISK' }); return reserve(...args); });
  replace(host, 'deliver', async (_sock, _chat, _msg, { file }) => {
    if (mode === 'send-failure') throw new Error('send failed');
    const probe = execFileSync(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // FFmpeg writes stream inspection to stderr; extract the subtitle directly instead.
    if (mode === 'embedded') {
      const extracted = path.join(temp, 'extracted.srt');
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0:s:0', extracted]);
      assert.match(fs.readFileSync(extracted, 'utf8'), /Subtitle fixture/);
      fs.rmSync(extracted);
    }
    delivered.push(file);
    void probe;
  });
  replace(host, 'sendSubtitle', async (_sock, _chat, _msg, { file }) => { sidecars.push(fs.readFileSync(file, 'utf8')); });
  try {
    config.movies.subtitles = true;
    for (const isMovie of [false, true]) {
      await command._fetchEpisode({}, {}, 'chat', { title: 'Fixture', isMovie }, { id: isMovie ? 22 : 11, number: 1, subs: 0 });
    }
    assert.deepEqual(requested, [11, 22], 'each episode checks its own subtitle even with an absent count');
    assert.equal(delivered.length, 2);
    assert.equal(sidecars.length, 0, 'no separate subtitle when mux succeeds');
    for (const file of delivered) assert.equal(fs.existsSync(file), false, 'muxed files cleaned');
    for (mode of ['no-ffmpeg', 'broken', 'no-space']) {
      await command._fetchEpisode({}, {}, 'chat', { title: 'Fixture', isMovie: false }, { id: 33, number: 1, subs: 1 });
    }
    assert.deepEqual(sidecars, [srt, srt, srt]);
    mode = 'absent';
    await command._fetchEpisode({}, {}, 'chat', { title: 'Fixture', isMovie: false }, { id: 44, number: 1 });
    assert.equal(sidecars.length, 3);
    config.movies.subtitles = false;
    await command._fetchEpisode({}, {}, 'chat', { title: 'Fixture', isMovie: false }, { id: 55, number: 1 });
    assert.equal(requested.includes(55), false);
    config.movies.subtitles = true;
    mode = 'send-failure';
    await assert.rejects(command._fetchEpisode({}, {}, 'chat', { title: 'Fixture', isMovie: false }, { id: 66, number: 1 }), /send failed/);
    assert.equal(reservations, releases, 'all disk reservations released');
    assert.deepEqual(fs.readdirSync(path.join(root, 'temp')), [], 'all temporary files are cleaned');
  } finally {
    for (const [obj, name, value] of originals.reverse()) obj[name] = value;
  }
});
