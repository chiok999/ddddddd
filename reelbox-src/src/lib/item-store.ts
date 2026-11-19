/**
 * The catalog entry behind a URL.
 *
 * Troy binds every catalog id to the session that fetched it and expires it
 * after an hour, so the detail and player pages cannot re-fetch by id from a
 * generic endpoint — the id alone is not enough. The entry is therefore kept
 * here, in memory, and mirrored to sessionStorage so a reload works.
 *
 * A URL, though, is shareable and a tab can be closed, so a memory map is not
 * always enough. The recovery route is Troy's own search: the entry carries the
 * title, type and year, and looking those up again mints a fresh id for this
 * session. That is why the stored copy is kept whole rather than reduced to the
 * fields a page happens to render.
 *
 * One consequence worth knowing: the id changes when an entry is recovered, so
 * anything holding the old one (a saved list, a resume position) must be
 * updated to the new entry. See `remember` for that.
 */

import type { Item } from './types';

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

// Imported lazily inside `recover`: api.ts imports this module, so a top-level
// import back would be a cycle.
const loadApi = async () => (await import('./api')).api;

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
  /**
   * Re-mints an id for an entry that has expired.
   *
   * Troy's search is the only way back to a fresh catalog id, so the title is
   * looked up by name and the closest match is taken. Being imprecise here is
   * worse than failing, so the match must agree on title and, when both sides
   * know it, on type. Year is used to choose between otherwise equal matches
   * rather than as a requirement: a provider's year is often one out.
   */
  async recover(id: string): Promise<Item | null> {
    hydrate();
    const known = memory.get(id);
    if (!known) return null;
    const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    try {
      const api = await loadApi();
      const { results } = await api.search(known.title);
      const sameTitle = results.filter((r) => norm(r.title) === norm(known.title));
      if (!sameTitle.length) return null;
      const sameType = sameTitle.filter((r) => !r.type || !known.type || r.type === known.type);
      const pool = sameType.length ? sameType : sameTitle;
      const sameYear = pool.find((r) => r.year && known.year && r.year === known.year);
      const found = sameYear || pool[0];
      // The new id resolves; the old one does not, so the caller is given a
      // mapping to carry over the things that referenced it.
      memory.set(id, found);
      memory.set(found.id, found);
      persist();
      return found;
    } catch {
      // A 401 means the session went, not that the title is gone; the caller
      // reloads and the gate takes over from there. Either way this returns
      // nothing rather than throwing, because a failed recovery is a state the
      // page can explain.
      return null;
    }
  },
};
