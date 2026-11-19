/**
 * Poster and backdrop artwork.
 *
 * Titles come from several providers whose images are not all fetchable from a
 * browser, and the old UI already routed every one through wsrv.nl to resize and
 * re-encode. The hostname allowlist is the same list the original used, and it
 * lives here rather than in each component so a new provider cannot quietly
 * widen it.
 */

const POSTER_HOSTS = ['images.metahub.space', 'live.metahub.space', 'pbcdn.aoneroom.com', 'pbcdnw.aoneroom.com'];
const BACKDROP_HOSTS = ['images.metahub.space', 'live.metahub.space'];

function proxy(input: unknown, hosts: string[], width: number, quality: number) {
  try {
    const url = new URL(String(input));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (!hosts.includes(url.hostname)) return null;
    const out = new URL('https://wsrv.nl/');
    out.searchParams.set('url', url.href);
    out.searchParams.set('w', String(width));
    out.searchParams.set('q', String(quality));
    out.searchParams.set('output', 'webp');
    return out.href;
  } catch {
    return null;
  }
}

export const posterUrl = (input: unknown, small = false) =>
  proxy(input, POSTER_HOSTS, small ? 140 : 240, small ? 45 : 60);

export const backdropUrl = (input: unknown, small = false) =>
  proxy(input, BACKDROP_HOSTS, small ? 960 : 1600, 62);

const IMDB = /^tt\d{1,12}$/;

/** Cinemeta serves a still by IMDb id at a fixed shape; no id means no art. */
export const backdropFor = (item?: { imdbId?: string | null } | null) =>
  item && IMDB.test(String(item.imdbId || ''))
    ? backdropUrl(`https://images.metahub.space/background/medium/${item.imdbId}/img`)
    : null;
