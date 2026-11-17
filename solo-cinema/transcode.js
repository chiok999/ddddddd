'use strict';
// One bounded FFmpeg job. Input is already fetched through Troy's pinned proxy;
// FFmpeg receives bytes on stdin and cannot open network or file input protocols.
const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {Readable,Transform}=require('node:stream');

// Reject non-fast-start MP4s before downloading the full file. FFmpeg's pipe input cannot seek back to a trailing moov atom.
function fastStartGate(limit=8*1024*1024){
 let buffer=Buffer.alloc(0),offset=0,seenFtyp=false,ready=false;
 return new Transform({transform(chunk,encoding,callback){
  if(ready){this.push(chunk);return callback();}
  buffer=Buffer.concat([buffer,chunk]);
  try{
   while(buffer.length-offset>=8){const size32=buffer.readUInt32BE(offset),type=buffer.toString('ascii',offset+4,offset+8);let size=size32,header=8;
    if(size32===1){if(buffer.length-offset<16)break;const n=buffer.readBigUInt64BE(offset+8);if(n>BigInt(limit))throw Error('MP4 metadata exceeds the fast-start limit');size=Number(n);header=16;}
    if(size===0 || size<header)throw Error('Invalid MP4 box');
    if(!seenFtyp && type!=='ftyp')throw Error('Only fast-start MP4 sources are supported');
    if(type==='mdat')throw Error('MP4 is not fast-start; use its original stream');
    if(size>limit || offset+size>limit)throw Error('MP4 metadata exceeds the fast-start limit');
    if(buffer.length-offset<size)break;
    if(type==='ftyp')seenFtyp=true;offset+=size;
    if(type==='moov'){ready=true;this.push(buffer);buffer=null;return callback();}
   }
   if(buffer.length>limit)throw Error('MP4 metadata exceeds the fast-start limit');callback();
  }catch(e){callback(e);}
 },flush(callback){callback(ready?null:Error('MP4 metadata is incomplete'));}});
}


