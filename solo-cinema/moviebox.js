'use strict';
// Standalone browser-streaming adapter. Injected request function must pin DNS,
// reject redirects and limit response size; do not substitute the bot downloader.
function alternativeYearConflict(a,b) { return !!a && !!b && String(a)!==String(b); }
// One subject shape for everything that returns a subject list, so a title from
// a home row, a search result and a paged category all behave identically
// downstream. `perPage` is a cap, not a promise: the provider decides.
const PER_PAGE = 20;
function normalizeSubjects(json, limit = PER_PAGE) {
  const data = json?.data || {};
  const items = data.items || data.subjectList || data.list || [];
  if (!Array.isArray(items)) return { items: [], hasMore: false };
  const pager = data.pager || {};
  const normalized = items.slice(0, limit).map(raw => {
    const s = raw?.subject || raw;
    const subjectId = String(s?.subjectId || ''), detailPath = String(s?.detailPath || '');
    const title = String(s?.title || '').slice(0, 150), type = Number(s?.subjectType);
    if (!title || !subjectId || !detailPath || ![1, 2, 4].includes(type)) return null;
    if (subjectId.length > 128 || detailPath.length > 512 || s?.isPornographic === true) return null;
    let poster = null;
    try {
      const u = new URL(s?.cover?.url || s?.image?.url);
      if (u.protocol === 'https:' && ['pbcdn.aoneroom.com', 'pbcdnw.aoneroom.com'].includes(u.hostname) && !u.username && !u.password && !u.port && u.href.length < 2048) poster = u.href;
    } catch { /* no usable artwork */ }
    return {
      source: 'moviebox',
      subjectId,
      detailPath,
      title,
      type: type === 1 ? 'movie' : 'series',
      year: String(s?.releaseDate || '').slice(0, 4),
      overview: String(s?.description || '').slice(0, 1000),
      imdbId: /^tt\d{1,12}$/.test(String(s?.imdbId || '')) ? String(s.imdbId) : null,
      tmdbId: /^\d{1,12}$/.test(String(s?.tmdbId || '')) ? String(s.tmdbId) : null,
      poster,
      anime: type === 4 || /\banime\b/i.test(String(s?.genre || '')),
    };
  }).filter(Boolean);
  // `hasMore` is the only stop signal worth trusting: an empty page is not the
  // same thing, and a page that returns fewer than asked is not either.
  return { items: normalized, hasMore: pager.hasMore === true };
}
module.exports = function createMoviebox({ request, safeUrl }) {
  const base = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
  const headers = { 'user-agent': 'Mozilla/5.0', referer: 'https://moviebox.ph/', origin: 'https://moviebox.ph', accept: 'application/json', 'content-type': 'application/json', 'x-client-info': '{"timezone":"Africa/Blantyre"}', 'x-request-lang': 'en' };
  let token = null, expires = 0;
  async function bff(route, payload, refresh = false) {
    if (refresh || !token || expires < Date.now()) {
      const response = await request(`${base}/home?host=moviebox.ph`, { headers, timeoutMs:7000 });
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
      return await request(`${base}${route}`, { timeoutMs:7000, method: payload ? 'POST' : 'GET', headers: { ...headers, authorization: `Bearer ${token}` }, body: payload ? JSON.stringify(payload) : undefined });
    } catch (e) {
      if (e.status === 401 && !refresh) return bff(route, payload, true);
      throw e;
    }
  }
  async function home() {
    const response=await request(`${base}/home?host=moviebox.ph`,{headers,timeoutMs:7000});
    return require('./moviebox-home').normalizeHome(response.json);
  }
  // A home row is a curated list with a genreTopId behind it. The site's own
  // "more" button asks this endpoint for the rest of that list, which is the
  // only way to grow a row past the ~20 subjects it ships with.
  async function ranking(genreTopId, page = 1) {
    if (!/^\d{1,25}$/.test(String(genreTopId || ''))) throw Error('Invalid category');
    if (!Number.isInteger(page) || page < 1 || page > 500) throw Error('Invalid page');
    const result = await bff(`/ranking-list/content?${new URLSearchParams({ id: String(genreTopId), page: String(page), perPage: String(PER_PAGE) })}`);
    return normalizeSubjects(result.json, PER_PAGE);
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
  async function episodes(item) {
    if(item?.type!=='series' || typeof item.detailPath!=='string' || !item.detailPath || item.detailPath.length>512)return [];
    const response=await request(`${base}/detail?${new URLSearchParams({detailPath:item.detailPath})}`,{headers,timeoutMs:7000});
    const data=response.json?.data, subject=data?.subject;
    if(String(subject?.subjectId || '')!==String(item.subjectId || '') || Number(subject?.subjectType)!==2)return [];
    const seasons=Array.isArray(data?.resource?.seasons)?data.resource.seasons:[];const result=[],seen=new Set();
    for(const row of seasons.slice(0,100)){
      const season=Number(row?.se),max=Number(row?.maxEp);
      if(!Number.isInteger(season)||season<1||season>999||!Number.isInteger(max)||max<1||max>9999||seen.has(season))continue;
      seen.add(season);for(let episode=1;episode<=max && result.length<5000;episode++)result.push({season,episode,title:`Episode ${episode}`});
    }
    return result;
  }
  async function resolve(item, season, episode) {
    if (!item || !['series','movie'].includes(item.type)) throw Error('Invalid catalog item');
    if (item.type === 'series' && (!Number.isInteger(season) || season < 1 || season > 999 || !Number.isInteger(episode) || episode < 1 || episode > 9999)) throw Error('Choose a valid season and episode');
    async function playCandidate(candidate) {
      const attempts = candidate.type === 'series' ? [[season,episode], ...(season === 1 ? [[0,episode]] : [])] : [[0,0],[1,1]];
      for (const [se, ep] of attempts) {
        // Refresh the returned player domain once after an empty response or
        // a 403/404, matching the bot's recovery path without credentials to it.
        for (let refresh=0; refresh<2; refresh++) {
          const domainResponse = await bff('/media-player/get-domain');
          const player = safeUrl(domainResponse.json?.data).origin;
          const qs = new URLSearchParams({ subjectId:candidate.subjectId, detailPath:candidate.detailPath, se:String(se), ep:String(ep) });
          const referer = `${player}/spa/videoPlayPage/movies/${encodeURIComponent(candidate.detailPath)}?${new URLSearchParams({ id:candidate.subjectId, type:'/movie/detail', detailSe:String(se), detailEp:String(ep), lang:'en' })}`;
          let response;
          try { response = await request(`${player}/wefeed-h5api-bff/subject/play?${qs}`, { headers: { ...headers, referer, 'x-source': '' } }); }
          catch(e) { if ((e.status === 403 || e.status === 404) && refresh === 0) continue; throw e; }
          const data = response.json?.data || {};
          const list = [];
          for (const stream of Array.isArray(data.streams) ? data.streams.slice(0,30) : []) {
            if (Number(stream?.duration) && Number(stream.duration) < (candidate.type === 'series' ? 300 : 2400)) continue;
            try { const url=safeUrl(stream.url).href; list.push({ url, format: /\.m3u8(?:\?|$)/i.test(url) ? 'hls' : 'file', quality: Number(stream.resolutions) || 0, duration: Number.isFinite(Number(stream.duration)) && Number(stream.duration)>0 && Number(stream.duration)<=86400 ? Number(stream.duration) : null }); } catch { /* unsafe or unsupported URL */ }
          }
          for (const stream of Array.isArray(data.hls) ? data.hls.slice(0,30) : []) {
            try { list.push({ url:safeUrl(typeof stream === 'string' ? stream : stream.url).href, format:'hls', quality:Number(stream?.resolutions) || 0 }); } catch { /* unsafe or unsupported URL */ }
          }
          if (list.length) {
            const captionStream=(Array.isArray(data.streams) ? data.streams : []).find(s=>s?.id);
            const captionInfo=captionStream ? {id:String(captionStream.id),format:String(captionStream.format || 'MP4'),subjectId:candidate.subjectId,detailPath:candidate.detailPath} : null;
            return { streams:list, referer, captionInfo };
          }
        }
      }
      return null;
    }
    let first, firstError;
    try { first = await playCandidate(item); } catch (e) { firstError=e; }
    if (first) return first;
    // The selected MovieBox subject can be a duplicate without resources.
    // Only retry exact title/type/year matches to avoid playing unrelated shows.
    const normalized=s=>String(s || '').toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g,' ').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();
    const matches=await search(item.title).catch(()=>[]);
    for (const alternative of matches.filter(x=>x.subjectId!==item.subjectId && x.type===item.type && normalized(x.title)===normalized(item.title) && (!item.year || !alternativeYearConflict(item.year,x.year))).slice(0,2)) {
      try { const found=await playCandidate(alternative); if(found) return found; } catch { /* try the next exact match */ }
    }
    if (firstError) throw firstError;
    throw Error('MovieBox returned no playable streams for this title or episode');
  }
  async function subtitle(info) {
    if (!info || !info.id || !info.subjectId || !info.detailPath) return null;
    const params=new URLSearchParams({id:info.id,format:info.format,subjectId:info.subjectId,detailPath:info.detailPath});
    for(const route of ['/subject/caption','/subject/captions','/subject/subtitle']) {
      let result; try { result=await bff(`${route}?${params}`); } catch { continue; }
      const data=result.json?.data || {};
      const tracks=Array.isArray(data)?data:(data.captions || data.list || data.subtitles || data.tracks || []);
      if(!Array.isArray(tracks)) continue;
      const track=tracks.find(t=>/^(?:en|eng|english)(?:$|[-_\s])/i.test(String(t?.language || t?.lan || t?.lang || t?.code || '')));
      if(!track) continue;
      try {
        const url=safeUrl(track.url || track.src || track.subtitleUrl);
        const text=(await request(url.href)).text?.replace(/^\uFEFF/,'').trim();
        if(!text || /^<(!doctype|html)/i.test(text) || !text.includes('-->')) continue;
        const converted=text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,'$1.$2');
        return /^WEBVTT/i.test(converted) ? converted : `WEBVTT\n\n${converted}`;
      } catch { /* malformed or unreachable subtitle */ }
    }
    return null;
  }
  return { search, resolve, subtitle, home, episodes, ranking };
};
