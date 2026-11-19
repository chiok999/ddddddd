// Behavioural checks for the playback engine.
//
// Each case is paired with the failure it prevents, because every one of these
// rules came from a specific bug in the classic player. A test that only asserts
// "it did not throw" would not have caught any of them.
//
// Run: node tools/build-engine-fixture.mjs && node tools/engine-check.mjs

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

// The engine schedules its poll with window.setInterval; give it the browser
// global it expects rather than changing production code for a test.
globalThis.window = globalThis;

// hls.js is external in the fixture, so the harness owns what the engine sees.
// This stand-in is also the assertion surface: the cases below read the events
// it was given and the conversions those events did or did not cause.
mkdirSync('/tmp/engine-hls', { recursive: true });
writeFileSync(
  '/tmp/engine-hls/hls.js',
  `export default class Hls {
     static isSupported(){return true}
     static get Events(){return {MANIFEST_PARSED:'manifest',ERROR:'error'}}
     constructor(config){this.config=config;globalThis.__hls=this;this.listeners={};this.levels=[];this._level=-1}
     // Levels are listed 360 first, as a provider might. A player that picks by
     // index rather than by height would download the wrong rung here.
     set currentLevel(v){this._level=v} get currentLevel(){return this._level}
     loadSource(u){this.url=u} attachMedia(v){this.media=v}
     on(e,cb){(this.listeners[e] ||= []).push(cb)}
     emit(e,d){for(const cb of this.listeners[e]||[]) cb(e,d)}
     startLoad(){} recoverMediaError(){} destroy(){this.destroyed=true}
   };`,
);
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(spec, ctx, next){
         if (spec === 'hls.js') return { url: 'file:///tmp/engine-hls/hls.js', shortCircuit: true };
         return next(spec, ctx);
       }`,
    ),
);

const { Playback } = await import(pathToFileURL('/home/user/ddddddd/reelbox-src/dist-test/playback.mjs').href);

let calls = [];
let responses = {};
globalThis.fetch = async (url, init) => {
  calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
  const handler = responses[url];
  const result = typeof handler === 'function' ? handler(init) : handler;
  if (!result) throw new Error(`unexpected fetch ${url}`);
  if (result instanceof Error) throw result;
  // A response without an explicit status is a success; one with a status is a
  // success only below 400. Getting this wrong made a 502 look like an empty
  // body, which is a different failure than the one under test.
  const status = result.status ?? 200;
  return { ok: result.ok !== undefined ? result.ok : status < 400, status, json: async () => result.body ?? result };
};

/**
 * A video element's pause() emits `pause` asynchronously in real browsers, and
 * that delay is what a playing engine reacts to. This stand-in does the same.
 */
// jsdom is not available here, so the engine's only DOM need -- creating and
// appending a <track> -- is stood in for. The assertions are about the calls the
// engine makes, not about how a browser renders captions.
const tracks = [];
globalThis.document = {
  createElement(tag) {
    // A real HTMLTrackElement always has a `track` property (a TextTrack whose
    // mode starts 'disabled'), and the engine relies on that when it sets the
    // default mode before attaching. The stand-in must have the same shape or the
    // test is checking a DOM that does not exist.
    const track = { mode: 'disabled' };
    const el = { tag, kind: '', label: '', srclang: '', src: '', track, removed: false };
    el.remove = () => {
      el.removed = true;
      const i = tracks.indexOf(el);
      if (i >= 0) tracks.splice(i, 1);
    };
    if (tag === 'track') tracks.push(el);
    return el;
  },
};

class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.currentTime = 0;
    this.duration = NaN;
    this.paused = true;
    this.playbackRate = 1;
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
    this.seekable = { length: 0, start: () => 0, end: () => 0 };
    this.src = '';
    this.attrs = {};
  }
  play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    setTimeout(() => this.dispatchEvent(new Event('pause')), 0);
  }
  append(el) {
    (this.children ||= []).push(el);
  }
  removeAttribute(name) {
    delete this.attrs[name];
    if (name === 'src') this.src = '';
  }
  load() {}
  addEventListener(t, cb, opts) {
    super.addEventListener(t, cb, opts);
  }
  removeEventListener(t, cb, opts) {
    super.removeEventListener(t, cb, opts);
  }
}

const results = [];
// A failed case must not leave the run green.
process.on('exit', (code) => {
  if (results.some(([passed]) => !passed)) process.exitCode = 1;
  else if (code) process.exitCode = code;
});
const cleanups = [];
const check = async (name, fn) => {
  calls = [];
  responses = {};
  try {
    await fn();
    results.push([true, name]);
    console.log(`ok   ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`FAIL ${name}\n     ${error.message}`);
  } finally {
    // An engine left running holds a 1 s interval, which would keep the process
    // alive and make a passing run look like a hang.
    for (const stop of cleanups.splice(0)) await stop();
  }
};

