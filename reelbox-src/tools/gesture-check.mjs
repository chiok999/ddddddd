// Gesture classification and chrome behaviour are pure functions of time and
// coordinates, so they are tested directly rather than through a real pointer.
// Every case here is a way the player could guess wrong, which on a phone is
// indistinguishable from being broken.
import assert from 'node:assert/strict';
import { build } from 'vite';

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    outDir: 'dist-test',
    emptyOutDir: false,
    lib: { entry: 'src/lib/gestures.ts', formats: ['es'], fileName: () => 'gestures.mjs' },
    minify: false,
  },
});
await build({
  configFile: false,
  logLevel: 'error',
  build: {
    outDir: 'dist-test',
    emptyOutDir: false,
    lib: { entry: 'src/lib/player-ux.ts', formats: ['es'], fileName: () => 'player-ux.mjs' },
    minify: false,
  },
});
await build({
  configFile: false,
  logLevel: 'error',
  build: {
    outDir: 'dist-test',
    emptyOutDir: false,
    lib: { entry: 'src/lib/library.ts', formats: ['es'], fileName: () => 'library.mjs' },
    minify: false,
  },
});
const { Gestures } = await import('../dist-test/gestures.mjs');
await build({
  configFile: false,
  logLevel: 'error',
  build: {
    outDir: 'dist-test',
    emptyOutDir: false,
    lib: { entry: 'src/lib/orientation.ts', formats: ['es'], fileName: () => 'orientation.mjs' },
    minify: false,
  },
});
const { readSpeed, saveSpeed, SPEEDS } = await import('../dist-test/library.mjs');
const { rotationStrategy, nextLock, shouldRelease, currentOrientation, rotationNote } = await import(
  '../dist-test/orientation.mjs'
);
const { chromeVisible, seekSegments, seekTarget, gestureLabel, IDLE_MS } = await import(
  '../dist-test/player-ux.mjs'
);

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push([true]);
    console.log('ok  ', name);
  } catch (error) {
    results.push([false]);
    console.log('FAIL', name, '\n     ', error.message);
  }
};

// A 360x640 phone held upright: one third is 120 px.
const phone = (gestures) => {
  gestures.setSurface(360, 640);
  return gestures;
};

await check('a tap on the left third seeks back ten seconds, a right one forward', () => {
  const g = phone(new Gestures());
  g.down(40, 300, 0);
  assert.equal(g.up(41, 301, 60), null, 'the first tap must wait to see if a second follows');
  assert.equal(g.hasPendingTap(), true);
  // The timer fires: no second tap came, so it is an ordinary tap.
  assert.deepEqual(g.flushPendingTap(), { kind: 'tap', zone: 'left', amount: 0 });

  g.down(320, 300, 1000);
  g.up(320, 300, 1040);
  g.down(320, 300, 1200);
  assert.deepEqual(g.up(321, 300, 1260), { kind: 'double', zone: 'right', amount: 10 });
});

await check('a double tap in the middle is not a seek', () => {
  // There is no direction to read in the centre, and guessing one makes the
  // play/pause button unreliable because it sits right there.
  const g = phone(new Gestures());
  g.down(180, 300, 0);
  g.up(180, 300, 40);
  g.down(180, 300, 120);
  assert.deepEqual(g.up(180, 300, 170), { kind: 'tap', zone: 'center', amount: 0 });
});

await check('two taps too far apart are two taps, not a seek', () => {
  const g = phone(new Gestures({ doubleTapMs: 300 }));
  g.down(40, 300, 0);
  g.up(40, 300, 40);
  g.down(40, 300, 500);
  assert.equal(g.up(40, 300, 540), null, 'a second tap after the window is a new first tap');
  assert.equal(g.flushPendingTap()?.kind, 'tap');
});

await check('a horizontal drag scrubs and never becomes a tap', () => {
  const g = phone(new Gestures({ seekRate: 60 / 360 }));
  g.down(180, 300, 0);
  // Half the screen width is half a minute at this rate.
  assert.deepEqual(g.move(360, 300), { kind: 'seek', zone: 'center', amount: 30 });
  const committed = g.up(360, 302, 400);
  assert.equal(committed.kind, 'seek');
  assert.equal(committed.amount, 30);
  assert.equal(g.hasPendingTap(), false, 'a drag must not leave a tap pending');
});

