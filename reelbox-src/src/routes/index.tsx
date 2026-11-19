import { useEffect, useMemo, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Play, Plus, Check, Star } from 'lucide-react';
import { Header } from '../components/Header';
import { PosterCard } from '../components/PosterCard';
import { api, type Item, type Section } from '../lib/api';
import { backdropFor, backdropUrl, posterUrl } from '../lib/art';
import { toggleList, useLib } from '../lib/library';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'ReelBox — Stream Movies & TV Shows' },
      { name: 'description', content: 'Browse trending movies, series and anime, then watch in a cinematic player.' },
      { property: 'og:title', content: 'ReelBox — Stream Movies & TV Shows' },
      { property: 'og:description', content: 'Browse trending movies, series and anime, then watch in a cinematic player.' },
    ],
  }),
  component: Home,
});

type Tab = 'For You' | 'Movie' | 'TV Series' | 'Anime';
const TABS: Tab[] = ['For You', 'Movie', 'TV Series', 'Anime'];

const matches = (tab: Tab, item: Item) => {
  if (tab === 'For You') return true;
  if (tab === 'Anime') return !!item.anime || item.type === 'anime';
  if (tab === 'TV Series') return item.type === 'series' || item.type === 'show';
  return item.type === 'movie';
};

function Row({ section }: { section: Section }) {
  const label = section.title || section.id;
  const list = section.id === 'anime' ? 'anime' : section.groups?.includes('movies') ? 'movies' : 'shows';
  return (
    <section className="py-4" aria-labelledby={`row-${section.id}`}>
      <div className="mb-2 flex items-center justify-between px-3">
        <h2 id={`row-${section.id}`} className="font-display text-lg font-bold">
          {label}
          <span className="ml-2 align-middle text-[10px] font-normal uppercase text-muted-foreground">
            {section.error ? 'Unavailable' : section.source || ''}
          </span>
        </h2>
        {/* Every row can leave the rail. Rows the provider can page open the full
            list; the rest render nothing rather than a dead control. */}
        {section.genreTopId && (
          <Link
            to="/browse"
            search={{ g: section.genreTopId, t: label }}
            className="shrink-0 text-xs text-primary"
            aria-label={`See more in ${label}`}
          >
            See more ›
          </Link>
        )}
      </div>
      {section.items.length ? (
        <div className="no-scrollbar flex gap-3 overflow-x-auto px-3 pb-1">
          {section.items.map((item) => (
            <PosterCard key={item.id} item={item} list={list} />
          ))}
        </div>
      ) : (
        <p className="px-3 text-xs text-muted-foreground">{section.error || 'No titles available right now.'}</p>
      )}
    </section>
  );
}

function Hero({ item }: { item: Item }) {
  const saved = useLib('list').includes(item.id);
  const art = backdropFor(item);
  const poster = posterUrl(item.poster);
  return (
    <section className="relative">
      {art ? (
        <img src={art} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />
      ) : poster ? (
        <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30" />
      ) : null}
      <div className="hero-fade absolute inset-0" />
      <div className="relative px-3 pb-6 pt-24">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-primary">
          {item.source === 'moviebox' ? 'MovieBox' : 'Cinemeta'} · {item.type === 'series' ? 'Series' : 'Film'}
        </p>
        <h1 className="mt-1 font-display text-2xl font-bold line-clamp-2">{item.title}</h1>
        <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {item.year && <span>{item.year}</span>}
          {item.anime && <span>· Anime</span>}
        </p>
        {item.overview && <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{item.overview}</p>}
        <div className="mt-4 flex gap-2">
          <Link
            to="/watch/$id"
            params={{ id: item.id }}
            search={{ s: undefined, e: undefined }}
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
  );
}

function Home() {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('For You');

  const load = () => {
    setError('');
    setSections(null);
    api
      .discover()
      .then(setSections)
      .catch((e) => setError(e.message));
  };

  useEffect(load, []);

  const visible = useMemo(() => {
    if (!sections) return [];
    if (tab === 'For You') return sections;
    return sections
      .map((s) => ({ ...s, items: s.items.filter((i) => matches(tab, i)) }))
      .filter((s) => s.items.length);
  }, [sections, tab]);

  const hero = useMemo(() => {
    const pool = visible.flatMap((s) => s.items).filter((i) => i.poster || i.imdbId);
    return pool[0] || null;
  }, [visible]);

  return (
    <div>
      <Header />
      {error ? (
        <div className="px-3 py-10 text-center">
          <h2 className="font-display text-lg font-bold">Catalog unreachable</h2>
          <p className="mx-auto mt-2 max-w-xs text-sm text-muted-foreground">
            Troy could not reach the catalog from this server. Search still works and will try every provider
            directly.
          </p>
          <button onClick={load} className="btn-ghost mt-4">
            Try again
          </button>
        </div>
      ) : !sections ? (
        <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
          <Star className="mr-2 h-4 w-4 animate-pulse text-primary" />
          Loading the catalog…
        </div>
      ) : (
        <>
          {hero && <Hero item={hero} />}
          <div className="no-scrollbar -mt-2 flex gap-2 overflow-x-auto px-3 py-2">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                aria-pressed={tab === t}
                className={`shrink-0 rounded-full px-4 py-1.5 text-sm ${
                  tab === t ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                }`}
              >
                {t === 'Movie' ? 'Movies' : t}
              </button>
            ))}
          </div>
          {visible.length ? (
            visible.map((section) => <Row key={section.id} section={section} />)
          ) : (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">
              Nothing in this tab right now.
            </p>
          )}
          {sections.some((s) => s.error) && (
            <div className="px-3 pb-8">
              <button onClick={load} className="btn-ghost w-full justify-center">
                Retry unavailable catalogs
              </button>
            </div>
          )}
        </>
      )}
      <div className="h-4" />
      <span className="hidden">{backdropUrl(null)}</span>
    </div>
  );
}
