'use strict';
// Session-bound FFmpeg jobs. Input is already fetched through Troy's pinned proxy;
// FFmpeg receives bytes on stdin and cannot open network or file input protocols.
const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const {Transform,Readable}=require('node:stream');
const {createHlsInput}=require('./hls-input');
const {resumableInput}=require('./resumable-input');

// Extract only the bounded mvhd declared movie duration; fragmented/unknown
// durations are not guessed. The gate has already buffered the complete moov.
function movieDuration(buffer,start,size,header){
 const end=start+size;let pos=start+header;
 while(pos+8<=end){let n=buffer.readUInt32BE(pos),h=8;if(n===1){if(pos+16>end)return null;const v=buffer.readBigUInt64BE(pos+8);if(v>BigInt(end-pos))return null;n=Number(v);h=16;}if(n<h || pos+n>end)return null;
  if(buffer.toString('ascii',pos+4,pos+8)==='mvhd'){
   const p=pos+h;if(p+4>pos+n)return null;const version=buffer[p];let scale,duration;
   if(version===0 && p+20<=pos+n){scale=buffer.readUInt32BE(p+12);duration=buffer.readUInt32BE(p+16);if(duration===0xffffffff)return null;}
   else if(version===1 && p+32<=pos+n){scale=buffer.readUInt32BE(p+20);const v=buffer.readBigUInt64BE(p+24);if(v>BigInt(Number.MAX_SAFE_INTEGER))return null;duration=Number(v);}
   else return null;
   const seconds=duration/scale;return scale && Number.isFinite(seconds) && seconds>0?seconds:null;
  }pos+=n;
 }return null;
}

// Reject non-fast-start MP4s before downloading the full file. FFmpeg's pipe input cannot seek back to a trailing moov atom.
function fastStartGate(limit=8*1024*1024,seekOffset=0){
 let buffer=Buffer.alloc(0),offset=0,seenFtyp=false,ready=false;
 return new Transform({transform(chunk,encoding,callback){
  if(ready){this.push(chunk);return callback();}
  buffer=Buffer.concat([buffer,chunk]);
  try{
   while(buffer.length-offset>=8){const size32=buffer.readUInt32BE(offset),type=buffer.toString('ascii',offset+4,offset+8);let size=size32,header=8;
    if(size32===1){if(buffer.length-offset<16)break;const n=buffer.readBigUInt64BE(offset+8);if(n>BigInt(limit))throw Error('MP4 metadata exceeds the fast-start limit');size=Number(n);header=16;}
    if(size===0 || size<header)throw Error('Invalid MP4 box');
    if(!seenFtyp && type!=='ftyp')throw Error('Only fast-start MP4 sources are supported');
    if(type==='mdat')throw Error('MP4 is not fast-start; this source cannot be converted');
    if(size>limit || offset+size>limit)throw Error('MP4 metadata exceeds the fast-start limit');
    if(buffer.length-offset<size)break;
    if(type==='ftyp')seenFtyp=true;
    if(type==='moov'){const duration=movieDuration(buffer,offset,size,header);this.duration=duration;if(seekOffset && (!duration || seekOffset>=duration))throw Error('Cannot seek beyond a known MP4 duration');ready=true;this.push(buffer);buffer=null;return callback();}
    offset+=size;
   }
   if(buffer.length>limit)throw Error('MP4 metadata exceeds the fast-start limit');callback();
  }catch(e){callback(e);}
 },flush(callback){callback(ready?null:Error('MP4 metadata is incomplete'));}});
}


