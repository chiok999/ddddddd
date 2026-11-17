'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {createPlaylistRewriter}=require('./playlist-rewrite');

// A private loopback relay rewrites all playlist references into unguessable
// handles. The caller performs HTTPS validation and DNS pinning for every hop.
async function createHlsInput({source,first,fetchResource,openRoot,signal,safeUrl}){
 const token=crypto.randomBytes(24).toString('base64url'),items=new Map(),ids=new Map();let port,initial=first,duration=null,lastError=null;
 // Scope is part of the handle: two masters can import different values for
 // the same child URL. Secrets stay server-side and never enter the relay URL.
 const add=(url,kind,parentVars={},extra={})=>{const safe=safeUrl(url).href;const scope=kind==='playlist'?parentVars:{};const k=JSON.stringify([kind,safe,Object.entries(scope).sort(([a],[b])=>a.localeCompare(b))]);if(ids.has(k))return ids.get(k);const id=crypto.randomBytes(18).toString('base64url');ids.set(k,id);items.set(id,{url:safe,kind,parentVars:{...scope},...extra});return id;};
 const root=add(first.url || source.url,'playlist');
 const rewriter=createPlaylistRewriter({safeUrl,toUrl:(absolute,kind,scope)=>`http://127.0.0.1:${port}/${token}/${add(absolute.href,kind,scope,{referer:source.referer,origin:source.origin,userAgent:source.userAgent})}/${kind==='playlist'?'index.m3u8':kind==='key'?'key.bin':'media.bin'}`});
 function rewrite(text,base,parentVars){
  const result=rewriter.rewrite(text,base,parentVars);
  if(result.duration)duration=result.duration;
  return result.text;
 }
 async function boundedText(body){const chunks=[];let size=0;for await(const chunk of Readable.fromWeb(body)){size+=chunk.length;if(size>4*1024*1024)throw Error('HLS playlist is too large');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}
 const server=http.createServer(async(req,res)=>{
  let upstream;try{
   const match=new RegExp(`^/${token}/([A-Za-z0-9_-]+)/[^/?]+$`).exec(req.url||'');const item=match&&items.get(match[1]);
   if(req.method!=='GET'||!item)return res.writeHead(404).end();
   const range=req.headers.range;if(range && !/^bytes=\d+-\d*$/.test(range))return res.writeHead(400).end();
   if(match[1]===root && initial && (!range || range==='bytes=0-')){upstream=initial;initial=null;}
   else if(match[1]===root && openRoot && (!range || range==='bytes=0-'))upstream=await openRoot(source,signal);
   else upstream=await fetchResource({...source,url:item.url,userAgent:item.userAgent||source.userAgent,referer:item.referer||source.referer,origin:item.origin||source.origin,refresh:null,refreshAt:null},signal,range);
   if(!upstream.body || (upstream.status!==200 && upstream.status!==206)){lastError=`HLS source returned HTTP ${upstream.status}`;await upstream.body?.cancel().catch(()=>{});return res.writeHead(502).end();}
   if((upstream.headers.get('content-encoding')||'identity').toLowerCase()!=='identity')throw Error('Compressed HLS input is unsupported');
   if(item.kind==='playlist'){
    const base=upstream.url || item.url;const data=rewrite(await boundedText(upstream.body),base,item.parentVars);
    res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl','cache-control':'no-store'});return res.end(data);
   }
   const headers={'content-type':'application/octet-stream'};for(const name of ['content-length','content-range','accept-ranges']){const value=upstream.headers.get(name);if(value)headers[name]=value;}
   res.writeHead(upstream.status,headers);const stream=Readable.fromWeb(upstream.body);res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
  }catch(e){const safeErrors=['Unsupported HLS reference','Invalid HLS variable or reference','Undefined HLS variable','Undefined imported HLS variable','Invalid HLS variable definition','Missing or ambiguous HLS query variable','Invalid or duplicate HLS variable','Invalid HLS playlist','Invalid HLS stream reference','Invalid HLS URI','Unsupported HLS variable in attribute','Unsupported HLS playlist feature','HLS playlist is too large','Compressed HLS input is unsupported','Only public HTTPS URLs are allowed','Invalid URL'];lastError=safeErrors.includes(e.message)?e.message:'HLS relay request failed';await upstream?.body?.cancel().catch(()=>{});if(!res.headersSent)res.writeHead(502).end();else res.destroy();}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});port=server.address().port;
 const close=()=>{server.closeAllConnections?.();server.close();if(initial){void initial.body?.cancel().catch(()=>{});initial=null;}};
 if(signal.aborted)close();else signal.addEventListener('abort',close,{once:true});
 return {url:`http://127.0.0.1:${port}/${token}/${root}/index.m3u8`,close,get duration(){return duration;},get error(){return lastError;}};
}
module.exports={createHlsInput};
