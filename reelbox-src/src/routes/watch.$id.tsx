import { useEffect, useRef, useState } from 'react';
import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import {
  ArrowLeft,
  Captions,
  Maximize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { VIDEO, getTitle, titles } from '../lib/movies';
import { pushHistory } from '../lib/library';

interface Search {
  s?: number;
  e?: number;
}

export const Route = createFileRoute('/watch/$id')({
  validateSearch: (q: Record<string, unknown>): Search => ({
    s: q.s ? Number(q.s) : undefined,
    e: q.e ? Number(q.e) : undefined,
  }),
  loader: ({ params }) => {
    const t = getTitle(params.id);
    if (!t) throw notFound();
    return t;
  },
  head: ({ loaderData: t }) => ({
    meta: [
      { title: `Watch ${t?.title} — ReelBox` },
      { name: 'description', content: `Now playing: ${t?.title}` },
      { property: 'og:title', content: `Watch ${t?.title} — ReelBox` },
      { property: 'og:description', content: t?.description },
    ],
  }),
  component: Player,
});

const fmt = (s: number) => {
  if (!isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

function Player() {
  const t = Route.useLoaderData();
  const { s, e } = Route.useSearch();
  const v = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [muted, setMuted] = useState(false);
  const [vol, setVol] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [menu, setMenu] = useState(false);
  const [quality, setQuality] = useState('1080p');
  const [subs, setSubs] = useState(false);
  const [show, setShow] = useState(true);
  const hide = useRef<number | undefined>(undefined);

  const toggle = () => {
    const el = v.current;
    if (!el) return;
    el.paused ? void el.play() : el.pause();
  };
  const seek = (d: number) => {
    if (v.current) v.current.currentTime += d;
  };
  const fs = () =>
    document.fullscreenElement ? void document.exitFullscreen() : box.current?.requestFullscreen();
  const poke = () => {
    setShow(true);
    clearTimeout(hide.current);
    hide.current = window.setTimeout(() => setShow(false), 2500);
  };

  useEffect(() => {
    const k = (ev: KeyboardEvent) => {
      if (ev.code === 'Space') {
        ev.preventDefault();
        toggle();
      }
      if (ev.key === 'ArrowRight') seek(10);
      if (ev.key === 'ArrowLeft') seek(-10);
      if (ev.key === 'f') fs();
      if (ev.key === 'm') setMuted((x) => !x);
      poke();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  useEffect(() => {
    if (v.current) {
      v.current.muted = muted;
      v.current.volume = vol;
      v.current.playbackRate = speed;
    }
  }, [muted, vol, speed]);

  useEffect(() => {
    pushHistory(t.id);
  }, [t.id]);

  const next = titles[(titles.indexOf(t) + 1) % titles.length];

  return (
    <div className="min-h-screen bg-background">
      <div
        ref={box}
        onMouseMove={poke}
        onTouchStart={poke}
        className={`relative aspect-video max-h-screen w-full bg-player ${show ? '' : 'cursor-none'}`}
      >
        <video
          ref={v}
          src={VIDEO}
          poster={t.backdrop}
          className="h-full w-full"
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(x) => setTime(x.currentTarget.currentTime)}
          onLoadedMetadata={(x) => setDur(x.currentTarget.duration)}
        />

        {subs && playing && (
          <p className="pointer-events-none absolute bottom-14 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-background/70 px-2 py-0.5 text-xs">
            [ Subtitles: English ]
          </p>
        )}

        {!playing && (
          <button
            onClick={toggle}
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
          <Link to="/title/$id" params={{ id: t.id }} aria-label="Back">
            <ArrowLeft className="h-6 w-6" />
          </Link>
          <div>
            <p className="font-display font-bold">{t.title}</p>
            {s && (
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
            max={dur || 0}
            step={0.1}
            value={time}
            onChange={(x) => {
              if (v.current) v.current.currentTime = +x.target.value;
            }}
            className="range w-full"
            style={{ ['--p' as string]: `${dur ? (time / dur) * 100 : 0}%` }}
            aria-label="Seek"
          />
          <div className="mt-1 flex min-w-0 items-center gap-3">
            <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
            </button>
            <button onClick={() => seek(-10)} aria-label="Back 10s">
              <RotateCcw className="h-5 w-5" />
            </button>
            <button onClick={() => seek(10)} aria-label="Forward 10s">
              <RotateCw className="h-5 w-5" />
            </button>
            <button onClick={() => setMuted(!muted)} aria-label="Mute">
              {muted || vol === 0 ? (
                <VolumeX className="h-5 w-5" />
              ) : (
                <Volume2 className="h-5 w-5" />
              )}
            </button>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {fmt(time)} / {fmt(dur)}
            </span>

            <div className="relative ml-auto flex shrink-0 items-center gap-3">
              <Link to="/watch/$id" params={{ id: next.id }} search={{}} aria-label="Next">
                <SkipForward className="h-5 w-5" />
              </Link>
              <button
                onClick={() => setSubs(!subs)}
                aria-label="Subtitles"
                className={subs ? 'text-primary' : ''}
              >
                <Captions className="h-5 w-5" />
              </button>
              <button onClick={() => setMenu(!menu)} aria-label="Settings">
                <Settings className="h-5 w-5" />
              </button>
              {menu && (
                <div className="absolute bottom-8 right-0 w-48 rounded-lg border border-border bg-popover p-3 text-sm">
                  <p className="mb-1 text-xs text-muted-foreground">Speed</p>
                  <div className="mb-3 flex flex-wrap gap-1">
                    {[0.5, 1, 1.25, 1.5, 2].map((x) => (
                      <button
                        key={x}
                        onClick={() => setSpeed(x)}
                        className={`rounded px-2 py-0.5 ${
                          speed === x ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                        }`}
                      >
                        {x}×
                      </button>
                    ))}
                  </div>
                  <p className="mb-1 text-xs text-muted-foreground">Quality</p>
                  <div className="flex flex-wrap gap-1">
                    {['1080p', '720p', '480p', '360p'].map((x) => (
                      <button
                        key={x}
                        onClick={() => setQuality(x)}
                        className={`rounded px-2 py-0.5 ${
                          quality === x ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                        }`}
                      >
                        {x}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button onClick={fs} aria-label="Fullscreen">
                <Maximize className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="px-3 py-4">
        <h1 className="font-display text-lg font-bold">{t.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.description}</p>
        <h2 className="mb-3 mt-8 font-display text-lg font-bold">Up next</h2>
        <div className="grid grid-cols-2 gap-3">
          {titles
            .filter((x) => x.id !== t.id)
            .slice(0, 8)
            .map((x) => (
              <Link
                key={x.id}
                to="/watch/$id"
                params={{ id: x.id }}
                search={{}}
                className="group min-w-0"
              >
                <img
                  src={x.backdrop}
                  alt={x.title}
                  className="aspect-video w-full rounded-lg object-cover group-hover:opacity-80"
                />
                <p className="mt-1 truncate text-xs">{x.title}</p>
              </Link>
            ))}
        </div>
      </div>
    </div>
  );
}
