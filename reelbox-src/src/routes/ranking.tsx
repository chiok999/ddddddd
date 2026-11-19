import { useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Star } from 'lucide-react';
import { Header } from '../components/Header';
import { titles } from '../lib/movies';

export const Route = createFileRoute('/ranking')({
  head: () => ({
    meta: [
      { title: 'Top Charts — ReelBox' },
      {
        name: 'description',
        content: 'The highest rated movies, series and anime on ReelBox right now.',
      },
      { property: 'og:title', content: 'Top Charts — ReelBox' },
      {
        property: 'og:description',
        content: 'The highest rated movies, series and anime on ReelBox right now.',
      },
    ],
  }),
  component: Ranking,
});

const kinds = ['All', 'Movie', 'TV Series', 'Anime'] as const;

function Ranking() {
  const [k, setK] = useState<(typeof kinds)[number]>('All');
  const list = titles
    .filter((t) => k === 'All' || t.type === k)
    .sort((a, b) => b.rating - a.rating);

  return (
    <div>
      <Header />
      <h1 className="px-3 pt-4 font-display text-xl font-bold">Top Charts</h1>

      <div className="no-scrollbar flex gap-2 overflow-x-auto px-3 py-3">
        {kinds.map((x) => (
          <button
            key={x}
            onClick={() => setK(x)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs ${
              k === x ? 'bg-primary text-primary-foreground' : 'bg-secondary'
            }`}
          >
            {x}
          </button>
        ))}
      </div>

      <ol className="space-y-3 px-3">
        {list.map((t, n) => (
          <li key={t.id}>
            <Link
              to="/title/$id"
              params={{ id: t.id }}
              className="grid grid-cols-[1.75rem_4rem_minmax(0,1fr)] items-center gap-3"
            >
              <span
                className={`text-center font-display text-lg font-black ${
                  n < 3 ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                {n + 1}
              </span>
              <img
                src={t.poster}
                alt={t.title}
                className="aspect-[2/3] w-16 rounded-md object-cover"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{t.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t.year} · {t.genres.join(', ')}
                </p>
                <p className="mt-1 flex items-center gap-1 text-xs">
                  <Star className="h-3 w-3 fill-primary text-primary" />
                  {t.rating}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
