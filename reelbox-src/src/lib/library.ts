/**
 * My List and watch history.
 *
 * Reconstructed verbatim from the build, including the custom event: the
 * original used one event so every mounted consumer re-reads storage instead of
 * holding a stale copy.
 */

import { useEffect, useState } from 'react';

const KEY = {
  list: 'rb:list',
  history: 'rb:history',
} as const;

type KeyName = keyof typeof KEY;

const read = (k: KeyName): string[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY[k]) || '[]');
  } catch {
    return [];
  }
};

const write = (k: KeyName, v: string[]) => {
  localStorage.setItem(KEY[k], JSON.stringify(v));
  window.dispatchEvent(new Event('rb:lib'));
};

export function useLib(k: KeyName) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const s = () => setIds(read(k));
    s();
    window.addEventListener('rb:lib', s);
    return () => window.removeEventListener('rb:lib', s);
  }, [k]);
  return ids;
}

export const toggleList = (id: string) => {
  const l = read('list');
  write('list', l.includes(id) ? l.filter((x) => x !== id) : [id, ...l]);
};

export const pushHistory = (id: string) =>
  write('history', [id, ...read('history').filter((x) => x !== id)].slice(0, 20));

export const clearHistory = () => write('history', []);
