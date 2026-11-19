import { useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Search as SearchIcon } from 'lucide-react';
import { Header } from '../components/Header';
import { PosterCard } from '../components/PosterCard';
import { api, type Item } from '../lib/api';

interface Search {
  q?: string;
  /** Genre rail opened from "See more". */
  g?: string;
  t?: string;
}

export const Route = createFileRoute('/browse')({
  validateSearch: (raw: Record<string, unknown>): Search => ({
    q: typeof raw.q === 'string' && raw.q ? raw.q : undefined,
    g: typeof raw.g === 'string' && /^\d{1,25}$/.test(raw.g) ? raw.g : undefined,
    t: typeof raw.t === 'string' ? raw.t : undefined,
  }),
  head: () => ({
    meta: [
      { title: 'Explore — ReelBox' },
      { name: 'description', content: 'Search and browse movies, series and anime by type, genre and rating.' },
      { property: 'og:title', content: 'Explore — ReelBox' },
      { property: 'og:description', content: 'Search and browse movies, series and anime by type, genre and rating.' },
    ],
  }),
  component: Browse,
});

function Browse() {
  const { q, g, t } = Route.useSearch();
  const [query, setQuery] = useState(q || '');
  const [results, setResults] = useState<Item[] | null>(null);
  const [providers, setProviders] = useState<{ provider: string; error: string | null }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => setQuery(q || ''), [q]);

  // A search replaces the list; a category page appends to it, because "see
  // more" is a continuation and not a new question.
  useEffect(() => {
    let live = true;
    setError('');
    setResults(null);
    setPage(1);
    setHasMore(false);
    if (g) {
      setBusy(true);
      api
        .category(g, 1)
        .then((r) => {
          if (!live) return;
          setResults(r.items);
          setHasMore(!!r.hasMore);
        })
        .catch((e) => live && setError(e.message))
        .finally(() => live && setBusy(false));
    } else if (q) {
      setBusy(true);
      api
        .search(q)
        .then((r) => {
          if (!live) return;
          setResults(r.results);
          setProviders(r.providers);
        })
        .catch((e) => live && setError(e.message))
        .finally(() => live && setBusy(false));
    } else {
      setResults([]);
    }
    return () => {
      live = false;
    };
  }, [q, g]);

  const more = async () => {
    if (!g || busy) return;
    setBusy(true);
    try {
      const next = page + 1;
      const r = await api.category(g, next);
      setResults((prev) => [...(prev || []), ...r.items]);
      setPage(next);
      setHasMore(!!r.hasMore);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const failed = useMemo(() => providers.filter((p) => p.error).map((p) => `${p.provider}: ${p.error}`), [providers]);
  const heading = g ? t || 'Category' : 'Explore';

  return (
    <div>
      <Header />
      <div className="px-3 py-4">
        <h1 className="font-display text-xl font-bold">{heading}</h1>

        <form
          className="mt-3 flex items-center gap-2 rounded-full bg-secondary px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            const next = query.trim();
            if (next) window.history.pushState({}, '', `/browse?q=${encodeURIComponent(next)}`);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }}
        >
          <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a title…"
            aria-label="Search a title"
            maxLength={150}
            className="w-full min-w-0 bg-transparent text-sm outline-none"
          />
        </form>

        {failed.length > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">Some providers did not answer — {failed.join(' · ')}</p>
        )}
        {error && <p className="mt-4 rounded-lg bg-secondary p-3 text-sm">{error}</p>}

        {results === null ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{busy ? 'Searching…' : ''}</p>
        ) : results.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {g || q ? 'Nothing found. Try a different title or category.' : 'Search for a film or series to begin.'}
          </p>
        ) : (
          <>
            <p className="mb-2 mt-4 text-xs text-muted-foreground">
              {results.length} title{results.length === 1 ? '' : 's'}
            </p>
            <div className="grid grid-cols-3 gap-3">
              {results.map((item) => (
                <PosterCard key={item.id} item={item} grid />
              ))}
            </div>
            {hasMore && (
              <button onClick={more} disabled={busy} className="btn-ghost mt-4 w-full justify-center">
                {busy ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
