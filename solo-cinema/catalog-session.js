'use strict';
const crypto=require('node:crypto');
// Bind cached discovery metadata to the current session without mutating the shared cache.
function bindDiscovery(sections,catalog,sid,now=Date.now()) {
  for(const [id,entry] of catalog) if(entry.expires<now) catalog.delete(id);
  const total=sections.reduce((n,section)=>n+section.items.length,0);
  if(catalog.size+total>3000) throw Error('Too many catalog entries; restart the server');
  return sections.map(section=>({...section,items:section.items.map(item=>{
    const id=crypto.randomBytes(20).toString('base64url');
    const source=item.source==='moviebox'?'moviebox':'cinemeta';
    catalog.set(id,{item:{...item,source},sid,expires:now+24*3600000});
    return {id,title:item.title,type:item.type,year:item.year,overview:item.overview,poster:item.poster,source,anime:!!item.anime,imdbId:/^tt\d{1,12}$/.test(String(item.imdbId||''))?item.imdbId:null};
  })}));
}
module.exports={bindDiscovery};
