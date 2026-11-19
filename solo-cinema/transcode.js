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
const config=require('./config');

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
// HLS segment length in seconds. Keyframes are forced onto this exact grid, so
// every segment is this long whatever the source framerate is.
const HLSTIME=4;

// Seconds of finished output the player needs to keep going, and the point at
// which a paused player may start again. The gap is what stops it flapping.
const MIN_LEAD=2, RESUME_LEAD=8;

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
  if(config.ffmpegPath())return [{label:'Configured FFmpeg',path:config.ffmpegPath()}];
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
  // -readrate is deliberately unused: it caps input at a multiple of realtime.
  // Pacing is done by pausing the process, which needs no encoder cooperation.
  if(!/^\s*-readrate_initial_burst\s/m.test(options))throw Error('FFmpeg lacks -readrate_initial_burst');
  // The listing prints `-force_key_frames[:<stream_spec>]`, so the name is not
  // followed directly by whitespace.
  if(!/^\s*-force_key_frames\b/m.test(options))throw Error('FFmpeg lacks -force_key_frames');
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
  if(config.encoder()==='rkmpp' && ffmpegEncoders.get(executable)==='h264_rkmpp') return 'h264_rkmpp';
  return 'libx264';
}

function createTranscoder({open, executable, tmpdir=os.tmpdir(), idleMs=config.idleMs(), startupMs=config.startupMs(), authorize=()=>true}={}){
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
    job.stopped=true;if(job.error){failures.set(job.id,{sid:job.sid,error:job.error,expires:Date.now()+300000});while(failures.size>100)failures.delete(failures.keys().next().value);}job.controller.abort();clearInterval(job.monitor);clearInterval(job.throttler);if(job.paused && job.proc?.pid){try{process.kill(job.proc.pid,'SIGCONT');}catch{}}
    job.stopPromise=(async()=>{
      job.input?.destroy();job.gate?.destroy();if(job.proc && job.proc.exitCode===null && !job.proc.killed){if(job.paused)job.proc.kill('SIGCONT');job.proc.kill('SIGKILL');}
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
      const next={sid,requestId,id:crypto.randomBytes(24).toString('base64url'),controller:new AbortController(),lastAccess:Date.now(),stopped:false,error:null,proc:null,dir:null,ready:false,readers:0,drainWaiters:[],offset:0,position:null,rungs:null};active=next;return next;
    });
    admission=claim.then(()=>{},()=>{});const job=await claim;
    job.offset=seekOffset;
    const startedAt=Date.now();
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
        // 427/429 are rate limits, not refusals: the request was valid and
        // arrived too soon. The relay worker already waits these out, so one
        // arriving here means even the wait was not enough.
        const detail=response.status===426
          ? 'Source returned 426 (the host refused this connection; this is a network path problem, not a bad file)'
          : response.status===427
            ? 'Source returned 427 (the CDN is rate-limiting this connection; it is worth retrying in a minute)'
            : response.status===429
              ? 'Source returned 429 (the CDN is rate-limiting this connection; it is worth retrying in a minute)'
              : `Source returned ${response.status}`;
        throw Error(detail);
      }
      const type=response.headers.get('content-type')||'', encoding=response.headers.get('content-encoding')||'identity';
      if(/mpegurl|text\/html/i.test(type) || encoding.toLowerCase()!=='identity'){await response.body.cancel().catch(()=>{});throw Error('Only uncompressed direct MP4 sources can be transcoded');}
      const encoder=videoEncoder(binary);
      // At 426x240 and 640x360 `veryfast` spends CPU on detail the output cannot
      // show. Measured on a 1080p source, one 240p rung: veryfast 11.5s of CPU,
      // ultrafast+zerolatency+baseline 5.0s, for 1% larger segments. baseline also
      // removes CABAC, which is what makes the decode cheap on old phones.
      // h264_rkmpp takes neither -preset nor -threads, and scaling stays on the
      // plain software filter so it works on any build.
      const videoOptions=encoder==='h264_rkmpp'
        ? ['-c:v','h264_rkmpp','-rc_mode','CBR']
        : ['-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-profile:v','baseline','-level','3.0','-threads','1','-sc_threshold','0'];
      // Two rungs, and FFmpeg must never write a segment before it is complete:
      // a half-written playlist is what makes a player re-request and jump back.
      const output=(w,h,bitrate,audio,dir)=>['-map','0:v:0','-map','0:a:0?','-vf',`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`,...videoOptions,'-pix_fmt','yuv420p','-b:v',bitrate,'-maxrate',`${Math.round(parseInt(bitrate)*1.3)}k`,'-bufsize',`${parseInt(bitrate)*3}k`,'-force_key_frames',`expr:gte(t,n_forced*${HLSTIME})`,'-c:a','aac','-b:a',audio,'-ac','2','-ar','48000','-f','hls','-hls_time',String(HLSTIME),'-hls_list_size','0','-hls_playlist_type','event','-hls_flags','temp_file+independent_segments','-hls_segment_filename',`${dir}/index%d.ts`,`${dir}/index.m3u8`];
      const headroom=config.leadSeconds();
      // No -readrate: it caps the input at a multiple of realtime, so a value
      // below 1 makes it arithmetically impossible for the encoder to stay ahead
      // and the buffer drains 15% per second. Read as fast as the encoder can and
      // bound the *lead* instead, by pausing the process (see `throttle`).
      // -readrate_initial_burst stays: it lets a seek refill the gap immediately.
      const lead=(seekOffset||0)+headroom;
      const pacing=['-readrate_initial_burst',String(Math.ceil(lead)),...(seekOffset>0?['-ss',String(seekOffset)]:[])];
      // Two rungs cost two encodes. On a small box the 240p one is enough to
      // start, and both are only worth encoding while the CPU has room.
      const rungs=config.ladder();
      const outputs=[];
      for(const rung of rungs) outputs.push(...output(rung==='240'?426:640,rung==='240'?240:360,rung==='240'?'250k':'600k',rung==='240'?'48k':'64k',rung));
      const args=['-hide_banner','-loglevel','error','-nostdin','-filter_threads','1',...pacing,'-threads','2','-protocol_whitelist','pipe','-format_whitelist','mov','-f','mov','-i','pipe:0',...outputs];
      job.proc=spawn(binary,args,{cwd:job.dir,stdio:['pipe','ignore','pipe'],shell:false});let stderr='',diskFull=false;job.proc.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-8192);if(/no space left on device|disk quota exceeded/i.test(stderr))diskFull=true;});
      job.proc.once('error',err=>{if(['ENOENT','EACCES','EPERM','ENOEXEC'].includes(err.code))binaryPromise=null;job.error=executableError(err);void stop(job);});
      job.proc.once('close',code=>{if(!job.stopped && code!==0){if(!job.error)job.error=ffmpegExitError(code,diskFull?'no space left on device':stderr);void stop(job);}});
      job.input=resumableInput(response,async(offset,validator)=>{const timer=setTimeout(()=>job.controller.abort(),30000);try{return await open(source,job.controller.signal,offset,validator);}finally{clearTimeout(timer);}},job.controller.signal);job.gate=fastStartGate(8*1024*1024,seekOffset);job.input.on('error',err=>{if(!job.stopped){job.error=err.message || 'Source stream failed';void stop(job);}});job.gate.on('error',err=>{if(!job.stopped){job.error=err.message;void stop(job);}});job.proc.stdin.on('error',()=>{});job.input.pipe(job.gate).pipe(job.proc.stdin);
      job.monitor=setInterval(()=>{if(!job.stopped && job.ready && job.proc?.exitCode!==null && Date.now()-job.lastAccess>idleMs){job.error='Conversion expired after inactivity';void stop(job);}},2000);job.monitor.unref();
      // Throttle by signal. `ahead` is recomputed here rather than trusted from
      // the client's report, so a stalled player cannot park the encoder and a
      // fast one cannot run it into the disk.
      // The floor is deliberately low: a large cap on a slow box would let a
      // job fill the disk before the viewer ever reaches it. 30s is still eight
      // segments of runway, well above the 2x-segment minimum for a pause to be
      // worth taking.
      const cap=Math.max(30,Math.min(900,config.leadCapSeconds()));
      // The throttle needs the *lead* -- finished output ahead of the viewer --
      // not the total encoded. Comparing total encoded to the cap would latch
      // stopped forever once the encode passed it, which is exactly the
      // "resumed playback never uncovers" failure. Counting .ts files is exact
      // now that every segment is HLSTIME long, and avoids re-parsing a playlist
      // every second.
      job.measure=async()=>{
        try{
          const names=await fsp.readdir(path.join(job.dir,rungDirs[0]));
          let done=0;
          for(const n of names) if(/^index\d+\.ts$/.test(n)) done++;
          const encoded=done*HLSTIME;
          const played=job.position ? Math.max(0,Number(job.position.seconds)||0) : 0;
          return Math.max(0,encoded-played);
        }catch{return null;}
      };
      const throttler=setInterval(()=>{
        const proc=job.proc;
        if(job.stopped || !proc || proc.exitCode!==null || !job.ready) return;
        const now=Date.now();
        if(proc.pid===undefined) return;
        // A stop must never fire into a job that has already been killed, and a
        // resumed viewer must never be left parked: SIGCONT after 30s of silence.
        if(job.paused && now-job.pausedAt>30000){try{process.kill(proc.pid,'SIGCONT');}catch{}job.paused=false;job.pausedAt=0;return;}
        job.measure?.().then(seconds=>{
          if(job.stopped || seconds===null) return;
          if(!job.paused && seconds>cap){try{process.kill(proc.pid,'SIGSTOP');job.paused=true;job.pausedAt=Date.now();}catch{}}
          else if(job.paused && seconds<cap/2){try{process.kill(proc.pid,'SIGCONT');job.paused=false;job.pausedAt=0;}catch{}}
        }).catch(()=>{});
      },1000);throttler.unref();job.throttler=throttler;
      // Ready means "there is something complete to play", not "a playlist
      // exists". Starting on a playlist with no finished segment is what makes a
      // player show an error and restart -- and restarting is the "seek back to
      // where I was" the viewer sees. Two finished segments is the minimum a
      // player can start on without immediately stalling.
      const rungDirs=rungs;
      async function finishedSegments(dir){
        try{
          const list=await fsp.readFile(path.join(job.dir,dir,'index.m3u8'),'utf8');
          // The muxer writes the path it was given, so a line may be absolute.
          const segments=(list.match(/^.*?index\d+\.ts\s*$/gm)||[]).length;
          // A finished rung is ready with one segment. Requiring two would
          // deadlock on any input shorter than two HLS segments, and an
          // ENDLIST already says the whole timeline is on disk.
          return list.includes('#EXT-X-ENDLIST') ? Math.max(segments,2) : segments;
        }catch{return 0;}
      }
      const deadline=Date.now()+(seekOffset ? Math.max(startupMs,180000+Math.ceil(seekOffset*1000)) : startupMs);
      while(Date.now()<deadline && !job.stopped){
        if(job.error)throw Error(job.error);
        const counts=await Promise.all(rungDirs.map(finishedSegments));
        if(counts.every(n=>n>=1)){job.ready=true;job.lastAccess=Date.now();job.rungs=rungDirs;job.firstSegmentMs=Date.now()-startedAt;return {id:job.id,url:`/transcode/${job.id}/master.m3u8`,duration:job.gate.duration || null,offset:seekOffset,rungs:rungDirs};}
        await interval(200);
      }
      throw Error(job.error || 'Transcode did not start in time');
    }catch(err){await stop(job);if(job.dir)await fsp.rm(job.dir,{recursive:true,force:true}).catch(()=>{});if(err.code==='ENOSPC'||err.code==='EDQUOT')throw Error('Temporary filesystem is full or its quota has been exceeded');throw err;}finally{requestSignal?.removeEventListener('abort',onDisconnect);}
  }
  function get(id,sid){if(!active || active.id!==id || active.sid!==sid || active.stopped)return null;active.lastAccess=Date.now();return active;}
  // How far playback has got, per job, in source seconds since the job's start.
  // The client owns this number; the server only remembers it, because pacing is
  // the one decision that needs both ends.
  function reportPosition(id,sid,position){
    const job=get(id,sid);if(!job)return null;
    if(typeof position==='number' && Number.isFinite(position) && position>=0 && position<86400) job.position={seconds:position,at:Date.now()};
    return job.position || null;
  }
  /**
   * The honest answer to "is the encoder ahead of the player": how many seconds
   * of finished output exist, measured from the playlist itself, against where
   * the player is. If this is negative, playback is outrunning the encoder and
   * the player should wait rather than stall, error, and restart.
   */
  async function status(id,sid){
    // A failed job is gone from `active` but its error still has to reach the
    // client, so the failure record is consulted before bailing out. This is the
    // single status function: an earlier sync copy shadowed this one by hoisting,
    // which silently dropped `ahead` and made the player's stall guard dead code.
    const job=get(id,sid);
    if(!job){
      const failure=failures.get(id);
      if(!failure || failure.sid!==sid)return null;
      if(failure.expires<Date.now()){failures.delete(id);return null;}
      return {active:false,error:failure.error,ahead:0};
    }
    const rungs=job.rungs || ['240','360'];
    const counts={};
    for(const rung of rungs){
      try{
        const list=await fsp.readFile(path.join(job.dir,rung,'index.m3u8'),'utf8');
        const segments=(list.match(/^.*?index\d+\.ts\s*$/gm)||[]).length;
        const duration=[...list.matchAll(/#EXTINF:([\d.]+)/g)].reduce((total,m)=>total+Number(m[1]),0);
        counts[rung]={segments,encoded:Number(duration.toFixed(2))};
      }catch{counts[rung]={segments:0,encoded:0};}
    }
    const encoded=Math.min(...Object.values(counts).map(rung=>rung.encoded));
    const offset=job.offset || 0;
    const played=job.position ? Math.max(0,Number(job.position.seconds)||0) : 0;
    const ahead=Number((offset+encoded-(offset+played)).toFixed(2));
    // The verdict is decided here, not inferred by the player: `canPlay` means
    // there is enough finished output to keep going, `resumeAt` gives the player
    // hysteresis so it does not toggle on the boundary.
    const canPlay=ahead>=MIN_LEAD, resumeAt=ahead>=RESUME_LEAD;
    return {active:true,error:null,encoded,ahead,canPlay,resumeAt,playing:played,position:offset+played,rungs:counts,finished:job.proc?.exitCode===0,throttled:!!job.paused,firstSegmentMs:job.firstSegmentMs ?? null};
  }
  async function read(id,sid,part){const job=get(id,sid);if(!job)return null;
    if(part==='master.m3u8'){
      const rows=job.rungs || ['240','360'];
      // avc1.42c01e is baseline level 3.0 (what the encoder is told to produce,
      // so 240p and 360p both fit it); mp4a.40.2 is AAC-LC. Without CODECS hls.js
      // has to load a fragment before it can decide the level is playable.
      const lines=['#EXTM3U','#EXT-X-VERSION:3','#EXT-X-INDEPENDENT-SEGMENTS'];
      for(const rung of rows){
        lines.push(rung==='240'
          ?'#EXT-X-STREAM-INF:BANDWIDTH=350000,RESOLUTION=426x240,CODECS="avc1.42c01e,mp4a.40.2"'
          :'#EXT-X-STREAM-INF:BANDWIDTH=750000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"');
        lines.push(`${rung}/index.m3u8`);
      }
      return {type:'application/vnd.apple.mpegurl',data:Buffer.from(`${lines.join('\n')}\n`)};
    }
    if(!/^(240|360)\/(?:index\.m3u8|index\d+\.ts)$/.test(part))return null;
    job.readers++;
    try{
      const file=path.join(job.dir,part),stat=await fsp.stat(file);
      if(!stat.isFile() || stat.size>(part.endsWith('.m3u8')?1024*1024:16*1024*1024))throw Error('Transcode output is too large');
      const type=part.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t';
      // Playlists are small and are rewritten under us, so they stay in memory.
      // Segments are immutable once written and can be large, so the caller
      // streams them instead of holding a second copy of every one.
      if(type==='application/vnd.apple.mpegurl')return {type,data:await fsp.readFile(file)};
      return {type,file,size:stat.size};
    }catch(e){if(e.code==='ENOENT')return null;throw e;}
    finally{if(--job.readers===0){for(const resolve of job.drainWaiters.splice(0))resolve();}}
  }
  async function stopFor(id,sid){const job=get(id,sid);if(!job)return false;await stop(job);return true;}
  async function stopRequest(requestId,sid){if(!active || active.sid!==sid || active.requestId!==requestId)return false;await stop(active);return true;}
  async function stopAny(){const action=admission.then(async()=>{if(!active)return false;await stop(active);return true;});admission=action.then(()=>{},()=>{});return action;}
  async function stopSession(sid){if(active?.sid===sid)await stop(active);for(const [id,failure] of failures)if(failure.sid===sid)failures.delete(id);}
  return {start,read,stopFor,stopRequest,stopSession,stopAny,status,reportPosition,close:()=>stop(active)};
}
module.exports={createTranscoder,fastStartGate,movieDuration,ffmpegExitError,bundledFfmpeg,ffmpegCandidates,probeFfmpeg,chooseFfmpeg,staticFfmpegExpectedPath,hardwareAvailable,probeCapabilities,videoEncoder};
