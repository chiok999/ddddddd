/**
 * The shape of the player frame, and how the picture sits inside it.
 *
 * A title is not always 16:9. A feature shot before widescreen is 4:3, a phone
 * clip is 4:5 or 9:16, and a scope film is 2.39:1. Boxing any of those inside a
 * 16:9 screen adds black bars to every scene, so the frame follows the decoded
 * picture by default and the viewer can pin a shape when they disagree with the
 * file.
 *
 * Two distinctions matter, and conflating either is what made the old player
 * feel broken:
 *
 * 1. A pinned shape is a statement about the *box* and applies before any
 *    metadata has arrived; "fit picture" describes the *file* and has nothing to
 *    apply until it is known.
 * 2. The *shape of the box* and the *fit of the picture inside it* are separate
 *    choices. Pinning 4:5 on a 16:9 file used to silently crop it with no way to
 *    see the whole frame. `zoom` is now the viewer's lever for that.
 */

export type AspectId = 'auto' | '16:9' | '4:3' | '4:5' | '2.39:1';

export const ASPECT_MODES = [
  { id: 'auto' as const, label: 'Fit picture', hint: 'Follows the video' },
  { id: '16:9' as const, label: 'Widescreen', hint: '16:9' },
  { id: '4:3' as const, label: 'Classic', hint: '4:3' },
  { id: '4:5' as const, label: 'Vertical', hint: '4:5' },
  { id: '2.39:1' as const, label: 'Cinema', hint: '2.39:1' },
];

/**
 * How the picture fills the box.
 *
 * `fit` shows everything and bars the remainder; `fill` covers the box and
 * crops the overflow; `stretch` distorts to the box exactly, which is the only
 * correct answer for anamorphic material that was never resized on the way out.
 */
export type ZoomId = 'fit' | 'fill' | 'stretch';

export const ZOOM_MODES = [
  { id: 'fit' as const, label: 'Fit', hint: 'Whole picture, bars if the shape differs' },
  { id: 'fill' as const, label: 'Fill', hint: 'Crop the overflow to fill the frame' },
  { id: 'stretch' as const, label: 'Stretch', hint: 'Distort to the frame; fixes anamorphic files' },
];

const KEY = 'solo-aspect-ratio';
const ZOOM_KEY = 'solo-zoom';
// Per-title memory. One vertical film should not change the frame for every
// other title, which is what a single global key did.
const PER_TITLE_KEY = 'solo-aspect-by-title';
const DEFAULT_RATIO = 16 / 9;
// A tolerance, not an equality test: two 16:9 sources can report 1920×1080 and
// 1918×1080, and a one-pixel difference should not pin the frame.
const RATIO_TOLERANCE = 0.02;

export const aspectFor = (id: string | null | undefined) =>
  ASPECT_MODES.find((mode) => mode.id === id) || ASPECT_MODES[0];

export const zoomFor = (id: string | null | undefined) =>
  ZOOM_MODES.find((mode) => mode.id === id) || ZOOM_MODES[0];

const readString = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage can be blocked in private mode; the default still applies.
    return null;
  }
};

const writeString = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* the choice still applies to this session */
  }
};

export const readAspect = (): AspectId => aspectFor(readString(KEY)).id;

export const saveAspect = (id: AspectId) => writeString(KEY, aspectFor(id).id);

export const readZoom = (): ZoomId => zoomFor(readString(ZOOM_KEY)).id;

export const saveZoom = (id: ZoomId) => writeString(ZOOM_KEY, zoomFor(id).id);

