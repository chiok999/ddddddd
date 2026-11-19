/**
 * My List, watch history and progress.
 *
 * The keys are unchanged from the original ReelBox (`rb:*`) so a browser that
 * already holds a list keeps it after this rewrite, and the history cap stays at
 * 20. `solo-progress`, `solo-watchlist` and `solo-quality-height` are Troy's
 * existing keys and are reused rather than duplicated, so the classic UI and
 * this one agree about what has been watched.
 *
 * One event (`rb:lib`) drives every subscriber: a stale copy in one mounted
 * component was the bug this shape exists to prevent.
 */

import { useEffect, useState } from 'react';

const KEY = {
  list: 'rb:list',
  history: 'rb:history',
  progress: 'solo-progress',
  height: 'solo-quality-height',
  saver: 'solo-data-saver',
  speed: 'solo-playback-speed',
} as const;

type KeyName = 'list' | 'history';

const read = (name: string): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(name) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const write = (name: string, value: unknown) => {
  try {
    localStorage.setItem(name, JSON.stringify(value));
  } catch {
    // Storage can be full or blocked in private mode; a failed save must not
    // take the page down with it.
  }
  window.dispatchEvent(new Event('rb:lib'));
};

export function useLib(k: KeyName) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const sync = () => setIds(read(KEY[k]));
    sync();
    window.addEventListener('rb:lib', sync);
    return () => window.removeEventListener('rb:lib', sync);
  }, [k]);
  return ids;
}

export const toggleList = (id: string) => {
  const list = read(KEY.list);
  write(KEY.list, list.includes(id) ? list.filter((x) => x !== id) : [id, ...list]);
};

export const pushHistory = (id: string) =>
  write(KEY.history, [id, ...read(KEY.history).filter((x) => x !== id)].slice(0, 20));

export const clearHistory = () => write(KEY.history, []);

/**
 * Last known position for one source, keyed the way the classic player keys it
 * (`source:title:year:type:season:episode`). Progress is deleted once a title is
 * finished, so a rewatch starts at the beginning.
 */
export interface Progress {
  url: string;
  time: number;
}

export const readProgress = (): Progress[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY.progress) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.url === 'string') : [];
  } catch {
    return [];
  }
};

export const progressFor = (key: string) =>
  readProgress().find((x) => x.url === key)?.time ?? 0;

export const saveProgress = (key: string, time: number) => {
  const kept = readProgress().filter((x) => x.url !== key);
  write(KEY.progress, [{ url: key, time }, ...kept].slice(0, 60));
};

export const clearProgress = (key: string) =>
  write(KEY.progress, readProgress().filter((x) => x.url !== key));

export const readHeight = () => (Number(localStorage.getItem(KEY.height)) === 360 ? 360 : 240);

export const saveHeight = (height: number) => {
  try {
    localStorage.setItem(KEY.height, String(height));
  } catch {
    /* see write() */
  }
};

/** The speeds the player offers. Anything else in storage is not trusted. */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/**
 * The saved playback rate.
 *
 * The README has promised "playback speed is saved locally" since the player was
 * written, and nothing ever saved it: it reset to 1x on every mount and every
 * episode. A rate is a viewing preference, not a per-title one.
 */
export const readSpeed = () => {
  try {
    const stored = Number(localStorage.getItem(KEY.speed));
    return (SPEEDS as readonly number[]).includes(stored) ? stored : 1;
  } catch {
    return 1;
  }
};

export const saveSpeed = (rate: number) => {
  try {
    localStorage.setItem(KEY.speed, String(rate));
  } catch {
    /* see write() */
  }
};

export const readSaver = () => {
  try {
    const stored = localStorage.getItem(KEY.saver);
    if (stored !== null) return stored === 'true';
  } catch {
    /* fall through to the connection hint */
  }
  return !!(navigator as any).connection?.saveData;
};

export const saveSaver = (on: boolean) => {
  try {
    localStorage.setItem(KEY.saver, String(on));
  } catch {
    /* see write() */
  }
};

/**
 * The rung to download, given the viewer's preferences and their connection.
 *
 * Data saver exists because 360p is roughly twice the bytes of 240p on these
 * encodes (measured through the current CRF settings: ~260 kbps against ~130, so
 * about 114 MB an hour against 57), and on a metered connection that difference
 * is the whole bill. An
 * explicit choice wins; otherwise a connection that reports itself as slow gets
 * the smaller rung without being asked, which is the case where it matters.
 */
export const readQuality = () => {
  const chosen = readHeight();
  // A saved 360 figure is a real choice only if the viewer made it; readSaver
  // reports the saved toggle or the browser's own hint.
  if (chosen === 360 && !readSaver()) {
    const connection = (navigator as any).connection;
    const slow = connection?.effectiveType && /(^|-)2g$|(^|-)3g$/.test(connection.effectiveType);
    if (slow) return 240;
  }
  if (readSaver()) return 240;
  return chosen;
};
