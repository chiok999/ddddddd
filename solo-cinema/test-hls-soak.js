'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),fsp=fs.promises,os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),{once}=require('node:events');
const {createTranscoder,bundledFfmpeg}=require('./transcode');const bin=process.env.CINEMA_TEST_FFMPEG||bundledFfmpeg();
test('five-minute HLS conversion soak retries a failed source segment',{skip:!bin,timeout:420000},async()=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'troy-hls-soak-'));let server,t;
 try{
  const made=spawnSync(bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=160x90:rate=1','-f','lavfi','-i','sine=frequency=440','-t','330','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-g','4','-c:a','aac','-b:a','48k','-f','hls','-hls_time','4','-hls_list_size','0',path.join(dir,'src.m3u8')],{timeout:60000});assert.equal(made.status,0,String(made.stderr));
  let failed=false,failedName=null,retried=0;
  server=http.createServer(async(req,res)=>{const name=path.basename(new URL(req.url,'http://fixture').pathname);if(name.endsWith('.ts') && !failed){failed=true;failedName=name;res.writeHead(503);return res.end();}if(name===failedName && failed)retried++;try{const file=await fsp.readFile(path.join(dir,name));const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');let start=m?Number(m[1]):0,end=m&&m[2]?Math.min(Number(m[2]),file.length-1):file.length-1;res.writeHead(m?206:200,{'content-type':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t','content-length':end-start+1,...(m?{'content-range':`bytes ${start}-${end}/${file.length}`}:{})});res.end(file.subarray(start,end+1));}catch{res.writeHead(404);res.end();}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  const safeUrl=u=>{const parsed=new URL(u);if(parsed.origin!==origin)throw Error('unsafe fixture address');return parsed;};
  const open=(entry,signal,range)=>fetch(entry.url,{signal,headers:range?{range}:{}});
  t=createTranscoder({tmpdir:dir,executable:bin,open,openHlsResource:open,safeUrl});const job=await t.start({url:origin+'/src.m3u8'},'viewer');
  const end=Date.now()+300000;let reads=0;
  while(Date.now()<end){const list=await t.read(job.id,'viewer','240/index.m3u8');assert.ok(list);assert.match(list.data.toString(),/#EXTM3U/);assert.equal(t.status(job.id,'viewer',Math.min(reads,300)).active,true);reads++;await new Promise(r=>setTimeout(r,1000));}
  assert.ok(failed && retried>0);assert.ok(reads>=290);console.log(`HLS soak: ${reads} playlist reads, failed segment and ${retried} retries of the failed segment.`);
 }finally{await t?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await fsp.rm(dir,{recursive:true,force:true});}
});
