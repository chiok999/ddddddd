'use strict';
// Standalone browser-streaming adapter. Injected request function must pin DNS,
// reject redirects and limit response size; do not substitute the bot downloader.
module.exports = function createMoviebox({ request, safeUrl }) {
  const base = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
  const headers = { 'user-agent': 'Mozilla/5.0', referer: 'https://moviebox.ph/', origin: 'https://moviebox.ph', accept: 'application/json', 'content-type': 'application/json', 'x-client-info': '{"timezone":"Africa/Blantyre"}', 'x-request-lang': 'en' };
  let token = null, expires = 0;
  async function bff(route, payload, refresh = false) {
    if (refresh || !token || expires < Date.now()) {
      const response = await request(`${base}/home?host=moviebox.ph`, { headers });
      const xuser = response.headers.get('x-user');
      try { token = JSON.parse(xuser || '{}').token; } catch { token = null; }
      if (!token) {
        for (const c of response.headers.getSetCookie?.() || []) {
          const m = /(?:^|[;,]\s*)token=([^;]+)/.exec(c); if (m) { token = m[1]; break; }
        }
      }
      if (typeof token !== 'string' || !token || token.length > 8192) throw Error('MovieBox guest token unavailable');
      expires = Date.now() + 50 * 60000;
    }
    try {
      return await request(`${base}${route}`, { method: payload ? 'POST' : 'GET', headers: { ...headers, authorization: `Bearer ${token}` }, body: payload ? JSON.stringify(payload) : undefined });
    } catch (e) {
      if (e.status === 401 && !refresh) return bff(route, payload, true);
      throw e;
    }
  }
  async function search(query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 150) throw Error('Enter a title up to 150 characters');
    const result = await bff('/subject/search', { keyword: query.trim(), page: 1, perPage: 20 });
    const items = result.json?.data?.items || result.json?.data?.list || [];
    if (!Array.isArray(items)) return [];
    return items.slice(0, 20).map(it => {
      const s = it?.subject || it;
      const subjectId = String(s?.subjectId || ''), detailPath = String(s?.detailPath || '');
      const title = String(s?.title || '').slice(0,150), st = Number(s?.subjectType);
      if (!title || !subjectId || !detailPath || ![1,2].includes(st) || subjectId.length > 128 || detailPath.length > 512) return null;
      return { subjectId, detailPath, title, type: st === 2 ? 'series' : 'movie', year: String(s?.releaseDate || '').slice(0,4), overview: String(s?.description || '').slice(0,1000), imdbId: /^tt\d{1,12}$/.test(String(s?.imdbId || '')) ? String(s.imdbId) : null, tmdbId: /^\d{1,12}$/.test(String(s?.tmdbId || '')) ? String(s.tmdbId) : null };
    }).filter(Boolean);
  }
  async function resolve(item, season, episode) {
    if (!item || !['series','movie'].includes(item.type)) throw Error('Invalid catalog item');
    if (item.type === 'series' && (!Number.isInteger(season) || season < 1 || season > 999 || !Number.isInteger(episode) || episode < 1 || episode > 9999)) throw Error('Choose a valid season and episode');
    const domainResponse = await bff('/media-player/get-domain');
    const domain = safeUrl(domainResponse.json?.data);
    // The returned player origin is untrusted. The network layer checks DNS and
    // redirects and receives no guest token or other credentials for this host.
    const player = domain.origin;
    const attempts = item.type === 'series' ? [[season,episode], ...(season === 1 ? [[0,episode]] : [])] : [[0,0],[1,1]];
    for (const [se, ep] of attempts) {
      const qs = new URLSearchParams({ subjectId:item.subjectId, detailPath:item.detailPath, se:String(se), ep:String(ep) });
      const response = await request(`${player}/wefeed-h5api-bff/subject/play?${qs}`, { headers: { ...headers, referer: `${player}/`, 'x-source': '' } });
      const data = response.json?.data || {};
      const list = [];
      for (const s of Array.isArray(data.streams) ? data.streams.slice(0,30) : []) {
        if (Number(s?.duration) && Number(s.duration) < (item.type === 'series' ? 300 : 2400)) continue;
        try { const url=safeUrl(s.url).href; list.push({ url, format: /\.m3u8(?:\?|$)/i.test(url) ? 'hls' : 'file', quality: Number(s.resolutions) || 0 }); } catch { /* unsafe or unsupported URL */ }
      }
      for (const h of Array.isArray(data.hls) ? data.hls.slice(0,30) : []) {
        try { list.push({ url:safeUrl(typeof h === 'string' ? h : h.url).href, format:'hls', quality:Number(h?.resolutions) || 0 }); } catch { /* unsafe or unsupported URL */ }
      }
      if (list.length) return { streams:list, referer:`${player}/` };
    }
    throw Error('MovieBox returned no playable streams for this title or episode');
  }
  return { search, resolve };
};
