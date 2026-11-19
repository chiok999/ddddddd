import { useState } from 'react';
import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { Check, Play, Plus, Share2, Star } from 'lucide-react';
import { Header } from '../components/Header';
import { PosterCard } from '../components/PosterCard';
import { getTitle, titles } from '../lib/movies';
import { toggleList, useLib } from '../lib/library';

export const Route = createFileRoute('/title/$id')({
  loader: ({ params }) => {
    const t = getTitle(params.id);
    if (!t) throw notFound();
    return t;
  },
  head: ({ loaderData: t }) => ({
    meta: [
      { title: `${t?.title} (${t?.year}) — ReelBox` },
      { name: 'description', content: t?.description },
      { property: 'og:title', content: `${t?.title} — ReelBox` },
      { property: 'og:description', content: t?.description },
      { property: 'og:image', content: t?.backdrop },
      { name: 'twitter:image', content: t?.backdrop },
    ],
  }),
  component: Detail,
});

function Detail() {
  const t = Route.useLoaderData();
  const saved = useLib('list').includes(t.id);
  const [season, setSeason] = useState(1);
  const similar = titles
    .filter((x) => x.id !== t.id && x.genres.some((g) => t.genres.includes(g)))
    .slice(0, 10);

  return (
    <div className="min-h-screen">
      <Header />
      <section className="relative">
        <img
          src={t.backdrop}
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-40"
        />
        <div className="hero-fade absolute inset-0" />
        <div className="relative grid grid-cols-[7rem_minmax(0,1fr)] gap-4 px-3 py-6">
          <img src={t.poster} alt={t.title} className="w-28 rounded-xl shadow-2xl" />
          <div className="min-w-0">
            <h1 className="font-display text-xl font-bold line-clamp-2">{t.title}</h1>
            <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Star className="h-4 w-4 fill-primary text-primary" />
                {t.rating}
              </span>
              {t.year}
              {' · '}
              {t.type}
              {' · '}
              {t.duration}
              {' · '}
              {t.country}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {t.genres.map((g) => (
                <span key={g} className="rounded-full bg-secondary px-2 py-0.5 text-[11px]">
                  {g}
                </span>
              ))}
            </div>
          </div>
          <div className="col-span-2">
            <p className="text-sm text-muted-foreground">{t.description}</p>
            <p className="mt-2 text-xs">
              <span className="text-muted-foreground">Cast: </span>
              {t.cast.join(', ')}
            </p>
          </div>
          <div className="col-span-2 grid grid-cols-3 gap-2">
            <Link
              to="/watch/$id"
              params={{ id: t.id }}
              search={{}}
              className="btn-primary justify-center px-2"
            >
              <Play className="h-4 w-4 fill-current" />
              Play
            </Link>
            <button onClick={() => toggleList(t.id)} className="btn-ghost justify-center px-2">
              {saved ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              My list
            </button>
            <button
              onClick={() => navigator.clipboard?.writeText(location.href)}
              className="btn-ghost justify-center px-2"
            >
              <Share2 className="h-4 w-4" />
              Share
            </button>
          </div>
        </div>
      </section>

      <div className="px-3">
        {t.seasons && (
          <section className="py-6">
            <div className="no-scrollbar flex gap-2 overflow-x-auto">
              {Array.from({ length: t.seasons }, (_, k) => (
                <button
                  key={k}
                  onClick={() => setSeason(k + 1)}
                  className={`shrink-0 rounded-full px-4 py-1.5 text-sm ${
                    season === k + 1 ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                  }`}
                >
                  Season {k + 1}
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {Array.from({ length: 8 }, (_, e) => (
                <Link
                  key={e}
                  to="/watch/$id"
                  params={{ id: t.id }}
                  search={{ s: season, e: e + 1 }}
                  className="flex items-center gap-3 rounded-lg bg-card p-3 hover:bg-secondary"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded bg-primary/15 text-primary">
                    <Play className="h-4 w-4" />
                  </span>
                  <span className="truncate text-xs">
                    S{season} · Episode {e + 1}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="py-6">
          <h2 className="mb-3 font-display text-xl font-bold">You may also like</h2>
          <div className="no-scrollbar flex gap-4 overflow-x-auto pb-2">
            {similar.map((x) => (
              <PosterCard key={x.id} t={x} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
