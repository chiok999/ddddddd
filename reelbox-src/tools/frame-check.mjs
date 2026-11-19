// The frame logic is pure, so it is tested directly rather than through a DOM.
// Each case comes from a behaviour the old player's tests pinned.
import assert from 'node:assert/strict';
import { build } from 'vite';

// Built with the same bundler as the app, into the same scratch directory the
// other checks use, so this needs no extra toolchain.
await build({
  configFile: false,
  logLevel: 'error',
  build: {
    outDir: 'dist-test',
    emptyOutDir: false,
    lib: { entry: 'src/lib/frame.ts', formats: ['es'], fileName: () => 'frame.mjs' },
    minify: false,
  },
});
const { frameFor, aspectFor, readAspect, saveAspect } = await import('../dist-test/frame.mjs');

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

await check('a 4:3 feature sizes its own frame instead of being pillarboxed', () => {
  assert.deepEqual(frameFor('auto', 640, 480), { ratio: '640 / 480', portrait: false, fixed: false });
});

await check('a 4:5 clip is framed tall and marked portrait', () => {
  const frame = frameFor('auto', 480, 600);
  assert.equal(frame.ratio, '480 / 600');
  assert.equal(frame.portrait, true);
});

await check('16:9 uses the default and sets no inline ratio', () => {
  assert.deepEqual(frameFor('auto', 1920, 1080), { ratio: null, portrait: false, fixed: false });
  // Two 16:9 sources can report sizes a pixel apart; that must not pin the frame.
  assert.equal(frameFor('auto', 1918, 1080).ratio, null);
  assert.equal(frameFor('auto', 1440, 810).ratio, null);
});

await check('no metadata yet falls back to the default rather than a broken ratio', () => {
  assert.deepEqual(frameFor('auto', 0, 0), { ratio: null, portrait: false, fixed: false });
  assert.deepEqual(frameFor('auto', NaN, NaN), { ratio: null, portrait: false, fixed: false });
  // The odd case: one dimension known, the other not.
  assert.equal(frameFor('auto', 640, 0).ratio, null);
});

await check('a pinned shape applies before any metadata arrives', () => {
  // This is the behaviour that broke when a pinned 4:5 fell back to 16:9 on
  // every source switch: a chosen box is not a description of the file.
  assert.deepEqual(frameFor('4:5', 0, 0), { ratio: '4:5', portrait: true, fixed: true });
  assert.deepEqual(frameFor('4:3', 0, 0), { ratio: '4:3', portrait: false, fixed: true });
});

await check('a pinned shape overrides a file of a different shape', () => {
  assert.equal(frameFor('4:3', 1920, 1080).ratio, '4:3');
  // Picking 4:5 for a landscape file still caps the height, so it stays portrait.
  assert.equal(frameFor('4:5', 1920, 1080).portrait, true);
  // Picking a widescreen shape for a vertical file removes the cap.
  assert.equal(frameFor('16:9', 480, 600).portrait, false);
});

await check('the choice survives a reload and an unknown value is not trusted', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  assert.equal(readAspect(), 'auto', 'a first visit fits the picture');
  saveAspect('4:5');
  assert.equal(readAspect(), '4:5');
  store.set('solo-aspect-ratio', 'nonsense');
  assert.equal(readAspect(), 'auto', 'a corrupted value falls back to fitting the picture');
  assert.equal(aspectFor('nonsense').id, 'auto');

  // Storage can be blocked; the player must still work.
  globalThis.localStorage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(readAspect(), 'auto');
  saveAspect('4:3');
});

console.log(results.every(([pass]) => pass) ? '\nall frame checks passed' : '\nfailures above');
process.exit(results.every(([pass]) => pass) ? 0 : 1);
