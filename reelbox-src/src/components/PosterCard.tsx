import { Link } from '@tanstack/react-router';
import { Star } from 'lucide-react';
import type { Title } from '../lib/movies';

/** `grid` switches the card from a fixed rail width to filling its track. */
export function PosterCard({ t, grid }: { t: Title; grid?: boolean }) {
  return (
    <Link
      to="/title/$id"
      params={{ id: t.id }}
      className={`group block min-w-0 ${grid ? '' : 'w-28 shrink-0'}`}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-muted">
        <img src={t.poster} alt={t.title} loading="lazy" className="h-full w-full object-cover" />
        <span className="absolute left-1.5 top-1.5 flex items-center gap-0.5 rounded bg-background/80 px-1 py-0.5 text-[10px]">
          <Star className="h-2.5 w-2.5 fill-primary text-primary" />
          {t.rating}
        </span>
      </div>
      <p className="mt-1.5 truncate text-xs font-medium">{t.title}</p>
      <p className="truncate text-[11px] text-muted-foreground">
        {t.year} · {t.type}
      </p>
    </Link>
  );
}