const resolved = (streams, providers = [{ provider: 'moviebox', count: streams.length }]) => ({
  body: { title: 'X', streams, providers },
});
const job = (id = 'a'.repeat(32), duration = 600) => ({
  body: { id, url: `/transcode/${id}/master.m3u8`, duration },
});

function makeEngine() {
  const video = new FakeVideo();
  const states = [];
  const progress = [];
  const subtitles = [];
  const engine = new Playback({
    onState: (s) => states.push(s),
    onProgress: (p, d, paused) => progress.push([p, d, paused]),
    onSubtitle: (st) => subtitles.push(st),
  });
  engine.attach(video);
  // Registered here so every case cleans up, including the ones that fail.
  cleanups.push(() => engine.stop());
  cleanups.push(() => engine.attach(null));
  return { engine, video, states, progress, subtitles, last: () => states.at(-1) };
}

const target = { id: 'abc', title: 'X', type: 'movie', progressKey: 'k' };

// 1. HLS input is refused, not converted.
await check('an HLS-only resolve fails with a reason instead of trying', async () => {
  const { engine, last } = makeEngine();
  responses['/api/resolve'] = resolved([{ provider: 'movy:x', format: 'hls', url: '/media/h' }], [
    { provider: 'movy:x', count: 1 },
  ]);
  await engine.start(target);
  assert.equal(last().phase, 'failed');
  assert.match(last().message, /HLS/);
  assert.ok(!calls.some((c) => c.url === '/api/transcode'), 'must not ask for a conversion');
});

// 2. A waitable hls.js error must not restart the conversion. Restarting starts a
//    new timeline, which is what made playback appear to jump backwards.
await check('a stalled segment waits instead of starting a new conversion', async () => {
  const { engine, last } = makeEngine();
  responses['/api/resolve'] = resolved([{ provider: 'moviebox', format: 'file', url: '/media/s' }]);
  responses['/api/transcode'] = job();
  responses['/api/transcode/status'] = { body: { canPlay: true, resumeAt: 0 } };
  await engine.start(target);
  const hls = globalThis.__hls;
  hls.emit('manifest', {});
  const before = calls.filter((c) => c.url === '/api/transcode').length;
  hls.emit('error', { fatal: true, details: 'bufferStalledError' });
  await new Promise((r) => setTimeout(r, 30));
  const after = calls.filter((c) => c.url === '/api/transcode').length;
  assert.equal(after, before, 'no second conversion for a waitable error');
  assert.equal(last().phase, 'buffering');
});

// 3. A fatal, non-waitable error retries the same source once at the same
//    position, then moves to the next provider.
await check('a fatal error retries the same position, then fails over', async () => {
  const { engine } = makeEngine();
  responses['/api/resolve'] = resolved([
    { provider: 'moviebox', format: 'file', url: '/media/a' },
    { provider: 'vaplayer', format: 'file', url: '/media/b' },
  ]);
  let n = 0;
  responses['/api/transcode'] = () => job(String(++n).padStart(32, 'b'));
  responses['/api/transcode/status'] = { body: { canPlay: true } };
  await engine.start(target, 120);
  const hls = globalThis.__hls;
  hls.emit('manifest', {});
  engine.video.currentTime = 30;
  hls.emit('error', { fatal: true, details: 'failed' });
  await new Promise((r) => setTimeout(r, 60));
  const jobs = calls.filter((c) => c.url === '/api/transcode');
  assert.equal(jobs.length, 2, `expected a retry, saw ${jobs.length} conversions`);
  assert.equal(jobs[1].body.offset, 150, 'retry must resume at 120 + 30, not 0');
});

// 4. Position is reported once a second, because a 2 s lead threshold cannot be
//    governed by a 4 s poll.
await check('the status poll runs at 1 s and carries the position', async () => {
  const { engine } = makeEngine();
  responses['/api/resolve'] = resolved([{ provider: 'moviebox', format: 'file', url: '/media/s' }]);
  responses['/api/transcode'] = job();
  responses['/api/transcode/status'] = { body: { canPlay: true } };
  await engine.start(target, 60);
  globalThis.__hls.emit('manifest', {});
  const before = calls.filter((c) => c.url === '/api/transcode/status').length;
  await new Promise((r) => setTimeout(r, 2150));
  // Requests issued by the previous case can still land in this window, so the
  // count is taken over this engine's own positions rather than the whole log.
  const polls = calls.filter((c) => c.url === '/api/transcode/status').slice(before);
  const mine = polls.filter((c) => c.body.position === 60);
  assert.ok(mine.length >= 2, `expected >=2 polls at the starting offset in 2 s, saw ${mine.length} of ${polls.length}`);
  assert.ok(polls.length >= 2, 'the poll is running');
});