// Use the locally installed platform binary without any network download at runtime.
function bundledFfmpeg(platform=process.platform,arch=process.arch,report=process.report){
  if(platform!=='linux' || !['x64','arm64'].includes(arch))return null;
  let libc='glibc';try{if(!report?.getReport?.().header?.glibcVersionRuntime)libc='musl';}catch{return null;}
  const name=`@seydx/node-av-ffmpeg-light-linux-${arch}${libc==='musl'?'-musl':''}`;
  try{const executable=path.join(path.dirname(require.resolve(`${name}/package.json`)),'ffmpeg');return fs.existsSync(executable)?executable:null;}catch{return null;}
}
// Software-only ARM64 build from npm; no Rockchip runtime initialization.
function softwareFfmpeg(platform=process.platform,arch=process.arch){
  if(platform!=='linux' || arch!=='arm64')return null;
  try{const executable=path.join(path.dirname(require.resolve('@content-forge/ffmpeg-linux-arm64/package.json')),'ffmpeg');return fs.existsSync(executable)?executable:null;}catch{return null;}
}
const ffmpegOptions=new Map();
function ffmpegCandidates(platform=process.platform,arch=process.arch,bundled=bundledFfmpeg(),software=softwareFfmpeg()){
  if(process.env.CINEMA_FFMPEG)return [{label:'Configured FFmpeg',path:process.env.CINEMA_FFMPEG}];
  const system={label:'System FFmpeg',path:'ffmpeg'},packaged=bundled?{label:'Bundled FFmpeg',path:bundled}:null;
  // The ARM64 bundle links Rockchip MPP, whose initializers can write to
  // system logs even for software-only jobs on non-Rockchip machines.
  if(platform==='linux' && arch==='arm64')return [...(software?[{label:'Software FFmpeg',path:software}]:[]),system,...(packaged?[packaged]:[])];
  return [...(packaged?[packaged]:[]),system];
}
function executableError(error){
  if(error?.code==='ENOENT')return 'FFmpeg executable or its system loader was not found';
  if(error?.code==='EACCES' || error?.code==='EPERM')return 'FFmpeg execution was denied (permissions or noexec filesystem)';
  if(error?.code==='ENOEXEC')return 'FFmpeg binary is incompatible with this system';
  return `FFmpeg could not start${error?.code ? ` (${String(error.code).slice(0,30)})` : ''}`;
}
function ffmpegExitError(code,stderr='',kind='file'){
  if(/no space left on device|disk quota exceeded/i.test(stderr))return 'Temporary filesystem is full or its quota has been exceeded';
  return kind==='hls'?`HLS conversion failed (FFmpeg exit ${code})`:`Transcoding failed (FFmpeg exit ${code}); this MP4 may not support streaming input`;
}
function probeCommand(executable,args){return new Promise((resolve,reject)=>{
  execFile(executable,args,{timeout:10000,maxBuffer:2*1024*1024,windowsHide:true},(err,stdout,stderr)=>{
    if(err){if(err.killed)return reject(Error('FFmpeg capability check timed out'));if(typeof err.code==='string')return reject(Error(executableError(err)));return reject(Error(`FFmpeg capability check failed (exit ${err.code})`));}
    resolve(stdout+'\n'+stderr);
  });
});}
async function probeFfmpeg(executable){
  await probeCommand(executable,['-version']);
  const encoders=await probeCommand(executable,['-hide_banner','-encoders']);
  if(!/^\s*[A-Z.]{6}\s+libx264\s/m.test(encoders) || !/^\s*[A-Z.]{6}\s+aac\s/m.test(encoders))throw Error('FFmpeg is missing the libx264 or AAC encoder');
  const muxers=await probeCommand(executable,['-hide_banner','-muxers']);
  if(!/^\s*E\s+hls\s/m.test(muxers))throw Error('FFmpeg is missing the HLS muxer');
  const filters=await probeCommand(executable,['-hide_banner','-filters']);
  if(!/^\s*[A-Z.]{2,3}\s+scale\s/m.test(filters) || !/^\s*[A-Z.]{2,3}\s+pad\s/m.test(filters))throw Error('FFmpeg is missing the scale or pad filter');
  const hls=await probeCommand(executable,['-hide_banner','-h','muxer=hls']);
  if(!/\btemp_file\b/.test(hls))throw Error('FFmpeg HLS muxer lacks temp_file support');
  const demuxer=await probeCommand(executable,['-hide_banner','-h','demuxer=hls']);
  for(const option of ['allowed_extensions','seg_max_retry'])if(!demuxer.includes(`-${option}`))throw Error(`FFmpeg HLS demuxer lacks ${option} support`);
  // FFmpeg builds differ: Jellyfin adds these optional segment extension checks.
  // All HLS references still pass through the private validating relay.
  ffmpegOptions.set(executable,{allowedSegmentExtensions:demuxer.includes('-allowed_segment_extensions'),extensionPicky:demuxer.includes('-extension_picky')});
}

