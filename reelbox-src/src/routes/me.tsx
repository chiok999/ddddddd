import { useEffect, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Bookmark, Crown, Globe, History, Monitor, Smartphone, Trash2, Tv } from 'lucide-react';
import { PosterCard } from '../components/PosterCard';
import { getTitle } from '../lib/movies';
import { clearHistory, useLib } from '../lib/library';

export const Route = createFileRoute('/me')({
  head: () => ({
    meta: [
      { title: 'My ReelBox — List, History & Settings' },
      {
        name: 'description',
        content: 'Your saved titles, watch history and app language on ReelBox.',
      },
      { property: 'og:title', content: 'My ReelBox' },
      {
        property: 'og:description',
        content: 'Your saved titles, watch history and app language on ReelBox.',
      },
    ],
  }),
  component: Me,
});

const langs = [
  'English',
  'العربية',
  'Français',
  'Bahasa Indonesia',
  'हिन्दी',
  'اردو',
  'Filipino',
];

const apps = [
  [Smartphone, 'Phone & tablet'],
  [Tv, 'Android TV'],
  [Monitor, 'Windows'],
] as const;

function Me() {
  const list = useLib('list').map(getTitle).filter((x) => !!x);
  const history = useLib('history').map(getTitle).filter((x) => !!x);
  const [lang, setLang] = useState('English');

  useEffect(() => {
    setLang(localStorage.getItem('rb:lang') || 'English');
  }, []);

  const pick = (l: string) => {
    setLang(l);
    localStorage.setItem('rb:lang', l);
  };

  return (
    <div className="space-y-5 px-3 py-5">
      <h1 className="font-display text-xl font-bold">Me</h1>

      <div className="flex items-center gap-3 rounded-xl bg-premium p-4">
        <Crown className="h-9 w-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-display font-bold">Get FREE Premium</p>
          <p className="text-xs opacity-80">Ad‑free streaming, 1080p and downloads</p>
        </div>
      </div>

      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Bookmark className="h-4 w-4" />
          My List ({list.length})
        </h2>
        {list.length ? (
          <div className="grid grid-cols-3 gap-3">
            {list.map((t) => (
              <PosterCard key={t.id} t={t} grid />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Tap “My List” on any title to save it here.
          </p>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <History className="h-4 w-4" />
            Watch History
          </h2>
          {history.length > 0 && (
            <button onClick={clearHistory} aria-label="Clear history" className="text-muted-foreground">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
        {history.length ? (
          <div className="space-y-2">
            {history.map((t) => (
              <Link
                key={t.id}
                to="/watch/$id"
                params={{ id: t.id }}
                search={{}}
                className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3"
              >
                <img src={t.backdrop} alt="" className="aspect-video w-24 rounded object-cover" />
                <span className="truncate text-sm">{t.title}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Nothing watched yet.</p>
        )}
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Globe className="h-4 w-4" />
          Language
        </h2>
        <div className="flex flex-wrap gap-2">
          {langs.map((l) => (
            <button
              key={l}
              onClick={() => pick(l)}
              className={`rounded-full px-3 py-1 text-xs ${
                lang === l ? 'bg-primary text-primary-foreground' : 'bg-secondary'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Get the app</h2>
        <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
          {apps.map(([Icon, l]) => (
            <div key={l} className="rounded-lg bg-card p-3">
              <Icon className="mx-auto mb-1 h-5 w-5 text-primary" />
              {l}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
