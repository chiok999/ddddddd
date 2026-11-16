'use strict';
// TVMaze lookup by exact IMDb ID avoids matching an unrelated show by title.
module.exports = function createEpisodes({ request }) {
  return async function episodes(item) {
    if (item.type !== 'series' || !/^tt\d{1,12}$/.test(item.imdbId || '')) return [];
    const lookup = await request(`https://api.tvmaze.com/lookup/shows?imdb=${item.imdbId}`);
    const showId = Number(lookup.json?.id);
    if (!Number.isSafeInteger(showId) || showId < 1) return [];
    const result = await request(`https://api.tvmaze.com/shows/${showId}/episodes`);
    if (!Array.isArray(result.json)) return [];
    return result.json.slice(0, 5000).filter(e => Number.isInteger(e.season) && e.season >= 1 && Number.isInteger(e.number) && e.number >= 1).map(e => ({ season:e.season, episode:e.number, title:String(e.name || '').slice(0, 200), airdate:String(e.airdate || '').slice(0, 10) }));
  };
};
