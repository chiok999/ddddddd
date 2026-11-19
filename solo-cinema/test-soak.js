'use strict';
// Explicit opt-in: runs for five minutes and uses real FFmpeg, a local HTTP
// fixture, and a playlist reader. It is not a browser or a provider test.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs'),fsp=fs.promises,os=require('node:os'),path=require('node:path');
const {once}=require('node:events');
const {spawnSync}=require('node:child_process');
const {createTranscoder,bundledFfmpeg}=require('./transcode');
const {createSourceOpener}=require('./source-opener');
const bin=process.env.CINEMA_TEST_FFMPEG||bundledFfmpeg();
test('five-minute conversion soak tolerates a dropped socket', {skip:!bin,timeout:400000},async()=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'troy-soak-')),file=path.join(dir,'input.mp4');
 let server,transcode,timer;try{
  const made=spawnSync(bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=160x90:rate=1','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','1000','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart',file],{timeout:60000});assert.equal(made.status,0,String(made.stderr));
  const size=(await fsp.stat(file)).size;let first=true,refreshes=0,resumes=0,dropped=false;
  server=http.createServer((req,res)=>{
   if(req.url==='/old' && !first){res.writeHead(403);return res.end();}
   const range=/^bytes=(\d+)-$/.exec(req.headers.range||''),offset=range?Number(range[1]):0;
   const isFirst=first;
   if(isFirst){first=false;res.writeHead(200,{'content-type':'video/mp4','content-length':size,'etag':'"soak"'});}
   else{resumes++;res.writeHead(206,{'content-type':'video/mp4','content-length':size-offset,'content-range':`bytes ${offset}-${size-1}/${size}`,'etag':'"soak"'});}
   const input=fs.createReadStream(file,{start:offset,...(isFirst?{end:Math.floor(size/10)-1}:{})});res.on('close',()=>input.destroy());input.on('error',()=>res.destroy());
   if(isFirst){input.pipe(res,{end:false});input.on('end',()=>{timer=setTimeout(()=>{dropped=true;res.destroy()},100);});}else input.pipe(res);
  });server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  const open=createSourceOpener({safeUrl:u=>new URL(u),remote:(url,headers,signal)=>fetch(url,{headers,signal})});
  transcode=createTranscoder({tmpdir:dir,executable:bin,open});const job=await transcode.start({url:base+'/old',refresh:async()=>{refreshes++;return {url:base+'/new'}}},'soak');
  const until=Date.now()+300000;let reads=0,last='';
  while(Date.now()<until){const list=await transcode.read(job.id,'soak','240/index.m3u8');assert.ok(list,'conversion disappeared');const text=list.data.toString();assert.match(text,/#EXTM3U/);assert.equal((await transcode.status(job.id,'soak')).active,true);last=text;reads++;await new Promise(r=>setTimeout(r,1000));}
  assert.ok(dropped,'fixture socket was not dropped');assert.ok(refreshes>0 && resumes>0,'range resume was not exercised');assert.ok((last.match(/index\d+\.ts/g)||[]).length>10);assert.ok(reads>=290);
  console.log(`Soak: ${reads} playlist reads, dropped socket, ${refreshes} refresh(es), ${resumes} range resume(s).`);
 }finally{clearTimeout(timer);await transcode?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await fsp.rm(dir,{recursive:true,force:true});}
});
