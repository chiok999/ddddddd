/**
 * The shape of the player frame.
 *
 * A title is not always 16:9. A feature shot before widescreen is 4:3, and a
 * phone clip is 4:5; boxing either inside a 16:9 screen adds black bars on two
 * sides of every scene. So the frame follows the decoded picture by default, and
 * the viewer can pin a shape when they disagree with the file.
 *
 * The distinction that matters: a pinned shape is a statement about the *box*
 * and applies before any metadata has arrived, while "fit picture" describes the
 * *file* and has nothing to apply until it is known. Conflating the two is what
 * made a pinned 4:5 fall back to 16:9 on every source switch.
 */

export type AspectId = 'auto' | '16:9' | '4:3' | '4:5';

export const ASPECT_MODES = [
  { id: 'auto' as const, label: 'Fit picture', hint: 'Follows the video' },
  { id: '16:9' as const, label: 'Widescreen', hint: '16:9' },
  { id: '4:3' as const, label: 'Classic', hint: '4:3' },
  { id: '4:5' as const, label: 'Vertical', hint: '4:5' },
];

const KEY = 'solo-aspect-ratio';
const DEFAULT_RATIO = 16 / 9;
// A tolerance, not an equality test: two 16:9 sources can report 1920×1080 and
// 1918×1080, and a one-pixel difference should not pin the frame.
const RATIO_TOLERANCE = 0.02;

export const aspectFor = (id: string | null | undefined) =>
  ASPECT_MODES.find((mode) => mode.id === id) || ASPECT_MODES[0];

export const readAspect = (): AspectId => {
  try {
    return aspectFor(localStorage.getItem(KEY)).id;
  } catch {
    // Storage can be blocked in private mode; the default still applies.
    return 'auto';
  }
};

export const saveAspect = (id: AspectId) => {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* the choice still applies to this session */
  }
};

export interface Frame {
  /** CSS `aspect-ratio` value, or null for the 16:9 default. */
  ratio: string | null;
  /** True when the frame is taller than it is wide, which changes the sizing. */
  portrait: boolean;
  /** True when the viewer pinned the shape rather than the file deciding it. */
  fixed: boolean;
}

/**
 * Works out the frame for one picture.
 *
 * `width`/`height` are the decoded size, or 0 before metadata arrives.
 */
export function frameFor(aspect: AspectId, width: number, height: number): Frame {
  const chosen = aspectFor(aspect);
  if (chosen.id !== 'auto') {
    return { ratio: chosen.hint, portrait: chosen.id === '4:5', fixed: true };
  }
  const ratio = width > 0 && height > 0 ? width / height : 0;
  if (!Number.isFinite(ratio) || ratio <= 0) return { ratio: null, portrait: false, fixed: false };
  if (Math.abs(ratio - DEFAULT_RATIO) < RATIO_TOLERANCE) {
    return { ratio: null, portrait: false, fixed: false };
  }
  // The pixel size is used rather than a rounded ratio, so a 636×480 file is
  // framed as 636/480 and not forced onto the nearest standard shape.
  return { ratio: `${width} / ${height}`, portrait: ratio < 1, fixed: false };
}
