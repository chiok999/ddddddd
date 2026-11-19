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
const { frameFor, aspectFor, readAspect, saveAspect, zoomFor, readZoom, saveZoom, readAspectFor, saveAspectFor, detectLetterbox, trimRatio } =
  await import('../dist-test/frame.mjs');

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
  assert.deepEqual(frameFor('auto', 640, 480), { ratio: '640 / 480', portrait: false, fixed: false, fit: 'contain' });
});

await check('a 4:5 clip is framed tall and marked portrait', () => {
  const frame = frameFor('auto', 480, 600);
  assert.equal(frame.ratio, '480 / 600');
  assert.equal(frame.portrait, true);
});

await check('16:9 uses the default and sets no inline ratio', () => {
  assert.deepEqual(frameFor('auto', 1920, 1080), { ratio: null, portrait: false, fixed: false, fit: 'contain' });
  // Two 16:9 sources can report sizes a pixel apart; that must not pin the frame.
  assert.equal(frameFor('auto', 1918, 1080).ratio, null);
  assert.equal(frameFor('auto', 1440, 810).ratio, null);
});

await check('no metadata yet falls back to the default rather than a broken ratio', () => {
  assert.deepEqual(frameFor('auto', 0, 0), { ratio: null, portrait: false, fixed: false, fit: 'contain' });
  assert.deepEqual(frameFor('auto', NaN, NaN), { ratio: null, portrait: false, fixed: false, fit: 'contain' });
  // The odd case: one dimension known, the other not.
  assert.equal(frameFor('auto', 640, 0).ratio, null);
});