await check('a drag that curves back to its start is still a drag', () => {
  // Classified once from total displacement: a gesture that returns to where it
  // began must not turn into a tap and pause the video.
  const g = phone(new Gestures());
  g.down(180, 300, 0);
  assert.ok(g.move(300, 300));
  assert.equal(g.up(181, 300, 500).kind, 'seek', 'the movement happened, so it counts');
});

await check('vertical drags use the side they started on', () => {
  const g = phone(new Gestures({ levelRate: 1 / 240 }));
  // Right side, dragged up 120 px: half the range, so volume +0.5.
  g.down(300, 400, 0);
  const up = g.move(302, 280);
  assert.equal(up.kind, 'volume');
  assert.equal(up.amount, 0.5);
  // Left side, dragged down: dimming. Down is darker, so the amount is negative.
  g.down(40, 300, 600);
  const down = g.move(42, 420);
  assert.equal(down.kind, 'dim');
  assert.equal(down.amount, -0.5);
  // The centre column has no vertical action at all.
  g.down(180, 300, 1200);
  assert.equal(g.move(181, 180), null, 'vertical in the middle does nothing');
});

await check('a tiny wobble inside the slop is a tap, not a drag', () => {
  const g = phone(new Gestures({ tapSlop: 10, dragThreshold: 24 }));
  g.down(40, 300, 0);
  assert.equal(g.move(44, 304), null, 'no command yet');
  g.down(40, 300, 1000);
  g.up(47, 306, 1040);
  g.down(40, 300, 1100);
  assert.equal(g.up(46, 303, 1140).kind, 'double');
});

await check('a gesture is cancelled cleanly on reset', () => {
  // The component calls this when the surface unmounts or the stream changes; a
  // half-finished gesture must not act on the new window.
  const g = phone(new Gestures());
  g.down(40, 300, 0);
  g.up(40, 300, 40);
  g.down(180, 300, 500);
  g.reset();
  assert.equal(g.hasPendingTap(), false);
  assert.equal(g.up(180, 300, 560), null);
});

await check('the chrome hides only when nothing is waiting for the viewer', () => {
  const base = { playing: true, pausedByViewer: false, menuOpen: false, busy: false, interacting: true };
  assert.equal(chromeVisible(base), true);
  assert.equal(chromeVisible({ ...base, interacting: false }), false, 'idle while playing hides');
  // Every one of these is a state where the next thing is the viewer pressing
  // something, so hiding the controls strands them.
  assert.equal(chromeVisible({ ...base, interacting: false, pausedByViewer: true }), true);
  assert.equal(chromeVisible({ ...base, interacting: false, playing: false }), true);
  assert.equal(chromeVisible({ ...base, interacting: false, menuOpen: true }), true);
  assert.equal(chromeVisible({ ...base, interacting: false, busy: true }), true);
  assert.ok(IDLE_MS >= 2500 && IDLE_MS <= 5000, 'the idle delay is a few seconds');
});

await check('the seek bar shows played and available separately', () => {
  const s = seekSegments(600, 3600, 120);
  assert.equal(s.played, 600 / 3600);
  assert.ok(Math.abs(s.buffered - (600 + 120) / 3600) < 1e-9);
  // A lagging status report must not drag the bar backwards.
  assert.equal(seekSegments(1800, 3600, -60).buffered, 0.5);
  assert.equal(seekSegments(3600, 3600, 300).buffered, 1, 'never past the end');
  assert.deepEqual(seekSegments(10, 0, 5), { played: 0, buffered: 0 }, 'no duration, no bar');
  assert.equal(seekSegments(10, NaN, 5).played, 0);
});

await check('a tap on the bar lands inside the timeline at a repeatable point', () => {
  assert.equal(seekTarget(0.5, 3600), 1800);
  assert.equal(seekTarget(0.5, 3600), seekTarget(0.5, 3600), 'the same tap lands twice');
  assert.equal(seekTarget(1.4, 3600), 3600, 'a tap past the end is clamped');
  assert.equal(seekTarget(-0.2, 3600), 0);
  assert.equal(seekTarget(0.5, 0), 0);
  assert.equal(seekTarget(NaN, 3600), 0);
});