function createTranscoder({open, executable=process.env.CINEMA_FFMPEG || 'ffmpeg', tmpdir=os.tmpdir(), idleMs=90000, maxMs=14400000, maxBytes=128*1024*1024, startupMs=45000}={}){
  let active=null;
  // Reap abandoned private directories after a crash, without touching a live Troy process.
  async function reap(){
    for(const name of await fsp.readdir(tmpdir).catch(()=>[])){
      const match=/^troy-transcode-(\d+)-[A-Za-z0-9]+$/.exec(name);if(!match)continue;
      const dir=path.join(tmpdir,name);try{const stat=await fsp.lstat(dir);if(!stat.isDirectory() || Date.now()-stat.mtimeMs<maxMs+3600000)continue;let alive=true;try{process.kill(Number(match[1]),0);}catch(e){alive=e.code!=='ESRCH';}if(!alive)await fsp.rm(dir,{recursive:true,force:true});}catch{}
    }
  }
  reap().catch(()=>{});
  const interval=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function stop(job){
    if(!job || job.stopped)return;job.stopped=true;job.controller.abort();clearInterval(job.monitor);clearTimeout(job.deadline);
    job.input?.destroy();job.gate?.destroy();if(job.proc && job.proc.exitCode===null && !job.proc.killed)job.proc.kill('SIGKILL');
    if(job.proc && job.proc.exitCode===null)await Promise.race([new Promise(resolve=>job.proc.once('close',resolve)),interval(3000)]);
    if(job.dir)await fsp.rm(job.dir,{recursive:true,force:true}).catch(()=>{});if(active===job)active=null;
  }
  async function measure(dir){let total=0;for(const d of ['240','360'])for(const file of await fsp.readdir(path.join(dir,d))){const stat=await fsp.lstat(path.join(dir,d,file));if(!stat.isFile())throw Error('Unexpected transcoder output');total+=stat.size;}return total;}
  async function start(source,sid){
    if(active)throw Object.assign(Error('A transcode is already active; stop it first'),{status:409});
    const job={sid,id:crypto.randomBytes(24).toString('base64url'),controller:new AbortController(),lastAccess:Date.now(),stopped:false,error:null,proc:null,dir:null};active=job;
    try{
      job.dir=await fsp.mkdtemp(path.join(tmpdir,`troy-transcode-${process.pid}-`));if(job.stopped)throw Error('Transcode stopped');for(const d of ['240','360']){await fsp.mkdir(path.join(job.dir,d));if(job.stopped)throw Error('Transcode stopped');}
      const timer=setTimeout(()=>job.controller.abort(),30000);let response;
      try{response=await open(source,job.controller.signal);}finally{clearTimeout(timer);}
      if(job.stopped){await response.body?.cancel();throw Error('Transcode stopped');}
      if(!response.ok || !response.body)throw Error(`Source returned ${response.status}`);
      const type=response.headers.get('content-type')||'';if(/mpegurl|text\/html/i.test(type))throw Error('Only direct MP4 sources can be transcoded');
      const output=(w,h,bitrate,audio,dir)=>['-map','0:v:0','-map','0:a:0?','-vf',`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,'-c:v','libx264','-preset','veryfast','-threads','2','-pix_fmt','yuv420p','-b:v',bitrate,'-maxrate',bitrate,'-bufsize',bitrate,'-force_key_frames','expr:gte(t,n_forced*4)','-sc_threshold','0','-c:a','aac','-b:a',audio,'-f','hls','-hls_time','4','-hls_list_size','8','-hls_flags','delete_segments+temp_file+independent_segments','-hls_segment_filename',path.join(job.dir,dir,'index%d.ts'),path.join(job.dir,dir,'index.m3u8')];
      const args=['-hide_banner','-loglevel','error','-nostdin','-filter_threads','1','-re','-threads','2','-protocol_whitelist','pipe','-format_whitelist','mov','-f','mov','-i','pipe:0',...output(426,240,'250k','48k','240'),...output(640,360,'600k','64k','360')];
      job.proc=spawn(executable,args,{stdio:['pipe','ignore','pipe'],shell:false});job.proc.stderr.resume();
      job.proc.once('error',()=>{job.error='FFmpeg could not start; install FFmpeg with libx264 and AAC support';void stop(job);});
      job.proc.once('close',code=>{if(!job.stopped && code!==0){if(!job.error)job.error=`Transcoding failed (FFmpeg exit ${code}); this MP4 may not support streaming input`;void stop(job);}});
      job.input=Readable.fromWeb(response.body);job.gate=fastStartGate();job.input.on('error',()=>{if(!job.stopped){job.error='Source stream failed';void stop(job);}});job.gate.on('error',err=>{if(!job.stopped){job.error=err.message;void stop(job);}});job.proc.stdin.on('error',()=>{});job.input.pipe(job.gate).pipe(job.proc.stdin);
      job.monitor=setInterval(()=>{if(job.stopped)return;if(Date.now()-job.lastAccess>idleMs){stop(job);return;}measure(job.dir).then(bytes=>{if(bytes>maxBytes){job.error='Transcode exceeded temporary storage limit';stop(job);}}).catch(()=>stop(job));},2000);job.monitor.unref();
      job.deadline=setTimeout(()=>stop(job),maxMs);job.deadline.unref();
      const deadline=Date.now()+startupMs;
      while(Date.now()<deadline && !job.stopped){if(job.error)throw Error(job.error);const ready=await Promise.all(['240','360'].map(d=>fsp.stat(path.join(job.dir,d,'index.m3u8')).then(s=>s.size>0,()=>false)));if(ready.every(Boolean))return {id:job.id,url:`/transcode/${job.id}/master.m3u8`};await interval(250);}
      throw Error(job.error || 'Transcode did not start in time');
    }catch(err){await stop(job);if(job.dir)await fsp.rm(job.dir,{recursive:true,force:true}).catch(()=>{});throw err;}
  }
  function get(id,sid){if(!active || active.id!==id || active.sid!==sid || active.stopped)return null;active.lastAccess=Date.now();return active;}
  async function read(id,sid,part){const job=get(id,sid);if(!job)return null;
    if(part==='master.m3u8')return {type:'application/vnd.apple.mpegurl',data:Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=350000,RESOLUTION=426x240\n240/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=750000,RESOLUTION=640x360\n360/index.m3u8\n')};
    if(!/^(240|360)\/(?:index\.m3u8|index\d+\.ts)$/.test(part))return null;
    try{const file=path.join(job.dir,part),stat=await fsp.stat(file);if(!stat.isFile() || stat.size>(part.endsWith('.m3u8')?1024*1024:16*1024*1024))throw Error('Transcode output is too large');return {type:part.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t',data:await fsp.readFile(file)};}catch(e){if(e.code==='ENOENT')return null;throw e;}
  }
  async function stopFor(id,sid){const job=get(id,sid);if(!job)return false;await stop(job);return true;}
  async function stopSession(sid){if(active?.sid===sid)await stop(active);}
  return {start,read,stopFor,stopSession,close:()=>stop(active)};
}
module.exports={createTranscoder,fastStartGate};
