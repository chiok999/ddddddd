'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');

// A private loopback relay rewrites all playlist references into unguessable
// handles. The caller performs HTTPS validation and DNS pinning for every hop.
async function createHlsInput({source,first,fetchResource,openRoot,signal,safeUrl}){
 const token=crypto.randomBytes(24).toString('base64url'),items=new Map(),ids=new Map();let port,initial=first,duration=null,lastError=null;
 const add=(url,kind)=>{const safe=safeUrl(url).href;const k=kind+' '+safe;if(ids.has(k))return ids.get(k);const id=crypto.randomBytes(18).toString('base64url');ids.set(k,id);items.set(id,{url:safe,kind});return id;};
 const root=add(first.url || source.url,'playlist');
 function ref(raw,base,kind){if(!raw || /[\r\n{}]/.test(raw))throw Error('Unsupported HLS reference');const id=add(new URL(raw,base),kind);return `http://127.0.0.1:${port}/${token}/${id}/${kind==='playlist'?'index.m3u8':kind==='key'?'key.bin':'media.bin'}`;}
 function rewrite(text,base){
  text=text.replace(/^\uFEFF/,'');if(!/^#EXTM3U(?:\r?\n|$)/.test(text))throw Error('Invalid HLS playlist');
  let variant=false,total=0,vod=false;
  const output=text.split(/\r?\n/).map(line=>{
   if(!line || !line.startsWith('#')){if(!line)return line;const out=ref(line.trim(),base,variant?'playlist':'media');variant=false;return out;}
   if(line.startsWith('#EXTINF:')){const n=Number(line.slice(8).split(',')[0]);if(Number.isFinite(n) && n>0)total+=n;}
   if(line==='#EXT-X-ENDLIST')vod=true;
   if(line.startsWith('#EXT-X-STREAM-INF:')){if(/URI\s*=/i.test(line))throw Error('Invalid HLS stream reference');variant=true;return line;}
   const match=/^#(EXT-X-(?:KEY|SESSION-KEY|MAP|MEDIA|I-FRAME-STREAM-INF)):(.*)$/.exec(line);
   if(match){const kind=match[1]==='EXT-X-KEY'||match[1]==='EXT-X-SESSION-KEY'?'key':match[1]==='EXT-X-MAP'?'media':'playlist';let n=0;
    const attrs=(match[2].match(/(?:^|,)\s*URI\s*=/gi)||[]).length;
    const replaced=match[2].replace(/(?:^|,)\s*URI\s*=\s*"([^"\r\n]*)"/gi,(whole,url)=>{n++;return (whole.startsWith(',')?',':'')+'URI="'+ref(url,base,kind)+'"';});
    if(attrs!==n || n>1 || (['EXT-X-MAP','EXT-X-I-FRAME-STREAM-INF'].includes(match[1]) && n!==1))throw Error('Invalid HLS URI');
    if(/\{\$/.test(replaced))throw Error('HLS variables are unsupported');return `#${match[1]}:${replaced}`;
   }
   // Reject unhandled URI-bearing extensions and variable substitution, rather
   // than letting FFmpeg resolve an unvalidated remote address itself.
   if(/URI\s*=|\{\$|^#EXT-X-(?:DEFINE|PART|PRELOAD-HINT|RENDITION-REPORT)/i.test(line))throw Error('Unsupported HLS playlist feature');
   return line;
  }).join('\n');
  if(vod && total>0)duration=total;return output;
 }
 async function boundedText(body){const chunks=[];let size=0;for await(const chunk of Readable.fromWeb(body)){size+=chunk.length;if(size>4*1024*1024)throw Error('HLS playlist is too large');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}
 const server=http.createServer(async(req,res)=>{
  let upstream;try{
   const match=new RegExp(`^/${token}/([A-Za-z0-9_-]+)/[^/?]+$`).exec(req.url||'');const item=match&&items.get(match[1]);
   if(req.method!=='GET'||!item)return res.writeHead(404).end();
   const range=req.headers.range;if(range && !/^bytes=\d+-\d*$/.test(range))return res.writeHead(400).end();
   if(match[1]===root && initial && (!range || range==='bytes=0-')){upstream=initial;initial=null;}
   else if(match[1]===root && openRoot && (!range || range==='bytes=0-'))upstream=await openRoot(source,signal);
   else upstream=await fetchResource({...source,url:item.url,refresh:null,refreshAt:null},signal,range);
   if(!upstream.body || (upstream.status!==200 && upstream.status!==206)){lastError=`HLS source returned HTTP ${upstream.status}`;await upstream.body?.cancel().catch(()=>{});return res.writeHead(502).end();}
   if((upstream.headers.get('content-encoding')||'identity').toLowerCase()!=='identity')throw Error('Compressed HLS input is unsupported');
   if(item.kind==='playlist'){
    const base=upstream.url || item.url;const data=rewrite(await boundedText(upstream.body),base);
    res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl','cache-control':'no-store'});return res.end(data);
   }
   const headers={'content-type':'application/octet-stream'};for(const name of ['content-length','content-range','accept-ranges']){const value=upstream.headers.get(name);if(value)headers[name]=value;}
   res.writeHead(upstream.status,headers);const stream=Readable.fromWeb(upstream.body);res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
  }catch(e){lastError=e.message || 'HLS source failed';await upstream?.body?.cancel().catch(()=>{});if(!res.headersSent)res.writeHead(502).end();else res.destroy();}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});port=server.address().port;
 const close=()=>{server.closeAllConnections?.();server.close();if(initial){void initial.body?.cancel().catch(()=>{});initial=null;}};
 if(signal.aborted)close();else signal.addEventListener('abort',close,{once:true});
 return {url:`http://127.0.0.1:${port}/${token}/${root}/index.m3u8`,close,get duration(){return duration;},get error(){return lastError;}};
}
module.exports={createHlsInput};
