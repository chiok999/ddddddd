'use strict';
// These adapters use only fixed API origins; the returned URLs still go through
// the media proxy's per-hop URL and DNS validation before a connection is made.
function createProviders({ request, safeUrl }) {
  async function vaplayer(item, season, episode) {
    if (!/^tt\d{1,12}$/.test(item.imdbId || '')) throw new Error('IMDb ID unavailable');
    const series = item.type === 'series';
    const qs = new URLSearchParams({ imdb: item.imdbId, type: series ? 'tv' : 'movie' });
    if (series) { qs.set('season', String(season)); qs.set('episode', String(episode)); }
    const origin = 'https://nextgencloudfabric.com';
    const referer = series ? `${origin}/embed/tv/${item.imdbId}/${season}/${episode}` : `${origin}/embed/movie/${item.imdbId}`;
    const { json } = await request(`https://streamdata.vaplayer.ru/api.php?${qs}`, { headers: { referer, origin, accept: 'application/json, */*' } });
    const list = String(json?.status_code) === '200' && Array.isArray(json?.data?.stream_urls) ? json.data.stream_urls : [];
    const streams = [];
    for (const raw of list.slice(0, 20)) {
      if (typeof raw !== 'string') continue;
      try { streams.push({ url: safeUrl(raw).href, format: 'hls', quality: 0 }); } catch { /* reject unsupported URLs */ }
    }
    return { streams, referer, origin };
  }
  async function vidsrc(item, season, episode) {
    if (!/^\d{1,12}$/.test(String(item.tmdbId || ''))) throw new Error('TMDB ID unavailable');
    const path = item.type === 'series' ? `embed/tv?tmdb=${item.tmdbId}&season=${season}&episode=${episode}` : `embed/movie?tmdb=${item.tmdbId}`;
    const { text } = await request(`https://vidsrc.net/${path}`);
    const rawHash = /data-hash="([^"]+)"/i.exec(text)?.[1] || /cloudorizon\.com\/rcp\/([a-z0-9]+)/i.exec(text)?.[1] || /"hash":"([a-z0-9]+)"/i.exec(text)?.[1];
    if (!/^[a-z0-9]{1,160}$/i.test(rawHash || '')) return { streams: [] };
    const result = await request(`https://cloudorizon.com/rcp/${rawHash}`);
    const found = result.text.match(/https?:\/\/[^\s"'<>\\]+?\.m3u8(?:\?[^\s"'<>\\]*)?/gi) || [];
    const streams = [];
    for (const raw of found.slice(0, 20)) {
      try { streams.push({ url: safeUrl(raw).href, format: 'hls', quality: 0 }); } catch { /* reject unsupported URLs */ }
    }
    return { streams };
  }
  return { vaplayer, vidsrc };
}
async function resolveProviders({ moviebox, providers, item, season, episode }) {
  if (item.type === 'series' && (!Number.isInteger(season) || season < 1 || season > 999 || !Number.isInteger(episode) || episode < 1 || episode > 9999)) throw Error('Choose a valid season and episode');
  const tasks = [['moviebox', () => moviebox.resolve(item, season, episode)], ['vaplayer', () => providers.vaplayer(item, season, episode)], ['vidsrc', () => providers.vidsrc(item, season, episode)]];
  const outcomes = await Promise.all(tasks.map(async ([provider, task]) => {
    try { const result = await task(); return { provider, streams: result.streams.map(s => ({ ...s, provider, referer: result.referer, origin: result.origin, captionInfo:result.captionInfo })), error: null }; }
    catch (err) { return { provider, streams: [], error: String(err?.message || 'Unavailable').slice(0, 160) }; }
  }));
  return { streams: outcomes.flatMap(o => o.streams), providers: outcomes.map(o => ({ provider: o.provider, count: o.streams.length, error: o.error })) };
}
module.exports = { createProviders, resolveProviders };
