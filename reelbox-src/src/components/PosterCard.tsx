import { Link } from '@tanstack/react-router';
import { posterUrl } from '../lib/art';
import type { Item } from '../lib/api';

/**
 * A catalog card. `list` is the group the title belongs to (`movies`, `shows`,
 * `anime`) and becomes the second path segment, so a card's link says what it is
 * without the detail page having to resolve it again.
 */
export function PosterCard({ item, list = 'movies', grid = false }: { item: Item; list?: string; grid?: boolean }) {
  const src = posterUrl(item.poster);
  return (
    <Link
      to="/title/$id"
      params={{ id: item.id }}
      className={`group min-w-0 ${grid ? '' : 'w-[7.5rem] shrink-0'}`}
      title={item.title}
    >
      <div className="aspect-[2/3] overflow-hidden rounded-lg bg-secondary">
        {src ? (
          <img
            src={src}
            alt={item.title}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-opacity group-hover:opacity-80"
          />
        ) : (
          <div className="grid h-full place-items-center p-2 text-center text-[11px] text-muted-foreground">
            {item.title}
          </div>
        )}
      </div>
      <p className="mt-1 truncate text-xs">{item.title}</p>
      <p className="truncate text-[10px] text-muted-foreground">
        {[item.year, item.anime ? 'Anime' : item.type === 'series' ? 'Series' : 'Film'].filter(Boolean).join(' · ')}
      </p>
      <span className="hidden">{list}</span>
    </Link>
  );
}