// Verify the optional software build actually decodes on this host; capability
// listings alone cannot detect incompatible CPU/kernel/static builds.
function binaryRun(executable,args,input){return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{stdio:['pipe','pipe','pipe'],shell:false});let data=[],size=0,finished=false;
  const timer=setTimeout(()=>{child.kill('SIGKILL');done(Error('FFmpeg software test timed out'));},10000);
  function done(error,result){if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(result);}
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){child.kill('SIGKILL');done(Error('FFmpeg software test output exceeded limit'));}else data.push(chunk);});
  child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',err=>done(Error(executableError(err))));
  child.on('close',(code,signal)=>{if(code!==0)return done(Error(`FFmpeg software test failed (${signal || code})`));done(null,Buffer.concat(data));});
  child.stdin.end(input);
});}
async function probeSoftwareFfmpeg(executable){
  const encoded=await binaryRun(executable,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=64x64:rate=1','-frames:v','1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-f','mpegts','pipe:1']);
  if(!encoded.length)throw Error('FFmpeg software test produced no video');
  const decoded=await binaryRun(executable,['-hide_banner','-loglevel','error','-f','mpegts','-i','pipe:0','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],encoded);
  if(decoded.length!==64*64*3)throw Error('FFmpeg software test could not decode video');
  const http=require('node:http');const server=http.createServer((req,res)=>{
    if(req.url==='/index.m3u8'){res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'});res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n');}
    else if(req.url==='/segment.ts'){res.writeHead(200,{'content-type':'video/mp2t'});res.end(encoded);}else res.writeHead(404).end();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try{
    const features=ffmpegOptions.get(executable)||{};
    const picture=await binaryRun(executable,['-hide_banner','-loglevel','error','-protocol_whitelist','http,tcp,crypto','-format_whitelist','hls,mpegts,mov,aac,mp3','-allowed_extensions','ALL',...(features.allowedSegmentExtensions?['-allowed_segment_extensions','ALL']:[]),...(features.extensionPicky?['-extension_picky','0']:[]),'-seg_max_retry','3','-f','hls','-i',`http://127.0.0.1:${server.address().port}/index.m3u8`,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    if(picture.length!==64*64*3)throw Error('FFmpeg software HLS test could not decode video');
  }finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
}
async function chooseFfmpeg(candidates){const failures=[];for(const candidate of candidates){try{await probeFfmpeg(candidate.path);if(candidate.label==='Software FFmpeg')await probeSoftwareFfmpeg(candidate.path);return candidate.path;}catch(err){failures.push(`${candidate.label}: ${err.message}`);}}throw Error(failures.join('; '));}

function createTranscoder({open, openHlsResource, safeUrl=require('./network').safeUrl, executable, tmpdir=os.tmpdir(), startupMs=45000, authorize=()=>true}={}){
  const jobs=new Map(),failures=new Map();let admission=Promise.resolve(),binaryPromise=null;
  function getBinary(){
    if(!binaryPromise){
      const candidates=executable?[{label:'FFmpeg',path:executable}]:ffmpegCandidates();
      binaryPromise=chooseFfmpeg(candidates).then(binary=>{
        if(!executable)console.log(`Troy FFmpeg: ${candidates.find(candidate=>candidate.path===binary)?.label || 'selected'}`);
        if(!executable && !process.env.CINEMA_FFMPEG && process.platform==='linux' && process.arch==='arm64' && binary===bundledFfmpeg())console.warn('Troy: software-only FFmpeg unavailable or incompatible; using Rockchip-enabled fallback.');
        return binary;
      }).catch(err=>{binaryPromise=null;throw err;});
    }
    return binaryPromise;
  }
  // Reap abandoned private directories after a crash, without touching a live Troy process.
  async function reap(){
    for(const name of await fsp.readdir(tmpdir).catch(()=>[])){
      const match=/^troy-transcode-(\d+)-[A-Za-z0-9]+$/.exec(name);if(!match)continue;
      const dir=path.join(tmpdir,name);try{const stat=await fsp.lstat(dir);if(!stat.isDirectory() || Date.now()-stat.mtimeMs<5*3600000)continue;let alive=true;try{process.kill(Number(match[1]),0);}catch(e){alive=e.code!=='ESRCH';}if(!alive)await fsp.rm(dir,{recursive:true,force:true});}catch{}
    }
  }
  reap().catch(()=>{});
  const interval=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function stop(job){
    if(!job)return Promise.resolve();if(job.stopPromise)return job.stopPromise;
    job.stopped=true;if(job.error){failures.set(job.id,{sid:job.sid,error:job.error,expires:Date.now()+300000});while(failures.size>100)failures.delete(failures.keys().next().value);}job.controller.abort();clearInterval(job.monitor);
    job.stopPromise=(async()=>{
      job.input?.destroy();job.gate?.destroy();job.relay?.close();if(job.proc && job.proc.exitCode===null && job.proc.signalCode===null)job.proc.kill('SIGKILL');
      if(job.proc && job.proc.exitCode===null)await Promise.race([new Promise(resolve=>job.proc.once('close',resolve)),interval(3000)]);
      if(job.readers)await new Promise(resolve=>job.drainWaiters.push(resolve));
      if(job.dir)await fsp.rm(job.dir,{recursive:true,force:true}).catch(()=>{});if(jobs.get(job.id)===job)jobs.delete(job.id);
    })();return job.stopPromise;
  }

  async function start(source,sid,seekOffset=0,requestId=null,requestSignal=null){
    if(typeof seekOffset!=='number' || !Number.isFinite(seekOffset) || seekOffset<0 || seekOffset>Number.MAX_SAFE_INTEGER/1000)throw Object.assign(Error('Invalid seek position'),{status:400});
    // Serialize job registration with explicit stop-all operations.
    const claim=admission.then(async()=>{
      if(requestSignal?.aborted)throw Error('Transcode request disconnected');
      if(!authorize(sid))throw Object.assign(Error('Session expired'),{status:401});
      const next={sid,requestId,id:crypto.randomBytes(24).toString('base64url'),controller:new AbortController(),lastAccess:Date.now(),stopped:false,error:null,proc:null,dir:null,ready:false,readers:0,drainWaiters:[]};jobs.set(next.id,next);return next;
    });
    admission=claim.then(()=>{},()=>{});const job=await claim;
    const onDisconnect=()=>{void stop(job);};requestSignal?.addEventListener('abort',onDisconnect,{once:true});if(requestSignal?.aborted)onDisconnect();
    try{
      if(job.stopped)throw Error('Transcode stopped');
      const binary=await getBinary();if(job.stopped)throw Error('Transcode stopped');
      job.dir=await fsp.mkdtemp(path.join(tmpdir,`troy-transcode-${process.pid}-`));if(job.stopped)throw Error('Transcode stopped');for(const d of ['240','360']){await fsp.mkdir(path.join(job.dir,d));if(job.stopped)throw Error('Transcode stopped');}
      const timer=setTimeout(()=>job.controller.abort(),30000);let response;
      try{response=await open(source,job.controller.signal);}finally{clearTimeout(timer);}
      if(job.stopped){await response.body?.cancel();throw Error('Transcode stopped');}
      if(response.status!==200 || !response.body){await response.body?.cancel().catch(()=>{});throw Error(`Source returned ${response.status}`);}
      const type=response.headers.get('content-type')||'', encoding=response.headers.get('content-encoding')||'identity';
      if(encoding.toLowerCase()!=='identity'){await response.body.cancel().catch(()=>{});throw Error('Source returned compressed content; uncompressed video or HLS is required');}
      if(/text\/html|application\/(?:json|problem\+json)/i.test(type)){await response.body.cancel().catch(()=>{});throw Error('Source returned HTML or JSON instead of video or HLS');}
      // Sniff the bytes: provider labels and opaque URLs are often inaccurate.
      const iterator=Readable.fromWeb(response.body)[Symbol.asyncIterator](),prefix=[];let size=0,done=false;
      while(size<16 && !done){const next=await iterator.next();done=next.done;if(!done){prefix.push(next.value);size+=next.value.length;}}
      const sample=Buffer.concat(prefix);const textPrefix=sample.toString('utf8').replace(/^\uFEFF/,'').trimStart();if(/^(?:<!doctype|<html|\{|\[)/i.test(textPrefix)){await iterator.return?.();throw Error('Source returned HTML or JSON instead of video or HLS');}const isHls=sample.toString('utf8').replace(/^\uFEFF/,'').startsWith('#EXTM3U');
      const body=Readable.toWeb(Readable.from((async function*(){try{for(const chunk of prefix)yield chunk;if(!done)for(;;){const next=await iterator.next();if(next.done)break;yield next.value;}}finally{await iterator.return?.();}})()));
      response={status:response.status,headers:response.headers,url:response.url,body};
      if(job.stopped){await body.cancel().catch(()=>{});throw Error('Transcode stopped');}
      if(isHls){if(!openHlsResource){await body.cancel().catch(()=>{});throw Error('HLS input unavailable');}job.relay=await createHlsInput({source,first:response,fetchResource:openHlsResource,openRoot:open,signal:job.controller.signal,safeUrl});if(job.stopped)throw Error('Transcode stopped');}
      const output=(w,h,bitrate,audio,dir)=>['-map','0:v:0','-map','0:a:0?','-vf',`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`,'-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-b:v',bitrate,'-maxrate',`${Math.round(parseInt(bitrate)*1.3)}k`,'-bufsize',`${parseInt(bitrate)*3}k`,'-force_key_frames','expr:gte(t,n_forced*4)','-sc_threshold','0','-c:a','aac','-b:a',audio,'-ac','2','-ar','48000','-f','hls','-hls_time','4','-hls_list_size','0','-hls_playlist_type','event','-hls_flags','temp_file+independent_segments','-hls_segment_filename',path.join(job.dir,dir,'index%d.ts'),path.join(job.dir,dir,'index.m3u8')];
      const pacing=seekOffset>0?['-ss',String(seekOffset)]:[];
      const features=ffmpegOptions.get(binary) || {};
      const input=isHls?['-protocol_whitelist','http,tcp,crypto','-format_whitelist','hls,mpegts,mov,aac,mp3','-allowed_extensions','ALL',...(features.allowedSegmentExtensions?['-allowed_segment_extensions','ALL']:[]),...(features.extensionPicky?['-extension_picky','0']:[]),'-seg_max_retry','3','-f','hls','-i',job.relay.url]:['-protocol_whitelist','pipe','-format_whitelist','mov','-f','mov','-i','pipe:0'];
      const args=['-hide_banner','-loglevel','error','-nostdin',...pacing,...input,...output(426,240,'250k','48k','240'),...output(640,360,'600k','64k','360')];
      job.proc=spawn(binary,args,{stdio:['pipe','ignore','pipe'],shell:false});let stderr='',diskFull=false;job.proc.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-8192);if(/no space left on device|disk quota exceeded/i.test(stderr))diskFull=true;});
      job.proc.once('error',err=>{if(['ENOENT','EACCES','EPERM','ENOEXEC'].includes(err.code))binaryPromise=null;job.error=executableError(err);void stop(job);});
      job.proc.once('close',code=>{if(!job.stopped && code!==0){if(!job.error)job.error=job.relay?.error?`HLS playlist or resource error: ${job.relay.error}`:ffmpegExitError(code,diskFull?'no space left on device':stderr,isHls?'hls':'file');void stop(job);}});
      if(!isHls){job.input=resumableInput(response,async(offset,validator)=>{const timer=setTimeout(()=>job.controller.abort(),30000);try{return await open(source,job.controller.signal,offset,validator);}finally{clearTimeout(timer);}},job.controller.signal);job.gate=fastStartGate(8*1024*1024,seekOffset);job.input.on('error',err=>{if(!job.stopped){job.error=err.message || 'Source stream failed';void stop(job);}});job.gate.on('error',err=>{if(!job.stopped){job.error=err.message;void stop(job);}});job.proc.stdin.on('error',()=>{});job.input.pipe(job.gate).pipe(job.proc.stdin);}else job.proc.stdin.end();
      // Encoding is deliberately independent of the viewer's playhead. Keep
      // only session authorization monitoring, not a conversion lead limit.
      job.monitor=setInterval(()=>{if(!job.stopped && !authorize(job.sid)){job.error='Session expired';void stop(job);}},2000);job.monitor.unref();
      const deadline=Date.now()+(seekOffset ? Math.max(startupMs,180000+Math.ceil(seekOffset*1000)) : startupMs);
      while(Date.now()<deadline && !job.stopped){if(job.error)throw Error(job.error);const ready=await Promise.all(['240','360'].map(d=>fsp.stat(path.join(job.dir,d,'index.m3u8')).then(s=>s.size>0,()=>false)));if(ready.every(Boolean)){job.ready=true;job.lastAccess=Date.now();return {id:job.id,url:`/transcode/${job.id}/master.m3u8`,duration:job.gate?.duration || job.relay?.duration || null,offset:seekOffset};}await interval(250);}
      throw Error(job.error || 'Transcode did not start in time');
    }catch(err){await stop(job);if(job.dir)await fsp.rm(job.dir,{recursive:true,force:true}).catch(()=>{});if(err.code==='ENOSPC'||err.code==='EDQUOT')throw Error('Temporary filesystem is full or its quota has been exceeded');throw err;}finally{requestSignal?.removeEventListener('abort',onDisconnect);}
  }
  function get(id,sid){const job=jobs.get(id);if(!job || job.sid!==sid || job.stopped)return null;job.lastAccess=Date.now();return job;}
  async function read(id,sid,part){const job=get(id,sid);if(!job)return null;
    if(part==='master.m3u8')return {type:'application/vnd.apple.mpegurl',data:Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=350000,RESOLUTION=426x240\n240/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=750000,RESOLUTION=640x360\n360/index.m3u8\n')};
    if(!/^(240|360)\/(?:index\.m3u8|index\d+\.ts)$/.test(part))return null;
    job.readers++;
    try{const file=path.join(job.dir,part),stat=await fsp.stat(file);if(!stat.isFile() || stat.size>(part.endsWith('.m3u8')?1024*1024:16*1024*1024))throw Error('Transcode output is too large');return {type:part.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t',data:await fsp.readFile(file)};}catch(e){if(e.code==='ENOENT')return null;throw e;}
    finally{if(--job.readers===0){for(const resolve of job.drainWaiters.splice(0))resolve();}}
  }
  async function stopFor(id,sid){const job=get(id,sid);if(!job)return false;await stop(job);return true;}
  async function stopRequest(requestId,sid){const job=[...jobs.values()].find(job=>job.sid===sid && job.requestId===requestId);if(!job)return false;await stop(job);return true;}
  async function stopAny(){const action=admission.then(async()=>{const current=[...jobs.values()];await Promise.all(current.map(stop));return current.length>0;});admission=action.then(()=>{},()=>{});return action;}
  async function stopSession(sid){await Promise.all([...jobs.values()].filter(job=>job.sid===sid).map(stop));for(const [id,failure] of failures)if(failure.sid===sid)failures.delete(id);}
  function status(id,sid){const job=jobs.get(id);if(job && job.sid===sid && !job.stopped){job.lastAccess=Date.now();return {active:true,error:null,paused:false};}const failure=failures.get(id);if(!failure || failure.sid!==sid)return null;if(failure.expires<Date.now()){failures.delete(id);return null;}return {active:false,error:failure.error};}
  return {start,read,stopFor,stopRequest,stopSession,stopAny,status,close:()=>stopAny()};
}
module.exports={createTranscoder,fastStartGate,movieDuration,ffmpegExitError,bundledFfmpeg,softwareFfmpeg,ffmpegCandidates,probeFfmpeg,probeSoftwareFfmpeg,chooseFfmpeg};
