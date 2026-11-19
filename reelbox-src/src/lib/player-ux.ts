/**
 * When the player chrome is on screen, and what the seek bar shows.
 *
 * Both were single booleans in the component: `show` was a 2.5 s timer and the
 * seek bar drew only the played position. That is enough for a mouse and wrong
 * for a phone -- controls vanished while the settings sheet was open, vanished
 * while paused (so the only way to press play again was to tap and wait), and the
 * bar gave no sign of how much was already downloaded during a conversion.
 */

export interface ChromeInput {
  playing: boolean;
  /** Paused by the viewer rather than by the buffering guard. */
  pausedByViewer: boolean;
  /** A settings sheet, the episode list, or a volume slider is open. */
  menuOpen: boolean;
  /** Still resolving or converting: there is nothing to watch yet. */
  busy: boolean;
  /** The viewer has touched the surface in the last few seconds. */
  interacting: boolean;
}

/**
 * Whether the chrome should be visible.
 *
 * The rule is "hide only when nothing is waiting for the viewer": a paused video
 * keeps its controls, an open menu keeps them, and a conversion keeps them,
 * because in all three the next thing that happens is the viewer pressing
 * something. Anything else hides after the idle delay.
 */
export function chromeVisible(input: ChromeInput): boolean {
  if (input.busy || input.menuOpen) return true;
  if (input.pausedByViewer || !input.playing) return true;
  return input.interacting;
}

/** How long a touch keeps the chrome up while playing. */
export const IDLE_MS = 3200;

/** A long enough drag that treating it as a tap would be a mistake, in px. */
export const TAP_SLOP = 10;

export interface Segments {
  /** Played, as a fraction of the whole timeline, 0..1. */
  played: number;
  /** Downloaded or converted ahead of the playhead, 0..1. */
  buffered: number;
}

/**
 * Seek-bar fractions for the played position and the already-available span.
 *
 * `ahead` is seconds of finished output from the server; `window` is the seconds
 * of timeline that output covers starting at the playhead. Both are clamped,
 * because a lagging status report can arrive out of order and a bar that runs
 * backwards looks like a glitch.
 */
export function seekSegments(
  position: number,
  duration: number,
  ahead: number,
): Segments {
  if (!(duration > 0)) return { played: 0, buffered: 0 };
  const played = Math.min(1, Math.max(0, position / duration));
  const aheadFraction = Number.isFinite(ahead) && ahead > 0 ? ahead / duration : 0;
  return { played, buffered: Math.min(1, played + aheadFraction) };
}

/**
 * The time a tap at `fraction` of the bar should seek to.
 *
 * Snapped to a tenth of a second so the same tap twice lands in the same place,
 * and clamped inside the timeline because a tap on the very end of a range input
 * reports slightly past it in some browsers.
 */
export function seekTarget(fraction: number, duration: number): number {
  if (!(duration > 0) || !Number.isFinite(fraction)) return 0;
  const clamped = Math.min(1, Math.max(0, fraction));
  return Number((clamped * duration).toFixed(1));
}

/**
 * A short label for a gesture in progress, for the on-screen overlay.
 *
 * Returns null when there is nothing worth saying, so the overlay does not flash
 * for a drag too small to have done anything.
 */
export function gestureLabel(kind: string, amount: number, current?: number): string | null {
  if (kind === 'seek') {
    if (!amount) return null;
    return `${amount > 0 ? '+' : '−'}${Math.abs(amount)}s`;
  }
  if (kind === 'volume') {
    const level = Math.round(Math.min(1, Math.max(0, (current ?? 0) + amount)) * 100);
    return `Volume ${level}%`;
  }
  if (kind === 'dim') {
    // Dimming is expressed as remaining brightness so "100%" always means full.
    const level = Math.round(Math.min(1, Math.max(0, 1 + amount)) * 100);
    return `Brightness ${level}%`;
  }
  return null;
}
