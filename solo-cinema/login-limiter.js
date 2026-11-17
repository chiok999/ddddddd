'use strict';
// The immediate peer is used by default; untrusted forwarded headers cannot
// reset the counter. Multiple clients behind one proxy share its bucket.
function createLoginLimiter({windowMs=60000,perPeer=8,global=120,now=Date.now}={}){
 let all=[];const peers=new Map();
 function clean(){const cutoff=now()-windowMs;all=all.filter(t=>t>cutoff);for(const [ip,times] of peers){const live=times.filter(t=>t>cutoff);if(live.length)peers.set(ip,live);else peers.delete(ip);}}
 return {
  blocked(peer){clean();return all.length>=global || (peers.get(peer)?.length||0)>=perPeer;},
  failure(peer){clean();const t=now();all.push(t);const times=peers.get(peer)||[];times.push(t);peers.set(peer,times);},
  success(peer){peers.delete(peer);},
 };
}
module.exports={createLoginLimiter};
