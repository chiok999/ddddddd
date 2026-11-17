'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {resumableInput}=require('./resumable-input');
const {createSourceOpener}=require('./source-opener');

async function fixture(bytes,{mode='good',dropAt=Math.floor(bytes.length/2)}={}){
 const requests=[];let initial=true;
 const server=http.createServer((req,res)=>{
  requests.push({path:req.url,range:req.headers.range,ifRange:req.headers['if-range']});
  if(req.url==='/old' && !initial){res.writeHead(403);return res.end();}
  const tag=mode==='changed' && req.url==='/new'?'"changed"':'"stable"';
  const headers={'content-type':'video/mp4','etag':tag,'accept-ranges':'bytes'};
  if(initial){initial=false;res.writeHead(200,{...headers,'content-length':bytes.length});res.write(bytes.subarray(0,dropAt));return setTimeout(()=>res.destroy(),100);}
  if(mode==='ignore'){res.writeHead(200,{...headers,'content-length':bytes.length});return res.end(bytes);}
  const match=/^bytes=(\d+)-$/.exec(req.headers.range||'');if(!match){res.writeHead(400);return res.end();}
  const offset=Number(match[1]);res.writeHead(206,{...headers,'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`,'content-length':bytes.length-offset});res.end(bytes.subarray(offset));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 return {base,requests,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
function opener(){return createSourceOpener({safeUrl:url=>new URL(url),remote:(url,headers,signal)=>fetch(url,{headers,signal,redirect:'manual'})});}
async function collect(stream){const chunks=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks);}

test('real socket drop resumes exact bytes after 403 and provider re-resolution',async()=>{
 const bytes=Buffer.alloc(300000);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 const f=await fixture(bytes);const controller=new AbortController();let refreshes=0;
 const entry={url:f.base+'/old',refresh:async()=>{refreshes++;return {url:f.base+'/new'}}};const open=opener();
 try{const first=await open(entry,controller.signal);const actual=await collect(resumableInput(first,(offset,validator)=>open(entry,controller.signal,offset,validator),controller.signal,{backoffMs:5}));assert.deepEqual(actual,bytes);assert.equal(refreshes,1);const final=f.requests.at(-1);assert.equal(final.ifRange,'"stable"');assert.equal(final.path,'/new');assert.equal(final.range,'bytes=150000-');}
 finally{controller.abort();await f.close();}
});

test('resume refuses ignored ranges or changed representation instead of corrupting input',async()=>{
 for(const mode of ['changed','ignore']){
  const bytes=Buffer.alloc(20000,3),f=await fixture(bytes,{mode});const controller=new AbortController();const entry={url:f.base+'/old',refresh:async()=>({url:f.base+'/new'})};const open=opener();
  try{const first=await open(entry,controller.signal);await assert.rejects(collect(resumableInput(first,(offset,validator)=>open(entry,controller.signal,offset,validator),controller.signal,{backoffMs:1,retries:2})),/validated range retry exhausted|Source changed/);}
  finally{controller.abort();await f.close();}
 }
});

test('real FFmpeg job survives a dropped HTTP socket without replacing the job', {timeout:50000},async t=>{
 const {bundledFfmpeg,createTranscoder}=require('./transcode');const bin=process.env.CINEMA_TEST_FFMPEG||bundledFfmpeg();if(!bin)return t.skip('FFmpeg unavailable');
 const fs=require('node:fs'),fsp=fs.promises,os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'troy-drop-')),file=path.join(dir,'input.mp4');
 const result=spawnSync(bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440','-t','30','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',file],{timeout:20000});assert.equal(result.status,0,String(result.stderr));
 const bytes=await fsp.readFile(file),f=await fixture(bytes),open=opener();let refreshes=0;
 const entry={url:f.base+'/old',refresh:async()=>{refreshes++;return {url:f.base+'/new'}}};const transcode=createTranscoder({tmpdir:dir,executable:bin,open});
 try{const job=await transcode.start(entry,'owner');const deadline=Date.now()+30000;let manifest;
  while(Date.now()<deadline){await new Promise(r=>setTimeout(r,500));const list=await transcode.read(job.id,'owner','240/index.m3u8');assert.ok(list,'job disappeared');manifest=list.data.toString();if(manifest.includes('#EXT-X-ENDLIST'))break;}
  assert.match(manifest,/#EXT-X-ENDLIST/);assert.equal(refreshes,1);assert.ok(f.requests.some(r=>r.path==='/new' && r.range));assert.equal(transcode.status(job.id,'owner').active,true);
  const last=manifest.match(/index\d+\.ts/g).at(-1);const segment=await transcode.read(job.id,'owner',`240/${last}`);const decoded=spawnSync(bin,['-hide_banner','-loglevel','error','-f','mpegts','-i','pipe:0','-map','0:v:0','-map','0:a:0','-f','null','-'],{input:segment.data,timeout:10000});assert.equal(decoded.status,0,String(decoded.stderr));
 }finally{await transcode.close();await f.close();await fsp.rm(dir,{recursive:true,force:true});}
});

test('missing validator fails closed on a dropped stream',async()=>{
 const bytes=Buffer.alloc(10000,5);const headers=new Headers({'content-length':String(bytes.length),'content-type':'video/mp4'});
 const body=new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,50));controller.error(Error('reset'));}});
 const controller=new AbortController();let retries=0;
 await assert.rejects(collect(resumableInput({headers,body},async()=>{retries++;throw Error('unexpected');},controller.signal,{backoffMs:1})),/safe resume is unavailable/);
 assert.equal(retries,0);
});

