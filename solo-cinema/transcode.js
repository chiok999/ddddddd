'use strict';
// One session-bound FFmpeg job. Input is already fetched through Troy's pinned proxy;
// FFmpeg receives bytes on stdin and cannot open network or file input protocols.
const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const {Transform}=require('node:stream');
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
   const seconds=duration/scale;return scale && Number.isFinite(seconds) && seconds>0 && seconds<=86400?seconds:null;
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
// A statically linked FFmpeg needs no root and no package manager, which is
// often the only option inside a panel container. Two sources, both the same
// prebuilt release: the ffmpeg-static npm package (persists across restarts
// because the panel runs npm install), or a direct download.
const staticFfmpeg = require('./static-ffmpeg');
function staticFfmpegExpectedPath(){return path.join(__dirname,'.troy-ffmpeg','ffmpeg');}
function ffmpegCandidates(){
  if(process.env.CINEMA_FFMPEG)return [{label:'Configured FFmpeg',path:process.env.CINEMA_FFMPEG}];
  // The bundled build links Rockchip MPP, which logs initializer errors on hosts
  // without that SoC. It is still worth trying, but a real system FFmpeg and an
  // explicitly downloaded static build are more portable, so try those first
  // when the operator has asked for the static one.
  const bundled=bundledFfmpeg(),system={label:'System FFmpeg',path:'ffmpeg'};
  const list=[];
  // Already-downloaded or npm-provided binaries need no privilege and are the
  // most predictable option, so they come first when they exist.
  const downloaded=staticFfmpegExpectedPath();
  if(fs.existsSync(downloaded))list.push({label:'Downloaded FFmpeg',path:downloaded});
  const installed=staticFfmpeg.fromNpmPackage();
  if(installed && installed!==downloaded)list.push({label:'ffmpeg-static package',path:installed});
  list.push(system);
  if(bundled)list.push({label:'Bundled FFmpeg',path:bundled});
  return list;
}
function executableError(error){
  if(error?.code==='ENOENT')return 'FFmpeg executable or its system loader was not found';
  if(error?.code==='EACCES' || error?.code==='EPERM')return 'FFmpeg execution was denied (permissions or noexec filesystem)';
  if(error?.code==='ENOEXEC')return 'FFmpeg binary is incompatible with this system';
  return `FFmpeg could not start${error?.code ? ` (${String(error.code).slice(0,30)})` : ''}`;
}
function ffmpegExitError(code,stderr=''){
  if(/no space left on device|disk quota exceeded/i.test(stderr))return 'Temporary filesystem is full or its quota has been exceeded';
  return `Transcoding failed (FFmpeg exit ${code}); this MP4 may not support streaming input`;
}
const ffmpegEncoders=new Map();
function probeCommand(executable,args){return new Promise((resolve,reject)=>{
  execFile(executable,args,{timeout:10000,maxBuffer:2*1024*1024,windowsHide:true},(err,stdout,stderr)=>{
    if(err){if(err.killed)return reject(Error('FFmpeg capability check timed out'));if(typeof err.code==='string')return reject(Error(executableError(err)));return reject(Error(`FFmpeg capability check failed (exit ${err.code})`));}
    resolve(stdout+'\n'+stderr);
  });
});}
// Hardware encoding is optional. libx264 always works and is the default; a
// Rockchip build is used only when the operator asks for it, because it also
// needs /dev/mpp_service passed into the container.
function hardwareAvailable(encoders){
  return /^\s*[A-Z.]{6}\s+h264_rkmpp\s/m.test(encoders);
}
function probeCapabilities(encoders){
  if(/^\s*[A-Z.]{6}\s+libx264\s/m.test(encoders)) return 'libx264';
  if(hardwareAvailable(encoders)) return 'h264_rkmpp';
  return null;
}
async function probeFfmpeg(executable){
  await probeCommand(executable,['-version']);
  const encoders=await probeCommand(executable,['-hide_banner','-encoders']);
  const encoder=probeCapabilities(encoders);
  if(!encoder) throw Error('FFmpeg has neither the libx264 nor the h264_rkmpp encoder');
  if(!/^\s*[A-Z.]{6}\s+aac\s/m.test(encoders)) throw Error('FFmpeg is missing the AAC encoder');
  ffmpegEncoders.set(executable,encoder);
  const muxers=await probeCommand(executable,['-hide_banner','-muxers']);
  if(!/^\s*E\s+hls\s/m.test(muxers))throw Error('FFmpeg is missing the HLS muxer');
  const filters=await probeCommand(executable,['-hide_banner','-filters']);
  if(!/^\s*[A-Z.]{2,3}\s+scale\s/m.test(filters) || !/^\s*[A-Z.]{2,3}\s+pad\s/m.test(filters))throw Error('FFmpeg is missing the scale or pad filter');
  const options=await probeCommand(executable,['-hide_banner','-h','full']);
  if(!/^\s*-readrate\s/m.test(options) || !/^\s*-readrate_initial_burst\s/m.test(options))throw Error('FFmpeg lacks the required readrate options');
  const hls=await probeCommand(executable,['-hide_banner','-h','muxer=hls']);
  if(!/\btemp_file\b/.test(hls))throw Error('FFmpeg HLS muxer lacks temp_file support');
}

