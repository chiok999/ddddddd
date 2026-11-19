/**
 * Screen orientation, as a decision rather than a pile of try/catch.
 *
 * The player shipped a "Landscape" button that called `screen.orientation.lock`
 * and nothing else. Three things were wrong with that, and only the first is
 * visible on a desktop:
 *
 * 1. it never called `unlock`, so leaving the player kept the whole app sideways;
 * 2. it called `lock` before entering fullscreen, which browsers reject -- the
 *    spec requires a fullscreen context, so the call failed on every Android
 *    device where it would have helped;
 * 3. iOS Safari does not implement the API at all, so the button did nothing
 *    there with no indication why.
 *
 * What can be done differs per platform, so it is decided here, in one place,
 * and tested. The component only carries out the answer.
 */

export type Strategy =
  /** The lock API works here; lock directly. */
  | 'lock'
  /** Needs a fullscreen context first (Chromium on Android). */
  | 'fullscreen-then-lock'
  /** No lock API (iOS Safari); the best available answer is fullscreen alone. */
  | 'fullscreen-only'
  /** Nothing can be done; the viewer rotates by hand. */
  | 'manual';

export type Lock = 'landscape' | 'portrait' | null;

export interface Environment {
  /** `screen.orientation.lock` exists. */
  canLock: boolean;
  /** `screen.orientation.unlock` exists. */
  canUnlock: boolean;
  /** The element can go fullscreen at all. */
  canFullscreen: boolean;
  /** Already fullscreen. */
  fullscreen: boolean;
}

/**
 * How to rotate on this device.
 *
 * A lock only succeeds inside fullscreen, so a device that can do both needs the
 * fullscreen request first. A device that can only do fullscreen (iOS) gets that,
 * because a fullscreen video is still better than a portrait one, and saying so
 * is more useful than a button that silently does nothing.
 */
export function rotationStrategy(env: Environment): Strategy {
  if (env.canLock) return env.fullscreen ? 'lock' : 'fullscreen-then-lock';
  if (env.canFullscreen) return 'fullscreen-only';
  return 'manual';
}

/**
 * The lock a tap on the rotate button should ask for.
 *
 * It is a toggle: from nothing, landscape; from landscape, portrait. Some videos
 * are vertical, and a viewer who pinned the frame to 4:5 wants the app upright
 * with the phone on its side.
 */
export function nextLock(current: Lock, hint: 'landscape' | 'portrait'): Lock {
  if (current === null) return hint;
  return current === 'landscape' ? 'portrait' : 'landscape';
}

/**
 * Whether a pending lock has to be given back.
 *
 * A screen lock outlives the page that took it: without this the home rail, the
 * search results and the settings page all stay sideways after the viewer leaves
 * the player. `released` is tracked so a lock that was already given back is not
 * unlocked twice.
 */
export function shouldRelease(lock: Lock, released: boolean): boolean {
  return lock !== null && !released;
}

/**
 * What the viewer is looking at now, as far as it can be known.
 *
 * `screen.orientation.type` is the authority; `matchMedia` is the fallback for
 * browsers that expose only that, and a square window is reported as portrait
 * because that is what the CSS media query says.
 */
export function currentOrientation(
  type: string | undefined,
  portraitMatch: boolean,
): 'landscape' | 'portrait' {
  if (type) {
    if (type.startsWith('landscape')) return 'landscape';
    if (type.startsWith('portrait')) return 'portrait';
  }
  return portraitMatch ? 'portrait' : 'landscape';
}

/** One line telling the viewer what happened, or null when nothing did. */
export function rotationNote(strategy: Strategy, locked: Lock): string | null {
  if (strategy === 'manual') return 'This browser cannot rotate the screen; turn the phone instead.';
  if (strategy === 'fullscreen-only') return 'Fullscreen only: this browser cannot lock the rotation.';
  if (locked) return `Screen locked ${locked}. Release it in Settings.`;
  return null;
}