const readTitleMap = (): Record<string, string> => {
  try {
    const parsed = JSON.parse(readString(PER_TITLE_KEY) || '{}');
    // Anything that is not a plain object is treated as no memory at all rather
    // than risking a prototype or a string leaking into the lookup.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * The shape pinned for one title, if the viewer pinned one.
 *
 * Falls back to the global default when this title has no memory of its own, so
 * a viewer who never pins anything per title keeps the old behaviour exactly.
 */
export const readAspectFor = (key: string | null | undefined): AspectId =>
  key ? aspectFor(readTitleMap()[key]).id : readAspect();

export function saveAspectFor(key: string | null | undefined, id: AspectId) {
  const next = aspectFor(id).id;
  // The global choice is always written too: it is what a *new* title starts
  // from, and leaving it stale would make the memory invisible.
  saveAspect(next);
  if (!key) return;
  const map = readTitleMap();
  if (next === 'auto') delete map[key];
  else map[key] = next;
  writeString(PER_TITLE_KEY, JSON.stringify(map));
}

export interface Frame {
  /** CSS `aspect-ratio` value, or null for the 16:9 default. */
  ratio: string | null;
  /** True when the frame is taller than it is wide, which changes the sizing. */
  portrait: boolean;
  /** True when the viewer pinned the shape rather than the file deciding it. */
  fixed: boolean;
  /** CSS `object-fit` for the video inside the frame. */
  fit: 'contain' | 'cover' | 'fill';
}

const FIT: Record<ZoomId, Frame['fit']> = { fit: 'contain', fill: 'cover', stretch: 'fill' };

/**
 * Works out the frame for one picture.
 *
 * `width`/`height` are the decoded size, or 0 before metadata arrives.
 * `zoom` defaults to `fit`, which is the non-destructive choice.
 */
export function frameFor(
  aspect: AspectId,
  width: number,
  height: number,
  zoom: ZoomId = 'fit',
): Frame {
  const chosen = aspectFor(aspect);
  const fit = FIT[zoomFor(zoom).id];
  if (chosen.id !== 'auto') {
    return { ratio: chosen.hint, portrait: chosen.id === '4:5', fixed: true, fit };
  }
  const ratio = width > 0 && height > 0 ? width / height : 0;
  if (!Number.isFinite(ratio) || ratio <= 0) return { ratio: null, portrait: false, fixed: false, fit };
  if (Math.abs(ratio - DEFAULT_RATIO) < RATIO_TOLERANCE) {
    return { ratio: null, portrait: false, fixed: false, fit };
  }
  // The pixel size is used rather than a rounded ratio, so a 636×480 file is
  // framed as 636/480 and not forced onto the nearest standard shape.
  return { ratio: `${width} / ${height}`, portrait: ratio < 1, fixed: false, fit };
}

export interface Bars {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Measures baked-in black bars by looking at the picture, not the metadata.
 *
 * A 2.39:1 film letterboxed into a 16:9 file reports 1920×1080 and looks
 * widescreen to every calculation above, so the frame is 16:9 and the viewer sees
 * two black bands that no shape control can remove. Only the pixels know.
 *
 * `pixels` is RGBA, row-major, `width`×`height`. Returns the inset as a fraction
 * of each dimension, all zero when no bars are found. A scanline counts as a bar
 * when essentially every pixel on it is near black: a dark scene that is not a
 * bar always has *some* detail, so the threshold is deliberately tight.
 */
export function detectLetterbox(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  level = 24,
): Bars {
  const none: Bars = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!pixels || width <= 0 || height <= 0) return none;
  if (pixels.length < width * height * 4) return none;
  // How much of a line may be non-black and still count as a bar. A true matte is
  // uniform; an encode can leave a few stray pixels at the edges.
  const allowed = Math.max(1, Math.floor(width * 0.02));
  const dark = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    // Rec. 601 luma on the stored values; the exact weights barely matter at this
    // threshold, but using luma rather than "all three channels" stops a deep
    // blue dark frame from being mistaken for a bar.
    return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2] <= level;
  };
  const rowIsBar = (y: number) => {
    let bright = 0;
    for (let x = 0; x < width; x++) if (!dark(x, y)) bright++;
    return bright <= allowed;
  };
  const colIsBar = (x: number) => {
    let bright = 0;
    for (let y = 0; y < height; y++) if (!dark(x, y)) bright++;
    return bright <= allowed;
  };
  let top = 0;
  while (top < height && rowIsBar(top)) top++;
  // All black means no picture to frame, not "everything is a bar".
  if (top === height) return none;
  let bottom = height - 1;
  while (bottom > top && rowIsBar(bottom)) bottom--;
  let left = 0;
  while (left < width && colIsBar(left)) left++;
  let right = width - 1;
  while (right > left && colIsBar(right)) right--;
  const bars = {
    top: top / height,
    right: (width - 1 - right) / width,
    bottom: (height - 1 - bottom) / height,
    left: left / width,
  };
  // A bar thinner than a percent is noise, and acting on it would crop a frame
  // for no visible gain.
  const useful = (n: number) => (n >= 0.01 ? Number(n.toFixed(4)) : 0);
  return {
    top: useful(bars.top),
    right: useful(bars.right),
    bottom: useful(bars.bottom),
    left: useful(bars.left),
  };
}

/**
 * The shape left after cropping detected bars, as a CSS ratio, or null when there
 * is nothing worth cropping.
 */
export function trimRatio(
  width: number,
  height: number,
  bars: Bars,
): string | null {
  if (width <= 0 || height <= 0) return null;
  // Nothing detected means nothing to offer. Without this the identity crop comes
  // back as a ratio equal to the source, which is a "fix" that changes nothing.
  if (!(bars.top || bars.right || bars.bottom || bars.left)) return null;
  const kept =
    (width * Math.max(0, 1 - bars.left - bars.right)) /
    (height * Math.max(0, 1 - bars.top - bars.bottom));
  if (!Number.isFinite(kept) || kept <= 0) return null;
  if (Math.abs(kept - DEFAULT_RATIO) < RATIO_TOLERANCE) return null;
  return String(Number(kept.toFixed(4)));
}
