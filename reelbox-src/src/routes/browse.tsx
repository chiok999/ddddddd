import { Link, createFileRoute } from '@tanstack/react-router';
import { Header } from '../components/Header';
import { PosterCard } from '../components/PosterCard';
import { genres, titles } from '../lib/movies';

interface Search {
  q?: string;
  type?: string;
  genre?: string;
  sort?: 'rating' | 'year';
}

export const Route = createFileRoute('/browse')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    q: typeof s.q === 'string' ? s.q : undefined,
    type: typeof s.type === 'string' ? s.type : undefined,
    genre: typeof s.genre === 'string' ? s.genre : undefined,
    sort: s.sort === 'rating' || s.sort === 'year' ? s.sort : undefined,
  }),
  head: () => ({
    meta: [
      { title: 'Browse & Search — ReelBox' },
      { name: 'description', content: 'Filter movies, series and anime by type, genre and rating.' },
      { property: 'og:title', content: 'Browse & Search — ReelBox' },
      {
        property: 'og:description',
        content: 'Filter movies, series and anime by type, genre and rating.',
      },
    ],
  }),
  component: Browse,
});

const types = [undefined, 'Movie', 'TV Series', 'Anime'] as const;
const sorts = [
  [undefined, 'Popular'],
  ['rating', 'Top rated'],
  ['year', 'Newest'],
] as const;

function Chip({
  active,
  to,
  search,
  children,
}: {
  active: boolean;
  to: '/browse';
  search: Search;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      search={search}
      className={`shrink-0 rounded-full px-3 py-1 text-xs ${
        active ? 'bg-primary text-primary-foreground' : 'bg-secondary'
      }`}
    >
      {children}
    </Link>
  );
}

function Browse() {
  const s = Route.useSearch();
  const q = (s.q || '').toLowerCase();

  let r = titles.filter(
    (t) =>
      (!q || t.title.toLowerCase().includes(q)) &&
      (!s.type || t.type === s.type) &&
      (!s.genre || t.genres.includes(s.genre)),
  );
  if (s.sort) r = [...r].sort((a, b) => (b[s.sort!] as number) - (a[s.sort!] as number));

  return (
    <div className="min-h-screen">
      <Header />
      <div className="px-3 py-4">
        <h1 className="font-display text-xl truncate font-bold">
          {s.q ? `Results for "${s.q}"` : 'Browse'}
        </h1>

        <div className="mt-5 space-y-2">
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            {types.map((t) => (
              <Chip key={t || 'all'} to="/browse" search={{ ...s, type: t }} active={s.type === t}>
                {t ?? 'All types'}
              </Chip>
            ))}
          </div>
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            {[undefined, ...genres].map((g) => (
              <Chip key={g || 'all'} to="/browse" search={{ ...s, genre: g }} active={s.genre === g}>
                {g ?? 'All genres'}
              </Chip>
            ))}
          </div>
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            {sorts.map(([v, label]) => (
              <Chip key={label} to="/browse" search={{ ...s, sort: v }} active={s.sort === v}>
                {label}
              </Chip>
            ))}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-3">
          {r.map((t) => (
            <PosterCard key={t.id} t={t} grid />
          ))}
        </div>
        {!r.length && <p className="mt-10 text-muted-foreground">Nothing found.</p>}
      </div>
    </div>
  );
}
