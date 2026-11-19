import { useEffect, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Check, Crown, Play, Plus, Star } from 'lucide-react';
import { Header } from '../components/Header';
import { PosterCard } from '../components/PosterCard';
import { getTitle, sections, titles } from '../lib/movies';
import { toggleList, useLib } from '../lib/library';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'ReelBox — Stream Movies & TV Shows' },
      {
        name: 'description',
        content: 'Browse trending movies, series and anime, then watch in a cinematic player.',
      },
      { property: 'og:title', content: 'ReelBox — Stream Movies & TV Shows' },
      {
        property: 'og:description',
        content: 'Browse trending movies, series and anime, then watch in a cinematic player.',
      },
    ],
  }),
  component: Home,
});

type Tab = 'For You' | 'Movie' | 'TV Series' | 'Anime';
const tabs: Tab[] = ['For You', 'Movie', 'TV Series', 'Anime'];

function Row({
  title,
  children,
  more = true,
}: {
  title: string;
  children: React.ReactNode;
  more?: boolean;
}) {
  return (
    <section className="py-3">
      <div className="mb-2 flex items-end justify-between px-3">
        <h2 className="truncate font-display text-base font-bold">{title}</h2>
        {more && (
          <Link to="/browse" className="shrink-0 text-xs text-primary">
            More
          </Link>
        )}
      </div>
      <div className="no-scrollbar flex gap-3 overflow-x-auto px-3 pb-1">{children}</div>
    </section>
  );
}

function Home() {
  const [tab, setTab] = useState<Tab>('For You');
  const pool = tab === 'For You' ? titles : titles.filter((t) => t.type === tab);
  const hero = pool.slice(0, 5);
  const [i, setI] = useState(0);

  // Reset the slide on a tab change, or the index points at a different film in
  // a shorter pool.
  useEffect(() => setI(0), [tab]);

  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % hero.length), 5000);
    return () => clearInterval(t);
  }, [hero.length]);

  const h = hero[i % hero.length];
  const list = useLib('list');
  const history = useLib('history').map(getTitle).filter((x) => !!x);

  return (
    <div>
      <Header />

      <div className="no-scrollbar flex gap-5 overflow-x-auto px-3 pt-2 text-sm">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`shrink-0 border-b-2 pb-1.5 font-semibold ${
              tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'
            }`}
          >
            {t === 'For You' ? t : t === 'Movie' ? 'Movies' : t}
          </button>
        ))}
      </div>

      <section className="px-3 pt-3">
        <div className="relative aspect-[4/5] overflow-hidden rounded-2xl">
          <img
            key={h.id}
            src={h.backdrop}
            alt=""
            className="absolute inset-0 h-full w-full object-cover animate-in fade-in duration-700"
          />
          <div className="hero-fade absolute inset-0" />
          <div className="absolute inset-x-0 bottom-0 p-4">
            <h1 className="line-clamp-2 font-display text-2xl font-bold">{h.title}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Star className="h-3 w-3 fill-primary text-primary" />
                {h.rating}
              </span>
              {h.year}
              {' · '}
              {h.genres.join(', ')}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Link
                to="/watch/$id"
                params={{ id: h.id }}
                search={{}}
                className="btn-primary justify-center"
              >
                <Play className="h-4 w-4 fill-current" />
                Play
              </Link>
              <button onClick={() => toggleList(h.id)} className="btn-ghost justify-center">
                {list.includes(h.id) ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                My List
              </button>
            </div>
            <div className="mt-3 flex justify-center gap-1.5">
              {hero.map((_, k) => (
                <button
                  key={k}
                  aria-label={`Slide ${k + 1}`}
                  onClick={() => setI(k)}
                  className={`h-1 rounded-full transition-all ${
                    k === i ? 'w-6 bg-primary' : 'w-2 bg-muted-foreground/50'
                  }`}
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      {history.length > 0 && (
        <Row title="Continue Watching" more={false}>
          {history.map((t) => (
            <Link
              key={t.id}
              to="/watch/$id"
              params={{ id: t.id }}
              search={{}}
              className="block w-40 shrink-0"
            >
              <div className="relative aspect-video overflow-hidden rounded-lg">
                <img src={t.backdrop} alt={t.title} className="h-full w-full object-cover" />
                <Play className="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 fill-foreground" />
              </div>
              <p className="mt-1 truncate text-xs">{t.title}</p>
            </Link>
          ))}
        </Row>
      )}

      <Row title="Top 10 Today">
        {[...pool]
          .sort((a, b) => b.rating - a.rating)
          .slice(0, 10)
          .map((t, k) => (
            <Link
              key={t.id}
              to="/title/$id"
              params={{ id: t.id }}
              className="flex shrink-0 items-end"
            >
              <span className="rank-num -mr-3 font-display text-6xl font-black leading-none">
                {k + 1}
              </span>
              <img
                src={t.poster}
                alt={t.title}
                className="relative aspect-[2/3] w-24 rounded-lg object-cover"
              />
            </Link>
          ))}
      </Row>

      <Link to="/me" className="mx-3 my-3 flex items-center gap-3 rounded-xl bg-premium p-3">
        <Crown className="h-8 w-8 shrink-0" />
        <div className="min-w-0">
          <p className="font-display text-sm font-bold">Get FREE Premium</p>
          <p className="truncate text-xs opacity-80">Ad‑free, 1080p and offline downloads</p>
        </div>
      </Link>

      {sections.map((s) => (
        <Row key={s.name} title={s.name}>
          {s.items
            .filter((t) => pool.includes(t))
            .map((t) => (
              <PosterCard key={t.id} t={t} />
            ))}
        </Row>
      ))}
    </div>
  );
}
