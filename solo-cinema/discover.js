'use strict';
// Cinemeta's documented catalogs supply metadata, not guaranteed playable streams.
module.exports = function createDiscover({request, now = () => new Date()}) {
  let cached=null, pending=null;
  async function load() {
    if(cached && cached.expires>Date.now()) return cached.sections;
    if(pending) return pending;
    pending=(async()=>{
      const year=now().getUTCFullYear();
      const paths=[['popular-movies','movie','top',''],['popular-series','series','top',''],['new-movies','movie','year',`genre=${year}`],['new-series','series','year',`genre=${year}`],['animation','series','top','genre=Animation'],['top-rated','movie','imdbRating','']];
      const results=await Promise.allSettled(paths.map(async ([id,type,catalog,extra])=>{
        const url=`https://cinemeta-catalogs.strem.io/${catalog}/catalog/${type}/${catalog}${extra ? '/'+extra : ''}.json`;
        const response=await request(url); const metas=response.json?.metas;
        if(!Array.isArray(metas)) throw Error('Invalid catalog response');
        const items=metas.slice(0,20).flatMap(m=>{
          if(!/^tt\d{1,12}$/.test(m.id || '') || typeof m.name!=='string' || !m.name.trim()) return [];
          const releaseYear=(String(m.releaseInfo || m.year || '').match(/\d{4}/)||[])[0] || '';
          if(catalog==='year' && releaseYear!==String(year)) return [];
          let poster=null;
          try { const u=new URL(m.poster); if(u.protocol==='https:' && ['images.metahub.space','live.metahub.space'].includes(u.hostname) && !u.username && !u.password && !u.port && u.href.length<2048) poster=u.href; } catch {}
          return [{title:m.name.slice(0,150),type,year:releaseYear,poster}];
        });
        return {id,items,error:null};
      }));
      const sections=results.map((r,i)=>r.status==='fulfilled'?r.value:{id:paths[i][0],items:[],error:'Catalog unavailable'});
      if(sections.every(s=>!s.error)) cached={sections,expires:Date.now()+30*60000};
      return sections;
    })().finally(()=>{pending=null});
    return pending;
  }
  return load;
};
