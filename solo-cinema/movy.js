'use strict';
// User-supplied Movy protocol. Server names are upstream labels, not proof of location.
const SERVERS = ['miami','boise','nashville','chicago','vegas','reno','oakland','seattle','phoenix','atlanta','portland','austin','dallas'];
const SITE='https://www.movy.sx', API='https://api.wecollege.net';
const headers={ 'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', origin:SITE, referer:SITE+'/' };
const mix = v => { v>>>=0; v^=v>>>16; v=Math.imul(v,0x85ebca6b); v^=v>>>13; v=Math.imul(v,0xc2b2ae35); return (v^(v>>>16))>>>0; };
const rotl=(v,n)=>{n&=31;return ((v<<n)|(v>>>(32-n)))>>>0};
function decrypt(text,seed,id){
  const data=Buffer.from(String(text).trim().replace(/^"|"$/g,''),'base64url');
  let fnv=0x811c9dc5; for(const c of seed) fnv=Math.imul(fnv^c.codePointAt(0),0x1000193)>>>0;
  let n=mix(mix(fnv)^mix((Number(id)>>>0)^0x9e3779b9)); const S=new Uint32Array(61),used=new Uint8Array(61);
  for(let e=0;e<8;e++){const a=n%61;n=rotl((n+0x9e3779b9)>>>0,7+(7&e));S[a]=(n^mix(n))>>>0;used[a]=1;n=mix((n+a)>>>0)}
  let acc=mix(0xa5a5a5a5^n);
  for(let i=0;i<data.length;i+=4){const dd=acc%61,neg=used[dd]?0xffffffff:0,nn=(S[dd]^Math.imul(0x9e3779b9,i/4+1))>>>0;let b=((acc^nn)|(acc&nn&neg))>>>0;b=(rotl((b+acc)>>>0,dd&31)^rotl(acc,(dd*7)&31))>>>0;acc=mix((b+0x9e3779b9)>>>0);S[dd]=acc;used[dd]=1;for(let j=0;j<4&&i+j<data.length;j++)data[i+j]^=(acc>>>(8*j))&255;}
  if(data.subarray(0,4).toString()!=='mvm1') throw Error('Movy seed mismatch');
  return JSON.parse(data.subarray(4).toString('utf8'));
}
function createMovy({request,safeUrl,now=Date.now}){
  let queue=Promise.resolve(), cooldown=0, pending=0; const cache=new Map();
  async function run(item,season,episode){
    const id=String(item.tmdbId||''); if(!/^\d{1,10}$/.test(id)) throw Error('TMDB ID unavailable');
    if(now()<cooldown) throw Error('Movy rate limited; wait before retrying');
    const type=item.type==='series'?'tv':'movie', key=`${type}:${id}:${season}:${episode}`, cached=cache.get(key);
    if(cached && cached.expires>now()) return cached.result;
    const html=(await request(`${SITE}/${type}/${id}`,{headers})).text;
    const match=/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if(!match) throw Error('Movy detail data unavailable');
    const det=JSON.parse(match[1])?.props?.pageProps?.details;
    if(!det || typeof det.title!=='string' || !det.title || !det.year || (type==='tv' && !Array.isArray(det.seasons))) throw Error('Movy detail metadata incomplete');
    const q=new URLSearchParams({title:encodeURIComponent(det.title),mediaType:type,year:String(det.year),totalSeasons:String(type==='tv'?det.seasons.length:0),episodeId:String(type==='tv'?episode:1),seasonId:String(type==='tv'?season:1),tmdbId:id,imdbId:String(det.imdbId||''),enc:'2'});
    let seed,seedTime=0;
    async function getSeed(force=false){ if(!force && seed && now()-seedTime<25000) return seed; const r=await request(`${API}/seed?mediaId=${id}`,{headers}); if(typeof r.json?.seed!=='string'||!r.json.seed||r.json.seed.length>512) throw Error('Invalid Movy seed');seed=r.json.seed;seedTime=now();return seed; }
    let lastError=null, consecutiveErrors=0;
    for(const server of SERVERS){
      try{
        let data;
        for(let attempt=0;attempt<2;attempt++){
          const s=await getSeed(attempt===1); const params=new URLSearchParams(q);params.set('seed',s);
          try{const r=await request(`${API}/${server}/sources?${params}`,{headers}); data=decrypt(r.text,s,id);break;}
          catch(err){if(attempt===0 && (err.status===401 || err.message==='Movy seed mismatch')) continue;throw err;}
        }
        const rows=Array.isArray(data?.sources)?data.sources.slice(0,30):[];if(typeof data?.playlist==='string') rows.unshift({url:data.playlist,quality:'Auto'});
        const streams=[]; for(const row of rows){if(server==='austin' && row.quality!=='English' && row.quality!=='Auto')continue; if(typeof row?.url!=='string')continue; try{const url=safeUrl(row.url).href;const quality=/\b(\d{3,4})p\b/i.exec(String(row.quality||'')); streams.push({url,format:/\.m3u8(?:$|\?)/i.test(url)||row.quality==='Auto'?'hls':'file',quality:quality?Number(quality[1]):0,provider:`movy:${server}`});}catch{}}
        consecutiveErrors=0; if(streams.length){const result={streams,referer:SITE+'/',origin:SITE,userAgent:'okhttp/4.12.0'}; if(cache.size>=100)cache.delete(cache.keys().next().value);cache.set(key,{result,expires:now()+600000});return result;}
      }catch(err){if(err.status===429){cooldown=now()+60000;throw Error('Movy rate limited; wait before retrying');}lastError=err; if(++consecutiveErrors>=2) break;}
    }
    if(lastError) throw Error(`Movy unavailable: ${String(lastError.message).slice(0,100)}`);
    return {streams:[]};
  }
  return function resolve(item,season,episode){if(pending>=8) return Promise.reject(Error('Movy queue full')); pending++; const job=queue.then(()=>run(item,season,episode));queue=job.catch(()=>{});return job.finally(()=>pending--);};
}
module.exports={createMovy,decrypt,SERVERS};
