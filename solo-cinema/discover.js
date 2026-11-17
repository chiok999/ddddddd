'use strict';
// Cinemeta's documented catalogs supply metadata, not guaranteed playable streams.
module.exports = function createDiscover({request, moviebox, now = () => new Date()}) {
  let cached=null, pending=null;
  async function load() {
    if(cached && cached.expires>Date.now()) return cached.sections;
    if(pending) return pending;
    pending=(async()=>{
      let home=null; try { if(moviebox) home=await moviebox.home(); } catch { /* independently use Cinemeta */ }
      const year=now().getUTCFullYear();
      const paths=[['popular-movies','movie','top',''],['popular-series','series','top',''],['new-movies','movie','year',`genre=${year}`],['new-series','series','year',`genre=${year}`],['animation','series','top','genre=Animation'],['anime','series','top','genre=Anime'],['top-rated','movie','imdbRating','']];
      const wanted=home?.length ? paths.filter(([id])=>(id==='anime' && !home.some(row=>row.groups.includes('anime'))) || (id==='popular-movies' && !home.some(row=>row.groups.includes('movies'))) || (id==='popular-series' && !home.some(row=>row.groups.includes('shows')))) : paths;
      const results=await Promise.allSettled(wanted.map(async ([id,type,catalog,extra])=>{
        const url=`https://cinemeta-catalogs.strem.io/${catalog}/catalog/${type}/${catalog}${extra ? '/'+extra : ''}.json`;
        const response=await request(url); const metas=response.json?.metas;
        if(!Array.isArray(metas)) throw Error('Invalid catalog response');
        const items=metas.slice(0,20).flatMap(m=>{
          if(!/^tt\d{1,12}$/.test(m.id || '') || typeof m.name!=='string' || !m.name.trim()) return [];
          const releaseYear=(String(m.releaseInfo || m.year || '').match(/\d{4}/)||[])[0] || '';
          if(catalog==='year' && releaseYear!==String(year)) return [];
          let poster=null;
          try { const u=new URL(m.poster); if(u.protocol==='https:' && ['images.metahub.space','live.metahub.space'].includes(u.hostname) && !u.username && !u.password && !u.port && u.href.length<2048) poster=u.href; } catch {}
          return [{title:m.name.slice(0,150),type,year:releaseYear,poster,imdbId:m.id,tmdbId:/^[1-9]\d{0,11}$/.test(String(m.moviedb_id||''))?String(m.moviedb_id):null,overview:typeof m.description==='string'?m.description.slice(0,1000):''}];
        });
        const labels={'popular-movies':'Popular movies','popular-series':'Popular series','new-movies':'New movies','new-series':'New series','animation':'Cartoons & animation','anime':'Anime','top-rated':'Featured movies'};
        const groups=id==='anime'?['anime']:id==='animation'?['shows']:type==='movie'?['movies']:['shows'];
        return {id,title:labels[id],source:'Cinemeta',groups,items,error:null};
      }));
      const fallback=results.map((r,i)=>r.status==='fulfilled'?r.value:{id:wanted[i][0],title:wanted[i][0]==='anime'?'Anime':'Catalog',source:'Cinemeta',groups:wanted[i][0]==='anime'?['anime']:wanted[i][1]==='movie'?['movies']:['shows'],items:[],error:'Catalog unavailable'});
      const sections=home?.length?[...home,...fallback]:fallback;
      if((!moviebox || home?.length) && sections.every(s=>!s.error)) cached={sections,expires:Date.now()+30*60000};
      return sections;
    })().finally(()=>{pending=null});
    return pending;
  }
  return load;
};
