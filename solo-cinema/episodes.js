'use strict';
module.exports = function createEpisodes({ request }) {
  return async function episodes(item) {
    if (item.type !== 'series' || !/^tt\d{1,12}$/.test(item.imdbId || '')) return [];
    // Cinemeta carries episode listings for shows that TVMaze doesn't know.
    try {
      const {json} = await request(`https://cinemeta-live.strem.io/meta/series/${item.imdbId}.json`);
      if (json?.meta?.id === item.imdbId && Array.isArray(json.meta.videos)) {
        const list=json.meta.videos.slice(0,5000).filter(e => Number.isInteger(e.season) && e.season>=1 && Number.isInteger(e.episode) && e.episode>=1).map(e=>({season:e.season,episode:e.episode,title:String(e.title || '').slice(0,200),airdate:String(e.released || '').slice(0,10)}));
        if (list.length) return list;
      }
    } catch { /* try TVMaze */ }
    const lookup = await request(`https://api.tvmaze.com/lookup/shows?imdb=${item.imdbId}`);
    const showId = Number(lookup.json?.id);
    if (!Number.isSafeInteger(showId) || showId < 1) return [];
    const result = await request(`https://api.tvmaze.com/shows/${showId}/episodes`);
    if (!Array.isArray(result.json)) return [];
    return result.json.slice(0, 5000).filter(e => Number.isInteger(e.season) && e.season >= 1 && Number.isInteger(e.number) && e.number >= 1).map(e => ({ season:e.season, episode:e.number, title:String(e.name || '').slice(0, 200), airdate:String(e.airdate || '').slice(0, 10) }));
  };
};
