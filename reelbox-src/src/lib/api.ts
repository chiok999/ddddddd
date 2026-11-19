/**
 * Troy's HTTP API, as the UI sees it.
 *
 * Every call goes through `request` so that one place decides what a failure
 * looks like. Without that, a 401 arrives as a silent empty list and the only
 * symptom is a blank home screen.
 */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A catalog entry, already bound to this session by the server. */
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

export interface Stream {
  provider: string;
  quality?: number | null;
  format: string;
  duration?: number | null;
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

export const api = {
  session: () => request<{ authenticated: boolean }>('/api/session').then((x) => x.authenticated),
  login: (password: string) => post<{ ok: true }>('/api/login', { password }),
  logout: () => post<{ ok: true }>('/api/logout', {}),

  discover: () => request<{ sections: Section[] }>('/api/discover').then((x) => x.sections),
  category: (genreTopId: any, page: any) =>
    post<{ items: Item[]; hasMore: boolean; page: number }>('/api/category', { genreTopId, page }),
  search: (query: any) =>
    post<{ results: Item[]; providers: { provider: string; error: string | null }[] }>('/api/search', {
      query,
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
  subtitle: (path: any, data: any) => post<{ url: string | null }>(path, data),
};
