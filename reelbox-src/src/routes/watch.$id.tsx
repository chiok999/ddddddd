import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import {
  ArrowLeft,
  Captions,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Lock as LockIcon,
  LockOpen,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { Playback, type PlaybackState, type SubtitleState } from '../lib/playback';
import {
  aspectFor,
  ASPECT_MODES,
  frameFor,
  readAspectFor,
  readZoom,
  saveAspectFor,
  saveZoom,
  trimRatio,
  detectLetterbox,
  zoomFor,
  ZOOM_MODES,
  type AspectId,
  type ZoomId,
} from '../lib/frame';
import { Gestures, type GestureCommand } from '../lib/gestures';
import {
  currentOrientation,
  nextLock,
  rotationNote,
  rotationStrategy,
  shouldRelease,
  type Lock as ScreenLock,
} from '../lib/orientation';
import { chromeVisible, gestureLabel, seekSegments, seekTarget, IDLE_MS } from '../lib/player-ux';
import { api, type Episode } from '../lib/api';
import { itemStore } from '../lib/item-store';
import {
  clearProgress,
  pushHistory,
  readQuality,
  readSaver,
  readSpeed,
  readProgress,
  saveHeight,
  saveProgress,
  saveSaver,
  saveSpeed,
  SPEEDS,
} from '../lib/library';

interface Search {
  s?: number;
  e?: number;
}

export const Route = createFileRoute('/watch/$id')({
  validateSearch: (raw: Record<string, unknown>): Search => ({
    s: raw.s ? Number(raw.s) : undefined,
    e: raw.e ? Number(raw.e) : undefined,
  }),
  head: () => ({ meta: [{ title: 'Watching — ReelBox' }, { name: 'description', content: 'Watch on ReelBox.' }] }),
  component: Watch,
});

const fmt = (seconds: number) => {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

function Watch() {
  const { id } = Route.useParams();
  const { s, e } = Route.useSearch();
  const navigate = Route.useNavigate();
  const found = itemStore.get(id);
  const item = found;
  const [recovering, setRecovering] = useState(false);
  const [lost, setLost] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const engine = useRef<Playback | null>(null);

  const [state, setState] = useState<PlaybackState>({
    phase: 'idle',
    message: '',
    tried: [],
    duration: null,
    seekBase: 0,
    providers: '',
    subtitleUrl: null,
  });
  const [subs, setSubs] = useState<SubtitleState>({ available: false, on: false, note: '' });
  const [aspect, setAspect] = useState<AspectId>(() => readAspectFor(null));
  const [zoom, setZoom] = useState<ZoomId>(() => readZoom());
  const [picture, setPicture] = useState({ width: 0, height: 0 });
  /** Shape left after removing baked-in bars, when there are any worth removing. */
  const [trimmed, setTrimmed] = useState<string | null>(null);
  /** True when the viewer asked to crop those bars rather than live with them. */
  const [cropped, setCropped] = useState(false);
  /**
   * The screen lock this player holds, if any. A lock outlives the component, so
   * this is state that has to be given back rather than a setting.
   */
  const [lock, setLock] = useState<ScreenLock>(null);
  const [lockReleased, setLockReleased] = useState(false);
  const [orientation, setOrientation] = useState<'landscape' | 'portrait'>(() =>
    currentOrientation(undefined, true),
  );
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [ahead, setAhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [vol, setVol] = useState(1);
  const [rate, setRate] = useState(() => readSpeed());
  // `height` is what the viewer asked for; the rung actually downloaded may be
  // smaller when data saver is on or the connection says it is metered.
  const [height, setHeight] = useState(240);
  const [saver, setSaver] = useState(false);
  const [menu, setMenu] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [locked, setLocked] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [touch, setTouch] = useState(false);
  const [overlay, setOverlay] = useState<{ key: number; text: string } | null>(null);
  const [dim, setDim] = useState(0);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [nextUp, setNextUp] = useState(false);

  const gestures = useRef(new Gestures());
  const pendingTap = useRef<number | undefined>(undefined);
  const idleTimer = useRef<number | undefined>(undefined);
  const overlayTimer = useRef<number | undefined>(undefined);
  const [interacting, setInteracting] = useState(true);
  const dimRef = useRef(0);

  const progressKey = item ? `${item.source}:${item.title}:${item.year}:${item.type}:${s ?? 1}:${e ?? 1}` : '';

  /** Keeps the chrome up for a moment after any input. */
  const poke = useCallback(() => {
    setInteracting(true);
    clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setInteracting(false), IDLE_MS);
  }, []);

  const flash = useCallback((text: string | null) => {
    if (!text) return;
    setOverlay({ key: Date.now(), text });
    clearTimeout(overlayTimer.current);
    overlayTimer.current = window.setTimeout(() => setOverlay(null), 900);
  }, []);

  // One engine per mounted player. It reports on its own clock, so the UI only
  // renders what the engine knows rather than polling the element separately.
  useEffect(() => {
    if (!item) return;
    const playback = new Playback({
      onState: setState,
      onSubtitle: setSubs,
      onProgress: (position, total, paused, lead) => {
        setTime(position);
        setDuration(total ?? 0);
        // Seconds of finished conversion past the playhead: the seek bar's second
        // layer, so the viewer can see how much is already downloaded.
        if (typeof lead === 'number') setAhead(lead);
        if (position > 5 && progressKey) saveProgress(progressKey, position);
        void paused;
      },
    });
    engine.current = playback;
    setHeight(readQuality());
    setSaver(readSaver());
    setAspect(readAspectFor(progressKey || null));
    // Applies the saved rung to this stream now, rather than only when the
    // settings menu is opened.
    playback.setQuality(readQuality());
    playback.attach(video.current);

    const startAt = progressKey ? readProgress().find((x) => x.url === progressKey)?.time : 0;
    void playback.start(
      {
        id: item.id,
        title: item.title,
        type: item.type,
        source: item.source,
        season: s ?? 1,
        episode: e ?? 1,
        progressKey,
      },
      // Resume only when the saved point is meaningfully into the title and the
      // caller did not pick an episode explicitly.
      startAt && s === undefined ? startAt : undefined,
    );
    pushHistory(item.id);
    poke();

    return () => {
      playback.attach(null);
      void playback.stop();
      engine.current = null;
    };
    // Starting again is an explicit user action (a retry button), never a render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, s, e]);

  // The episode list is what makes previous/next and "next up" possible in the
  // player. It is the same endpoint the title page uses; the player never had it.
  useEffect(() => {
    if (!item || !e) return;
    let live = true;
    void api
      .episodes(item.id)
      .then((r) => live && setEpisodes(r.episodes || []))
      .catch(() => live && setEpisodes([]));
    return () => {
      live = false;
    };
  }, [item?.id, e]);

  const ordered = useMemo(
    () => [...episodes].sort((a, b) => a.season - b.season || a.episode - b.episode),
    [episodes],
  );
  const position = e !== undefined ? ordered.findIndex((x) => x.season === (s ?? 1) && x.episode === e) : -1;
  const prevEpisode = position > 0 ? ordered[position - 1] : null;
  const nextEpisode = position >= 0 && position < ordered.length - 1 ? ordered[position + 1] : null;

  const goEpisode = (ep: Episode) => {
    navigate({ to: '/watch/$id', params: { id: item!.id }, search: { s: ep.season, e: ep.episode } });
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const playback = engine.current;
      if (!playback) return;
      const target = ev.target as HTMLElement | null;
      // Typing in a field must never seek or toggle; the settings sheet has none
      // today, but a range input does and this is cheap insurance.
      if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName) && ev.code !== 'Space') return;
      if (ev.code === 'Space') {
        ev.preventDefault();
        playback.toggle();
      }
      if (ev.key === 'ArrowRight') playback.seek(playback.totalTime() + 10);
      if (ev.key === 'ArrowLeft') playback.seek(playback.totalTime() - 10);
      if (ev.key === 'm') setMuted((x) => !x);
      if (ev.key === 'f') void toggleFullscreen();
      if (ev.key === 'Escape' && locked) setLocked(false);
      poke();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [poke, locked]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.muted = muted;
    v.volume = vol;
  }, [muted, vol]);

  useEffect(() => {
    engine.current?.setRate(rate);
    // Remembered across titles and episodes: a rate is a viewing preference, not
    // a property of one film.
    saveSpeed(rate);
  }, [rate]);

  // Fullscreen state is read from the document rather than remembered, because
  // the viewer can leave it with the system gesture or the back button.
  useEffect(() => {
    const onFs = () => {
      setFullscreen(document.fullscreenElement === box.current);
      // Any fullscreen change resizes the surface; the gesture zone map must not
      // keep the portrait dimensions.
      const el = box.current;
      if (el) gestures.current.setSurface(el.clientWidth, el.clientHeight);
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // The orientation is read from the screen rather than assumed, so the button's
  // label and the frame stay honest when the viewer rotates the phone by hand.
  useEffect(() => {
    const read = () => setOrientation(currentOrientation((screen.orientation as any)?.type, matchMedia('(orientation: portrait)').matches));
    read();
    const mq = matchMedia('(orientation: portrait)');
    mq.addEventListener?.('change', read);
    screen.orientation?.addEventListener?.('change', read as any);
    return () => {
      mq.removeEventListener?.('change', read);
      screen.orientation?.removeEventListener?.('change', read as any);
    };
  }, []);

  // A lock taken here must not outlive the player: without this the home rail and
  // the settings page stay sideways after the viewer leaves.
  useEffect(() => {
    return () => {
      if (!shouldRelease(lock, lockReleased)) return;
      try {
        (screen.orientation as any)?.unlock?.();
      } catch {
        /* the browser will drop it with the document */
      }
    };
  }, [lock, lockReleased]);

  // The screen must not sleep under a playing film. Best-effort: the API needs a
  // visible document and a gesture in some browsers, so failure is silent.
  useEffect(() => {
    let sentinel: any = null;
    if (!playing || document.hidden) return;
    const nav = navigator as any;
    if (!nav.wakeLock?.request) return;
    void nav.wakeLock
      .request('screen')
      .then((s: any) => {
        sentinel = s;
      })
      .catch(() => {});
    return () => {
      void sentinel?.release?.().catch(() => {});
    };
  }, [playing]);

  useEffect(() => () => clearTimeout(pendingTap.current), []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await box.current?.requestFullscreen();
    } catch {
      /* some browsers refuse without a gesture; the button is best-effort */
    }
  };

  /**
   * Rotates the screen, taking the fullscreen and no-API cases into account.
   *
   * A lock only succeeds inside fullscreen, so the request goes after entering
   * it rather than before -- doing it the other way round is why this used to
   * fail on every Android device. Where there is no lock API (iOS Safari) the
   * fullscreen request is still worth making, and the viewer is told what
   * happened instead of pressing a button that appears dead.
   */
  const rotate = async () => {
    const api = (screen.orientation || {}) as any;
    const strategy = rotationStrategy({
      canLock: typeof api.lock === 'function',
      canUnlock: typeof api.unlock === 'function',
      canFullscreen: !!box.current?.requestFullscreen,
      fullscreen,
    });
    // A vertical film wants the app upright; a normal one wants it on its side.
    const hint = aspect === '4:5' ? 'portrait' : 'landscape';
    const want = nextLock(lock, hint);
    try {
      if (strategy === 'fullscreen-then-lock') await box.current?.requestFullscreen();
      if (strategy === 'lock' || strategy === 'fullscreen-then-lock') await api.lock(want);
      if (strategy === 'lock' || strategy === 'fullscreen-then-lock') {
        setLock(want);
        setLockReleased(false);
      }
    } catch {
      // Browsers refuse outside a gesture, in an iframe, or with the screen locked
      // by the OS. The note below is the whole failure surface.
    }
    flash(rotationNote(strategy, strategy === 'lock' || strategy === 'fullscreen-then-lock' ? want : null));
  };

  /** Gives the lock back without rotating anything. */
  const releaseLock = () => {
    const api = (screen.orientation || {}) as any;
    try {
      if (typeof api.unlock === 'function') api.unlock();
    } catch {
      /* nothing to do; the page is leaving anyway */
    }
    setLock(null);
    setLockReleased(true);
  };

  const pip = async () => {
    const v = video.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      /* not supported on this browser */
    }
  };

  const changeQuality = (next: number) => {
    setHeight(next);
    saveHeight(next);
    // Choosing a rung by hand overrides data saver for the rest of the session,
    // otherwise the toggle would silently undo the choice on the next title.
    if (saver) {
      setSaver(false);
      saveSaver(false);
    }
    engine.current?.setQuality(next);
  };

  const toggleSaver = () => {
    const next = !saver;
    setSaver(next);
    saveSaver(next);
    const rung = next ? 240 : height;
    setHeight(rung);
    saveHeight(rung);
    engine.current?.setQuality(rung);
  };

  const retry = () => {
    if (!item) return;
    void engine.current?.start(
      {
        id: item.id,
        title: item.title,
        type: item.type,
        source: item.source,
        season: s ?? 1,
        episode: e ?? 1,
        progressKey,
      },
      state.seekBase || undefined,
    );
  };

  // A player link can outlive its entry — a resume link, a bookmark, a shared
  // address. The id is still Troy's, so the title is looked up again and the URL
  // moved onto the fresh one rather than leaving a dead page.
  useEffect(() => {
    if (found) return;
    let live = true;
    setRecovering(true);
    itemStore.recover(id).then((recovered) => {
      if (!live) return;
      setRecovering(false);
      if (!recovered) return setLost(true);
      navigate({
        to: '/watch/$id',
        params: { id: recovered.id },
        search: { s: s ?? undefined, e: e ?? undefined },
        replace: true,
      });
    });
    return () => {
      live = false;
    };
  }, [id, found]);

  // The auto-hide clock restarts whenever any of these change, so opening the
  // sheet or pausing does not leave the chrome mid-fade.
  const visible =
    locked ||
    chromeVisible({
      playing,
      pausedByViewer: !playing && state.phase === 'playing',
      menuOpen: menu || scrubbing,
      busy: state.phase === 'resolving' || state.phase === 'converting',
      interacting,
    });

  if (!item) {
    return (
      <div className="px-3 py-16 text-center">
        {recovering ? (
          <p className="text-sm text-muted-foreground">Looking this title up again…</p>
        ) : (
          <>
            <h1 className="font-display text-lg font-bold">This link has expired</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {lost
                ? 'The title behind this address could not be found again, which usually means it has left the catalog.'
                : 'Catalog entries expire an hour after the search that produced them.'}
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Link to="/" className="btn-primary">
                Go home
              </Link>
              <Link to="/browse" search={{ q: undefined, g: undefined, t: undefined }} className="btn-ghost">
                Search
              </Link>
            </div>
          </>
        )}
      </div>
    );
  }

  const pending = state.phase === 'resolving' || state.phase === 'converting';
  // A cropped frame is `auto` plus the shape left after the bars. It applies only
  // while the viewer is fitting the picture: pinning a shape is a stronger
  // statement than removing a matte.
  const effective = aspect !== 'auto' || !cropped || !trimmed ? aspect : ('auto' as AspectId);
  const frame = frameFor(effective, picture.width, picture.height, zoom);
  const ratio = aspect === 'auto' && cropped && trimmed ? trimmed : frame.ratio;
  const bars = seekSegments(time, duration, ahead);

  const chooseAspect = (next: AspectId) => {
    const chosen = aspectFor(next).id;
    setAspect(chosen);
    saveAspectFor(progressKey || null, chosen);
  };

  const chooseZoom = (next: ZoomId) => {
    const chosen = zoomFor(next).id;
    setZoom(chosen);
    saveZoom(chosen);
  };

  // Looking for baked-in bars is only worth it once, when the picture is known
  // and the viewer has not pinned a shape of their own.
  const inspectPicture = (el: HTMLVideoElement) => {
    setPicture({ width: el.videoWidth, height: el.videoHeight });
    if (aspect !== 'auto' || !el.videoWidth) {
      setTrimmed(null);
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      // A downscaled sample is enough: bars are whole rows, and 160 px wide
      // catches a matte just as reliably as the full frame for a fraction of the
      // work on a phone.
      const w = 160;
      const h = Math.max(1, Math.round((el.videoHeight / el.videoWidth) * w));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(el, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      setTrimmed(trimRatio(el.videoWidth, el.videoHeight, detectLetterbox(data, w, h)));
    } catch {
      // A tainted canvas (it never should be -- this is our own HLS output) or a
      // browser that refuses drawImage on a video element. Not worth a message.
      setTrimmed(null);
    }
  };

  /** Runs one classified gesture against the player. */
  const run = (command: GestureCommand | null) => {
    const playback = engine.current;
    if (!command) return;
    if (command.kind === 'tap') {
      // A tap flips the chrome and nothing else. It must never pause by
      // accident; every phone player single-taps to reveal controls.
      poke();
      return;
    }
    if (command.kind === 'double') {
      if (!playback) return;
      playback.seek(playback.totalTime() + command.amount);
      flash(`${command.amount > 0 ? '+' : '−'}${Math.abs(command.amount)}s`);
      return;
    }
    if (command.kind === 'seek') {
      if (!playback) return;
      playback.seek(playback.totalTime() + command.amount);
      flash(gestureLabel('seek', command.amount));
      return;
    }
    if (command.kind === 'volume') {
      const next = Math.min(1, Math.max(0, vol + command.amount));
      setVol(next);
      // A volume drag means the viewer wants sound, so it unmutes as a side effect.
      setMuted(false);
      flash(gestureLabel('volume', command.amount, vol));
      return;
    }
    if (command.kind === 'dim') {
      const next = Math.min(0.85, Math.max(0, dimRef.current + -command.amount));
      dimRef.current = next;
      setDim(next);
      flash(gestureLabel('dim', -command.amount));
    }
  };

  const pointerDown = (ev: React.PointerEvent) => {
    setTouch(true);
    if (locked) {
      poke();
      return;
    }
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    gestures.current.setSurface(rect.width, rect.height);
    gestures.current.down(ev.clientX - rect.left, ev.clientY - rect.top, Date.now());
    poke();
  };

  const pointerMove = (ev: React.PointerEvent) => {
    if (locked) return;
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const live = gestures.current.move(ev.clientX - rect.left, ev.clientY - rect.top);
    if (!live) return;
    // Live feedback while the finger is down, but nothing is committed yet: a
    // scrub that is abandoned must leave the player where it was.
    if (live.kind === 'seek') flash(gestureLabel('seek', live.amount));
    else if (live.kind === 'volume') flash(gestureLabel('volume', live.amount, vol));
    else if (live.kind === 'dim') flash(gestureLabel('dim', live.amount));
  };

  const pointerUp = (ev: React.PointerEvent) => {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const command = gestures.current.up(ev.clientX - rect.left, ev.clientY - rect.top, Date.now());
    run(command);
    // A tap that never found a partner is still a tap; three hundred ms later
    // the chrome appears on the first touch of a double tap, which is wrong.
    clearTimeout(pendingTap.current);
    if (gestures.current.hasPendingTap()) {
      pendingTap.current = window.setTimeout(() => {
        run(gestures.current.flushPendingTap());
      }, 300);
    }
  };

  const tapZone = (amount: number) => {
    const playback = engine.current;
    if (!playback) return;
    playback.seek(playback.totalTime() + amount);
    flash(`${amount > 0 ? '+' : '−'}${Math.abs(amount)}s`);
  };

  return (
    <div className="min-h-screen bg-player">
      <div
        ref={box}
        className={`relative w-full select-none overflow-hidden bg-player ${
          fullscreen ? 'h-[100dvh]' : 'player-box'
        }`}
        style={{
          // The frame is the viewer's or the file's shape, and the picture fills
          // it according to `zoom`. A portrait frame is driven by height: at full
          // width a 4:5 clip is taller than the window and pushes the controls
          // off-screen, so a definite height lets the width follow instead.
          ...(frame.portrait && !fullscreen
            ? { aspectRatio: 'auto', height: 'min(calc(100dvh - 2rem), 1200px)', width: 'auto', maxWidth: '100%', margin: '0 auto' }
            : { aspectRatio: ratio ?? undefined }),
        }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={() => gestures.current.reset()}
        onMouseMove={poke}
        onDoubleClick={(ev) => ev.preventDefault()}
      >
        <video
          ref={video}
          className="h-full w-full"
          style={{ objectFit: frame.fit }}
          playsInline
          // Keeps the controls ours rather than the OS's.
          controls={false}
          preload="metadata"
          onClick={() => {
            // On a desktop the click is the primary control; on touch the pointer
            // handler above has already classified it.
            if (!touch && !locked) engine.current?.toggle();
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={(ev) => inspectPicture(ev.currentTarget)}
          // A source switch can change the size after metadata, so the shape is
          // followed rather than decided once.
          onResize={(ev) => inspectPicture(ev.currentTarget)}
          onEnded={() => setNextUp(true)}
          onEmptied={() => {
            // A stale shape would describe a picture that no longer exists. A
            // pinned shape stands, because the viewer chose the frame.
            if (aspect === 'auto') {
              setPicture({ width: 0, height: 0 });
              setTrimmed(null);
            }
          }}
        />

        {/* Reading light: the left-zone dim, drawn over the picture only so the
            controls stay legible. */}
        {dim > 0 && <div className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: dim }} />}

        {pending && (
          <div className="absolute inset-0 grid place-items-center bg-player/85 px-6 text-center backdrop-blur-sm">
            <div className="max-w-xs">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
              <p className="mt-3 font-display text-sm font-semibold">{state.message || 'Preparing…'}</p>
              {state.providers && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{state.providers}</p>}
            </div>
          </div>
        )}

        {state.phase === 'failed' && (
          <div className="absolute inset-0 grid place-items-center bg-player/95 px-6 text-center">
            <div className="max-w-xs">
              <p className="text-sm">{state.message}</p>
              <div className="mt-4 flex justify-center gap-2">
                <button onClick={retry} className="btn-primary">
                  Try again
                </button>
                <Link to="/title/$id" params={{ id: item.id }} search={{}} className="btn-ghost">
                  Back
                </Link>
              </div>
              {state.providers && <p className="mt-3 text-[11px] text-muted-foreground">{state.providers}</p>}
            </div>
          </div>
        )}

        {/* Centre play button: hidden while the chrome is down, since a tap
            already brings it back. */}
        {!playing && !pending && state.phase !== 'failed' && !locked && visible && (
          <button
            onClick={() => engine.current?.toggle()}
            aria-label="Play"
            className="absolute left-1/2 top-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-primary/95 text-primary-foreground shadow-glow backdrop-blur"
          >
            <Play className="ml-0.5 h-7 w-7 fill-current" />
          </button>
        )}

        {/* Gesture overlay: one line, never interactive. */}
        {overlay && (
          <div
            key={overlay.key}
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/70 px-4 py-2 font-display text-sm font-semibold tabular-nums text-white shadow-lg backdrop-blur"
          >
            {overlay.text}
          </div>
        )}

        {/* Next up, when the episode ends. */}
        {nextUp && nextEpisode && !pending && (
          <div className="absolute inset-0 grid place-items-center bg-player/90 px-6 text-center">
            <div className="w-full max-w-xs">
              <p className="text-xs uppercase tracking-widest text-muted-foreground">Up next</p>
              <p className="mt-1 font-display text-base font-bold">
                S{nextEpisode.season} · E{nextEpisode.episode}
              </p>
              {nextEpisode.title && <p className="mt-1 truncate text-sm text-muted-foreground">{nextEpisode.title}</p>}
              <div className="mt-4 flex justify-center gap-2">
                <button onClick={() => goEpisode(nextEpisode)} className="btn-primary">
                  Play next
                </button>
                <button
                  onClick={() => {
                    setNextUp(false);
                    void box.current?.requestFullscreen().catch(() => {});
                  }}
                  className="btn-ghost"
                >
                  Stay
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Top bar: room for a notch, and it fades rather than slides. */}
        <div
          className={`player-safe-top absolute inset-x-0 top-0 flex items-start gap-3 bg-gradient-to-b from-black/85 via-black/45 to-transparent px-3 pb-10 transition-opacity duration-200 ${
            visible ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          <Link
            to="/title/$id"
            params={{ id: item.id }}
            search={{}}
            aria-label="Back"
            className="mt-2 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-black/40 backdrop-blur"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="mt-1.5 min-w-0 flex-1">
            <p className="truncate font-display text-[15px] font-bold leading-tight">{item.title}</p>
            {s !== undefined && (
              <p className="mt-0.5 text-[11px] text-white/60">
                Season {s} · Episode {e}
                {ordered.length > 1 && ` of ${ordered.length}`}
              </p>
            )}
          </div>
          <button
            onClick={() => setLocked(true)}
            aria-label="Lock controls"
            className="mt-2 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-black/40 backdrop-blur"
          >
            <LockIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Locked: only the unlock pill, and the surface stops sending gestures. */}
        {locked && (
          <button
            onClick={() => setLocked(false)}
            aria-label="Unlock controls"
            className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur"
          >
            <LockOpen className="h-3.5 w-3.5" /> Unlock
          </button>
        )}

        {/* Bottom transport. */}
        <div
          className={`player-safe-bottom absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent px-3 pt-12 transition-opacity duration-200 ${
            visible && !locked ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          {/* Seek bar with the available span behind the played span. */}
          <div className="relative">
            <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/20">
              <div className="absolute inset-y-0 left-0 bg-white/30" style={{ width: `${bars.buffered * 100}%` }} />
            </div>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={time}
              onPointerDown={() => setScrubbing(true)}
              onPointerUp={() => setScrubbing(false)}
              onPointerCancel={() => setScrubbing(false)}
              onChange={(ev) => {
                const next = Number(ev.target.value);
                setTime(next);
                engine.current?.seek(next);
              }}
              onBlur={() => setScrubbing(false)}
              className="range range-player relative w-full"
              style={{ ['--p' as string]: `${bars.played * 100}%` }}
              aria-label="Seek"
              aria-valuetext={`${fmt(time)} of ${duration ? fmt(duration) : 'unknown'}`}
            />
          </div>

          <div className="mt-1 flex items-center gap-1">
            <button onClick={() => engine.current?.toggle()} aria-label={playing ? 'Pause' : 'Play'} className="player-btn">
              {playing ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
            </button>
            <button onClick={() => prevEpisode && goEpisode(prevEpisode)} disabled={!prevEpisode} aria-label="Previous episode" className="player-btn">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button onClick={() => tapZone(-10)} aria-label="Back 10 seconds" className="player-btn">
              <RotateCcw className="h-5 w-5" />
            </button>
            <button onClick={() => tapZone(10)} aria-label="Forward 10 seconds" className="player-btn">
              <RotateCw className="h-5 w-5" />
            </button>
            <button onClick={() => nextEpisode && goEpisode(nextEpisode)} disabled={!nextEpisode} aria-label="Next episode" className="player-btn">
              <ChevronRight className="h-5 w-5" />
            </button>
            <span className="ml-1 shrink-0 text-[11px] tabular-nums text-white/70">
              {fmt(time)} <span className="text-white/40">/ {duration ? fmt(duration) : '—'}</span>
            </span>

            <div className="ml-auto flex items-center gap-0.5">
              <button onClick={() => setMuted(!muted)} aria-label="Mute" className="player-btn">
                {muted || vol === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
              </button>
              <button
                onClick={() => engine.current && setSubs(engine.current.toggleSubtitle())}
                aria-label={subs.on ? 'Hide subtitles' : 'Show subtitles'}
                aria-pressed={subs.on}
                disabled={!subs.available}
                title={subs.note || (subs.available ? 'Subtitles' : 'No subtitles for this source')}
                className={`player-btn ${subs.on ? 'text-primary' : subs.available ? '' : 'opacity-30'}`}
              >
                <Captions className="h-5 w-5" />
              </button>
              {/* Rotation belongs on the bar, not three taps deep: on a phone it
                  is used mid-film, when the phone is already being turned. */}
              <button
                onClick={lock ? releaseLock : rotate}
                aria-label={lock ? 'Release screen rotation' : 'Rotate screen'}
                aria-pressed={!!lock}
                className={`player-btn ${lock ? 'text-primary' : ''}`}
              >
                <RotateCcw className={`h-5 w-5 ${orientation === 'portrait' ? 'rotate-90' : ''}`} />
              </button>
              <button onClick={() => setMenu(true)} aria-label="Settings" className="player-btn">
                <Settings className="h-5 w-5" />
              </button>
              <button onClick={toggleFullscreen} aria-label="Fullscreen" className="player-btn">
                {fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Settings sheet. A bottom sheet rather than a 208 px popover: it is
          thumb-reachable, it can hold every control at a 44 px target, and it
          dims the picture instead of floating over the seek bar. */}
      {menu && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setMenu(false)}>
          <div
            className="sheet-safe player-sheet w-full max-w-md rounded-t-2xl border-t border-white/10 bg-popover px-4 pt-3"
            onClick={(ev) => ev.stopPropagation()}
            role="dialog"
            aria-label="Player settings"
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20" />
            <div className="mb-3 flex items-center justify-between">
              <p className="font-display text-sm font-bold">Settings</p>
              <button onClick={() => setMenu(false)} aria-label="Close" className="player-btn">
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mb-1.5 text-[11px] uppercase tracking-widest text-muted-foreground">Quality</p>
            <div className="mb-1 grid grid-cols-2 gap-2">
              {[240, 360].map((x) => (
                <button
                  key={x}
                  onClick={() => changeQuality(x)}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold ${
                    height === x ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                  }`}
                >
                  {x}p
                  <span className="ml-1 text-[10px] font-normal opacity-70">{x === 240 ? '57 MB/h' : '114 MB/h'}</span>
                </button>
              ))}
            </div>
            <button
              onClick={toggleSaver}
              aria-pressed={saver}
              className="flex w-full items-center justify-between rounded-lg bg-secondary px-3 py-2 text-xs"
            >
              <span>Data saver</span>
              <span className={saver ? 'text-primary' : 'text-muted-foreground'}>{saver ? 'on' : 'off'}</span>
            </button>
            <p className="mt-1 text-[10px] leading-tight text-muted-foreground">
              Converted output only; the source may be higher. Figures are measured, not budgeted.
            </p>

            <p className="mb-1.5 mt-4 text-[11px] uppercase tracking-widest text-muted-foreground">Speed</p>
            <div className="grid grid-cols-6 gap-1">
              {SPEEDS.map((x) => (
                <button
                  key={x}
                  onClick={() => setRate(x)}
                  className={`rounded-lg py-2 text-xs font-semibold ${
                    rate === x ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                  }`}
                >
                  {x}×
                </button>
              ))}
            </div>

            <p className="mb-1.5 mt-4 text-[11px] uppercase tracking-widest text-muted-foreground">Frame</p>
            <div className="flex flex-wrap gap-1">
              {ASPECT_MODES.map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => chooseAspect(mode.id)}
                  title={mode.hint}
                  aria-pressed={aspect === mode.id}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ${
                    aspect === mode.id ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            {/* Only offered when the picture actually has bars; otherwise it is a
                button that would change nothing. Nothing is cropped automatically:
                those pixels are the viewer's, and removal is their call. */}
            {trimmed && aspect === 'auto' && (
              <button
                onClick={() => setCropped((v) => !v)}
                aria-pressed={cropped}
                className={`mt-2 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs ${
                  cropped ? 'bg-primary/15 text-primary' : 'bg-secondary'
                }`}
              >
                <span className="font-semibold">Black bars detected</span>
                <span className="opacity-80">{cropped ? 'cropped' : 'remove'}</span>
              </button>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {ZOOM_MODES.map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => chooseZoom(mode.id)}
                  title={mode.hint}
                  aria-pressed={zoom === mode.id}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ${
                    zoom === mode.id ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] leading-tight text-muted-foreground">
              {aspect === 'auto'
                ? `The frame follows the picture${picture.width ? ` (${picture.width}×${picture.height})` : ''}.`
                : `Pinned to ${aspectFor(aspect).hint}, whatever the file.`}
            </p>

            <p className="mb-1.5 mt-4 text-[11px] uppercase tracking-widest text-muted-foreground">Extras</p>
            <div className="mb-4 grid grid-cols-3 gap-2">
              <button onClick={pip} className="flex flex-col items-center gap-1 rounded-lg bg-secondary px-2 py-2 text-[10px]">
                <PictureInPicture2 className="h-4 w-4" /> PiP
              </button>
              <button
                onClick={lock ? releaseLock : rotate}
                aria-pressed={!!lock}
                className={`flex flex-col items-center gap-1 rounded-lg px-2 py-2 text-[10px] ${
                  lock ? 'bg-primary/20 text-primary' : 'bg-secondary'
                }`}
              >
                <Maximize className={`h-4 w-4 ${lock ? '' : 'rotate-45'}`} />
                {lock ? 'Release' : orientation === 'portrait' ? 'Rotate' : 'Upright'}
              </button>
              <button
                onClick={() => {
                  // The old handler restored the volume only when it was already
                  // zero, so pressing it while audible changed nothing at all.
                  // A mute is what a viewer is actually asking for here.
                  setMuted((m) => !m);
                  setVol((v) => (v === 0 ? 0.8 : v));
                  setMenu(false);
                }}
                aria-pressed={!muted}
                className="flex flex-col items-center gap-1 rounded-lg bg-secondary px-2 py-2 text-[10px]"
              >
                {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                {muted ? 'Unmute' : 'Sound'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Below the player: a slim, quiet block. The old one repeated the title
          (already in the top bar) and printed provider chatter as body text. */}
      <div className="px-3 py-4">
        {item.overview && <p className="text-sm leading-relaxed text-muted-foreground">{item.overview}</p>}
        {state.message && state.phase === 'playing' && !state.message.startsWith('Seeking') && (
          <p className="mt-2 text-[11px] text-muted-foreground">{state.message}</p>
        )}
        {subs.on && <p className="mt-2 text-[11px] text-primary">Subtitles on — English (provider)</p>}
        {subs.note && !subs.available && <p className="mt-2 text-[11px] text-muted-foreground">{subs.note}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to="/title/$id" params={{ id: item.id }} search={{}} className="btn-ghost">
            Details
          </Link>
          {nextEpisode && (
            <button onClick={() => goEpisode(nextEpisode)} className="btn-ghost">
              Next episode
            </button>
          )}
          {progressKey && (
            <button
              onClick={() => {
                clearProgress(progressKey);
                engine.current?.seek(0);
              }}
              className="btn-ghost"
            >
              Start over
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
