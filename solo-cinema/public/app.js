'use strict';
const $ = id => document.getElementById(id);
let hls = null, current = null, lastSave = 0, selected = null, externalTrack = null, pendingFailure = null, searchSequence = 0, episodes = [], uploadTrack = null, uploadUrl = null, subtitleTouched = false;
const load = key => { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } };
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
async function api(url, options = {}) {
  const response = await fetch(url, options); let result;
  try{result=await response.json();}catch{throw new Error(`Request failed (HTTP ${response.status || 'unknown'})`);}
  if (!response.ok) throw new Error(result.error || `Request failed (HTTP ${response.status || 'unknown'})`); return result;
}
const post = (url, data) => api(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(data) });
let route='home', resolveSequence=0, watchReturn='search', discoveryEpoch=0;
let catalogSections=[], searchResults=[], searchFilter='all', exploreType='all', exploreSection='all', exploreYear='all', searchTimer;
let transcodeJob=null, transcodeSequence=0, transcodeQueue=Promise.resolve(), lastTranscodeError='', pendingRequestId=null, attemptErrors=[];
function enqueueTranscode(fn){const task=transcodeQueue.then(fn,fn);transcodeQueue=task.catch(()=>{});return task;}
async function conversionFailed(item,fail){
  const sequence=transcodeSequence;let message='Converted playback failed.';try{const result=await post('/api/transcode/status',{id:item.transcodeId});if(result.error)message=result.error;}catch{}
  if(current!==item || route!=='watch' || sequence!==transcodeSequence)return;
  lastTranscodeError=message;
  if(!item.playbackRetried){
    const position=(item.seekBase || 0)+($('video').currentTime || 0);
    $('playError').textContent='Playback interrupted; retrying this source…';
    void playItem({...item,format:'file',seekAt:position,playbackRetried:true,keepUpload:!!uploadTrack,wasPaused:$('video').paused},fail,true,item.isActive);
  } else fail();
}
function stopTranscode(){++transcodeSequence;const pending=pendingRequestId;pendingRequestId=null;if(pending)post('/api/transcode/cancel',{requestId:pending}).catch(()=>{});const id=transcodeJob;transcodeJob=null;if(id)enqueueTranscode(()=>post('/api/transcode/stop',{id})).catch(()=>{});}

let dataSaver = (()=>{try{const v=localStorage.getItem('solo-data-saver'); return v===null ? !!navigator.connection?.saveData : v==='true';}catch{return !!navigator.connection?.saveData;}})();
let preferredHeight = (()=>{try{return Number(localStorage.getItem('solo-quality-height'))===360?360:240;}catch{return 240;}})();
let activeLevels=[];
function loadPolicy(retries,firstByte,maxLoad){const retry=()=>({maxNumRetry:retries,retryDelayMs:1000,maxRetryDelayMs:8000,backoff:'exponential'});return {default:{maxTimeToFirstByteMs:firstByte,maxLoadTimeMs:maxLoad,timeoutRetry:retry(),errorRetry:retry()}};}
function posterUrl(input){
  try {const u=new URL(input); if(u.protocol!=='https:' || u.username || u.password || u.port || !['images.metahub.space','live.metahub.space','pbcdn.aoneroom.com','pbcdnw.aoneroom.com'].includes(u.hostname)) return null;
    const p=new URL('https://wsrv.nl/'); p.searchParams.set('url',u.href); p.searchParams.set('w',dataSaver?'140':'240'); p.searchParams.set('q',dataSaver?'45':'60'); p.searchParams.set('output','webp'); return p.href;
  }catch{return null;}
}
function updatePoster(img){const url=posterUrl(img.dataset.poster);if(url && img.getAttribute('src')!==url) img.src=url;}
function addPoster(art,url){if(!posterUrl(url)) return;const img=document.createElement('img'); img.dataset.poster=url;img.loading='lazy';img.decoding='async';img.width=125;img.height=187;img.alt='';img.referrerPolicy='no-referrer';img.onerror=()=>img.remove();art.append(img);}
function refreshCards(){
 document.querySelectorAll('#catalogRows .catalog-section').forEach(row=>{let shown=0, hidden=0;const expanded=row.dataset.expanded==='true';
  row.querySelectorAll('.catalog-card').forEach(card=>{const eligible=!card.classList.contains('hidden');const limited=eligible && dataSaver && !expanded && shown>=6;card.classList.toggle('saver-hidden',limited);if(eligible&&!limited){shown++;card.querySelectorAll('img[data-poster]').forEach(updatePoster);}else if(limited)hidden++;});
  const more=row.querySelector('.more-cards');if(more){more.hidden=!hidden;more.textContent=`More (${hidden})`;}
 });
 document.querySelectorAll('#results img[data-poster]').forEach(updatePoster);
}
function capAdaptive(){if(!hls || !activeLevels.length)return;let cap=-1;if(dataSaver){cap=activeLevels.findIndex(l=>!l.height || l.height>360);cap=cap<0?activeLevels.length-1:Math.max(0,cap-1);}hls.autoLevelCapping=cap;}
function updateSaver(){ $('dataSaver').textContent=`Data saver: ${dataSaver?'on':'off'}`; $('dataSaver').setAttribute('aria-pressed',String(dataSaver));capAdaptive();refreshCards(); }
updateSaver();
$('dataSaver').onclick=()=>{dataSaver=!dataSaver;try{localStorage.setItem('solo-data-saver',String(dataSaver));}catch{} updateSaver();};

