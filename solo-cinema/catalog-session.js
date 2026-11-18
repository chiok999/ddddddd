'use strict';
const crypto=require('node:crypto');
// Bind cached discovery metadata to the current session without mutating the shared cache.
function bindItem(catalog,item,sid,now){
  const id=crypto.randomBytes(20).toString('base64url');
  const source=item.source==='moviebox'?'moviebox':'cinemeta';
  catalog.set(id,{item:{...item,source},sid,expires:now+24*3600000});
  return {id,title:item.title,type:item.type,year:item.year,overview:item.overview,poster:item.poster,source,anime:!!item.anime,imdbId:/^tt\d{1,12}$/.test(String(item.imdbId||''))?item.imdbId:null};
}
function bindDiscovery(sections,catalog,sid,now=Date.now()) {
  for(const [id,entry] of catalog) if(entry.expires<now) catalog.delete(id);
  const total=sections.reduce((n,section)=>n+section.items.length,0);
  if(catalog.size+total>3000) throw Error('Too many catalog entries; restart the server');
  return sections.map(section=>({...section,items:section.items.map(item=>bindItem(catalog,item,sid,now))}));
}
// A paged category reuses the same binding, so a title opened from "see more"
// is indistinguishable from the same title opened from the home row.
function bindItems(items,catalog,sid,now=Date.now()) {
  if(!Array.isArray(items)) throw Error('Invalid catalog page');
  if(catalog.size+items.length>3000) throw Error('Too many catalog entries; restart the server');
  return items.map(item=>bindItem(catalog,item,sid,now));
}
module.exports={bindDiscovery,bindItems};
