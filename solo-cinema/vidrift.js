'use strict';
// VidRift's documented embed routes; never accept a caller-supplied URL or host.
function embedUrl(item, season, episode) {
  const id=String(item.tmdbId || '');
  if (!/^[1-9]\d{0,11}$/.test(id)) throw Error('TMDB ID unavailable for VidRift');
  if (!['movie','series'].includes(item.type)) throw Error('Invalid title type');
  let route=`movie/${id}`;
  if (item.type==='series') {
    if(!Number.isInteger(season) || season<1 || season>999 || !Number.isInteger(episode) || episode<1 || episode>9999) throw Error('Choose a valid season and episode');
    route=`tv/${id}/${season}/${episode}`;
  }
  const url=new URL(`https://embed.vidrift.net/embed/${route}`);
  url.searchParams.set('title',String(item.title||'').slice(0,150));
  url.searchParams.set('brand','Troy');
  url.searchParams.set('brandColor','ed4459');
  return url.href;
}
module.exports={embedUrl};
