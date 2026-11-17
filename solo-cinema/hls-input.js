'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');

// A private loopback relay rewrites all playlist references into unguessable
// handles. The caller performs HTTPS validation and DNS pinning for every hop.
async function createHlsInput({source,first,fetchResource,openRoot,signal,safeUrl}){
 const token=crypto.randomBytes(24).toString('base64url'),items=new Map(),ids=new Map();let port,initial=first,duration=null,lastError=null;
 // Scope is part of the handle: two masters can import different values for
 // the same child URL. Secrets stay server-side and never enter the relay URL.
 const add=(url,kind,parentVars={})=>{const safe=safeUrl(url).href;const scope=kind==='playlist'?parentVars:{};const k=JSON.stringify([kind,safe,Object.entries(scope).sort(([a],[b])=>a.localeCompare(b))]);if(ids.has(k))return ids.get(k);const id=crypto.randomBytes(18).toString('base64url');ids.set(k,id);items.set(id,{url:safe,kind,parentVars:{...scope}});return id;};
 const root=add(first.url || source.url,'playlist');
 function expand(value,vars){
  const result=value.replace(/\{\$([A-Za-z0-9_-]+)\}/g,(_,name)=>{if(!Object.hasOwn(vars,name))throw Error('Undefined HLS variable');return vars[name];});
  if(/[\r\n"{}]/.test(result))throw Error('Invalid HLS variable or reference');return result;
 }
 function ref(raw,base,kind,vars){const expanded=expand(raw,vars);if(!expanded)throw Error('Unsupported HLS reference');const id=add(new URL(expanded,base),kind,vars);return `http://127.0.0.1:${port}/${token}/${id}/${kind==='playlist'?'index.m3u8':kind==='key'?'key.bin':'media.bin'}`;}
 function attributes(text){
  const out=Object.create(null);let pos=0;
  while(pos<text.length){const m=/^\s*([A-Z0-9-]+)\s*=\s*"([^"\r\n]*)"\s*(,|$)/.exec(text.slice(pos));if(!m||Object.hasOwn(out,m[1]))throw Error('Invalid HLS variable definition');out[m[1]]=m[2];pos+=m[0].length;if(m[3] && pos===text.length)throw Error('Invalid HLS variable definition');}
  return out;
 }
 function rewrite(text,base,parentVars){
  text=text.replace(/^\uFEFF/,'');if(!/^#EXTM3U(?:\r?\n|$)/.test(text))throw Error('Invalid HLS playlist');
  let variant=false,total=0,vod=false;const vars=Object.create(null);
  const output=text.split(/\r?\n/).map(line=>{
   if(line.startsWith('#EXT-X-DEFINE:')){
    const attrs=attributes(line.slice('#EXT-X-DEFINE:'.length)),keys=Object.keys(attrs);let name,value;
    if(keys.length===2 && Object.hasOwn(attrs,'NAME') && Object.hasOwn(attrs,'VALUE')){name=attrs.NAME;value=expand(attrs.VALUE,vars);}
    else if(keys.length===1 && Object.hasOwn(attrs,'IMPORT')){name=attrs.IMPORT;if(!Object.hasOwn(parentVars,name))throw Error('Undefined imported HLS variable');value=parentVars[name];}
    else if(keys.length===1 && Object.hasOwn(attrs,'QUERYPARAM')){name=attrs.QUERYPARAM;const query=new URL(base).search.slice(1).split('&').filter(Boolean).map(pair=>{const n=pair.indexOf('=');return [n<0?pair:pair.slice(0,n),n<0?'':pair.slice(n+1)];});const matches=query.filter(([key])=>{try{return decodeURIComponent(key.replace(/\+/g,' '))===name;}catch{return false;}});if(matches.length!==1)throw Error('Missing or ambiguous HLS query variable');value=expand(matches[0][1],vars);}
    else throw Error('Invalid HLS variable definition');
    if(!/^[A-Za-z0-9_-]+$/.test(name)||Object.hasOwn(vars,name))throw Error('Invalid or duplicate HLS variable');vars[name]=value;return '';
   }
   if(!line || !line.startsWith('#')){if(!line)return line;const out=ref(line.trim(),base,variant?'playlist':'media',vars);variant=false;return out;}
   if(line.startsWith('#EXTINF:')){const n=Number(line.slice(8).split(',')[0]);if(Number.isFinite(n) && n>0)total+=n;}
   if(line==='#EXT-X-ENDLIST')vod=true;
   if(line.startsWith('#EXT-X-STREAM-INF:')){if(/URI\s*=|\{\$/i.test(line))throw Error('Invalid HLS stream reference');variant=true;return line;}
   const match=/^#(EXT-X-(?:KEY|SESSION-KEY|MAP|MEDIA|I-FRAME-STREAM-INF|SESSION-DATA|PART|PRELOAD-HINT|RENDITION-REPORT)):(.*)$/.exec(line);
   if(match){const tag=match[1],kind=['EXT-X-KEY','EXT-X-SESSION-KEY'].includes(tag)?'key':['EXT-X-MEDIA','EXT-X-I-FRAME-STREAM-INF','EXT-X-RENDITION-REPORT'].includes(tag)?'playlist':'media';let n=0;
    const attrs=(match[2].match(/(?:^|,)\s*URI\s*=/gi)||[]).length;
    const replaced=match[2].replace(/(?:^|,)\s*URI\s*=\s*"([^"\r\n]*)"/gi,(whole,url)=>{n++;return (whole.startsWith(',')?',':'')+'URI="'+ref(url,base,kind,vars)+'"';});
    if(attrs!==n || n>1 || (['EXT-X-MAP','EXT-X-I-FRAME-STREAM-INF','EXT-X-PART','EXT-X-PRELOAD-HINT','EXT-X-RENDITION-REPORT'].includes(tag) && n!==1))throw Error('Invalid HLS URI');
    if(/\{\$/.test(replaced))throw Error('Unsupported HLS variable in attribute');return `#${tag}:${replaced}`;
   }
   // Unknown URI-bearing extensions and delta updates must not reach FFmpeg
   // directly. Reject rather than allowing it to fetch unvalidated URLs.
   if(/URI\s*=|\{\$|^#EXT-X-SKIP:/i.test(line))throw Error('Unsupported HLS playlist feature');
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
