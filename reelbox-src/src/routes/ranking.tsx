import { useEffect, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Header } from '../components/Header';
import { api, type Item, type Section } from '../lib/api';
import { posterUrl } from '../lib/art';
import { itemStore } from '../lib/item-store';

export const Route = createFileRoute('/ranking')({
  head: () => ({
    meta: [
      { title: 'Top — ReelBox' },
      { name: 'description', content: 'The most rated movies, series and anime on ReelBox right now.' },
      { property: 'og:title', content: 'Top — ReelBox' },
      { property: 'og:description', content: 'The most rated movies, series and anime on ReelBox right now.' },
    ],
  }),
  component: Ranking,
});

const LIMIT = 20;

function Ranking() {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'movies' | 'shows' | 'anime'>('movies');

  useEffect(() => {
    api
      .discover()
      .then(setSections)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (sections) itemStore.putAll(sections.flatMap((s) => s.items));
  }, [sections]);

  /**
   * The rank is this list's own order, not a claim about the wider catalog, so
   * the number is shown and nothing more is inferred from it.
   */
  const ranked = (sections || [])
    .filter((s) => (s.groups || []).includes(tab) || (tab === 'anime' && s.id === 'anime'))
    .flatMap((s) => s.items)
    .filter((item, index, all) => all.findIndex((x) => x.id === item.id) === index)
    .slice(0, LIMIT);

  return (
    <div>
      <Header />
      <div className="px-3 py-4">
        <h1 className="font-display text-xl font-bold">Top</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          This list's own order from today's catalog — not a rating.
        </p>
        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto">
          {(
            [
              ['movies', 'Movies'],
              ['shows', 'Series'],
              ['anime', 'Anime'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={`shrink-0 rounded-full px-4 py-1.5 text-sm ${
                tab === key ? 'bg-primary text-primary-foreground' : 'bg-secondary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {error ? (
          <p className="py-16 text-center text-sm">{error}</p>
        ) : sections === null ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
        ) : ranked.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Nothing ranked in this group yet.</p>
        ) : (
          <ol className="mt-4 space-y-2">
            {ranked.map((item: Item, index) => (
              <li key={item.id}>
                <Link
                  to="/title/$id"
                  params={{ id: item.id }}
                  className="flex items-center gap-3 rounded-lg p-1 hover:bg-secondary"
                >
                  <span className="rank-num w-8 shrink-0 text-center font-display text-2xl font-bold">
                    {index + 1}
                  </span>
                  {posterUrl(item.poster, true) ? (
                    <img
                      src={posterUrl(item.poster, true)!}
                      alt=""
                      className="h-[4.5rem] w-12 rounded object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="h-[4.5rem] w-12 rounded bg-secondary" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{item.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {[item.year, item.anime ? 'Anime' : item.type === 'series' ? 'Series' : 'Film']
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