async function chooseFfmpeg(candidates){
  const failures=[];
  for(const candidate of candidates){
    try{await probeFfmpeg(candidate.path);return candidate.path;}
    catch(err){failures.push(`${candidate.label}: ${err.message}`);}
  }
  throw Error(failures.join('; '));
}
function videoEncoder(executable){
  // Software unless the operator explicitly opted into hardware encoding.
  if(process.env.CINEMA_ENCODER==='rkmpp' && ffmpegEncoders.get(executable)==='h264_rkmpp') return 'h264_rkmpp';
  return 'libx264';
}

function createTranscoder({open, executable, tmpdir=os.tmpdir(), idleMs=600000, startupMs=45000, authorize=()=>true}={}){
  let active=null;const failures=new Map();let admission=Promise.resolve(),binaryPromise=null;
  function getBinary(){if(!binaryPromise)binaryPromise=chooseFfmpeg(executable?[{label:'FFmpeg',path:executable}]:ffmpegCandidates()).catch(err=>{binaryPromise=null;throw err;});return binaryPromise;}
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
      job.input?.destroy();job.gate?.destroy();if(job.proc && job.proc.exitCode===null && !job.proc.killed)job.proc.kill('SIGKILL');
      if(job.proc && job.proc.exitCode===null)await Promise.race([new Promise(resolve=>job.proc.once('close',resolve)),interval(3000)]);
      if(job.readers)await new Promise(resolve=>job.drainWaiters.push(resolve));
      if(job.dir)await fsp.rm(job.dir,{recursive:true,force:true}).catch(()=>{});if(active===job)active=null;
    })();return job.stopPromise;
  }

  async function start(source,sid,seekOffset=0,requestId=null,requestSignal=null){
    if(typeof seekOffset!=='number' || !Number.isFinite(seekOffset) || seekOffset<0 || seekOffset>86400)throw Object.assign(Error('Invalid seek position'),{status:400});
    // Serialize admission so a reload or retry can replace its own abandoned job
    // without stopping another authenticated session or creating overlapping jobs.
    const claim=admission.then(async()=>{
      if(requestSignal?.aborted)throw Error('Transcode request disconnected');
      if(!authorize(sid))throw Object.assign(Error('Session expired'),{status:401});
      if(active && active.sid!==sid)throw Object.assign(Error('Another session is watching; stop it first'),{status:409});
      if(active)await stop(active);
      if(!authorize(sid))throw Object.assign(Error('Session expired'),{status:401});
      const next={sid,requestId,id:crypto.randomBytes(24).toString('base64url'),controller:new AbortController(),lastAccess:Date.now(),stopped:false,error:null,proc:null,dir:null,ready:false,readers:0,drainWaiters:[]};active=next;return next;
    });
    admission=claim.then(()=>{},()=>{});const job=await claim;
    const onDisconnect=()=>{void stop(job);};requestSignal?.addEventListener('abort',onDisconnect,{once:true});if(requestSignal?.aborted)onDisconnect();
    try{
      if(job.stopped)throw Error('Transcode stopped');
      const binary=await getBinary();if(job.stopped)throw Error('Transcode stopped');
      job.dir=await fsp.mkdtemp(path.join(tmpdir,`troy-transcode-${process.pid}-`));if(job.stopped)throw Error('Transcode stopped');for(const d of ['240','360']){await fsp.mkdir(path.join(job.dir,d));if(job.stopped)throw Error('Transcode stopped');}
      // A CDN edge can refuse the first connection of a burst with 426 and
      // accept the next one -- the same thing a browser retry does silently.
      // Only retried at offset 0: beyond it, a short replay would leave a hole
      // in the file and FFmpeg would transcode damaged output.
      let response=null, attempt=0;
      for(;attempt<3;attempt++){
        const timer=setTimeout(()=>job.controller.abort(),30000);
        try{response=await open(source,job.controller.signal);}finally{clearTimeout(timer);}
        if(job.stopped){await response.body?.cancel();throw Error('Transcode stopped');}
        if(response.status!==426 || seekOffset>0 || attempt===2) break;
        await response.body?.cancel().catch(()=>{});
        await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
      }
      if(job.stopped){await response.body?.cancel();throw Error('Transcode stopped');}
      if(response.status!==200 || !response.body){
        await response.body?.cancel().catch(()=>{});
        const detail=response.status===426
          ? 'Source returned 426 (the host refused this connection; this is a network path problem, not a bad file)'
          : `Source returned ${response.status}`;
        throw Error(detail);
      }
      const type=response.headers.get('content-type')||'', encoding=response.headers.get('content-encoding')||'identity';
      if(/mpegurl|text\/html/i.test(type) || encoding.toLowerCase()!=='identity'){await response.body.cancel().catch(()=>{});throw Error('Only uncompressed direct MP4 sources can be transcoded');}
      const encoder=videoEncoder(binary);
      // h264_rkmpp takes neither -preset nor -threads, and scaling stays on the
      // plain software filter so it works on any build.
      const videoOptions=encoder==='h264_rkmpp'
        ? ['-c:v','h264_rkmpp','-rc_mode','CBR']
        : ['-c:v','libx264','-preset','veryfast','-threads','1'];
      const output=(w,h,bitrate,audio,dir)=>['-map','0:v:0','-map','0:a:0?','-vf',`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`,...videoOptions,'-pix_fmt','yuv420p','-b:v',bitrate,'-maxrate',`${Math.round(parseInt(bitrate)*1.3)}k`,'-bufsize',`${parseInt(bitrate)*3}k`,'-force_key_frames','expr:gte(t,n_forced*4)','-sc_threshold','0','-c:a','aac','-b:a',audio,'-ac','2','-ar','48000','-f','hls','-hls_time','4','-hls_list_size','0','-hls_playlist_type','event','-hls_flags','temp_file+independent_segments','-hls_segment_filename',path.join(job.dir,dir,'index%d.ts'),path.join(job.dir,dir,'index.m3u8')];
      const pacing=seekOffset>0?['-readrate','3','-readrate_initial_burst',String(Math.ceil(seekOffset+12)),'-ss',String(seekOffset)]:['-readrate','3'];
      const args=['-hide_banner','-loglevel','error','-nostdin','-filter_threads','1',...pacing,'-threads','2','-protocol_whitelist','pipe','-format_whitelist','mov','-f','mov','-i','pipe:0',...output(426,240,'250k','48k','240'),...output(640,360,'600k','64k','360')];
      job.proc=spawn(binary,args,{stdio:['pipe','ignore','pipe'],shell:false});let stderr='',diskFull=false;job.proc.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-8192);if(/no space left on device|disk quota exceeded/i.test(stderr))diskFull=true;});
      job.proc.once('error',err=>{if(['ENOENT','EACCES','EPERM','ENOEXEC'].includes(err.code))binaryPromise=null;job.error=executableError(err);void stop(job);});
      job.proc.once('close',code=>{if(!job.stopped && code!==0){if(!job.error)job.error=ffmpegExitError(code,diskFull?'no space left on device':stderr);void stop(job);}});
      job.input=resumableInput(response,async(offset,validator)=>{const timer=setTimeout(()=>job.controller.abort(),30000);try{return await open(source,job.controller.signal,offset,validator);}finally{clearTimeout(timer);}},job.controller.signal);job.gate=fastStartGate(8*1024*1024,seekOffset);job.input.on('error',err=>{if(!job.stopped){job.error=err.message || 'Source stream failed';void stop(job);}});job.gate.on('error',err=>{if(!job.stopped){job.error=err.message;void stop(job);}});job.proc.stdin.on('error',()=>{});job.input.pipe(job.gate).pipe(job.proc.stdin);
      job.monitor=setInterval(()=>{if(!job.stopped && job.ready && job.proc?.exitCode!==null && Date.now()-job.lastAccess>idleMs){job.error='Conversion expired after inactivity';void stop(job);}},2000);job.monitor.unref();
      const deadline=Date.now()+(seekOffset ? Math.max(startupMs,180000+Math.ceil(seekOffset*1000)) : startupMs);
      while(Date.now()<deadline && !job.stopped){if(job.error)throw Error(job.error);const ready=await Promise.all(['240','360'].map(d=>fsp.stat(path.join(job.dir,d,'index.m3u8')).then(s=>s.size>0,()=>false)));if(ready.every(Boolean)){job.ready=true;job.lastAccess=Date.now();return {id:job.id,url:`/transcode/${job.id}/master.m3u8`,duration:job.gate.duration || null,offset:seekOffset};}await interval(250);}
      throw Error(job.error || 'Transcode did not start in time');
    }catch(err){await stop(job);if(job.dir)await fsp.rm(job.dir,{recursive:true,force:true}).catch(()=>{});if(err.code==='ENOSPC'||err.code==='EDQUOT')throw Error('Temporary filesystem is full or its quota has been exceeded');throw err;}finally{requestSignal?.removeEventListener('abort',onDisconnect);}
  }
  function get(id,sid){if(!active || active.id!==id || active.sid!==sid || active.stopped)return null;active.lastAccess=Date.now();return active;}
  async function read(id,sid,part){const job=get(id,sid);if(!job)return null;
    if(part==='master.m3u8')return {type:'application/vnd.apple.mpegurl',data:Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=350000,RESOLUTION=426x240\n240/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=750000,RESOLUTION=640x360\n360/index.m3u8\n')};
    if(!/^(240|360)\/(?:index\.m3u8|index\d+\.ts)$/.test(part))return null;
    job.readers++;
    try{const file=path.join(job.dir,part),stat=await fsp.stat(file);if(!stat.isFile() || stat.size>(part.endsWith('.m3u8')?1024*1024:16*1024*1024))throw Error('Transcode output is too large');return {type:part.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t',data:await fsp.readFile(file)};}catch(e){if(e.code==='ENOENT')return null;throw e;}
    finally{if(--job.readers===0){for(const resolve of job.drainWaiters.splice(0))resolve();}}
  }
  async function stopFor(id,sid){const job=get(id,sid);if(!job)return false;await stop(job);return true;}
  async function stopRequest(requestId,sid){if(!active || active.sid!==sid || active.requestId!==requestId)return false;await stop(active);return true;}
  async function stopAny(){const action=admission.then(async()=>{if(!active)return false;await stop(active);return true;});admission=action.then(()=>{},()=>{});return action;}
  async function stopSession(sid){if(active?.sid===sid)await stop(active);for(const [id,failure] of failures)if(failure.sid===sid)failures.delete(id);}
  function status(id,sid){if(active && active.id===id && active.sid===sid && !active.stopped){active.lastAccess=Date.now();return {active:true,error:null};}const failure=failures.get(id);if(!failure || failure.sid!==sid)return null;if(failure.expires<Date.now()){failures.delete(id);return null;}return {active:false,error:failure.error};}
  return {start,read,stopFor,stopRequest,stopSession,stopAny,status,close:()=>stop(active)};
}
module.exports={createTranscoder,fastStartGate,movieDuration,ffmpegExitError,bundledFfmpeg,ffmpegCandidates,probeFfmpeg,chooseFfmpeg,staticFfmpegExpectedPath,hardwareAvailable,probeCapabilities,videoEncoder};
