'use strict';
module.exports = function createMetadata({ request }) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return async function enrich(item) {
    let out = { ...item };
    if (!out.imdbId) {
      const title = String(item.title || '').slice(0, 150);
      if (!title) return out;
      const type = item.type === 'series' ? 'series' : 'movie';
      const result = await request(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(title)}.json`);
      const hits = Array.isArray(result.json?.metas) ? result.json.metas : [];
      // Only exact title and, when supplied by both sources, exact release year.
      const matches = hits.filter(hit => norm(hit.name) === norm(title) && (!item.year || !String(hit.releaseInfo || hit.year || '').match(/\d{4}/) || String(hit.releaseInfo || hit.year).match(/\d{4}/)[0] === item.year));
      if (matches.length !== 1) return out;
      const hit = matches[0];
      out.imdbId = /^tt\d{1,12}$/.test(hit.id || '') ? hit.id : null;
      if (!out.tmdbId && /^\d{1,12}$/.test(String(hit.moviedb_id || ''))) out.tmdbId=String(hit.moviedb_id);
    }
    if (!out.tmdbId && /^tt\d{1,12}$/.test(out.imdbId || '')) {
      try {
        // Catalog entries often omit moviedb_id; Cinemeta's detail endpoint
        // includes it. Use its canonical host because provider requests reject redirects.
        const type = out.type === 'series' ? 'series' : 'movie';
        const result = await request(`https://cinemeta-live.strem.io/meta/${type}/${out.imdbId}.json`);
        const meta = result.json?.meta;
        if (meta?.id === out.imdbId && /^\d{1,12}$/.test(String(meta.moviedb_id || ''))) out.tmdbId=String(meta.moviedb_id);
      } catch { /* ID enrichment is optional */ }
    }
    return out;
  };
};
