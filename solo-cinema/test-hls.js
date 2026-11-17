'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {createTranscoder,bundledFfmpeg}=require('./transcode');
const bin=process.env.CINEMA_TEST_FFMPEG||bundledFfmpeg();
for(const scenario of ['master-ts','aes128-ts','fmp4','byterange-ts','variables-ll'])test(`real FFmpeg converts ${scenario} HLS to both playable renditions`,{skip:!bin,timeout:60000},async()=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'troy-hls-test-'));let t;const requests=[];
 try{
  const opts=[];
  if(scenario==='aes128-ts'){await fsp.writeFile(path.join(dir,'key.bin'),crypto.randomBytes(16));await fsp.writeFile(path.join(dir,'keyinfo'),`https://fixture.example/key.bin\n${path.join(dir,'key.bin')}\n`);opts.push('-hls_key_info_file',path.join(dir,'keyinfo'));}
  if(scenario==='fmp4')opts.push('-hls_segment_type','fmp4');
  if(scenario==='byterange-ts')opts.push('-hls_flags','single_file');
  const generated=spawnSync(bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440','-t','12','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-g','20','-c:a','aac','-f','hls','-hls_time','2','-hls_list_size','0',...opts,path.join(dir,'media.m3u8')],{timeout:20000});assert.equal(generated.status,0,String(generated.stderr));
  if(scenario==='variables-ll'){
   const media=await fsp.readFile(path.join(dir,'media.m3u8'),'utf8');
   const extra='#EXT-X-DEFINE:IMPORT="seg"\n#EXT-X-PART:DURATION=1.0,URI="{$seg}0.ts"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="{$seg}0.ts"\n#EXT-X-RENDITION-REPORT:URI="{$seg}.m3u8",LAST-MSN=1\n';
   await fsp.writeFile(path.join(dir,'media.m3u8'),media.replace('#EXTM3U\n','#EXTM3U\n'+extra).replace(/media(\d+\.ts)/g,'{$seg}$1'));
   await fsp.writeFile(path.join(dir,'master.m3u8'),'#EXTM3U\n#EXT-X-DEFINE:NAME="seg",VALUE="media"\n#EXT-X-STREAM-INF:BANDWIDTH=500000\n{$seg}.m3u8\n');
  }
  if(scenario==='master-ts')await fsp.writeFile(path.join(dir,'master.m3u8'),'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nmedia.m3u8\n');
  const fetchFixture=async(entry,_signal,range)=>{
   const u=new URL(entry.url);assert.equal(u.hostname,'fixture.example');const name=path.basename(u.pathname);requests.push({name,range});const data=await fsp.readFile(path.join(dir,name));
   let start=0,end=data.length-1;if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);assert.ok(match);start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
   const chunk=data.subarray(start,end+1);return new Response(chunk,{status:range?206:200,headers:{'content-type':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'application/octet-stream','content-length':String(chunk.length),...(range?{'content-range':`bytes ${start}-${end}/${data.length}`}:{})}});
  };
  t=createTranscoder({tmpdir:dir,executable:bin,open:fetchFixture,openHlsResource:fetchFixture,safeUrl:u=>new URL(u)});
  const job=await t.start({url:`https://fixture.example/${['master-ts','variables-ll'].includes(scenario)?'master':'media'}.m3u8`,format:'hls'},'viewer');assert.equal(job.duration,12);
  for(const rendition of ['240','360']){const list=(await t.read(job.id,'viewer',`${rendition}/index.m3u8`)).data.toString(),name=list.match(/index\d+\.ts/)[0];const segment=await t.read(job.id,'viewer',`${rendition}/${name}`);const decoded=spawnSync(bin,['-hide_banner','-loglevel','error','-f','mpegts','-i','pipe:0','-map','0:v:0','-map','0:a:0','-f','null','-'],{input:segment.data,timeout:15000});assert.equal(decoded.status,0,String(decoded.stderr));}
  if(scenario==='aes128-ts')assert.ok(requests.some(x=>x.name==='key.bin'));if(scenario==='fmp4')assert.ok(requests.some(x=>x.name.endsWith('.mp4')));if(scenario==='byterange-ts')assert.ok(requests.some(x=>x.range && !x.range.endsWith('-')));
 }finally{await t?.close();await fsp.rm(dir,{recursive:true,force:true});}
});