test('retry budget resets after each successful validated reconnect',async()=>{
 const body=(bytes,fail)=>new ReadableStream({start(c){c.enqueue(Uint8Array.from(bytes));if(fail)setTimeout(()=>c.error(Error('reset')),1);else c.close();}});
 const headers=(offset)=>new Headers({'etag':'"same"','content-length':String(8-offset),...(offset?{'content-range':`bytes ${offset}-7/8`}:{})});
 const first={headers:headers(0),body:body([0,1],true)};let calls=0;const controller=new AbortController();
 const result=await collect(resumableInput(first,async offset=>{calls++;return {status:206,headers:headers(offset),body:body([offset,offset+1],offset<6)}},controller.signal,{retries:1,backoffMs:1}));
 assert.deepEqual([...result],[0,1,2,3,4,5,6,7]);assert.equal(calls,3);
});

test('reconnects that never deliver bytes exhaust the retry budget',async()=>{
 const headers=new Headers({'etag':'"same"','content-length':'8'});const failed=()=>new ReadableStream({start(c){setTimeout(()=>c.error(Error('reset')),1);}});const controller=new AbortController();let calls=0;
 const first={headers,body:failed()};
 await assert.rejects(collect(resumableInput(first,async offset=>{calls++;return {status:206,headers:new Headers({'etag':'"same"','content-range':`bytes ${offset}-7/8`,'content-length':String(8-offset)}),body:failed()}},controller.signal,{retries:2,backoffMs:1})),/retry exhausted/);
 assert.equal(calls,2);
});

test('provider TTL refresh runs before open without bypassing range validator checks',async()=>{
 const {createSourceOpener}=require('./source-opener');let refreshes=0;const calls=[];const open=createSourceOpener({now:()=>1000,safeUrl:u=>new URL(u),remote:async(url,headers)=>{calls.push({url,headers});return new Response('abc',{status:206,headers:{'content-range':'bytes 2-4/5','content-length':'3','etag':'"different"'}})}});
 const entry={url:'https://old.example/a',refreshAt:999,refresh:async()=>{refreshes++;return {url:'https://new.example/a'}}};const controller=new AbortController();const response=await open(entry,controller.signal,2,'"original"');assert.equal(refreshes,1);assert.equal(calls[0].url,'https://new.example/a');assert.equal(calls[0].headers.range,'bytes=2-');assert.equal(calls[0].headers['if-range'],'"original"');
 const original={headers:new Headers({'etag':'"original"','content-length':'5'}),body:new ReadableStream({start(c){c.enqueue(Uint8Array.from([1,2]));setTimeout(()=>c.error(Error('disconnect')),1);}})};
 await assert.rejects(collect(resumableInput(original,()=>Promise.resolve(response),controller.signal,{retries:1,backoffMs:1})),/Source changed/);
});

test('a series host that answers 426 to HTTP/1.1 plays once HTTP/2 is offered', async t => {
 // This is the reported failure: a movie plays, a series returns 426 from the
 // same server. The difference is the edge demanding HTTP/2 (ALPN) for the
 // series endpoint, which the server previously could not offer at all.
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http2=require('node:http2');
 const {spawnSync}=require('node:child_process');const {Agent,fetch}=require('undici');
 const {getRemote,h2Requested}=require('./network');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'troy-series-'));
 const key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem');
 const gen=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=fixture.test'],{stdio:'ignore'});
 if(gen.error||gen.status!==0){fs.rmSync(dir,{recursive:true,force:true});return t.skip('openssl unavailable');}

 const server=http2.createSecureServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert),allowHTTP1:true});
 const seen=[];
 server.on('request',(req,res)=>{
  seen.push({version:req.httpVersionMajor,url:req.url});
  if(req.httpVersionMajor===1){
   // Exactly what the series edge does: refuse HTTP/1.1, ask for an upgrade.
   res.writeHead(426,{upgrade:'h2'});res.end();return;
  }
  res.writeHead(200,{'content-type':'video/mp4'});res.end('series bytes');
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');

 const lookup=(name,options,cb)=>options.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4);
 const connect={lookup,rejectUnauthorized:false};
 const h1=new Agent({connect}),h2=new Agent({connect,allowH2:true});
 const fixtureFetch=(url,options)=>{const u=new URL(url);u.port=String(server.address().port);return fetch(u,options);};
 try{
  const {response}=await getRemote('https://fixture.test/series.m3u8',{},AbortSignal.timeout(15000),fixtureFetch,h1,h2);
  assert.equal(response.status,200,'the retry over HTTP/2 is accepted');
  assert.equal(await response.text(),'series bytes');
  assert.deepEqual(seen.map(s=>s.version),[1,2],'one refused HTTP/1.1 request, then HTTP/2');
  // Without an h2 agent the failure is reported honestly rather than looping.
  seen.length=0;
  const plain=await getRemote('https://fixture.test/series.m3u8',{},AbortSignal.timeout(15000),fixtureFetch,h1);
  assert.equal(plain.response.status,426);
  assert.equal(seen.length,1);
  // A refusal that names something other than h2 is not retried.
  assert.equal(h2Requested({headers:{get:()=> 'websocket'}}),false);
  assert.equal(h2Requested({headers:{get:()=> null}}),true);
 }finally{await h1.close();await h2.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
