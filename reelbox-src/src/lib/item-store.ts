/**
 * The catalog entry behind a URL.
 *
 * Troy binds every catalog id to the session that fetched it and expires it
 * after an hour, so the detail and player pages cannot re-fetch by id — they
 * only ever have the id. The entry is therefore kept here, in memory, and
 * mirrored to sessionStorage so a reload of a detail page still works. When both
 * are gone the page says so and offers a search instead of inventing a title.
 */

import type { Item } from './api';

const SESSION_KEY = 'rb:items';

const memory = new Map<string, Item>();

function hydrate() {
  if (memory.size) return;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, Item>;
    for (const [id, item] of Object.entries(parsed)) if (item && item.id === id) memory.set(id, item);
  } catch {
    /* a corrupt mirror is not worth failing over */
  }
}

function persist() {
  try {
    // Only the most recent entries survive: the server expires them after an
    // hour, and a stale mirror would offer titles that can no longer resolve.
    const recent = [...memory.entries()].slice(-300);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(Object.fromEntries(recent)));
  } catch {
    /* quota or private mode; the in-memory copy still works */
  }
}

export const itemStore = {
  put(item: Item) {
    hydrate();
    memory.set(item.id, item);
    persist();
  },
  putAll(items: Item[]) {
    hydrate();
    for (const item of items) if (item?.id) memory.set(item.id, item);
    persist();
  },
  get(id: string): Item | undefined {
    hydrate();
    return memory.get(id);
  },
};