test('HLS relay blocks private URLs and unhandled URI-bearing tags before fetching them',async()=>{
 const {createHlsInput}=require('./hls-input'),{safeUrl}=require('./network');
 for(const playlist of [
  '#EXTM3U\n#EXTINF:4,\nhttps://127.0.0.1/secret.ts\n',
  '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://169.254.169.254/key"\n#EXTINF:4,\nhttps://example.com/seg.ts\n',
  '#EXTM3U\n#EXT-X-SESSION-DATA:DATA-ID="x",URI="http://localhost/secret"\n',
  '#EXTM3U\n#EXT-X-DEFINE:NAME="host",VALUE="127.0.0.1"\n#EXTINF:4,\nhttps://{$host}/seg.ts\n',
 ]){
  let fetched=0;const controller=new AbortController();const relay=await createHlsInput({source:{url:'https://example.com/list.m3u8'},first:new Response(playlist),safeUrl,signal:controller.signal,fetchResource:async()=>{fetched++;throw Error('unexpected');}});
  try{assert.equal((await fetch(relay.url)).status,502);assert.equal(fetched,0);}finally{controller.abort();relay.close();}
 }
});

test('HLS relay resolves references against the validated final playlist URL and hides original URLs',async()=>{
 const {createHlsInput}=require('./hls-input'),{safeUrl}=require('./network');const signal=new AbortController();const initial={status:200,headers:new Headers(),url:'https://cdn.example/sub/master.m3u8',body:new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500\nchild.m3u8?secret=xyz\n').body};
 let requested;const relay=await createHlsInput({source:{url:'https://example.com/master.m3u8'},first:initial,safeUrl,signal:signal.signal,fetchResource:async(source)=>{requested=source.url;return new Response('#EXTM3U\n#EXT-X-ENDLIST\n')}});
 try{const root=await (await fetch(relay.url)).text();assert.doesNotMatch(root,/secret|cdn\.example/);const child=root.split('\n').find(x=>x.startsWith('http'));assert.ok(child);assert.equal((await fetch(child)).status,200);assert.equal(requested,'https://cdn.example/sub/child.m3u8?secret=xyz');}finally{signal.abort();relay.close();}
});

test('real HLS seek starts near the requested episode timestamp', {skip:!bin,timeout:60000},async()=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'troy-hls-seek-'));let t;
 try{
  const made=spawnSync(bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=red:size=160x90:rate=10:duration=8','-f','lavfi','-i','color=blue:size=160x90:rate=10:duration=8','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-g','20','-f','hls','-hls_time','2','-hls_list_size','0',path.join(dir,'media.m3u8')],{timeout:20000});assert.equal(made.status,0,String(made.stderr));
  const open=async(entry,_signal,range)=>{const b=await fsp.readFile(path.join(dir,path.basename(new URL(entry.url).pathname)));let start=0,end=b.length-1;if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}return new Response(b.subarray(start,end+1),{status:range?206:200,headers:range?{'content-range':`bytes ${start}-${end}/${b.length}`}:{}});};
  t=createTranscoder({tmpdir:dir,executable:bin,open,openHlsResource:open,safeUrl:u=>new URL(u)});const job=await t.start({url:'https://fixture.example/media.m3u8'},'viewer',10);
  const list=(await t.read(job.id,'viewer','240/index.m3u8')).data.toString(),name=list.match(/index\d+\.ts/)[0],segment=await t.read(job.id,'viewer',`240/${name}`);
  const frame=spawnSync(bin,['-hide_banner','-loglevel','error','-f','mpegts','-i','pipe:0','-frames:v','1','-vf','scale=2:2','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{input:segment.data,timeout:10000});assert.equal(frame.status,0,String(frame.stderr));assert.ok(frame.stdout[2]>200 && frame.stdout[0]<30,`expected blue after seek, got ${[...frame.stdout.subarray(0,3)]}`);
 }finally{await t?.close();await fsp.rm(dir,{recursive:true,force:true});}
});

test('real HLS master with separate audio is converted with sound', {skip:!bin,timeout:60000},async()=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'troy-hls-audio-'));let t;
 try{
  const video=spawnSync(bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=160x90:rate=10','-t','12','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-g','20','-f','hls','-hls_time','2','-hls_list_size','0','-hls_segment_filename',path.join(dir,'video%d.ts'),path.join(dir,'video.m3u8')],{timeout:20000});assert.equal(video.status,0,String(video.stderr));
  const audio=spawnSync(bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440','-t','12','-c:a','aac','-f','hls','-hls_time','2','-hls_list_size','0','-hls_segment_filename',path.join(dir,'audio%d.ts'),path.join(dir,'audio.m3u8')],{timeout:20000});assert.equal(audio.status,0,String(audio.stderr));
  await fsp.writeFile(path.join(dir,'master.m3u8'),'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="aud"\nvideo.m3u8\n');
  const open=async(entry,_signal,range)=>{const b=await fsp.readFile(path.join(dir,path.basename(new URL(entry.url).pathname)));let start=0,end=b.length-1;if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}return new Response(b.subarray(start,end+1),{status:range?206:200,headers:range?{'content-range':`bytes ${start}-${end}/${b.length}`}:{}});};
  t=createTranscoder({tmpdir:dir,executable:bin,open,openHlsResource:open,safeUrl:u=>new URL(u)});const job=await t.start({url:'https://fixture.example/master.m3u8'},'viewer');
  const list=(await t.read(job.id,'viewer','360/index.m3u8')).data.toString(),name=list.match(/index\d+\.ts/)[0],segment=await t.read(job.id,'viewer',`360/${name}`);
  const decoded=spawnSync(bin,['-hide_banner','-loglevel','error','-f','mpegts','-i','pipe:0','-map','0:v:0','-map','0:a:0','-f','null','-'],{input:segment.data,timeout:10000});assert.equal(decoded.status,0,String(decoded.stderr));
 }finally{await t?.close();await fsp.rm(dir,{recursive:true,force:true});}
});

