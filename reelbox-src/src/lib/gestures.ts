/**
 * Touch intent for the player surface.
 *
 * The README has promised double-tap-to-seek and the two swipe zones since the
 * player was written, and none of it existed. Rather than wire that into the
 * component where it cannot be tested, the classification lives here as a pure
 * state machine: the component feeds it pointer events and acts on the commands
 * it returns.
 *
 * The hard part is not recognising a double tap. It is that every gesture has a
 * near-miss neighbour -- a tap is a swipe that did not move, a double tap is two
 * taps within a window, and a horizontal drag across the screen midpoint is the
 * same motion in a different zone -- and a player that guesses wrong is worse
 * than one with no gestures at all. So movement is classified once, from the
 * total displacement, and never re-classified mid-gesture.
 */

export type Zone = 'left' | 'right' | 'center';
export type GestureKind = 'tap' | 'double' | 'seek' | 'volume' | 'dim' | 'none';

export interface GestureCommand {
  kind: GestureKind;
  /** Which third of the surface the gesture started in. */
  zone: Zone;
  /** Signed seconds for `seek`, signed fraction for `volume` and `dim`. */
  amount: number;
}

export interface GestureOptions {
  /** Below this the gesture is a tap, in CSS pixels. */
  tapSlop?: number;
  /** Above this a vertical drag starts controlling volume and dimming. */
  dragThreshold?: number;
  /** Two taps closer together than this are a double tap, in ms. */
  doubleTapMs?: number;
  /** Horizontal drag to full-width ratio: seconds of seek per pixel. */
  seekRate?: number;
  /** Vertical drag to full-height ratio: volume and dim per pixel. */
  levelRate?: number;
}

const DEFAULTS = {
  tapSlop: 10,
  dragThreshold: 24,
  doubleTapMs: 300,
  // A full screen width is about a minute of scrub, which is the range a viewer
  // can aim with a thumb. Dividing by height instead makes it depend on the
  // device, and a tall phone should not scrub faster than a short one.
  seekRate: 60 / 360,
  levelRate: 1 / 240,
};

