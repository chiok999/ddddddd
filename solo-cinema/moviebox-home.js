'use strict';
// Normalize MovieBox's home operatingList; only data from its fixed API is used.
function normalizeHome(json) {
  const rows=json?.data?.operatingList;
  if(!Array.isArray(rows)) throw Error('Invalid MovieBox home response');
  const result=[];
  for(const row of rows.slice(0,60)) {
    if(!row || typeof row.title!=='string' || !Array.isArray(row.subjects) || !row.title.trim()) continue;
    const title=row.title.trim().slice(0,100); const seen=new Set();const items=[];
    for(const raw of row.subjects.slice(0,60)) {
      const s=raw?.subject||raw;const subjectId=String(s?.subjectId||''),detailPath=String(s?.detailPath||''),type=Number(s?.subjectType);
      if(!subjectId || subjectId.length>128 || !detailPath || detailPath.length>512 || ![1,2].includes(type) || typeof s.title!=='string' || !s.title.trim() || s.isPornographic===true || seen.has(subjectId)) continue;
      seen.add(subjectId);let poster=null;
      try{const u=new URL(s.cover?.url);if(u.protocol==='https:' && ['pbcdn.aoneroom.com','pbcdnw.aoneroom.com'].includes(u.hostname) && !u.username && !u.password && !u.port && u.href.length<2048) poster=u.href;}catch{}
      const genre=String(s.genre||'');
      items.push({source:'moviebox',subjectId,detailPath,title:s.title.trim().slice(0,150),type:type===1?'movie':'series',year:(String(s.releaseDate||'').match(/^\d{4}/)||[])[0]||'',overview:String(s.description||'').slice(0,1000),imdbId:/^tt\d{1,12}$/.test(String(s.imdbId||''))?String(s.imdbId):null,tmdbId:/^[1-9]\d{0,11}$/.test(String(s.tmdbId||''))?String(s.tmdbId):null,poster,anime:/\banime\b/i.test(title+' '+genre)});
      if(items.length>=20) break;
    }
    if(!items.length) continue;
    const groups=[...new Set(items.map(i=>i.type==='movie'?'movies':'shows'))]; if(items.some(i=>i.anime)) groups.push('anime');
    result.push({id:`moviebox-${result.length}`,title,source:'MovieBox',groups,items,error:null});
    if(result.length>=18) break;
  }
  return result;
}
module.exports={normalizeHome};