test('HLS variables and low-latency references remain private and pass URL validation',async()=>{
 const {createHlsInput}=require('./hls-input'),{safeUrl}=require('./network');const ctrl=new AbortController();let requests=[];
 const initial={status:200,headers:new Headers(),url:'https://cdn.example/master.m3u8?token=secret%2Fvalue',body:new Response('#EXTM3U\n#EXT-X-DEFINE:QUERYPARAM="token"\n#EXT-X-DEFINE:NAME="name",VALUE="video"\n#EXT-X-SESSION-DATA:DATA-ID="id",URI="metadata.json?t={$token}"\n#EXT-X-STREAM-INF:BANDWIDTH=500\n{$name}.m3u8?t={$token}\n').body};
 const relay=await createHlsInput({source:{url:'https://cdn.example/master.m3u8'},first:initial,safeUrl,signal:ctrl.signal,fetchResource:async entry=>{requests.push(entry.url);return new Response('#EXTM3U\n#EXT-X-DEFINE:IMPORT="token"\n#EXT-X-PART:DURATION=0.5,URI="part.ts?t={$token}"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.ts?t={$token}"\n#EXT-X-RENDITION-REPORT:URI="other.m3u8?t={$token}",LAST-MSN=1\n#EXTINF:1,\nfull.ts?t={$token}\n#EXT-X-ENDLIST\n');}});
 try{const root=await (await fetch(relay.url)).text();assert.doesNotMatch(root,/secret|cdn\.example|EXT-X-DEFINE|\{\$/);const uri=/URI="([^"]+)"/.exec(root)[1];assert.match(uri,/^http:\/\/127\.0\.0\.1:/);const child=root.split('\n').find(x=>x.startsWith('http'));const media=await (await fetch(child)).text();assert.doesNotMatch(media,/secret|cdn\.example|\{\$/);assert.equal((media.match(/http:\/\/127\.0\.0\.1:/g)||[]).length,4);assert.deepEqual(requests,['https://cdn.example/video.m3u8?t=secret%2Fvalue']);}finally{ctrl.abort();relay.close();}
});

test('unsafe variable expansion and ambiguous URI attributes fail closed',async()=>{
 const {createHlsInput}=require('./hls-input'),{safeUrl}=require('./network');
 for(const text of [
 '#EXTM3U\n#EXT-X-DEFINE:NAME="address",VALUE="127.0.0.1"\n#EXT-X-PART:DURATION=1,URI="https://{$address}/secret"\n',
 '#EXTM3U\n#EXT-X-DEFINE:IMPORT="missing"\n#EXTINF:1,\n{$missing}\n',
 '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key",URI="https://example.com/other"\n',
 '#EXTM3U\n#EXT-X-UNKNOWN:URI="https://example.com/secret"\n',
 '#EXTM3U\n#EXT-X-SKIP:SKIPPED-SEGMENTS=3\n',
 ]){let opened=0;const ctrl=new AbortController(),relay=await createHlsInput({source:{url:'https://example.com/x.m3u8'},first:new Response(text),safeUrl,signal:ctrl.signal,fetchResource:async()=>{opened++;throw Error('not expected')}});try{assert.equal((await fetch(relay.url)).status,502);assert.equal(opened,0);}finally{ctrl.abort();relay.close();}}
});

test('HLS relay rejection is reported as an HLS error rather than an MP4 fault', {skip:!bin,timeout:30000},async()=>{
 const {createTranscoder}=require('./transcode'),{safeUrl}=require('./network');const t=createTranscoder({executable:bin,safeUrl,open:async()=>new Response('#EXTM3U\n#EXT-X-UNKNOWN:URI="https://example.com/secret?token=hidden"\n'),openHlsResource:async()=>{throw Error('not expected')}});
 try{await assert.rejects(t.start({url:'https://example.com/master.m3u8'},'viewer'),e=>/HLS playlist or resource error: Unsupported HLS playlist feature/.test(e.message) && !/MP4|hidden/.test(e.message));}finally{await t.close();}
});
