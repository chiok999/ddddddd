'use strict';
// 7Movies' VidLink upstream; encryptor is an independent third-party API.
module.exports = function createVidlink({request,safeUrl}) {
  const apiHeaders={'user-agent':'Mozilla/5.0',referer:'https://vidlink.pro/',origin:'https://vidlink.pro'};
  function remoteHeaders(data){
    const result={userAgent:'okhttp/4.12.0'};
    for(const [key,value] of Object.entries(data||{})){
      if(!['referer','origin'].includes(key.toLowerCase()) || typeof value!=='string') continue;
      try {const u=safeUrl(value); result[key.toLowerCase()]=key.toLowerCase()==='origin'?u.origin:u.href;} catch {}
    }
    return result;
  }
  return async function resolve(item,season,episode){
    const id=String(item.tmdbId||''); if(!/^\d{1,12}$/.test(id)) throw Error('TMDB ID unavailable');
    const enc=await request(`https://enc-dec.app/api/enc-vidlink?text=${id}`,{timeoutMs:4000,headers:{'user-agent':'Mozilla/5.0'}});
    const hash=enc.json?.result;
    if(typeof hash!=='string'||hash.length<1||hash.length>1024||!/^[a-zA-Z0-9_=-]+$/.test(hash)) throw Error('VidLink encryptor unavailable');
    const path=item.type==='series'?`tv/${encodeURIComponent(hash)}/${season}/${episode}`:`movie/${encodeURIComponent(hash)}`;
    const response=await request(`https://vidlink.pro/api/b/${path}`,{timeoutMs:5000,headers:apiHeaders});const data=response.json?.stream;
    if(!data || typeof data!=='object') return {streams:[]};
    const captions=Array.isArray(data.captions)?data.captions:Array.isArray(response.json?.captions)?response.json.captions:[];
    const sub=captions.find(c=>/^(?:en|eng|english)(?:$|[-_\s])/i.test(String(c?.language||c?.label||c?.name||''))); let captionInfo=null;
    if(sub) try { captionInfo={url:safeUrl(sub.url).href}; } catch {}
    const ttl=Number(data.TTL);const refreshAfterMs=Number.isFinite(ttl) && ttl>0 && ttl<=604800?Math.min(2700000,Math.floor(ttl*750)):null;
    const streams=[], seen=new Set();
    function add(raw,format,quality,headers){try{const url=safeUrl(raw).href;if(seen.has(url))return;seen.add(url); streams.push({url,format,quality,refreshAfterMs,...remoteHeaders(headers)});}catch{}}
    if(data.qualities && typeof data.qualities==='object') for(const [key,row] of Object.entries(data.qualities).slice(0,30)){
      if(!row || typeof row.url!=='string')continue;const q=/(\d{3,4})/.exec(key);const format=/hls|m3u8/i.test(String(row.type||''))||/\.m3u8(?:$|\?)/i.test(row.url)?'hls':'file';
      add(row.url,format,q?Number(q[1]):/4k/i.test(key)?2160:0,{...data.headers,...row.headers});
    }
    if(typeof data.playlist==='string') add(data.playlist,'hls',0,data.headers);
    return {streams,captionInfo};
  };
};