function directControls(show){for(const id of ['directTransport','directPlayerbar','directHint']) $(id).classList.toggle('hidden',!show);}
function showRoute(name, updateHash=true) {
  if(!['home','movies','shows','anime','categories','search','watch','list'].includes(name)) name='home';
  const previous=route; route=name;
  const view=['movies','shows','anime'].includes(name)?'home':name;
  for(const id of ['home','search','categories','watch','list']) $('view-'+id).classList.toggle('hidden',id!==view);
  document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===name));
  document.querySelectorAll('#catalogRows .catalog-section').forEach(el=>{
    const filtered=['movies','shows','anime'].includes(name);
    el.querySelectorAll('.catalog-card').forEach(card=>{card.classList.toggle('hidden',filtered && (name==='anime' ? card.dataset.anime!=='true' : card.dataset.type!==(name==='movies'?'movie':'series')));});
    el.classList.toggle('hidden',filtered && !el.querySelector('.catalog-card:not(.hidden)') && (el.querySelector('.catalog-card') || !(el.dataset.groups||'').split(',').includes(name)));
  });
  refreshCards();if(view==='home'){renderContinue();updateHero();}if(view==='categories')renderExplore();if(view==='search')renderSearchPanels();
  if(previous==='watch' && view!=='watch') {$('screen').classList.remove('player-expanded');$('playerEpisodeDrawer').classList.add('hidden');stopTranscode(); ++resolveSequence; fallback.cancel(); directControls(true); $('findStreams').disabled=false; $('video').pause();}
  if(updateHash && location.hash!=='#'+name) location.hash=name;
  if(typeof window.scrollTo==='function') window.scrollTo(0,0);
}
window.addEventListener('hashchange',()=>showRoute(location.hash.slice(1),false));
$('backToSearch').onclick=()=>showRoute(watchReturn);
function loggedIn(on) { $('login').classList.toggle('hidden', on); $('app').classList.toggle('hidden', !on); $('logout').classList.toggle('hidden', !on); $('dataSaver').classList.toggle('hidden', !on); $('mainNav').classList.toggle('hidden', !on); $('bottomNav').classList.toggle('hidden', !on); $('headerSearch').classList.toggle('hidden', !on); if (on) { render(); showRoute(location.hash.slice(1)||'home',false); loadDiscovery(); } }
$('loginForm').onsubmit = async e => { e.preventDefault(); $('loginError').textContent = ''; try { await post('/api/login', {password:$('password').value}); $('password').value=''; loggedIn(true); } catch (err) { $('loginError').textContent=err.message; } };
$('logout').onclick = async () => { try { await post('/api/logout', {}); } catch(err) { $('playError').textContent='Sign out failed: '+err.message; return; } stopTranscode(); ++searchSequence; ++resolveSequence; ++discoveryEpoch; discoveryLoaded=false; catalogSections=[];searchResults=[];clearTimeout(searchTimer); selected=null; episodes=[]; fallback.cancel(); directControls(true); current=null; pendingFailure=null; if(uploadUrl){ URL.revokeObjectURL(uploadUrl); uploadUrl=null; uploadTrack=null; } $('server').replaceChildren(new Option('No sources yet','')); $('server').disabled=true; $('back10').disabled=true; $('forward10').disabled=true; updateNext(); if (hls) hls.destroy(); $('video').pause(); $('video').removeAttribute('src'); $('video').load(); $('video').classList.add('hidden'); $('placeholder').classList.remove('hidden'); $('playing').textContent='Nothing playing yet'; $('selection').classList.add('hidden'); $('results').replaceChildren(); $('streams').replaceChildren(); $('playError').textContent=''; loggedIn(false); };
function render() {
  renderContinue();updateHero();
  const list=load('solo-watchlist'); $('listCount').textContent=`${list.length} saved`; $('empty').classList.toggle('hidden', list.length > 0); $('list').replaceChildren();
  list.forEach((item, index) => { const div=document.createElement('div'); div.className='item'; const title=document.createElement('strong'); title.textContent=item.title; const note=document.createElement('small'); note.textContent=item.kind==='catalog' ? `${item.type} · ${item.year || 'year unknown'}` : 'Saved stream'; const play=document.createElement('button'); play.textContent='Play'; play.onclick=()=>{ if(item.kind==='catalog'){ $('query').value=item.title; watchReturn='list'; showRoute('watch'); searchTitles(item.title,item); } else {showRoute('watch'); fallback.play([item]);} }; const del=document.createElement('button'); del.className='secondary'; del.textContent='Remove'; del.onclick=()=>{ list.splice(index,1); save('solo-watchlist',list); render(); }; if(item.poster){const art=document.createElement('div');art.className='watchlist-art';addPoster(art,item.poster);art.querySelectorAll('img[data-poster]').forEach(updatePoster);div.append(art);}div.append(title,note,play,del); $('list').append(div); });
}
function formItem() { return { title:$('title').value.trim(), url:$('url').value.trim(), format:$('format').value }; }
$('save').onclick=()=>{ if (!$('sourceForm').reportValidity()) return; const item=formItem(), list=load('solo-watchlist'); if (!list.some(x=>x.kind!=='catalog' && x.url===item.url)) list.unshift(item); save('solo-watchlist', list); render(); };
$('sourceForm').onsubmit=e=>{ e.preventDefault(); stopTranscode(); ++resolveSequence; selected=null; directControls(true);  updateNext(); showRoute('watch'); $('selection').classList.add('hidden'); fallback.play([formItem()]); };
// Session-only observations: a 'playing' event means playback started, not
// that a provider is permanently healthy. New providers retain a neutral prior.
const providerStats=new Map();
function scoreProvider(name){const stat=providerStats.get(name);return stat?(stat.ok+1)/(stat.ok+stat.fail+2):0.5;}
function recordProvider(name,success){if(!name)return;const stat=providerStats.get(name)||{ok:0,fail:0};if(stat.ok+stat.fail>=20){stat.ok=Math.floor(stat.ok/2);stat.fail=Math.floor(stat.fail/2);}stat[success?'ok':'fail']++;providerStats.set(name,stat);}
const fallback = createFallback((item, index, total, fail, isActive) => {
  if(index===0){attemptErrors=[];$('sourceFailures').textContent='';}
  $('playError').textContent=index ? `Trying another source (${index+1}/${total})…` : '';
  playItem(item, ()=>{if(isActive()){recordProvider(item.provider,false);const reason=String(lastTranscodeError || 'Playback failed').replace(/https?:\/\/\S+/g,'[source]').slice(0,150);attemptErrors.push(`${item.provider || 'Direct'}: ${reason}`);fail();}}, index>0, isActive);
}, () => { pendingFailure=null; stopTranscode(); if(hls){hls.destroy();hls=null;} const video=$('video');video.pause();video.removeAttribute('src');video.load(); $('playing').textContent=selected?.title || 'Playback unavailable';$('placeholder').classList.remove('hidden');$('placeholder').querySelector('p').textContent='Playback unavailable';$('playError').textContent='No source could be played. '+lastTranscodeError; $('sourceFailures').textContent=attemptErrors.join(' · '); });
async function playItem(item, fail, isFallback = false, isActive = () => true) {
  $('screen').classList.add('player-expanded');stopTranscode(); const sequence=transcodeSequence; const oldVideo=$('video'); if(hls){hls.destroy();hls=null;} oldVideo.pause();oldVideo.removeAttribute('src');oldVideo.load();
  directControls(true);
  if (!isFallback) $('playError').textContent=''; $('playing').textContent='Preparing…';
  try {
    const url = item.proxy || (await post('/api/source', {url:item.url, format:item.format})).url;
    if (!isActive()) return;
    if(!item.proxy) item.proxy=url;
    const saved=load('solo-progress').find(x=>x.url===(item.progressKey || item.url));
    const offset=Number.isFinite(item.seekAt) ? item.seekAt : (Number.isFinite(saved?.time) && saved.time>0 ? saved.time : 0);
    if(relaySupported) return await playRelay({...item,proxy:url,isActive,fail},offset);
    return await playConverted({...item,proxy:url,isActive,fail},offset);
  } catch(e) { if(isActive()) { lastTranscodeError=e.message; pendingFailure=null; fail(); } }
}
// Quality: 240p and 360p are always selectable. When the provider exposes real
// levels (many HLS masters do) those are added too, sorted, with Auto on top.
// A choice the stream cannot deliver falls back to the nearest available level
// rather than being silently ignored.
function renderQualityOptions(levels){
  const select=$('quality');
  const heights=[...new Set((levels||[]).map(l=>Number(l.height)).filter(h=>Number.isFinite(h)&&h>0))].sort((a,b)=>a-b);
  for(const base of [240,360]) if(!heights.includes(base)) heights.push(base);
  heights.sort((a,b)=>a-b);
  const previous=select.value;
  select.replaceChildren(new Option('Auto','auto'));
  for(const h of heights) select.add(new Option(`${h}p`,String(h)));
  select.value=[...select.options].some(o=>o.value===previous)?previous:'auto';
  return heights;
}
function nearestLevelIndex(height){
  if(!activeLevels.length)return -1;
  let best=0,bestDelta=Infinity;
  activeLevels.forEach((level,index)=>{
    const delta=Math.abs((level.height||0)-height);
    if(delta<bestDelta){bestDelta=delta;best=index;}
  });
  return best;
}

