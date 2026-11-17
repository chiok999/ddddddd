'use strict';
// Bounded, session-aware handle cache. Evicting a handle doesn't stop an
// already-started conversion, which retains its source entry independently.
function createSourceStore({perSession=2000,maxEntries=12000,now=Date.now}={}){
 const entries=new Map();
 return {
  get(id){const entry=entries.get(id);if(!entry)return null;if(entry.expires<now()){entries.delete(id);return null;}entries.delete(id);entries.set(id,entry);return entry;},
  set(id,entry){
   for(const [key,value] of entries)if(value.expires<now())entries.delete(key);
   let count=0,oldest=null;for(const [key,value] of entries)if(value.sid===entry.sid){count++;if(oldest===null)oldest=key;}
   if(count>=perSession && oldest!==null)entries.delete(oldest);
   while(entries.size>=maxEntries)entries.delete(entries.keys().next().value);
   entries.set(id,entry);
  },
  get size(){return entries.size;},
 };
}
module.exports={createSourceStore};
