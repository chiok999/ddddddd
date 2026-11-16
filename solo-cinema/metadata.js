'use strict';
module.exports = function createMetadata({ request }) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return async function enrich(item) {
    if (item.imdbId && item.tmdbId) return item;
    const title = String(item.title || '').slice(0, 150);
    if (!title) return item;
    const type = item.type === 'series' ? 'series' : 'movie';
    const result = await request(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(title)}.json`);
    const hits = Array.isArray(result.json?.metas) ? result.json.metas : [];
    // Only exact title and, when supplied by both sources, exact release year.
    const matches = hits.filter(hit => norm(hit.name) === norm(title) && (!item.year || !String(hit.releaseInfo || hit.year || '').match(/\d{4}/) || String(hit.releaseInfo || hit.year).match(/\d{4}/)[0] === item.year));
    if (matches.length !== 1) return item;
    const hit = matches[0];
    return { ...item, imdbId:item.imdbId || (/^tt\d{1,12}$/.test(hit.id || '') ? hit.id : null), tmdbId:item.tmdbId || (/^\d{1,12}$/.test(String(hit.moviedb_id || '')) ? String(hit.moviedb_id) : null) };
  };
};
