import { useEffect, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Check, Play, Plus } from 'lucide-react';
import { Header } from '../components/Header';
import { api, type Episode } from '../lib/api';
import { backdropFor, posterUrl } from '../lib/art';
import { toggleList, useLib } from '../lib/library';
import { itemStore } from '../lib/item-store';

interface Search {
  season?: number;
  episode?: number;
}

export const Route = createFileRoute('/title/$id')({
  validateSearch: (raw: Record<string, unknown>): Search => ({
    season: raw.season ? Number(raw.season) : undefined,
    episode: raw.episode ? Number(raw.episode) : undefined,
  }),
  head: () => ({
    meta: [
      { title: 'Title — ReelBox' },
      { name: 'description', content: 'Title details, cast and episodes.' },
    ],
  }),
  component: Detail,
});

function Detail() {
  const { id } = Route.useParams();
  const item = itemStore.get(id);
  const saved = useLib('list').includes(id);
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [source, setSource] = useState('');
  const [season, setSeason] = useState(1);

  const series = item?.type === 'series' || item?.type === 'show';

  useEffect(() => {
    if (!series) return;
    let live = true;
    api
      .episodes(id)
      .then((r) => {
        if (!live) return;
        setEpisodes(r.episodes);
        setSource(r.source);
        const first = r.episodes[0];
        if (first) setSeason(first.season);
      })
      .catch(() => live && setEpisodes([]));
    return () => {
      live = false;
    };
  }, [id, series]);

  if (!item) {
    return (
      <div>
        <Header />
        <div className="px-3 py-16 text-center">
          <h1 className="font-display text-lg font-bold">This title is no longer loaded</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Catalog entries are bound to the session that fetched them. Reload the page you came from, or search
            again.
          </p>
          <Link to="/browse" search={{ q: undefined, g: undefined, t: undefined }} className="btn-ghost mt-4">
            Search again
          </Link>
        </div>
      </div>
    );
  }

  const art = backdropFor(item) || posterUrl(item.poster);
  const seasons = [...new Set((episodes || []).map((e) => e.season))];
  const inSeason = (episodes || []).filter((e) => e.season === season);

  return (
    <div>
      <Header />
      <section className="relative">
        {art && <img src={art} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />}
        <div className="hero-fade absolute inset-0" />
        <div className="relative grid grid-cols-[7rem_minmax(0,1fr)] gap-4 px-3 py-6">
          {posterUrl(item.poster) ? (
            <img src={posterUrl(item.poster)!} alt={item.title} className="w-28 rounded-xl shadow-2xl" />
          ) : (
            <div className="aspect-[2/3] w-28 rounded-xl bg-secondary" />
          )}
          <div className="min-w-0">
            <h1 className="font-display text-xl font-bold line-clamp-3">{item.title}</h1>
            <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              {item.year && <span>{item.year}</span>}
              <span>·</span>
              <span>{item.anime ? 'Anime' : series ? 'Series' : 'Film'}</span>
              {item.source && (
                <>
                  <span>·</span>
                  <span className="uppercase">{item.source}</span>
                </>
              )}
            </p>
          </div>
          <div className="col-span-2">
            {item.overview && <p className="text-sm text-muted-foreground">{item.overview}</p>}
          </div>
          <div className="col-span-2 flex gap-2">
            <Link
              to="/watch/$id"
              params={{ id: item.id }}
              search={{ s: series ? season : undefined, e: series ? inSeason[0]?.episode : undefined }}
              className="btn-primary"
            >
              <Play className="h-4 w-4 fill-current" />
              Play
            </Link>
            <button onClick={() => toggleList(item.id)} className="btn-ghost">
              {saved ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              My list
            </button>
          </div>
        </div>
      </section>

      {series && (
        <section className="px-3 py-4">
          <h2 className="mb-2 flex items-baseline gap-2 font-display text-lg font-bold">
            Episodes
            <span className="text-[10px] font-normal uppercase text-muted-foreground">{source}</span>
          </h2>
          {episodes === null ? (
            <p className="text-xs text-muted-foreground">Loading the episode list…</p>
          ) : episodes.length === 0 ? (
            <p className="text-xs text-muted-foreground">No episode list is available; play will use episode 1.</p>
          ) : (
            <>
              {seasons.length > 1 && (
                <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto">
                  {seasons.map((s) => (
                    <button
                      key={s}
                      onClick={() => setSeason(s)}
                      className={`shrink-0 rounded-full px-4 py-1.5 text-sm ${
                        season === s ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                      }`}
                    >
                      Season {s}
                    </button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {inSeason.map((e) => (
                  <Link
                    key={`${e.season}-${e.episode}`}
                    to="/watch/$id"
                    params={{ id }}
                    search={{ s: e.season, e: e.episode }}
                    className="flex items-center gap-3 rounded-lg bg-card p-3 hover:bg-secondary"
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded bg-primary/15 text-primary">
                      <Play className="h-4 w-4" />
                    </span>
                    <span className="truncate text-xs">{e.title || `Episode ${e.episode}`}</span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