// Direct playback through Troy's same-origin relay. The browser receives the
// provider's own bytes, so no encoding, no waiting and no temporary disk use;
// seeking is native. Conversion remains the fallback for sources the relay or
// the browser cannot handle (unsupported codecs, or a CDN that refuses even a
// server-side request).
async function playRelay(item,offset){
  const fail=item.fail,isActive=item.isActive;
  try{
    if(!isActive())return;
    transcodeJob=null;
    item={...item,isActive,reliabilityRecorded:false,seekBase:0,totalDuration:null,relay:true};
    current=item; pendingFailure=()=>relayFailed(item,fail);
    const keepUpload=!!(item.keepUpload && uploadUrl);subtitleTouched=keepUpload;
    if(uploadUrl && !keepUpload){URL.revokeObjectURL(uploadUrl);uploadUrl=null;uploadTrack=null;}
    const video=$('video');
    $('playError').textContent='';
    $('back10').disabled=false;$('forward10').disabled=false;updateNext();
    $('server').replaceChildren();const variants=item.variants||[item];
    variants.forEach((source,i)=>$('server').add(new Option(`${source.provider||'Direct'} · ${source.quality?source.quality+'p':'source'} · ${(source.format||'file').toUpperCase()}`,String(i))));
    $('server').disabled=variants.length<2;
    const serverIndex=variants.findIndex(source=>source.proxy?source.proxy===item.proxy:source===item);
    $('server').value=String(Math.max(0,serverIndex));
    renderQualityOptions([]);
    $('quality').value=[240,360].includes(preferredHeight)?String(preferredHeight):'auto';
    $('subtitles').replaceChildren(new Option('Off','-1'));
    $('audio').replaceChildren(new Option('Default','-1'));
    if(keepUpload){uploadTrack=document.createElement('track');uploadTrack.kind='subtitles';uploadTrack.label='Uploaded subtitles';uploadTrack.srclang='en';uploadTrack.src=uploadUrl;video.append(uploadTrack);$('subtitles').add(new Option('Uploaded subtitles','upload'));$('subtitles').value='upload';const track=uploadTrack;track.addEventListener('load',()=>{if(uploadTrack===track && current===item){track.track.mode='showing';watchCaptionTrack(track.track);positionActiveCues(track.track);}});}
    $('placeholder').classList.add('hidden');video.classList.remove('hidden');$('playing').textContent=item.title;
    video.playbackRate=Number($('speed').value);
    // A source can accept the connection and then send nothing, or send bytes
    // the browser silently refuses. Without this the viewer just waits.
    let started=false,watchdog=null;
    const startEvents=['loadeddata','playing','timeupdate'];
    const markStarted=()=>{started=true;clearTimeout(watchdog);for(const event of startEvents)video.removeEventListener(event,markStarted);};
    for(const event of startEvents)video.addEventListener(event,markStarted);
    watchdog=setTimeout(()=>{
      for(const event of startEvents)video.removeEventListener(event,markStarted);
      if(started||current!==item)return;
      lastTranscodeError='The source opened but never produced playable video';
      $('playError').textContent='This source is not responding; converting it instead…';
      void relayFailed(item,fail);
    },15000);
    const resume=Number.isFinite(offset)&&offset>0?offset:0;
    if(resume) video.addEventListener('loadedmetadata',()=>{try{if(resume<video.duration-1)video.currentTime=resume;}catch{}},{once:true});
    if (item.subtitleRequest) {
      post(item.subtitleRequest.path,item.subtitleRequest.data).then(result=>{
        if(!result.url || current!==item)return;
        const track=document.createElement('track');track.kind='subtitles';track.label='English (provider)';track.srclang='en';track.src=result.url;track.default=!uploadTrack && !subtitleTouched;externalTrack=track;video.append(track);
        $('subtitles').add(new Option('English (provider)','external'));
        if(!uploadTrack && !subtitleTouched){$('subtitles').value='external';if(hls)hls.subtitleTrack=-1;}
        track.addEventListener('load',()=>{if(current===item && $('subtitles').value==='external'){track.track.mode='showing';watchCaptionTrack(track.track);positionActiveCues(track.track);}});
      }).catch(()=>{});
    }
    const play=()=>{if(item.wasPaused!==true)video.play().catch(()=>{if(current===item)$('playError').textContent='Tap play on the video to start.';});};
    if(item.format==='hls' && window.Hls && Hls.isSupported()){
      activeLevels=[];hls=new Hls({liveDurationInfinity:false,maxBufferLength:60,maxMaxBufferLength:120,backBufferLength:30,fragLoadPolicy:loadPolicy(10,10000,120000),playlistLoadPolicy:loadPolicy(8,10000,20000),manifestLoadPolicy:loadPolicy(6,10000,20000),nudgeMaxRetry:30});
      const player=hls;player.loadSource(item.proxy);player.attachMedia(video);
      player.on(Hls.Events.MANIFEST_PARSED,(_event,data)=>{
        if(current!==item||hls!==player)return;
        activeLevels=(data.levels||[]).slice().sort((a,b)=>(a.height||0)-(b.height||0));
        renderQualityOptions(activeLevels);
        const select=$('quality');
        const wanted=[240,360].includes(preferredHeight)?preferredHeight:null;
        if(wanted!==null){
          // Prefer an exact level; otherwise the closest one at or below it.
          const exact=activeLevels.findIndex(level=>level.height===wanted);
          if(exact>=0){player.currentLevel=exact;select.value=String(wanted);}
          else{
            const capped=activeLevels.map((level,index)=>({level,index})).filter(x=>(x.level.height||0)<=wanted).pop();
            if(capped){player.currentLevel=capped.index;select.value=String(capped.level.height);}
            else{select.value='auto';player.currentLevel=-1;}
          }
        } else {select.value='auto';player.currentLevel=-1;}
        play();
      });
      let recovered=false;
      player.on(Hls.Events.ERROR,(_event,data)=>{
        if(!data.fatal||current!==item||hls!==player)return;
        if(!recovered && data.details==='bufferStalledError'){recovered=true;player.startLoad?.();if(!video.paused)video.play().catch(()=>{});return;}
        if(!recovered && data.type===Hls.ErrorTypes?.MEDIA_ERROR && typeof player.recoverMediaError==='function'){recovered=true;player.recoverMediaError();return;}
        void relayFailed(item,fail);
      });
      player.on(Hls.Events.SUBTITLE_TRACKS_UPDATED,(_event,data)=>{
        if(current!==item||hls!==player)return;const previous=$('subtitles').value;
        $('subtitles').replaceChildren(new Option('Off','-1'));
        (data.subtitleTracks||[]).forEach((track,i)=>$('subtitles').add(new Option(track.name||track.lang||`Track ${i+1}`,String(i))));
        if(externalTrack)$('subtitles').add(new Option('English (provider)','external'));
        if(uploadTrack)$('subtitles').add(new Option('Uploaded subtitles','upload'));
        if([...$('subtitles').options].some(o=>o.value===previous))$('subtitles').value=previous;
      });
      player.on(Hls.Events.AUDIO_TRACKS_UPDATED,(_event,data)=>{
        if(current!==item||hls!==player)return;const previous=$('audio').value;
        $('audio').replaceChildren(new Option('Default','-1'));
        (data.audioTracks||[]).forEach((track,i)=>$('audio').add(new Option(track.name||track.lang||`Track ${i+1}`,String(i))));
        if([...$('audio').options].some(o=>o.value===previous))$('audio').value=previous;
      });
    } else {
      video.src=item.proxy;nativeSubtitleOptions();nativeAudioOptions();
      video.onerror=()=>{if(current===item)void relayFailed(item,fail);};
      play();
    }
  } catch(e) { if(isActive()){lastTranscodeError=e.message;pendingFailure=null;fail();} }
}
// One tiny ranged request tells us whether the relay can reach the source, and
// why not. It reuses the session-bound handle, so no URL is exposed.
async function relayReason(item){
  // Bounded: the whole point of this probe is to explain a failure, so it must
  // never become a second hang of its own.
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),4000);
  try{
    const response=await fetch(item.proxy,{headers:{Range:'bytes=0-1'},signal:controller.signal});
    if(response.ok){response.body?.cancel?.();return null;}
    $('sourceFailures').textContent=`${item.provider||'Source'}: HTTP ${response.status}`;
    try{const body=await response.json();if(body?.error)return body.error;}catch{}
    return `the media host returned HTTP ${response.status}`;
  }catch(error){return controller.signal.aborted?'the media host did not respond in time':null;}
  finally{clearTimeout(timer);}
}
// One conversion attempt per source, then move to the next source.
async function relayFailed(item,fail){
  if(current!==item || route!=='watch')return;
  const position=(item.seekBase||0)+($('video').currentTime||0);
  // Ask the server why. A 426/403 is a provider refusal, not a codec problem,
  // and saying so avoids pointless repeated conversion attempts.
  const reason=await relayReason(item);
  if(!item.convertRetried){
    pendingFailure=null;
    lastTranscodeError=reason ? `Direct playback failed: ${reason}` : 'Direct playback failed';
    $('playError').textContent=reason ? `${reason}. Converting this source instead…` : 'Direct playback is not possible for this source; converting it instead…';
    if(hls){hls.destroy();hls=null;}
    return playConverted({...item,convertRetried:true,seekAt:position>1?position:0,wasPaused:$('video').paused,keepUpload:!!uploadTrack},position>1?position:0);
  }
  fail();
}
async function playConverted(item,offset){
  const fail=item.fail,isActive=item.isActive;
  try{
    const sequence=transcodeSequence;
    const result=await enqueueTranscode(async()=>{
      if(sequence!==transcodeSequence || !isActive()) return null;
      const requestId=Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');pendingRequestId=requestId;
      let job;try{job=await post('/api/transcode',{url:item.proxy,offset,requestId});}finally{if(pendingRequestId===requestId)pendingRequestId=null;}
      if(!job || typeof job.id!=='string' || !/^[A-Za-z0-9_-]+$/.test(job.id) || job.url!==`/transcode/${job.id}/master.m3u8`){if(typeof job?.id==='string' && /^[A-Za-z0-9_-]+$/.test(job.id))await post('/api/transcode/stop',{id:job.id}).catch(()=>{});throw Error('Invalid conversion response');}
      if(sequence!==transcodeSequence || !isActive() || route!=='watch'){await post('/api/transcode/stop',{id:job.id}).catch(()=>{});return null;}
      return job;
    });
    if(!result || !isActive())return;
    transcodeJob=result.id;
    item={...item,isActive,reliabilityRecorded:false,format:'hls',transcodeId:result.id,noResume:true,seekBase:offset,totalDuration:Number.isFinite(result.duration) && result.duration>0 ? result.duration : (Number.isFinite(item.totalDuration)?item.totalDuration:null)};
    const outputUrl=result.url;
    $('playError').textContent='';
    current=item; pendingFailure=null; const keepUpload=!!(item.keepUpload && uploadUrl);subtitleTouched=keepUpload; if(uploadUrl && !keepUpload){ URL.revokeObjectURL(uploadUrl); uploadUrl=null; uploadTrack=null; } $('subtitleFile').value=''; $('back10').disabled=false; $('forward10').disabled=false; updateNext(); const video=$('video'); video.querySelectorAll('track').forEach(track=>track.remove()); externalTrack=null; if (hls) { hls.destroy(); hls=null; } video.pause(); video.removeAttribute('src'); video.load();
    $('server').replaceChildren(); const variants=item.variants || [item]; variants.forEach((source,i)=>$('server').add(new Option(`${source.provider || 'Direct'} · ${source.quality ? source.quality+'p' : 'source'} · ${(source.format || 'file').toUpperCase()}`,String(i)))); $('server').disabled=variants.length<2; const serverIndex=variants.findIndex(source=>source.proxy ? source.proxy===item.proxy : source===item); $('server').value=String(Math.max(0,serverIndex));
    // Auto returns to the provider's own stream, so leaving conversion is
    // always one click away once the server has started encoding.
    // Auto only exists when there is a direct stream to go back to; without the
    // relay, conversion is the only way to play and a bare Auto would be a dead
    // option.
    const convertedOptions=relaySupported?[new Option('Auto','auto')]:[];
    convertedOptions.push(new Option('240p','240'),new Option('360p','360'));
    $('quality').replaceChildren(...convertedOptions); $('quality').value=String(preferredHeight); $('subtitles').replaceChildren(new Option('Off', '-1')); $('audio').replaceChildren(new Option('Default', '-1')); if(keepUpload){uploadTrack=document.createElement('track');uploadTrack.kind='subtitles';uploadTrack.label='Uploaded subtitles';uploadTrack.srclang='en';uploadTrack.src=uploadUrl;video.append(uploadTrack);$('subtitles').add(new Option('Uploaded subtitles','upload'));$('subtitles').value='upload';const track=uploadTrack;track.addEventListener('load',()=>{if(uploadTrack===track && current===item){shiftCaptionCues(track.track,item.seekBase);track.track.mode='showing';watchCaptionTrack(track.track);positionActiveCues(track.track);}});} $('placeholder').classList.add('hidden'); video.classList.remove('hidden'); $('playing').textContent=item.title;
    video.onloadedmetadata=null; video.playbackRate=Number($('speed').value); pendingFailure=fail;
    if (item.subtitleRequest) {
      post(item.subtitleRequest.path,item.subtitleRequest.data).then(result=>{
        if (!result.url || current!==item) return;
        const track=document.createElement('track'); track.kind='subtitles'; track.label='English (provider)'; track.srclang='en'; track.src=result.url; track.default=!uploadTrack && !subtitleTouched; externalTrack=track; video.append(track); $('subtitles').add(new Option('English (provider)', 'external')); if(!uploadTrack && !subtitleTouched) { $('subtitles').value='external'; if(hls) hls.subtitleTrack=-1; } track.addEventListener('load',()=>{ if (current===item && $('subtitles').value==='external') {shiftCaptionCues(track.track,item.seekBase);track.track.mode='showing';watchCaptionTrack(track.track);positionActiveCues(track.track);} });
      }).catch(()=>{});
    }
    // hls.js can detect a playlist whose URL itself is opaque.
    if (item.format === 'hls' && Hls.isSupported()) {
      activeLevels=[]; hls=new Hls({startLevel:0,startPosition:0,liveDurationInfinity:false,maxBufferLength:60,maxMaxBufferLength:120,backBufferLength:30,fragLoadPolicy:loadPolicy(10,10000,120000),playlistLoadPolicy:loadPolicy(8,10000,20000),manifestLoadPolicy:loadPolicy(6,10000,20000),nudgeMaxRetry:30}); const player=hls; player.loadSource(outputUrl); player.attachMedia(video);
      player.on(Hls.Events.MANIFEST_PARSED, (_event, data)=>{ if(current!==item || hls!==player) return; activeLevels=data.levels || []; const index=activeLevels.findIndex(level=>level.height===preferredHeight); if(index<0){lastTranscodeError='The converted quality is unavailable.';pendingFailure=null;fail();return;} player.currentLevel=index; $('quality').value=String(preferredHeight); if(item.wasPaused!==true) video.play().catch(()=>{if(current===item) $('playError').textContent='Tap play on the video to start.';}); });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event,data)=>{ if(current!==item || hls!==player) return; const previous=$('subtitles').value; $('subtitles').replaceChildren(new Option('Off', '-1')); (data.subtitleTracks || []).forEach((track,i)=>$('subtitles').add(new Option(track.name || track.lang || `Track ${i+1}`, String(i)))); if(externalTrack) $('subtitles').add(new Option('English (provider)','external')); if(uploadTrack) $('subtitles').add(new Option('Uploaded subtitles','upload')); if([...$('subtitles').options].some(o=>o.value===previous)) $('subtitles').value=previous; });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event,data)=>{ if(current!==item || hls!==player) return; const previous=$('audio').value; $('audio').replaceChildren(new Option('Default', '-1')); (data.audioTracks || []).forEach((track,i)=>$('audio').add(new Option(track.name || track.lang || `Track ${i+1}`, String(i)))); if([...$('audio').options].some(o=>o.value===previous)) $('audio').value=previous; });
      let recoveredStall=false;
      hls.on(Hls.Events.ERROR, (_event,data)=>{ if(!data.fatal || current!==item || pendingFailure!==fail)return;
        if(!recoveredStall && (data.details==='bufferStalledError' || (data.details==='bufferAppendError' && typeof player.recoverMediaError==='function'))){recoveredStall=true;if(data.details==='bufferAppendError')player.recoverMediaError();else player.startLoad?.();if(!video.paused)video.play().catch(()=>{});$('playError').textContent='Buffering…';return;}
        pendingFailure=null; void conversionFailed(item,fail);
      });
    } else { video.src=outputUrl.replace('master.m3u8',`${preferredHeight}/index.m3u8`); nativeSubtitleOptions(); nativeAudioOptions(); if(item.wasPaused!==true) video.play().catch(()=>{if(current===item) $('playError').textContent='Tap play on the video to start.';}); }
  } catch(e) { if(isActive()) { lastTranscodeError=e.message; pendingFailure=null; fail(); } }
}
$('quality').onchange=()=>{ const value=$('quality').value;
 if(!current) return;
 const video=$('video');
 const resumeAt=Number.isFinite(video.currentTime)&&video.currentTime>1?video.currentTime:0;
 const wasPaused=video.paused;

 // Auto releases any pinned version. Server-encoded levels drop back to the
 // provider's own bytes so the viewer is watching the best available copy.
 if(value==='auto'){
  if(hls){hls.currentLevel=-1;return;}
  if(!relaySupported) return;
  if(current.transcodeId){
   const item={...current,seekAt:resumeAt,wasPaused,keepUpload:!!uploadTrack};
   if(hls){hls.destroy();hls=null;}
   playRelay(item,resumeAt);
   return;
  }
  return;
 }

 const height=Number(value); if(![240,360,480,720,1080,1440,2160].includes(height))return;

 // 240p and 360p are real conversions the server can produce. Picking them is
 // how you deliberately spend the 3 GB box's CPU on a small picture; it is
 // remembered for the next title.
 if([240,360].includes(height)){
  preferredHeight=height;try{localStorage.setItem('solo-quality-height',String(height));}catch{}
  // Already converting at this height: just swap rendition.
  if(current.transcodeId && hls){
   const index=activeLevels.findIndex(level=>level.height===height);
   if(index>=0){hls.currentLevel=index;return;}
  }
  if(current.transcodeId && !hls){
   const item=current;
   video.addEventListener('loadedmetadata',()=>{if(current!==item)return;try{if(resumeAt<=video.duration)video.currentTime=resumeAt;}catch{}},{once:true});
   video.src=`/transcode/${current.transcodeId}/${height}/index.m3u8`;video.load();
   if(!wasPaused)video.play().catch(()=>{});
   return;
  }
  // Relay or a higher provider level: start a conversion at this height.
  if(hls){hls.destroy();hls=null;}
  const item={...current,seekAt:resumeAt,wasPaused,keepUpload:!!uploadTrack};
  playConverted({...item,convertRetried:true},resumeAt);
  return;
 }

 // Any other level can only come from the provider's own ladder.
 if(!hls) return;
 const index=activeLevels.findIndex(level=>level.height===height);
 if(index>=0){hls.currentLevel=index;return;}
 const capped=nearestLevelIndex(height);
 if(capped>=0)hls.currentLevel=capped;
 const actual=activeLevels[capped]?.height;
 $('playError').textContent=actual?`This stream has no ${height}p; using the closest available (${actual}p).`:`This stream does not report quality levels; it adapts automatically.`;
};
function nativeSubtitleOptions(){
  if(hls || !current) return;
  const select=$('subtitles'), previous=select.value, tracks=$('video').textTracks;
  for(const option of [...select.options]) if(option.value.startsWith('native:')) option.remove();
  for(let i=0;i<tracks.length;i++){const track=tracks[i];if(track===uploadTrack?.track || track===externalTrack?.track || !['subtitles','captions'].includes(track.kind))continue;select.add(new Option(track.label || track.language || `Track ${i+1}`,`native:${i}`));}
  if([...select.options].some(o=>o.value===previous)) select.value=previous;
}
$('video').textTracks?.addEventListener?.('addtrack',nativeSubtitleOptions);
$('video').textTracks?.addEventListener?.('removetrack',nativeSubtitleOptions);
$('subtitles').onchange=()=>{ subtitleTouched=true; const value=$('subtitles').value; if(!hls){const tracks=$('video').textTracks;for(let i=0;i<tracks.length;i++){const track=tracks[i];if(track!==uploadTrack?.track && track!==externalTrack?.track && ['subtitles','captions'].includes(track.kind))track.mode=value===`native:${i}`?'showing':'disabled';}} if(uploadTrack?.track) uploadTrack.track.mode=value==='upload'?'showing':'disabled'; if(externalTrack?.track) externalTrack.track.mode=value==='external'?'showing':'disabled'; if(hls) hls.subtitleTrack=(value==='external'||value==='upload')?-1:Number(value); };
function nativeAudioOptions(){
  if(hls || !current) return; const tracks=$('video').audioTracks;if(!tracks)return;
  const select=$('audio'), previous=select.value;select.replaceChildren(new Option('Default','-1'));
  for(let i=0;i<tracks.length;i++) select.add(new Option(tracks[i].label || tracks[i].language || `Track ${i+1}`,String(i)));
  if([...select.options].some(o=>o.value===previous))select.value=previous;
}
$('video').audioTracks?.addEventListener?.('addtrack',nativeAudioOptions);
$('video').audioTracks?.addEventListener?.('removetrack',nativeAudioOptions);
$('audio').onchange=()=>{ if(hls) hls.audioTrack=Number($('audio').value); else {const tracks=$('video').audioTracks,index=Number($('audio').value);if(tracks && index>=0 && index<tracks.length)for(let i=0;i<tracks.length;i++)tracks[i].enabled=i===index;} };
$('speed').onchange=()=>{ $('video').playbackRate=Number($('speed').value); try{localStorage.setItem('solo-playback-speed',$('speed').value);}catch{} };
try {const speed=localStorage.getItem('solo-playback-speed');if([...$('speed').options].some(o=>o.value===speed)) $('speed').value=speed;}catch{}
// Position native WebVTT cues rather than painting an overlay: their text, timing,
// markup and track selection remain browser-controlled, including in fullscreen.
const captionTracks=new WeakSet();
// Subtitle timestamps refer to the original title, while restarted output starts at zero.
function shiftCaptionCues(track,offset){
 if(!track || !offset || !track.cues)return;
 try{for(const cue of Array.from(track.cues)){if(cue.endTime<=offset){track.removeCue(cue);continue;}cue.startTime=Math.max(0,cue.startTime-offset);cue.endTime=Math.max(0,cue.endTime-offset);}}catch{$('playError').textContent='Subtitle timing may be inaccurate after seeking on this browser.';}
}
function positionActiveCues(track){
  try {
    if(!track || !['subtitles','captions'].includes(track.kind)) return;
    const cues=track.activeCues; if(!cues) return; const line=100-Number($('subtitlePosition').value);
    for(let i=0;i<cues.length;i++){
      const cue=cues[i]; if(!cue || !('line' in cue) || cue.vertical)continue;
      try{if(cue.snapToLines!==false)cue.snapToLines=false;if(cue.line!==line)cue.line=line;if('lineAlign' in cue && cue.lineAlign!=='end')cue.lineAlign='end';}catch{/* Native/non-WebVTT cues may be read-only. */}
    }
  }catch{/* Some native tracks do not expose cues. */}
}
function watchCaptionTrack(track){if(!track || captionTracks.has(track))return;captionTracks.add(track);track.addEventListener?.('cuechange',()=>positionActiveCues(track));positionActiveCues(track);}
function syncCaptionPosition(){const tracks=$('video').textTracks;if(!tracks)return;for(let i=0;i<tracks.length;i++){watchCaptionTrack(tracks[i]);positionActiveCues(tracks[i]);}}
$('video').textTracks?.addEventListener?.('addtrack',event=>{watchCaptionTrack(event.track);syncCaptionPosition();});
$('video').textTracks?.addEventListener?.('change',syncCaptionPosition);
$('video').addEventListener('timeupdate',syncCaptionPosition);
function applyCaptionAppearance(){ const video=$('video'); for(const value of ['small','large','xlarge','yellow']) video.classList.remove(`caption-${value}`); const size=$('subtitleSize').value, color=$('subtitleColor').value, position=Number($('subtitlePosition').value); if(['small','large','xlarge'].includes(size)) video.classList.add(`caption-${size}`); if(color==='yellow') video.classList.add('caption-yellow'); syncCaptionPosition(); try {localStorage.setItem('solo-caption-style',JSON.stringify({size,color,position}));} catch {} }
$('subtitleSize').onchange=applyCaptionAppearance; $('subtitleColor').onchange=applyCaptionAppearance; $('subtitlePosition').onchange=applyCaptionAppearance;
try {const settings=JSON.parse(localStorage.getItem('solo-caption-style') || '{}'); if(['normal','small','large','xlarge'].includes(settings.size)) $('subtitleSize').value=settings.size; if(['white','yellow'].includes(settings.color)) $('subtitleColor').value=settings.color; if([...$('subtitlePosition').options].some(option=>option.value===String(settings.position))) $('subtitlePosition').value=String(settings.position);} catch {} applyCaptionAppearance();
$('server').onchange=()=>{ if(!current?.variants) return; const picked=current.variants[Number($('server').value)]; if(!picked || picked.proxy===current.proxy) return; const video=$('video'); const target=(current.seekBase||0)+(video.currentTime||0);fallback.play([picked,...current.variants.filter(x=>x!==picked)].map(source=>({...source,seekAt:target,wasPaused:video.paused,keepUpload:!!uploadTrack}))); };
$('subtitleFile').onchange=async()=>{
  const file=$('subtitleFile').files[0], item=current; if(!file) return; if(!item){ $('playError').textContent='Start a stream before uploading subtitles.'; $('subtitleFile').value=''; return; }
  if(file.size>2*1024*1024 || !/\.(srt|vtt)$/i.test(file.name)){ $('playError').textContent='Choose an SRT or VTT subtitle file under 2 MB.'; return; }
  try {
    let text=(await file.text()).replace(/^\uFEFF/,'').trim(); if(current!==item) return;
    if(!text.includes('-->') || /^<(!doctype|html)/i.test(text)) throw Error('Invalid subtitle file');
    text=text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,'$1.$2'); if(!/^WEBVTT(?:\s|$)/.test(text)) text='WEBVTT\n\n'+text;
    if(uploadTrack) uploadTrack.remove(); if(uploadUrl) URL.revokeObjectURL(uploadUrl);
    uploadUrl=URL.createObjectURL(new Blob([text],{type:'text/vtt'})); uploadTrack=document.createElement('track'); uploadTrack.kind='subtitles'; uploadTrack.label='Uploaded subtitles'; uploadTrack.srclang='en'; uploadTrack.src=uploadUrl; $('video').append(uploadTrack);
    $('subtitles').querySelector('option[value="upload"]')?.remove(); $('subtitles').add(new Option('Uploaded subtitles','upload')); $('subtitles').value='upload'; $('subtitles').dispatchEvent(new Event('change')); const track=uploadTrack; track.addEventListener('load',()=>{if(uploadTrack===track && $('subtitles').value==='upload') {shiftCaptionCues(track.track,item.seekBase);track.track.mode='showing';watchCaptionTrack(track.track);positionActiveCues(track.track);}}); $('playError').textContent='';
  } catch { if(current===item) $('playError').textContent='Could not read that subtitle file.'; }
};
$('video').addEventListener('playing',()=>{if(current && !current.reliabilityRecorded){current.reliabilityRecorded=true;recordProvider(current.provider,true);}});
$('video').ontimeupdate=()=>{ if(!current || Date.now()-lastSave<5000) return; const key=current.progressKey || current.url;if(!key)return;lastSave=Date.now(); const progress=load('solo-progress').filter(x=>x.url!==key); progress.unshift({url:key,time:(current.seekBase||0)+($('video').currentTime||0),...(selected ? {kind:'catalog',title:selected.title,type:selected.type,year:selected.year || '',source:selected.source || '',poster:selected.poster || null,season:current.context?.season || null,episode:current.context?.episode || null} : {})}); save('solo-progress', progress.slice(0,100)); };
$('video').onerror=()=>{ if(current && pendingFailure && $('video').currentSrc) { const fail=pendingFailure, item=current; pendingFailure=null; void conversionFailed(item,fail); } };
// Direct same-origin relay is the default playback path; conversion is the
// fallback when a source cannot be relayed or the operator disabled the relay.
let relaySupported=true;
api('/api/session').then(x=>{relaySupported=x.relay!==false;loggedIn(x.authenticated);}).catch(()=>loggedIn(false));

