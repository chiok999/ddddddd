/**
 * The shapes Troy's catalog endpoints return.
 *
 * These live on their own so that `item-store` can describe a stored entry
 * without importing `api`, which imports `item-store`. Keeping the types here
 * removes that cycle instead of relying on import order.
 */

export interface Item {
  id: string;
  title: string;
  type?: string;
  year?: number | string;
  overview?: string;
  poster?: string | null;
  source?: string;
  anime?: boolean;
  imdbId?: string | null;
}

export interface Section {
  id: string;
  title?: string;
  source?: string;
  groups?: string[];
  genreTopId?: string;
  error?: string | null;
  items: Item[];
}