await check('a pinned shape applies before any metadata arrives', () => {
  // This is the behaviour that broke when a pinned 4:5 fell back to 16:9 on
  // every source switch: a chosen box is not a description of the file.
  assert.deepEqual(frameFor('4:5', 0, 0), { ratio: '4:5', portrait: true, fixed: true, fit: 'contain' });
  assert.deepEqual(frameFor('4:3', 0, 0), { ratio: '4:3', portrait: false, fixed: true, fit: 'contain' });
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

await check('a scope film gets its own frame instead of being letterboxed twice', () => {
  // 2.39:1 is the most common feature shape and had no mode at all, so it was
  // framed at 16:9 and gained bars on top of the bars already in the file.
  assert.equal(frameFor('auto', 1920, 804).ratio, '1920 / 804');
  assert.equal(frameFor('2.39:1', 0, 0).ratio, '2.39:1');
  assert.equal(frameFor('2.39:1', 0, 0).portrait, false);
});

await check('zoom decides how the picture fills the frame, independently of its shape', () => {
  // The bug this exists for: pinning 4:5 on a 16:9 file cropped it silently with
  // no way to see the whole picture. Shape and fit are separate choices now.
  assert.equal(frameFor('4:5', 1920, 1080, 'fit').fit, 'contain');
  assert.equal(frameFor('4:5', 1920, 1080, 'fill').fit, 'cover');
  assert.equal(frameFor('4:5', 1920, 1080, 'stretch').fit, 'fill');
  // Zoom must not change the box itself -- only the picture inside it.
  assert.equal(frameFor('4:5', 1920, 1080, 'fill').ratio, '4:5');
  assert.equal(frameFor('auto', 640, 480, 'fill').ratio, '640 / 480');
  // An unknown or missing zoom is the non-destructive one.
  assert.equal(frameFor('4:3', 640, 480, 'nonsense').fit, 'contain');
  assert.equal(frameFor('4:3', 640, 480).fit, 'contain');
  assert.equal(zoomFor('nonsense').id, 'fit');
});

await check('the zoom choice survives a reload', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  assert.equal(readZoom(), 'fit');
  saveZoom('fill');
  assert.equal(readZoom(), 'fill');
  store.set('solo-zoom', 'nonsense');
  assert.equal(readZoom(), 'fit');
});

await check('a frame pinned for one title does not follow the viewer to the next', () => {
  // A single global key meant pinning Vertical for one phone-shot film changed
  // every other title too. The global value is now only what a new title starts
  // from.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  saveAspect('auto');
  saveAspectFor('movie:one', '4:5');
  assert.equal(readAspectFor('movie:one'), '4:5', 'the pinned title remembers');
  assert.equal(readAspectFor('movie:two'), 'auto', 'another title does not inherit it');
  // ...while the global default is still updated, because that is what the next
  // *new* title starts from and a stale value would make the choice invisible.
  assert.equal(readAspect(), '4:5');

  // Returning a title to "fit picture" must forget it rather than pin 'auto'.
  saveAspectFor('movie:one', 'auto');
  assert.equal(readAspectFor('movie:one'), 'auto');
  saveAspectFor('movie:one', '16:9');
  saveAspectFor('movie:one', 'auto');
  const map = JSON.parse(store.get('solo-aspect-by-title'));
  assert.deepEqual(map, {}, 'auto is the absence of a pin, not a stored pin');

  // A corrupt map must read as no memory at all, not throw.
  store.set('solo-aspect-by-title', '{"movie:x":["not","a","mode"]}');
  assert.equal(readAspectFor('movie:x'), 'auto');
  store.set('solo-aspect-by-title', 'not json');
  assert.equal(readAspectFor('movie:one'), 'auto');
  assert.equal(readAspectFor(null), 'auto');
});

await check('baked-in black bars are measured from the picture, not the metadata', () => {
  // A 2.39:1 film letterboxed into 16:9 reports 1920x1080, so every calculation
  // above thinks it is widescreen and the viewer sees two bands no shape control
  // can remove. Only the pixels know.
  const width = 100, height = 100;
  const make = (bandTop, bandBottom) => {
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const isBar = y < bandTop || y >= height - bandBottom;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        // A gradient, so "detail everywhere" is the thing being distinguished.
        const v = isBar ? 0 : 40 + ((x + y) % 200);
        pixels[i] = v; pixels[i + 1] = v; pixels[i + 2] = v; pixels[i + 3] = 255;
      }
    }
    return pixels;
  };

  const bars = detectLetterbox(make(12, 12), width, height);
  assert.equal(bars.top, 0.12);
  assert.equal(bars.bottom, 0.12);
  assert.equal(bars.left, 0);
  assert.equal(bars.right, 0);

  // The resulting frame is the picture without the bands, which is close to 2.39.
  const ratio = Number(trimRatio(width, height, bars));
  assert.ok(Math.abs(ratio - 100 / 76) < 0.01, `expected ~${(100 / 76).toFixed(3)}, got ${ratio}`);

  // No bars: a full-frame picture must not be cropped.
  assert.deepEqual(detectLetterbox(make(0, 0), width, height), { top: 0, right: 0, bottom: 0, left: 0 });
  assert.equal(trimRatio(width, height, { top: 0, right: 0, bottom: 0, left: 0 }), null);

  // Pillarbox is the other axis and must be found too.
  const piller = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = x < 10 || x >= width - 10 ? 0 : 60 + ((x * y) % 180);
      piller[i] = v; piller[i + 1] = v; piller[i + 2] = v; piller[i + 3] = 255;
    }
  }
  const pill = detectLetterbox(piller, width, height);
  assert.equal(pill.left, 0.1);
  assert.equal(pill.right, 0.1);
  // Pillarboxing is the other direction: the picture is *narrower* than the
  // frame, so the trimmed ratio drops below 1 for this square source.
  assert.ok(Math.abs(Number(trimRatio(width, height, pill)) - 0.8) < 0.001);

  // A frame that is entirely black is not "all bar": there is no picture to frame.
  const black = new Uint8Array(width * height * 4);
  assert.deepEqual(detectLetterbox(black, width, height), { top: 0, right: 0, bottom: 0, left: 0 });

  // A bar thinner than a percent is noise and must not trigger a crop.
  assert.equal(detectLetterbox(make(0, 0), width, height).bottom, 0);
  assert.deepEqual(detectLetterbox(null, width, height), { top: 0, right: 0, bottom: 0, left: 0 });
  assert.deepEqual(detectLetterbox(new Uint8Array(4), width, height), { top: 0, right: 0, bottom: 0, left: 0 });
});

console.log(results.every(([pass]) => pass) ? '\nall frame checks passed' : '\nfailures above');
process.exit(results.every(([pass]) => pass) ? 0 : 1);