function catalogMatches(a,b){return a.kind==='catalog' && a.title===b.title && a.type===b.type && (a.year||'')===(b.year||'') && (a.source||'')===(b.source||'');}
function updateCatalogSave(){const saved=selected && load('solo-watchlist').some(x=>catalogMatches(x,selected));$('saveTitle').textContent=saved?'Remove from watchlist':'Add to watchlist';$('saveTitle').setAttribute('aria-pressed',String(!!saved));}
$('saveTitle').onclick=()=>{if(!selected)return;const list=load('solo-watchlist'),index=list.findIndex(x=>catalogMatches(x,selected));if(index>=0)list.splice(index,1);else list.unshift({kind:'catalog',title:selected.title,type:selected.type,year:selected.year || '',source:selected.source || '',poster:selected.poster || null});save('solo-watchlist',list);updateCatalogSave();render();};
async function selectTitle(item) {
  selected=item; updateCatalogSave(); episodes=[]; $('season').value='1'; $('episode').value='1'; updateNext(); $('selectedTitle').textContent=item.title; $('overview').textContent=item.overview;
  $('episodeFields').classList.toggle('hidden', item.type!=='series'); $('episodeCatalog').classList.add('hidden'); $('selection').classList.remove('hidden'); $('streams').replaceChildren(); $('providersNotice').textContent=''; $('findStreams').textContent=item.type==='series'?'Play selected episode':'Play again';
  if(item.type==='series') {
    $('season').value='1'; $('episode').value='1';
    $('episodeNotice').textContent='Loading episode list…'; $('episodeCatalog').classList.remove('hidden'); $('episodeSelect').replaceChildren(new Option('Loading…','')); $('episodeSelect').disabled=true;
    try { const data=await post('/api/episodes',{id:item.id}); if(selected!==item) return; $('episodeSelect').replaceChildren(); episodes=data.episodes.slice().sort((a,b)=>a.season-b.season || a.episode-b.episode); for(const e of episodes){ const option=new Option(`S${e.season} E${e.episode} · ${e.title}`, `${e.season}:${e.episode}`); $('episodeSelect').add(option); } $('episodeSelect').disabled=!episodes.length; if(!episodes.length) $('episodeSelect').add(new Option('No episode list available','')); $('episodeNotice').textContent=data.episodes.length ? `Episode data from ${data.source}; availability may vary. You can also enter numbers below.` : 'No episode list available; enter numbers below.'; const chosenEpisode=`${$('season').value}:${$('episode').value}`;if([...$('episodeSelect').options].some(o=>o.value===chosenEpisode))$('episodeSelect').value=chosenEpisode; updateNext(); } catch { if(selected===item){$('episodeSelect').replaceChildren(new Option('Episode list unavailable','')); $('episodeSelect').disabled=true; $('episodeNotice').textContent='Episode list unavailable; enter numbers below.';} }
  }
}
async function searchTitles(query, saved = null) {
  const sequence=++searchSequence; ++resolveSequence; selected=null; updateNext(); $('searchError').textContent=''; $('results').replaceChildren(); $('selection').classList.add('hidden'); $('streams').replaceChildren();
  try {
    const data=await post('/api/search', {query});
    if(sequence!==searchSequence) return;
    $('searchError').textContent=(data.providers || []).filter(p=>p.error).map(p=>`${p.provider}: ${p.error}`).join(' · ');
    const normalized=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); const q=normalized(query); const rank=x=>{const n=normalized(x.title);return n===q?0:n.startsWith(q)?1:n.includes(q)?2:3;};
    searchResults=data.results.slice().sort((a,b)=>rank(a)-rank(b));renderSearchResults();
    if(saved) {
      const candidates=data.results.filter(item=>item.title===saved.title && item.type===saved.type && (!saved.year || item.year===saved.year));
      const item=(saved.source && candidates.find(x=>x.source===saved.source)) || (candidates.length===1 ? candidates[0] : null);
      if (!item) { showRoute('search'); $('searchError').textContent='Saved title not found unambiguously. Select a result above.'; return; }
      openTitle(item,saved);
    }
  } catch(err) { if(sequence===searchSequence) { if(saved) showRoute('search'); $('searchError').textContent=err.message; $('resultCount').textContent='Search unavailable'; } }
}
$('searchForm').onsubmit=e=>{e.preventDefault();clearTimeout(searchTimer);const query=$('query').value.trim();if(!query)return;saveSearch(query);showRoute('search');searchTitles(query);};
$('query').addEventListener('input',()=>{clearTimeout(searchTimer);++searchSequence;searchResults=[];const query=$('query').value.trim();if(!query){$('searchError').textContent='';searchResults=[];renderSearchResults();return;}$('resultCount').textContent='Searching…';$('results').replaceChildren();searchTimer=setTimeout(()=>{if(route==='search' && $('query').value.trim()===query)searchTitles(query);},400);});
$('clearSearch').onclick=()=>{clearTimeout(searchTimer);++searchSequence;$('query').value='';$('searchError').textContent='';searchResults=[];renderSearchResults();$('query').focus();};
$('clearHistory').onclick=()=>{save('solo-search-history',[]);renderSearchPanels();};
$('searchFilters').onclick=e=>{const button=e.target.closest('[data-filter]');if(!button)return;searchFilter=button.dataset.filter;document.querySelectorAll('#searchFilters button').forEach(b=>b.classList.toggle('active',b===button));renderSearchResults();};
function openTitle(item,resume=null){ stopTranscode(); if(route!=='watch') watchReturn=route; fallback.cancel(); directControls(true);  ++resolveSequence; if(hls){hls.destroy();hls=null;} current=null; pendingFailure=null; $('video').pause(); $('video').removeAttribute('src'); $('video').load(); $('video').classList.add('hidden'); $('placeholder').classList.remove('hidden'); $('placeholder').querySelector('p').textContent='Looking for a stream…'; $('playError').textContent=''; showRoute('watch'); $('screen').classList.add('player-expanded'); selectTitle(item); if(resume && item.type==='series' && Number.isInteger(resume.season) && Number.isInteger(resume.episode) && resume.season>0 && resume.episode>0){$('season').value=String(resume.season);$('episode').value=String(resume.episode);} findStreams(true); }
$('episodeSelect').onchange=()=>{ const [s,e]=$('episodeSelect').value.split(':').map(Number); if(s && e){ $('season').value=s; $('episode').value=e; } };
async function findStreams(autoplay = false) {
  stopTranscode();
  if(!selected) return;  const sequence=++resolveSequence; const chosen=selected; $('playError').textContent=''; $('sourceFailures').textContent=''; $('streams').replaceChildren(); $('findStreams').disabled=true; $('findStreams').textContent='Preparing your video…';
  const season=Number($('season').value), episode=Number($('episode').value);
  try {
    const data=await post('/api/resolve',{id:chosen.id, season, episode});
    if (selected!==chosen || sequence!==resolveSequence) return;
    $('providersNotice').textContent=data.providers.map(p=>`${p.provider}: ${p.count ? p.count+' stream(s)' : (p.error || 'no streams')}`).join(' · ');
    const items=data.streams.map(stream=>({title:`${data.title}${chosen.type === 'series' ? ` S${season} E${episode}` : ''}`,proxy:stream.url,format:stream.format,subtitleRequest:chosen.source==='kisskh'?{path:'/api/kiss-subtitle',data:{id:chosen.id,season,episode}}:stream.captionId?{path:stream.provider.startsWith('movy:')?'/api/movy-subtitle':stream.provider==='7movies'?'/api/vidlink-subtitle':'/api/moviebox-subtitle',data:{id:stream.captionId}}:null,progressKey:`${chosen.source}:${chosen.title}:${chosen.year}:${chosen.type}:${season}:${episode}`,provider:stream.provider,quality:stream.quality,context:chosen.type==='series'?{id:chosen.id,season,episode}:null}));
    items.sort((a,b)=>scoreProvider(b.provider)-scoreProvider(a.provider) || (a.format==='file'?0:1)-(b.format==='file'?0:1) || (a.quality || Infinity)-(b.quality || Infinity)); items.forEach(item=>{item.variants=items;});
    for(let i=0;i<items.length;i++){
      const item=items[i], btn=document.createElement('button'); btn.textContent=`${item.provider} · ${item.quality ? item.quality+'p' : 'Auto'} · ${item.format.toUpperCase()}`;
      btn.onclick=()=>fallback.play([item,...items.filter((_,n)=>n!==i)]);
      $('streams').append(btn);
    }
    if(items.length){ const auto=document.createElement('button'); auto.textContent='Play automatically →'; auto.onclick=()=>fallback.play(items); $('streams').prepend(auto); if (autoplay) fallback.play(items); } else { $('playError').textContent='No playable streams found for this title or episode. Player options have provider details.'; $('placeholder').querySelector('p').textContent='No stream available'; }

  } catch(err) { if(selected===chosen && sequence===resolveSequence){ $('playError').textContent=err.message; $('placeholder').querySelector('p').textContent='Could not find a stream';} }
  finally { if(sequence===resolveSequence){$('findStreams').disabled=false; $('findStreams').textContent=chosen.type==='series'?'Play selected episode':'Play again';} }
}
$('findStreams').onclick=()=>findStreams(true);
$('reclaimTranscode').onclick=async()=>{if(!confirm('Stop all conversions, including those on other devices?'))return;try{const result=await post('/api/transcode/reclaim',{});$('playError').textContent=result.stopped?'Conversion stopped. Press Play again.':'No conversion was active.';}catch(err){$('playError').textContent=err.message;}};

