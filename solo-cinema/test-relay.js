'use strict';
// Real HTTP end-to-end coverage for the same-origin media relay. The upstream
// fixture behaves like a provider CDN that refuses requests lacking its Referer
// (the exact failure this relay was added to fix), and one that answers 426.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {createMediaProxy}=require('./media-proxy');

const BYTES=Buffer.from('ABCDEFGHIJ');
function listen(handler){return new Promise(resolve=>{const s=http.createServer(handler);s.listen(0,'127.0.0.1',()=>resolve(s));});}
function close(s){s.closeAllConnections?.();return new Promise(r=>s.close(r));}

// A relay host that exposes the proxy over real HTTP, like server.js does.
async function relayHost(openMedia,options={}){
 const handles=new Map();
 const register=entry=>{const u=`/media/${Buffer.from(entry.url).toString('base64url')}`;handles.set(u,entry);return u;};
 const proxy=createMediaProxy({safeUrl:u=>new URL(u),openMedia,createHandle:register,...options});
 const server=await listen(async(req,res)=>{
  const entry=handles.get(req.url);
  if(!entry){res.writeHead(404);return res.end();}
  const result=await proxy.relay(req,res,entry,'session');
  if(!res.headersSent){res.writeHead(result.status||502,{'content-type':'application/json'});res.end(JSON.stringify({error:result.error}));}
 });
 return {proxy,server,base:`http://127.0.0.1:${server.address().port}`,add:register};
}
const passthrough=async(entry,headers)=>({response:await fetch(entry.url,{headers}),url:entry.url});

test('relay adds provider headers a browser cannot send, then rewrites the playlist',async()=>{
 const seen=[];
 const cdn=await listen((req,res)=>{
  seen.push({referer:req.headers.referer,origin:req.headers.origin,ua:req.headers['user-agent']});
  if(req.headers.referer!=='https://moviebox.ph/'){res.writeHead(426);return res.end();}
  if(req.url==='/master.m3u8'){res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'});return res.end('#EXTM3U\n#EXTINF:4,\nseg1.ts\n#EXT-X-ENDLIST\n');}
  if(req.url==='/seg1.ts'){res.writeHead(200,{'content-type':'video/mp2t'});return res.end('SEGMENT');}
  res.writeHead(404).end();
 });
 const host=await relayHost(passthrough);
 try{
  const handle=host.add({url:`http://127.0.0.1:${cdn.address().port}/master.m3u8`,referer:'https://moviebox.ph/',origin:'https://moviebox.ph',userAgent:'okhttp/4.12.0',format:'hls'});
  const playlist=await fetch(host.base+handle);
  assert.equal(playlist.status,200);
  assert.match(playlist.headers.get('content-type'),/mpegurl/);
  const text=await playlist.text();
  assert.match(text,/#EXTM3U/);
  const child=text.match(/^\/media\/[A-Za-z0-9_-]+$/m)?.[0];
  assert.ok(child,'references come back through the relay');
  const segment=await fetch(host.base+child);
  assert.equal(segment.status,200);
  assert.equal(await segment.text(),'SEGMENT');
  assert.equal(seen[0].referer,'https://moviebox.ph/');
  assert.equal(seen[0].origin,'https://moviebox.ph');
  assert.equal(seen[0].ua,'okhttp/4.12.0');
  assert.ok(seen.length>=2,'segment request also carried the headers');
 }finally{await close(cdn);await close(host.server);}
});

test('a 426 from the CDN becomes an explicit diagnosis instead of a bare status',async()=>{
 const cdn=await listen((req,res)=>{res.writeHead(426);res.end();});
 const host=await relayHost(passthrough);
 try{
  const handle=host.add({url:`http://127.0.0.1:${cdn.address().port}/v.mp4`,format:'file'});
  const response=await fetch(host.base+handle);
  assert.equal(response.status,502);
  const body=await response.json();
  assert.match(body.error,/HTTP 426/);
  assert.match(body.error,/blocks non-browser clients/);
  assert.doesNotMatch(body.error,/127\.0\.0\.1/,'no upstream URL is echoed to the client');
 }finally{await close(cdn);await close(host.server);}
});

test('relay streams ranges through so the browser can seek natively',async()=>{
 const cdn=await listen((req,res)=>{
  const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
  if(!match){res.writeHead(200,{'content-type':'video/mp4','content-length':String(BYTES.length),'accept-ranges':'bytes'});return res.end(BYTES);}
  const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),BYTES.length-1):BYTES.length-1;
  res.writeHead(206,{'content-type':'video/mp4','content-range':`bytes ${start}-${end}/${BYTES.length}`,'content-length':String(end-start+1),'accept-ranges':'bytes'});
  res.end(BYTES.subarray(start,end+1));
 });
 const host=await relayHost(passthrough);
 try{
  const handle=host.add({url:`http://127.0.0.1:${cdn.address().port}/v.mp4`,format:'file'});
  const full=await fetch(host.base+handle);
  assert.equal(full.status,200);
  assert.equal(await full.text(),'ABCDEFGHIJ');
  const ranged=await fetch(host.base+handle,{headers:{range:'bytes=4-6'}});
  assert.equal(ranged.status,206);
  assert.equal(ranged.headers.get('content-range'),'bytes 4-6/10');
  assert.equal(await ranged.text(),'EFG');
 }finally{await close(cdn);await close(host.server);}
});

test('relay refuses HTML masquerading as video and releases its slot',async()=>{
 const cdn=await listen((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<html>nope</html>');});
 const host=await relayHost(passthrough);
 try{
  const handle=host.add({url:`http://127.0.0.1:${cdn.address().port}/v.mp4`,format:'file'});
  const response=await fetch(host.base+handle);
  assert.equal(response.status,502);
  assert.match((await response.json()).error,/web page/);
  assert.equal(host.proxy.active,0,'a failed relay must not leak a concurrency slot');
 }finally{await close(cdn);await close(host.server);}
});

test('relay caps simultaneous streams per session without leaking slots',async()=>{
 let release;
 const gate=new Promise(r=>{release=r;});
 const cdn=await listen(async(req,res)=>{await gate;res.writeHead(200,{'content-type':'video/mp4'});res.end('x');});
 const host=await relayHost(passthrough,{perSession:1,global:4});
 try{
  const handle=host.add({url:`http://127.0.0.1:${cdn.address().port}/v.mp4`,format:'file'});
  const first=fetch(host.base+handle);
  await new Promise(r=>setTimeout(r,60));
  const second=await fetch(host.base+handle);
  assert.equal(second.status,429);
  assert.match((await second.json()).error,/Too many simultaneous/);
  release();
  assert.equal((await first).status,200);
  await new Promise(r=>setTimeout(r,60));
  assert.equal(host.proxy.active,0);
 }finally{await close(cdn);await close(host.server);}
});