const zoneFor = (x: number, width: number): Zone => {
  if (!(width > 0)) return 'center';
  if (x < width / 3) return 'left';
  if (x > (width * 2) / 3) return 'right';
  return 'center';
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * One reused classifier. `down` opens a gesture, `move` reports the live amount
 * for on-screen feedback, and `up` commits it.
 */
export class Gestures {
  private opts: Required<GestureOptions>;
  private start: { x: number; y: number; t: number; zone: Zone } | null = null;
  /** Set once a gesture has been classified, and never revised. */
  private committed: GestureKind | null = null;
  private width = 0;
  private height = 0;
  /** A completed tap waiting to find out whether a second one follows. */
  private pendingTap: { at: number; zone: Zone } | null = null;

  constructor(options: GestureOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** The surface being gestured on. Called on every `down` so rotation is free. */
  setSurface(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  down(x: number, y: number, at: number) {
    this.start = { x, y, t: at, zone: zoneFor(x, this.width) };
    this.committed = null;
  }

  /**
   * The live amount for a gesture in progress, or null while it is still
   * ambiguous. This is what drives the "▲ 12%" style overlay.
   */
  move(x: number, y: number): GestureCommand | null {
    const start = this.start;
    if (!start) return null;
    const dx = x - start.x;
    const dy = y - start.y;
    // Classified on total displacement and then held: a drag that curves back
    // towards the start must not turn into a tap, and a mostly-vertical drag must
    // not become a seek halfway through.
    if (Math.abs(dx) < this.opts.dragThreshold && Math.abs(dy) < this.opts.dragThreshold) return null;
    // Once this gesture has moved far enough to be a drag it stays one, even if
    // the finger comes back to where it started. Re-classifying on each move is
    // what turns a scrub that changes its mind into a tap that pauses the video.
    if (!this.committed) this.committed = this.classify(dx, dy, start.zone);
    if (this.committed === 'seek') {
      return { kind: 'seek', zone: start.zone, amount: this.seekAmount(dx) };
    }
    // Vertical is volume on the right and dim on the left, which is the
    // convention every phone player uses and the README promised. Up is more.
    if (this.committed === 'volume') return { kind: 'volume', zone: start.zone, amount: this.levelAmount(dy) };
    if (this.committed === 'dim') return { kind: 'dim', zone: start.zone, amount: this.levelAmount(dy) };
    // The middle has no vertical action; it is where the picture is.
    return null;
  }

  /** Which gesture a displacement of this size means, in this zone. */
  private classify(dx: number, dy: number, zone: Zone): GestureKind {
    // Horizontal is always seek, wherever it started, because there is no
    // competing action on that axis.
    if (Math.abs(dx) > Math.abs(dy)) return 'seek';
    if (zone === 'right') return 'volume';
    if (zone === 'left') return 'dim';
    return 'none';
  }

  /** Seconds of seek for a horizontal drag, snapped to whole seconds. */
  seekAmount(dx: number) {
    return Math.round(dx * this.opts.seekRate);
  }

  /** Fraction of the full level for a vertical drag. Up (negative dy) increases. */
  levelAmount(dy: number) {
    return clamp(-dy * this.opts.levelRate, -1, 1);
  }

  /**
   * Ends the gesture. Returns one command, or null when the gesture did nothing
   * a caller should act on -- which includes the first tap of a double tap, since
   * committing it would pause the video a fraction of a second before seeking it.
   */
  up(x: number, y: number, at: number): GestureCommand | null {
    const start = this.start;
    this.start = null;
    if (!start) return null;
    const dx = x - start.x;
    const dy = y - start.y;
    const moved =
      this.committed !== null ||
      Math.abs(dx) >= this.opts.dragThreshold ||
      Math.abs(dy) >= this.opts.dragThreshold;

    if (moved) {
      this.pendingTap = null;
      this.committed = null;
      return this.moveAmountFor(dx, dy, start.zone);
    }

    const isTap = Math.abs(dx) < this.opts.tapSlop && Math.abs(dy) < this.opts.tapSlop;
    if (!isTap) return null;

    const pending = this.pendingTap;
    if (pending && at - pending.at <= this.opts.doubleTapMs) {
      this.pendingTap = null;
      // A double tap in the middle is not a seek: there is no direction to read,
      // and treating it as one makes the play/pause button unreliable.
      if (pending.zone === 'center') return { kind: 'tap', zone: 'center', amount: 0 };
      const sign = pending.zone === 'left' ? -1 : 1;
      // Double taps accumulate outward from the edge against a 10 s step, so two
      // quick double taps are 20 s without needing a third threshold.
      return { kind: 'double', zone: pending.zone, amount: sign * 10 };
    }

    // First tap: remember it and say nothing. The caller shows the controls, and
    // if no second tap arrives it never learns this happened.
    this.pendingTap = { at, zone: start.zone };
    return null;
  }

  /** True while a tap is waiting to see whether it becomes a double tap. */
  hasPendingTap() {
    return this.pendingTap !== null;
  }

  /** Called by a timer: the pending tap expired without a partner. */
  flushPendingTap(): GestureCommand | null {
    const pending = this.pendingTap;
    this.pendingTap = null;
    return pending ? { kind: 'tap', zone: pending.zone, amount: 0 } : null;
  }

  reset() {
    this.start = null;
    this.pendingTap = null;
    this.committed = null;
  }

  private moveAmountFor(dx: number, dy: number, zone: Zone): GestureCommand | null {
    const kind = this.classify(dx, dy, zone);
    if (kind === 'seek') return { kind, zone, amount: this.seekAmount(dx) };
    if (kind === 'volume' || kind === 'dim') return { kind, zone, amount: this.levelAmount(dy) };
    return null;
  }
}
