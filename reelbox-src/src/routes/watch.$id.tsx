import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import {
  ArrowLeft,
  Captions,
  Maximize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Playback, type PlaybackState, type SubtitleState } from '../lib/playback';
import { aspectFor, ASPECT_MODES, frameFor, readAspect, saveAspect, type AspectId } from '../lib/frame';
import { itemStore } from '../lib/item-store';
import {
  clearProgress,
  pushHistory,
  readQuality,
  readSaver,
  readProgress,
  saveHeight,
  saveProgress,
  saveSaver,
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
  const [aspect, setAspect] = useState<AspectId>(() => readAspect());
  const [picture, setPicture] = useState({ width: 0, height: 0 });
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [vol, setVol] = useState(1);
  const [rate, setRate] = useState(1);
  // `height` is what the viewer asked for; the rung actually downloaded may be
  // smaller when data saver is on or the connection says it is metered.
  const [height, setHeight] = useState(240);
  const [saver, setSaver] = useState(false);
  const [menu, setMenu] = useState(false);
  const [show, setShow] = useState(true);
  const hide = useRef<number | undefined>(undefined);

  const progressKey = item ? `${item.source}:${item.title}:${item.year}:${item.type}:${s ?? 1}:${e ?? 1}` : '';

  const poke = useCallback(() => {
    setShow(true);
    clearTimeout(hide.current);
    hide.current = window.setTimeout(() => setShow(false), 2500);
  }, []);

  // One engine per mounted player. It reports on its own clock, so the UI only
  // renders what the engine knows rather than polling the element separately.
  useEffect(() => {
    if (!item) return;
    const playback = new Playback({
      onState: setState,
      onSubtitle: setSubs,
      onProgress: (position, total, paused) => {
        setTime(position);
        setDuration(total ?? 0);
        if (position > 5 && progressKey) saveProgress(progressKey, position);
        void paused;
      },
    });
    engine.current = playback;
    setHeight(readQuality());
    setSaver(readSaver());
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

    return () => {
      playback.attach(null);
      void playback.stop();
      engine.current = null;
    };
    // Starting again is an explicit user action (a retry button), never a render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, s, e]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const playback = engine.current;
      if (!playback) return;
      if (ev.code === 'Space') {
        ev.preventDefault();
        playback.toggle();
      }
      if (ev.key === 'ArrowRight') playback.seek(playback.totalTime() + 10);
      if (ev.key === 'ArrowLeft') playback.seek(playback.totalTime() - 10);
      if (ev.key === 'm') setMuted((x) => !x);
      if (ev.key === 'f') void fullscreen();
      poke();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [poke]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.muted = muted;
    v.volume = vol;
  }, [muted, vol]);

  useEffect(() => {
    engine.current?.setRate(rate);
  }, [rate]);

  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await box.current?.requestFullscreen();
    } catch {
      /* some browsers refuse without a gesture; the button is best-effort */
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
  const frame = frameFor(aspect, picture.width, picture.height);

  const chooseAspect = (id: AspectId) => {
    setAspect(aspectFor(id).id);
    saveAspect(aspectFor(id).id);
  };

  return (
    <div className="min-h-screen bg-background">
      <div
        ref={box}
        onMouseMove={poke}
        onTouchStart={poke}
        style={{
          aspectRatio: frame.ratio ?? undefined,
          // A portrait frame is driven by height: at full width a 4:5 clip is
          // taller than the window and pushes the controls off-screen. With a
          // definite height the width follows, so nothing is stretched.
          ...(frame.portrait
            ? { height: 'min(calc(100dvh - 2rem), 1200px)', width: 'auto', maxWidth: '100%', margin: '0 auto' }
            : {}),
        }}
        className={`relative max-h-screen w-full bg-player ${show ? '' : 'cursor-none'} ${
          frame.ratio ? '' : 'aspect-video'
        }`}
      >
        <video
          ref={video}
          className="h-full w-full object-contain"
          playsInline
          onClick={() => engine.current?.toggle()}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setPicture({ width: v.videoWidth, height: v.videoHeight });
          }}
          // A source switch can change the size after metadata, so the shape is
          // followed rather than decided once.
          onResize={(e) => {
            const v = e.currentTarget;
            setPicture({ width: v.videoWidth, height: v.videoHeight });
          }}
          onEmptied={() => {
            // A stale shape would describe a picture that no longer exists. A
            // pinned shape stands, because the viewer chose the frame.
            if (aspect === 'auto') setPicture({ width: 0, height: 0 });
          }}
        />

        {pending && (
          <div className="absolute inset-0 grid place-items-center bg-player/80 px-6 text-center">
            <div>
              <p className="font-display text-sm font-semibold">{state.message || 'Preparing…'}</p>
              {state.providers && <p className="mt-2 text-[11px] text-muted-foreground">{state.providers}</p>}
            </div>
          </div>
        )}

        {state.phase === 'failed' && (
          <div className="absolute inset-0 grid place-items-center bg-player/90 px-6 text-center">
            <div>
              <p className="text-sm">{state.message}</p>
              <div className="mt-3 flex justify-center gap-2">
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

        {!playing && !pending && state.phase !== 'failed' && (
          <button
            onClick={() => engine.current?.toggle()}
            aria-label="Play"
            className="absolute left-1/2 top-1/2 grid h-14 w-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-primary text-primary-foreground shadow-glow"
          >
            <Play className="h-6 w-6 fill-current" />
          </button>
        )}

        <div
          className={`absolute inset-x-0 top-0 flex items-center gap-4 bg-gradient-to-b from-background/90 to-transparent p-3 transition-opacity ${
            show || !playing ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <Link to="/title/$id" params={{ id: item.id }} search={{}} aria-label="Back">
            <ArrowLeft className="h-6 w-6" />
          </Link>
          <div className="min-w-0">
            <p className="truncate font-display font-bold">{item.title}</p>
            {s !== undefined && (
              <p className="text-xs text-muted-foreground">
                Season {s} · Episode {e}
              </p>
            )}
          </div>
        </div>

        <div
          className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-background/95 to-transparent p-3 transition-opacity ${
            show || !playing ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={time}
            onChange={(ev) => engine.current?.seek(Number(ev.target.value))}
            className="range w-full"
            style={{ ['--p' as string]: `${duration ? (time / duration) * 100 : 0}%` }}
            aria-label="Seek"
          />
          <div className="mt-1 flex min-w-0 items-center gap-3">
            <button onClick={() => engine.current?.toggle()} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
            </button>
            <button onClick={() => engine.current?.seek((engine.current?.totalTime() || 0) - 10)} aria-label="Back 10s">
              <RotateCcw className="h-5 w-5" />
            </button>
            <button onClick={() => engine.current?.seek((engine.current?.totalTime() || 0) + 10)} aria-label="Forward 10s">
              <RotateCw className="h-5 w-5" />
            </button>
            <button onClick={() => setMuted(!muted)} aria-label="Mute">
              {muted || vol === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </button>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {fmt(time)} / {duration ? fmt(duration) : '—'}
            </span>

            <div className="relative ml-auto flex shrink-0 items-center gap-3">
              <button
                onClick={() => engine.current && setSubs(engine.current.toggleSubtitle())}
                aria-label={subs.on ? 'Hide subtitles' : 'Show subtitles'}
                aria-pressed={subs.on}
                disabled={!subs.available}
                title={subs.note || (subs.available ? 'Subtitles' : 'No subtitles for this source')}
                className={subs.on ? 'text-primary' : subs.available ? '' : 'opacity-40'}
              >
                <Captions className="h-5 w-5" />
              </button>
              <button onClick={() => setMenu(!menu)} aria-label="Settings">
                <Settings className="h-5 w-5" />
              </button>
              {menu && (
                <div className="absolute bottom-8 right-0 w-52 rounded-lg border border-border bg-popover p-3 text-sm">
                  <p className="mb-1 text-xs text-muted-foreground">Speed</p>
                  <div className="mb-3 flex flex-wrap gap-1">
                    {[0.5, 1, 1.25, 1.5, 2].map((x) => (
                      <button
                        key={x}
                        onClick={() => setRate(x)}
                        className={`rounded px-2 py-0.5 ${
                          rate === x ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                        }`}
                      >
                        {x}×
                      </button>
                    ))}
                  </div>
                  <p className="mb-1 text-xs text-muted-foreground">Quality</p>
                  <div className="flex flex-wrap gap-1">
                    {/* Only what the conversion actually produces. */}
                    {[240, 360].map((x) => (
                      <button
                        key={x}
                        onClick={() => changeQuality(x)}
                        className={`rounded px-2 py-0.5 ${
                          height === x ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                        }`}
                      >
                        {x}p
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[10px] leading-tight text-muted-foreground">
                    Converted output only; the source may be higher.
                  </p>
                  {/* Measured through these exact encoder flags on a 1080p
                      source: 426x240 is ~250 kbps of transport stream (about
                      110 MB an hour) and 640x360 is ~531 (~230 MB). The figures
                      are here rather than in a tooltip so the choice is made on
                      numbers instead of on a feeling about "quality". */}
                  <button
                    onClick={toggleSaver}
                    aria-pressed={saver}
                    className="mt-3 flex w-full items-center justify-between rounded bg-secondary px-2 py-1 text-xs"
                  >
                    <span>Data saver</span>
                    <span className={saver ? 'text-primary' : 'text-muted-foreground'}>
                      {saver ? 'on' : 'off'}
                    </span>
                  </button>
                  <p className="mt-1 text-[10px] leading-tight text-muted-foreground">
                    {saver
                      ? 'Pinned to 240p, about 110 MB an hour.'
                      : height === 360
                        ? '360p, about 230 MB an hour.'
                        : '240p, about 110 MB an hour.'}
                  </p>
                  <p className="mb-1 mt-3 text-xs text-muted-foreground">Frame</p>
                  <div className="flex flex-wrap gap-1">
                    {ASPECT_MODES.map((mode) => (
                      <button
                        key={mode.id}
                        onClick={() => chooseAspect(mode.id)}
                        title={mode.hint}
                        aria-pressed={aspect === mode.id}
                        className={`rounded px-2 py-0.5 ${
                          aspect === mode.id ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                        }`}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[10px] leading-tight text-muted-foreground">
                    {aspect === 'auto'
                      ? 'The frame follows the picture.'
                      : `Pinned to ${aspectFor(aspect).hint}, whatever the file.`}
                  </p>
                </div>
              )}
              <button onClick={fullscreen} aria-label="Fullscreen">
                <Maximize className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="px-3 py-4">
        <h1 className="font-display text-lg font-bold">{item.title}</h1>
        {item.overview && <p className="mt-1 text-sm text-muted-foreground">{item.overview}</p>}
        {state.message && state.phase === 'playing' && (
          <p className="mt-2 text-[11px] text-muted-foreground">{state.message}</p>
        )}
        {subs.on && <p className="mt-2 text-[11px] text-primary">Subtitles on — English (provider)</p>}
        {subs.note && <p className="mt-2 text-[11px] text-muted-foreground">{subs.note}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Link to="/title/$id" params={{ id: item.id }} search={{}} className="btn-ghost">
            Details
          </Link>
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