// 5. The server, not the client, decides whether playback may continue.
await check('canPlay=false pauses and resumes when the server allows it', async () => {
  const { engine, video } = makeEngine();
  responses['/api/resolve'] = resolved([{ provider: 'moviebox', format: 'file', url: '/media/s' }]);
  responses['/api/transcode'] = job();
  let allowed = false;
  responses['/api/transcode/status'] = () => ({ body: { canPlay: allowed, resumeAt: allowed ? 5 : null } });
  await engine.start(target);
  globalThis.__hls.emit('manifest', {});
  assert.equal(video.paused, false, 'should be playing before the throttle');
  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(video.paused, true, 'the server said wait, so playback must stop');
  allowed = true;
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(video.paused, false, 'must resume once the server allows it');
});

// 6. The governor borrows the rate on a thin buffer and hands it back.
await check('a thin buffer slows playback, a healthy one restores the chosen rate', async () => {
  const { engine, video } = makeEngine();
  responses['/api/resolve'] = resolved([{ provider: 'moviebox', format: 'file', url: '/media/s' }]);
  responses['/api/transcode'] = job();
  responses['/api/transcode/status'] = { body: { canPlay: true } };
  engine.setRate(1.5);
  await engine.start(target);
  globalThis.__hls.emit('manifest', {});
  video.buffered = { length: 1, start: () => 0, end: () => video.currentTime + 2 };
  video.playbackRate = 1.5;
  await new Promise((r) => setTimeout(r, 1150));
  assert.ok(video.playbackRate < 1.5, `thin buffer should slow, rate=${video.playbackRate}`);
  video.buffered = { length: 1, start: () => 0, end: () => video.currentTime + 40 };
  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(video.playbackRate, 1.5, 'the viewer choice is authoritative once the buffer is healthy');
});

// 7. A seek inside the converted window moves the element; past it, a new
//    conversion is started at that point. Silently doing nothing was the bug.
await check('seeking past the converted window restarts the conversion there', async () => {
  const { engine, video } = makeEngine();
  responses['/api/resolve'] = resolved([{ provider: 'moviebox', format: 'file', url: '/media/s' }]);
  responses['/api/transcode'] = job('c'.repeat(32), 3600);
  responses['/api/transcode/status'] = { body: { canPlay: true } };
  await engine.start(target);
  globalThis.__hls.emit('manifest', {});
  video.duration = 300; // only 300 s converted
  video.seekable = { length: 1, start: () => 0, end: () => 300 };
  video.currentTime = 100;
  engine.seek(120);
  assert.equal(video.currentTime, 120, 'inside the window is a plain seek');
  const before = calls.filter((c) => c.url === '/api/transcode').length;
  engine.seek(1800);
  await new Promise((r) => setTimeout(r, 40));
  const after = calls.filter((c) => c.url === '/api/transcode');
  assert.equal(after.length, before + 1, 'past the window needs a new conversion');
  assert.equal(after.at(-1).body.offset, 1800, 'and it starts at the requested point');
});

// 8. A failed conversion on the last provider names what was tried.
await check('the final message lists the providers that were tried', async () => {
  const { engine, last } = makeEngine();
  responses['/api/resolve'] = resolved([
    { provider: 'moviebox', format: 'file', url: '/media/a' },
    { provider: 'vaplayer', format: 'file', url: '/media/b' },
  ]);
  responses['/api/transcode'] = { ok: false, status: 502, body: { error: 'Provider refused' } };
  await engine.start(target);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(last().phase, 'failed');
  assert.match(last().message, /Provider refused/);
  assert.match(last().message, /moviebox/);
  assert.match(last().message, /vaplayer/);
});

