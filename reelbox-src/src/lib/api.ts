/**
 * Troy's HTTP API, as the UI sees it.
 *
 * Every call goes through `request` so that one place decides what a failure
 * looks like. Without that, a 401 arrives as a silent empty list and the only
 * symptom is a blank home screen.
 */

import { itemStore } from './item-store';
import type { Item, Section } from './types';
export type { Item, Section } from './types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A catalog entry, already bound to this session by the server. */
export interface Stream {
  provider: string;
  quality?: number | null;
  format: string;
  duration?: number | null;
  /**
   * Opaque handle for this stream's subtitle, if the provider offers one. It is
   * not a URL: it is redeemed through one of the three subtitle endpoints, and
   * which one depends on the provider that produced it.
   */
  captionId?: string | null;
  url: string;
}

export interface Episode {
  season: number;
  episode: number;
  title?: string;
}

export interface TranscodeJob {
  id: string;
  url: string;
  duration?: number;
}

export interface TranscodeStatus {
  canPlay: boolean;
  resumeAt?: number | null;
  error?: string;
  ahead?: number;
  finished?: boolean;
  [key: string]: unknown;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    // A dropped connection is not a provider fault and must not read like one.
    throw new ApiError('Cannot reach Troy. Check the connection and try again.', 0);
  }
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) throw new ApiError(`Request failed (HTTP ${response.status})`, response.status);
  }
  if (!response.ok) throw new ApiError(body?.error || `Request failed (HTTP ${response.status})`, response.status);
  return body as T;
}

const post = <T,>(path: string, data: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

// Every entry Troy returns is bound to this session and expires, and the detail
// and player pages hold only an id, so the entry has to be kept somewhere. This
// is done in the API layer on purpose: it was previously done by one route
// (/ranking) and forgotten by the others, which made every card tapped from Home
// or Explore open a page saying the title no longer existed.
const keep = <T extends { items: Item[] }>(sections: T[]) => {
  itemStore.putAll(sections.flatMap((section) => section.items || []));
  return sections;
};

export const api = {
  session: () => request<{ authenticated: boolean }>('/api/session').then((x) => x.authenticated),
  login: (password: string) => post<{ ok: true }>('/api/login', { password }),
  logout: () => post<{ ok: true }>('/api/logout', {}),

  discover: () => request<{ sections: Section[] }>('/api/discover').then((x) => keep(x.sections)),
  category: (genreTopId: any, page: any) =>
    post<{ items: Item[]; hasMore: boolean; page: number }>('/api/category', { genreTopId, page }).then(
      (r) => {
        itemStore.putAll(r.items || []);
        return r;
      },
    ),
  search: (query: any) =>
    post<{ results: Item[]; providers: { provider: string; error: string | null }[] }>('/api/search', {
      query,
    }).then((r) => {
      itemStore.putAll(r.results || []);
      return r;
    }),
  episodes: (id: any) => post<{ episodes: Episode[]; source: string }>('/api/episodes', { id }),

  resolve: (id: any, season: any, episode: any) =>
    post<{ title: string; streams: Stream[]; providers: { provider: string; count?: number; error?: string }[] }>(
      '/api/resolve',
      { id, season, episode },
    ),

  /** Turns a resolved stream into a handle the machine will accept as a source. */
  source: (url: any, format: any) => post<{ url: string }>('/api/source', { url, format }),
  transcode: (url: any, offset: any, requestId: any) =>
    post<TranscodeJob>('/api/transcode', { url, offset, requestId }),
  transcodeStatus: (id: any, position: any) =>
    post<TranscodeStatus>('/api/transcode/status', { id, position }),
  stopTranscode: (id: any) => post<{ stopped: boolean }>('/api/transcode/stop', { id }),
  cancelTranscode: (requestId: any) => post<{ stopped: boolean }>('/api/transcode/cancel', { requestId }),
  reclaim: () => post<{ stopped: boolean }>('/api/transcode/reclaim', {}),
  /**
   * Redeems a subtitle and returns a VTT URL the player can attach.
   *
   * Troy answers with `{ url: '/caption/<id>' }` or `{ url: null }`, and the URL
   * is session-scoped and expires after six hours, so it must be fetched when
   * playback starts rather than stored.
   */
  subtitle: (path: SubtitlePath, data: Record<string, unknown>) =>
    post<{ url: string | null }>(path, data),
};

export type SubtitlePath =
  | '/api/kiss-subtitle'
  | '/api/moviebox-subtitle'
  | '/api/movy-subtitle'
  | '/api/vidlink-subtitle';

/**
 * Which subtitle endpoint a stream's caption belongs to.
 *
 * The provider name is the only thing that distinguishes them, and getting it
 * wrong asks one provider for another's caption id, which comes back empty. The
 * mapping mirrors the classic player exactly, including that 7movies serves its
 * captions from the VidLink endpoint.
 */
export function subtitleRequest(
  provider: string,
  stream: { captionId?: string | null },
  source: string | undefined,
  ids: { id: string; season: number; episode: number },
): { path: SubtitlePath; data: Record<string, unknown> } | null {
  if (source === 'kisskh') {
    return { path: '/api/kiss-subtitle', data: ids };
  }
  if (!stream.captionId) return null;
  const path: SubtitlePath = provider.startsWith('movy:')
    ? '/api/movy-subtitle'
    : provider === '7movies'
      ? '/api/vidlink-subtitle'
      : '/api/moviebox-subtitle';
  return { path, data: { id: stream.captionId } };
}