$('video').addEventListener('ended',()=>{ if(current){const key=current.progressKey || current.url; if(key) try{save('solo-progress',load('solo-progress').filter(x=>x.url!==key));}catch{}} const ctx=current?.context; if(ctx && selected?.id===ctx.id && episodes.some(e=>e.season>ctx.season || (e.season===ctx.season && e.episode>ctx.episode))) $('nextEpisode').click(); });
function updateNext(){
  const ctx=current?.context;
  $('nextEpisode').disabled=!ctx || !selected || selected.id!==ctx.id;
  $('prevEpisode').disabled=!ctx || !selected || selected.id!==ctx.id || (episodes.length ? !episodes.some(e=>e.season<ctx.season || (e.season===ctx.season && e.episode<ctx.episode)) : ctx.episode<=1);
}
// Video time is relative to the current conversion; the overlay owns the full timeline.
window.troyTimeline={
 duration(){const v=$('video');if(current?.totalDuration)return current.totalDuration;if(Number.isFinite(v.duration))return (current?.seekBase||0)+v.duration;try{return v.seekable.length?(current?.seekBase||0)+v.seekable.end(v.seekable.length-1):0;}catch{return 0;}},
 time(){return (current?.seekBase || 0)+($('video').currentTime || 0);},
 seek(value){
  const item=current,video=$('video');if(!item || !Number.isFinite(value))return;
  // Relayed media is the provider's own file, so the browser seeks natively
  // across the whole timeline without restarting anything.
  if(item.relay){const duration=this.duration();const target=Math.max(0,duration?Math.min(duration-1,value):value);try{video.currentTime=target;}catch{}return;}
  const duration=this.duration();if(duration<=0){if(!item.totalDuration)video.currentTime=Math.max(0,value);return;}
  const target=Math.max(0,Math.min(Math.max(0,duration-1),value)),base=item.seekBase||0,relative=target-base;
  let available=Number.isFinite(video.duration)?video.duration:0;try{for(let i=0;i<video.seekable.length;i++){if(relative>=video.seekable.start(i) && relative<video.seekable.end(i)-0.1){video.currentTime=relative;return;}available=Math.max(available,video.seekable.end(i));}}catch{}
  if(relative>=0 && Number.isFinite(video.duration) && relative<available-0.1){video.currentTime=relative;return;}
  if(!item.totalDuration){$('playError').textContent='This source has no usable duration for seeking beyond converted video.';return;}
  const rest=(item.variants||[]).filter(source=>source.proxy!==item.proxy);
  fallback.play([{...item,format:'file',seekAt:target,transcodeId:null,wasPaused:video.paused,keepUpload:!!uploadTrack},...rest.map(source=>({...source,seekAt:target,wasPaused:video.paused,keepUpload:!!uploadTrack}))]);
 }
};
function skip(seconds){if(current)window.troyTimeline.seek(window.troyTimeline.time()+seconds);}
$('back10').onclick=()=>skip(-10);
$('forward10').onclick=()=>skip(10);
$('prevEpisode').onclick=async()=>{
  const ctx=current?.context; if(!ctx || !selected || selected.id!==ctx.id) return;
  const prev=episodes.filter(e=>e.season<ctx.season || (e.season===ctx.season && e.episode<ctx.episode)).at(-1);
  if(!prev && (episodes.length || ctx.episode<=1)){ $('playError').textContent='No earlier episode is listed.'; return; }
  const season=prev?.season ?? ctx.season, episode=prev?.episode ?? ctx.episode-1;
  $('season').value=String(season); $('episode').value=String(episode);
  const option=`${season}:${episode}`; if([...$('episodeSelect').options].some(x=>x.value===option)) $('episodeSelect').value=option;
  await findStreams(true);
};
$('nextEpisode').onclick=async()=>{
  const ctx=current?.context; if(!ctx || !selected || selected.id!==ctx.id) return;
  const next=episodes.find(e=>e.season>ctx.season || (e.season===ctx.season && e.episode>ctx.episode));
  if(!next && episodes.length){ $('playError').textContent='No later episode is listed.'; return; }
  const season=next?.season ?? ctx.season, episode=next?.episode ?? ctx.episode+1;
  if(episode>9999){ $('playError').textContent='No later episode is listed.'; return; }
  $('season').value=String(season); $('episode').value=String(episode);
  const option=`${season}:${episode}`; if([...$('episodeSelect').options].some(x=>x.value===option)) $('episodeSelect').value=option;
  await findStreams(true);
};

