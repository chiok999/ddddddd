import { useEffect, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Bookmark, History, LogOut, Trash2, User } from 'lucide-react';
import { Header } from '../components/Header';
import { PosterCard } from '../components/PosterCard';
import { api } from '../lib/api';
import { clearHistory, useLib } from '../lib/library';
import { itemStore } from '../lib/item-store';

export const Route = createFileRoute('/me')({
  head: () => ({
    meta: [
      { title: 'My ReelBox — List, History & Session' },
      { name: 'description', content: 'Your saved titles, watch history and session on ReelBox.' },
      { property: 'og:title', content: 'My ReelBox' },
      { property: 'og:description', content: 'Your saved titles, watch history and session on ReelBox.' },
    ],
  }),
  component: Me,
});

function Me() {
  const list = useLib('list').map((id) => itemStore.get(id));
  const history = useLib('history').map((id) => itemStore.get(id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
  }, []);

  const signOut = async () => {
    setBusy(true);
    try {
      await api.logout();
      window.location.assign('/');
    } catch (err: any) {
      setError(err.message || 'Sign out failed');
      setBusy(false);
    }
  };

  const saved = list.filter((x): x is NonNullable<typeof x> => !!x);
  const watched = history.filter((x): x is NonNullable<typeof x> => !!x);

  return (
    <div>
      <Header />
      <div className="space-y-5 px-3 py-5">
        <h1 className="font-display text-xl font-bold">Me</h1>

        <section>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Bookmark className="h-4 w-4" />
            My List ({saved.length})
          </h2>
          {saved.length ? (
            <div className="grid grid-cols-3 gap-3">
              {saved.map((item) => (
                <PosterCard key={item.id} item={item} grid />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Tap “My list” on any title to save it here.</p>
          )}
          {list.length > saved.length && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {list.length - saved.length} saved title(s) came from a previous session and need a fresh search to
              load.
            </p>
          )}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <History className="h-4 w-4" />
              Watch History
            </h2>
            {watched.length > 0 && (
              <button onClick={clearHistory} aria-label="Clear history" className="text-muted-foreground">
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
          {watched.length ? (
            <div className="space-y-2">
              {watched.map((item) => (
                <Link
                  key={item.id}
                  to="/watch/$id"
                  params={{ id: item.id }}
                  search={{ s: undefined, e: undefined }}
                  className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3"
                >
                  <span className="grid aspect-video w-24 place-items-center rounded bg-secondary text-[10px] text-muted-foreground">
                    Resume
                  </span>
                  <span className="truncate text-sm">{item.title}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing watched yet.</p>
          )}
        </section>

        <section>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <User className="h-4 w-4" />
            Session
          </h2>
          <p className="text-xs text-muted-foreground">
            Signed in to this Troy instance. Signing out also ends any conversion this browser started.
          </p>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          <button onClick={signOut} disabled={busy} className="btn-ghost mt-2">
            <LogOut className="h-4 w-4" />
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </section>

        <section>
          {/* The classic player is a separate page, not a route in this app. */}
          <a href="/classic/" className="text-xs text-muted-foreground underline">
            Open the classic player
          </a>
        </section>
      </div>
    </div>
  );
}
