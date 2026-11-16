'use strict';
// Construct only documented provider URLs from validated IDs; no caller-supplied host.
function embedUrl(item, season, episode, provider='vidrift') {
  const configs={vidrift:['https://embed.vidrift.net','/embed'],vixsrc:['https://vixsrc.to',''],vidlink:['https://vidlink.pro',''],vidfast:['https://vidfast.vc','']};
  if(!Object.hasOwn(configs,provider)) throw Error('Unknown embed provider');
  const tmdb=String(item.tmdbId||''), imdb=String(item.imdbId||'');
  const id=/^[1-9]\d{0,11}$/.test(tmdb) ? tmdb : (['vixsrc','vidfast'].includes(provider) && /^tt\d{1,12}$/.test(imdb)?imdb:'');
  if(!id) throw Error(`TMDB or compatible IMDb ID unavailable for ${provider}`);
  if(!['movie','series'].includes(item.type)) throw Error('Invalid title type');
  let route=`movie/${id}`;
  if(item.type==='series') {
    if(!Number.isInteger(season)||season<1||season>999||!Number.isInteger(episode)||episode<1||episode>9999) throw Error('Choose a valid season and episode');
    route=`tv/${id}/${season}/${episode}`;
  }
  const [origin,prefix]=configs[provider];const url=new URL(`${origin}${prefix}/${route}`);
  if(provider==='vidrift'){url.searchParams.set('title',String(item.title||'').slice(0,150));url.searchParams.set('brand','Troy');url.searchParams.set('brandColor','ed4459');}
  return url.href;
}
module.exports={embedUrl};