function titleCard(item, animeSection=false){
  const card=document.createElement('button'); card.type='button'; card.className='catalog-card'; card.dataset.type=item.type; card.dataset.anime=String(animeSection || !!item.anime);
  const art=document.createElement('div'); art.className='catalog-art';
  if(item.poster) addPoster(art,item.poster);
  const fallback=document.createElement('span'); fallback.className='art-fallback'; fallback.textContent=item.title; art.append(fallback);
  const name=document.createElement('strong'); name.textContent=item.title;
  const meta=document.createElement('small'); meta.textContent=`${item.year || 'Year unknown'} · ${item.type==='series'?'Series':'Movie'}`;
  card.append(art,name,meta); card.onclick=()=>openTitle(item); return card;
}
let featuredItems=[],featuredIndex=0;
function heroItems(){return featuredItems.filter(item=>route==='movies'?item.type==='movie':route==='shows'?item.type==='series':route==='anime'?item.anime:true).slice(0,6);}
function updateHero(){
 const items=heroItems();if(featuredIndex>=items.length)featuredIndex=0;const item=items[featuredIndex];const play=$('heroPlay'),saveButton=$('heroSave');
 play.disabled=!item;saveButton.disabled=!item;$('heroInfo').disabled=!item;
 if(!item){$('heroTitle').textContent='Discover something new.';$('heroDescription').textContent='Browse the catalog or search for a title.';$('heroMeta').textContent='';$('heroImage').classList.add('hidden');$('heroDots').replaceChildren();return;}
 $('heroTitle').textContent=item.title;$('heroDescription').textContent=item.overview || 'Select a title to find available sources.';
 $('heroMeta').textContent=[item.year,item.type==='series'?'TV series':'Movie'].filter(Boolean).join(' · ');
 const img=$('heroImage'),url=posterUrl(item.poster);if(url){img.src=url;img.classList.remove('hidden');}else{img.removeAttribute('src');img.classList.add('hidden');}
 const saved=load('solo-watchlist').some(x=>catalogMatches(x,item));saveButton.textContent=saved?'✓  In my list':'＋  My list';saveButton.setAttribute('aria-pressed',String(saved));
 $('heroDots').replaceChildren();items.forEach((_,index)=>{const dot=document.createElement('button');dot.type='button';dot.classList.toggle('active',index===featuredIndex);dot.setAttribute('aria-label',`Featured title ${index+1}`);dot.onclick=()=>{featuredIndex=index;updateHero();};$('heroDots').append(dot);});
}
let detailItem=null;
function closeDetails(){$('detailsModal').classList.add('hidden');detailItem=null;}
$('heroInfo').onclick=()=>{detailItem=heroItems()[featuredIndex];if(!detailItem)return;$('detailTitle').textContent=detailItem.title;$('detailMeta').textContent=[detailItem.type==='series'?'TV series':'Movie',detailItem.year].filter(Boolean).join(' · ');$('detailSynopsis').textContent=detailItem.overview||'No synopsis available.';const img=$('detailImage'),url=posterUrl(detailItem.poster);if(url){img.src=url;img.classList.remove('hidden');}else{img.removeAttribute('src');img.classList.add('hidden');}updateDetailSave();$('detailsModal').classList.remove('hidden');$('detailBack').focus();};
function updateDetailSave(){const saved=detailItem&&load('solo-watchlist').some(x=>catalogMatches(x,detailItem));$('detailSave').textContent=saved?'✓  In my list':'＋  My list';}
$('detailBack').onclick=closeDetails;$('detailPlay').onclick=()=>{const item=detailItem;closeDetails();if(item)openTitle(item);};$('detailSave').onclick=()=>{if(!detailItem)return;const list=load('solo-watchlist'),index=list.findIndex(x=>catalogMatches(x,detailItem));if(index>=0)list.splice(index,1);else list.unshift({kind:'catalog',title:detailItem.title,type:detailItem.type,year:detailItem.year||'',source:detailItem.source||'',poster:detailItem.poster||null});save('solo-watchlist',list);updateDetailSave();render();};
$('heroPlay').onclick=()=>{const item=heroItems()[featuredIndex];if(item)openTitle(item);};
$('heroSave').onclick=()=>{const item=heroItems()[featuredIndex];if(!item)return;const list=load('solo-watchlist'),index=list.findIndex(x=>catalogMatches(x,item));if(index<0)list.unshift({kind:'catalog',title:item.title,type:item.type,year:item.year || '',source:item.source || '',poster:item.poster || null});else list.splice(index,1);save('solo-watchlist',list);render();};
$('heroPrev').onclick=()=>{const items=heroItems();if(items.length){featuredIndex=(featuredIndex-1+items.length)%items.length;updateHero();}};
$('heroNext').onclick=()=>{const items=heroItems();if(items.length){featuredIndex=(featuredIndex+1)%items.length;updateHero();}};
setInterval(()=>{const items=heroItems();if(['home','movies','shows','anime'].includes(route) && items.length>1){featuredIndex=(featuredIndex+1)%items.length;updateHero();}},6000);
function renderContinue(){
 const root=$('continueRow');root.replaceChildren();const entries=load('solo-progress').filter(x=>x.kind==='catalog' && x.title && Number.isFinite(x.time) && x.time>0).slice(0,20);
 $('continueSection').classList.toggle('hidden',!entries.length);
 for(const item of entries){const button=document.createElement('button');button.className='continue-card';button.type='button';const title=document.createElement('strong');title.textContent=item.title;const meta=document.createElement('small');const minutes=Math.floor(item.time/60);meta.textContent=`${item.season && item.episode?`S${item.season} E${item.episode} · `:''}Resume at ${minutes}:${String(Math.floor(item.time%60)).padStart(2,'0')}`;const action=document.createElement('span');action.className='continue-play';action.textContent='▶  Continue watching';const art=document.createElement('div');art.className='continue-art';if(item.poster)addPoster(art,item.poster);const info=document.createElement('div');info.className='continue-info';info.append(title,meta,action);button.append(art,info);button.onclick=()=>{watchReturn='home';$('query').value=item.title;showRoute('watch');searchTitles(item.title,item);};root.append(button);}
}
function catalogItems(){const found=new Map();for(const section of catalogSections)for(const item of section.items||[]){if(!item.id || !item.title)continue;const key=`${item.source||''}:${item.id}`;const old=found.get(key);if(old){old.sections.add(section.id);old.anime ||= !!item.anime || section.id==='anime' || (section.groups||[]).includes('anime');}else found.set(key,{item,sections:new Set([section.id]),anime:!!item.anime || section.id==='anime' || (section.groups||[]).includes('anime')});}return [...found.values()];}
function resultCard(item){const btn=titleCard(item,!!item.anime);btn.className='result';btn.querySelector('.catalog-art').className='result-art';return btn;}
function renderSearchResults(){const q=$('query').value.trim(),items=q?searchResults:catalogItems().map(x=>x.item);const filtered=items.filter(x=>searchFilter==='all'||x.type===searchFilter);$('searchHeading').textContent=q?'Search results':'Popular catalog';$('resultCount').textContent=`${filtered.length} ${filtered.length===1?'title':'titles'}`;$('results').replaceChildren(...filtered.map(resultCard));refreshCards();}
function saveSearch(query){const history=load('solo-search-history').filter(x=>typeof x==='string'&&x.toLowerCase()!==query.toLowerCase());history.unshift(query);save('solo-search-history',history.slice(0,10));renderSearchPanels();}
function renderSearchPanels(){const suggestions=$('searchSuggestions');suggestions.replaceChildren();for(const {item} of catalogItems().slice(0,6)){const button=document.createElement('button');button.type='button';button.textContent=item.title;button.onclick=()=>{$('query').value=item.title;saveSearch(item.title);searchTitles(item.title);};suggestions.append(button);}if(!suggestions.children.length)suggestions.textContent='Catalog suggestions unavailable.';const history=$('searchHistory');history.replaceChildren();for(const query of load('solo-search-history').filter(x=>typeof x==='string')){const button=document.createElement('button');button.type='button';button.textContent=query;button.onclick=()=>{$('query').value=query;searchTitles(query);};history.append(button);}if(!history.children.length)history.textContent='No recent searches';}
function pill(container,text,value,active,callback){const b=document.createElement('button');b.type='button';b.textContent=text;b.classList.toggle('active',active);b.onclick=()=>callback(value);container.append(b);}
function renderExplore(){const entries=catalogItems(),sections=$('exploreSections'),years=$('exploreYears');sections.replaceChildren();years.replaceChildren();pill(sections,'All','all',exploreSection==='all',v=>{exploreSection=v;renderExplore();});for(const section of catalogSections){if(!section.id||!section.title||!section.items?.length)continue;pill(sections,section.title,section.id,exploreSection===section.id,v=>{exploreSection=v;renderExplore();});}pill(years,'All','all',exploreYear==='all',v=>{exploreYear=v;renderExplore();});for(const year of [...new Set(entries.map(x=>x.item.year).filter(y=>/^\d{4}$/.test(y)))].sort().reverse())pill(years,year,year,exploreYear===year,v=>{exploreYear=v;renderExplore();});document.querySelectorAll('#exploreTypes button').forEach(b=>b.classList.toggle('active',b.dataset.type===exploreType));const filtered=entries.filter(x=>(exploreType==='all'||(exploreType==='anime'?x.anime:x.item.type===exploreType))&&(exploreSection==='all'||x.sections.has(exploreSection))&&(exploreYear==='all'||x.item.year===exploreYear));$('exploreGrid').replaceChildren(...filtered.map(x=>resultCard(x.item)));$('exploreCount').textContent=`${filtered.length} ${filtered.length===1?'title':'titles'}`;document.querySelectorAll('#exploreGrid img[data-poster]').forEach(updatePoster);}
$('exploreTypes').onclick=e=>{const b=e.target.closest('[data-type]');if(b){exploreType=b.dataset.type;renderExplore();}};
$('resetExplore').onclick=()=>{exploreType=exploreSection=exploreYear='all';renderExplore();};
let discoveryLoading=false, discoveryLoaded=false;
async function loadDiscovery(){
  if(discoveryLoading || discoveryLoaded) return; discoveryLoading=true; const epoch=discoveryEpoch;
  try {
    const data=await api('/api/discover'); if(epoch!==discoveryEpoch) return; data.sections=(data.sections||[]).filter(section=>!/(?:^|[^a-z])bl(?:[^a-z]|$)|boys?[’' -]*love/i.test(`${section.title||''} ${section.id||''}`));catalogSections=data.sections;renderExplore();renderSearchPanels();if(!$('query').value.trim())renderSearchResults(); featuredItems=[];const featuredSeen=new Set();for(const section of data.sections||[])for(const item of section.items||[]){const key=`${item.title}|${item.type}|${item.year}`;if(item.id && item.title && !featuredSeen.has(key)){featuredSeen.add(key);featuredItems.push({...item,anime:!!item.anime || section.id==='anime'});}}featuredIndex=0;updateHero();const root=$('catalogRows'); root.replaceChildren();
    for(const section of data.sections){ if(!/^[a-z0-9-]{1,60}$/.test(section.id||'') || !Array.isArray(section.items)) continue;
      const label=section.title || section.id; const groups=Array.isArray(section.groups)?section.groups:section.id==='anime'?['anime']:[...new Set(section.items.map(i=>i.type==='movie'?'movies':'shows'))];
      const row=document.createElement('section'); row.className='catalog-section'; row.id=section.id; row.dataset.groups=groups.join(',');
      const heading=document.createElement('div'); heading.className='row-head'; const title=document.createElement('h2'); title.textContent=label; const note=document.createElement('span'); note.textContent=section.source || 'Catalog'; heading.append(title,note); row.append(heading);
      const rail=document.createElement('div'); rail.className='catalog-rail'; rail.setAttribute('role','group'); rail.setAttribute('aria-label',label); rail.tabIndex=0;
      for(const item of section.items) rail.append(titleCard(item,section.id==='anime')); if(!section.items.length){ const empty=document.createElement('p'); empty.className='catalog-status'; empty.textContent=section.error || 'No titles available right now.'; rail.append(empty); }
      row.append(rail); const more=document.createElement('button');more.type='button';more.className='more-cards secondary';more.hidden=true;more.onclick=()=>{row.dataset.expanded='true';refreshCards();};row.append(more);root.append(row);
    }
    showRoute(route,false); discoveryLoaded=data.sections.every(section=>!section.error);
    if(!discoveryLoaded){ const retry=document.createElement('button'); retry.className='secondary'; retry.textContent='Retry unavailable catalogs'; retry.onclick=loadDiscovery; root.append(retry); }
  } catch { if(epoch!==discoveryEpoch) return; $('catalogRows').replaceChildren(); for(const id of ['popular-movies','popular-series']) {const anchor=document.createElement('div'); anchor.id=id; $('catalogRows').append(anchor);} const note=document.createElement('p'); note.className='catalog-status'; note.textContent='Catalog unavailable. Search is still available.'; const retry=document.createElement('button'); retry.className='secondary'; retry.textContent='Retry unavailable catalogs'; retry.onclick=loadDiscovery; $('catalogRows').append(note,retry); }
  finally {discoveryLoading=false; if(epoch!==discoveryEpoch && !$('app').classList.contains('hidden')) loadDiscovery();}
}