// 9. A provider caption is attached but not shown, and the button toggles it.
await check('a provider subtitle is attached hidden, then toggled on and off', async () => {
  tracks.length = 0;
  const { engine, video, subtitles } = makeEngine();
  responses['/api/resolve'] = resolved([{ provider: 'moviebox', format: 'file', url: '/media/s', captionId: 'cap1' }]);
  responses['/api/transcode'] = job();
  responses['/api/transcode/status'] = { body: { canPlay: true } };
  responses['/api/moviebox-subtitle'] = { body: { url: '/caption/abc123' } };
  await engine.start({ ...target, source: 'moviebox' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(tracks.length, 1, 'exactly one track is created');
  assert.equal(tracks[0].src, '/caption/abc123');
  assert.equal(tracks[0].kind, 'subtitles');
  assert.equal(tracks[0].track.mode, 'hidden', 'captions must not autoplay');
  assert.ok((video.children || []).includes(tracks[0]), 'the track is attached to the video');
  assert.deepEqual(engine.subtitleState(), { available: true, on: false, note: '' });
  assert.equal(engine.toggleSubtitle().on, true);
  assert.equal(tracks[0].track.mode, 'showing');
  assert.equal(engine.toggleSubtitle().on, false);
  assert.equal(tracks[0].track.mode, 'hidden');
  assert.ok(subtitles.length >= 2, 'the UI is told about each change');
});

// 10. No caption is normal: the button reports why instead of offering a dead track.
await check('a source with no subtitle says so and creates no track', async () => {
  tracks.length = 0;
  const { engine } = makeEngine();
  responses['/api/resolve'] = resolved([{ provider: 'moviebox', format: 'file', url: '/media/s' }]);
  responses['/api/transcode'] = job();
  responses['/api/transcode/status'] = { body: { canPlay: true } };
  await engine.start({ ...target, source: 'moviebox' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(tracks.length, 0);
  const st = engine.subtitleState();
  assert.equal(st.available, false);
  assert.match(st.note, /no subtitles/i);
  // Toggling with no track must not claim captions are on.
  assert.equal(engine.toggleSubtitle().on, false);
});

// 11. A failing subtitle request must not break playback.
await check('a subtitle outage leaves the video playing', async () => {
  tracks.length = 0;
  const { engine, video, last, subtitles } = makeEngine();
  responses['/api/resolve'] = resolved([{ provider: 'moviebox', format: 'file', url: '/media/s', captionId: 'cap1' }]);
  responses['/api/transcode'] = job();
  responses['/api/transcode/status'] = { body: { canPlay: true } };
  responses['/api/moviebox-subtitle'] = { status: 502, body: { error: 'Provider refused' } };
  await engine.start({ ...target, source: 'moviebox' });
  globalThis.__hls.emit('manifest', {});
  // The subtitle request runs alongside playback, so wait for its report rather
  // than guessing how long a failing request takes.
  for (let i = 0; i < 100 && !subtitles.some((st) => st.note); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(subtitles.some((st) => st.note), 'the UI was told why there is no track');
  assert.equal(tracks.length, 0);
  assert.equal(last().phase, 'playing', 'playback continues');
  assert.equal(video.paused, false);
  assert.match(engine.subtitleState().note, /Provider refused/);
});

// 12. The chosen rung is what gets downloaded, before the menu is ever opened.
await check('the saved quality is pinned on load, not left to bandwidth estimation', async () => {
  const { engine } = makeEngine();
  responses['/api/resolve'] = resolved([
    { provider: 'moviebox', format: 'file', url: '/media/360', quality: 360 },
    { provider: 'moviebox', format: 'file', url: '/media/240', quality: 240 },
  ]);
  responses['/api/transcode'] = job();
  responses['/api/transcode/status'] = { body: { canPlay: true } };
  // Set before playback, the way the page does it from the saved preference.
  engine.setQuality(240);
  await engine.start({ ...target, source: 'moviebox' });
  const hls = globalThis.__hls;
  // The provider lists 360 first, so an index-based choice would take it.
  hls.levels = [{ height: 360 }, { height: 240 }];
  hls.emit('manifest', {});
  assert.equal(hls.currentLevel, 1, 'the 240p level is selected by height, not by index');
  // Opening the menu and choosing 360 must still work afterwards.
  engine.setQuality(360);
  assert.equal(hls.currentLevel, 0);
});

// 13. A seek that restarts the conversion builds a new HLS instance; the rung
// has to be re-applied or the restart silently reverts to the default.
await check('a restarted conversion keeps the chosen quality', async () => {
  const { engine, video } = makeEngine();
  responses['/api/resolve'] = resolved([{ provider: 'moviebox', format: 'file', url: '/media/s' }]);
  responses['/api/transcode'] = job();
  responses['/api/transcode/status'] = { body: { canPlay: true } };
  engine.setQuality(360);
  await engine.start({ ...target, source: 'moviebox' });
  const first = globalThis.__hls;
  first.levels = [{ height: 240 }, { height: 360 }];
  first.emit('manifest', {});
  assert.equal(first.currentLevel, 1);
  // Seek past the converted window: a second job and a second Hls instance.
  video.duration = 300; // 300 s converted of a 3600 s title
  video.seekable = { length: 1, start: () => 0, end: () => 300 };
  engine.seek(1800);
  await new Promise((r) => setTimeout(r, 60));
  const second = globalThis.__hls;
  assert.notEqual(second, first, 'a new instance was built');
  second.levels = [{ height: 240 }, { height: 360 }];
  second.emit('manifest', {});
  assert.equal(second.currentLevel, 1, 'the chosen rung survives the restart');
});

// Everything above stops its own engine, so nothing should be left holding the
// event loop. Exit explicitly rather than hoping the last timer was the last one.
console.log(results.every(([passed]) => passed) ? '\nall engine checks passed' : '\nfailures above');
process.exit(results.every(([passed]) => passed) ? 0 : 1);