await check('a gesture overlay says something only when something happened', () => {
  assert.equal(gestureLabel('seek', 0), null, 'no movement, no label');
  assert.equal(gestureLabel('seek', 30), '+30s');
  assert.equal(gestureLabel('seek', -10), '−10s', 'the minus is a real minus sign');
  // Volume is absolute, so the label adds the drag to where the level already is.
  assert.equal(gestureLabel('volume', 0.25, 0.5), 'Volume 75%');
  assert.equal(gestureLabel('volume', 0.9, 0.9), 'Volume 100%', 'clamped, never 180%');
  assert.equal(gestureLabel('dim', -1), 'Brightness 0%');
  assert.equal(gestureLabel('dim', 0), 'Brightness 100%');
  assert.equal(gestureLabel('tap', 0), null);
});

await check('the playback speed is remembered, and only a real speed is trusted', () => {
  // The README has promised "playback speed is saved locally" since the player
  // was written, and nothing ever saved it: every mount and every episode went
  // back to 1x. A rate is a viewing preference, not a property of one film.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  assert.equal(readSpeed(), 1, 'a first visit plays at normal speed');
  saveSpeed(1.5);
  assert.equal(readSpeed(), 1.5);
  // Storage can hold anything; a rate the player cannot play must not reach the
  // element, where it would silently do nothing or throw.
  for (const bogus of ['7', '0', '-1', 'nope', '']) {
    store.set('solo-playback-speed', bogus);
    assert.equal(readSpeed(), 1, `"${bogus}" is not a speed the player offers`);
  }
  assert.ok(SPEEDS.includes(1) && SPEEDS.includes(0.5) && SPEEDS.includes(2));

  // Blocked storage must not take playback down with it.
  globalThis.localStorage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(readSpeed(), 1);
  saveSpeed(2);
});

await check('rotation asks for fullscreen first on the devices where a lock needs it', () => {
  // The shipped button called `lock()` outside fullscreen, which browsers reject,
  // so it failed on every Android device where it would have helped.
  const both = { canLock: true, canUnlock: true, canFullscreen: true, fullscreen: false };
  assert.equal(rotationStrategy(both), 'fullscreen-then-lock');
  assert.equal(rotationStrategy({ ...both, fullscreen: true }), 'lock');
  // iOS Safari: no lock API at all. Fullscreen is still better than portrait, and
  // saying so beats a button that silently does nothing.
  assert.equal(rotationStrategy({ ...both, canLock: false }), 'fullscreen-only');
  // Neither.
  assert.equal(rotationStrategy({ ...both, canLock: false, canFullscreen: false }), 'manual');
});

await check('the rotate button is a toggle, not a one-way trip', () => {
  assert.equal(nextLock(null, 'landscape'), 'landscape');
  assert.equal(nextLock('landscape', 'landscape'), 'portrait', 'and back again');
  assert.equal(nextLock('portrait', 'landscape'), 'landscape');
  // A vertical film wants the app upright with the phone on its side.
  assert.equal(nextLock(null, 'portrait'), 'portrait');
});

await check('a screen lock is given back when the player goes away', () => {
  // The shipped version never unlocked. A lock outlives the page that took it, so
  // the home rail and the settings page stayed sideways until the tab closed.
  assert.equal(shouldRelease('landscape', false), true);
  assert.equal(shouldRelease('landscape', true), false, 'never unlock twice');
  assert.equal(shouldRelease(null, false), false, 'nothing held, nothing to release');
});

await check('the current orientation is read from the screen, not assumed', () => {
  assert.equal(currentOrientation('landscape-primary', false), 'landscape');
  assert.equal(currentOrientation('landscape-secondary', true), 'landscape');
  assert.equal(currentOrientation('portrait-primary', false), 'portrait');
  // Browsers that expose only matchMedia.
  assert.equal(currentOrientation(undefined, true), 'portrait');
  assert.equal(currentOrientation(undefined, false), 'landscape');
  // An unknown type must fall through rather than be guessed as landscape.
  assert.equal(currentOrientation('sideways', true), 'portrait');
});

await check('the viewer is told when rotation could not happen', () => {
  assert.match(rotationNote('manual', null), /turn the phone/i);
  assert.match(rotationNote('fullscreen-only', null), /fullscreen/i);
  assert.equal(rotationNote('lock', 'landscape'), 'Screen locked landscape. Release it in Settings.');
  assert.equal(rotationNote('lock', null), null, 'a released lock needs no note');
});

console.log(results.every(([pass]) => pass) ? '\nall gesture checks passed' : '\nfailures above');
process.exit(results.every(([pass]) => pass) ? 0 : 1);
