'use strict';
const $ = id => document.getElementById(id);
let hls = null, current = null, lastSave = 0, selected = null, externalTrack = null, pendingFailure = null, searchSequence = 0, episodes = [], uploadTrack = null, uploadUrl = null;
const load = key => { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } };
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
async function api(url, options = {}) {
  const response = await fetch(url, options); const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed'); return result;
}
const post = (url, data) => api(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(data) });
function loggedIn(on) { $('login').classList.toggle('hidden', on); $('app').classList.toggle('hidden', !on); $('logout').classList.toggle('hidden', !on); if (on) render(); }
$('loginForm').onsubmit = async e => { e.preventDefault(); $('loginError').textContent = ''; try { await post('/api/login', {password:$('password').value}); $('password').value=''; loggedIn(true); } catch (err) { $('loginError').textContent=err.message; } };
$('logout').onclick = async () => { fallback.cancel(); current=null; pendingFailure=null; if(uploadUrl){ URL.revokeObjectURL(uploadUrl); uploadUrl=null; uploadTrack=null; } $('server').replaceChildren(new Option('No sources yet','')); $('server').disabled=true; $('back10').disabled=true; $('forward10').disabled=true; updateNext(); await post('/api/logout', {}); if (hls) hls.destroy(); $('video').pause(); $('video').removeAttribute('src'); $('video').load(); loggedIn(false); };
function render() {
  const list=load('solo-watchlist'); $('empty').classList.toggle('hidden', list.length > 0); $('list').replaceChildren();
  list.forEach((item, index) => { const div=document.createElement('div'); div.className='item'; const title=document.createElement('strong'); title.textContent=item.title; const note=document.createElement('small'); note.textContent=item.kind==='catalog' ? `${item.type} · ${item.year || 'year unknown'}` : 'Saved stream'; const play=document.createElement('button'); play.textContent='Play'; play.onclick=()=>{ if(item.kind==='catalog'){ $('query').value=item.title; searchTitles(item.title,item); window.scrollTo({top:0,behavior:'smooth'}); } else fallback.play([item]); }; const del=document.createElement('button'); del.className='secondary'; del.textContent='Remove'; del.onclick=()=>{ list.splice(index,1); save('solo-watchlist',list); render(); }; div.append(title,note,play,del); $('list').append(div); });
}
function formItem() { return { title:$('title').value.trim(), url:$('url').value.trim(), format:$('format').value }; }
$('save').onclick=()=>{ if (!$('sourceForm').reportValidity()) return; const item=formItem(), list=load('solo-watchlist'); if (!list.some(x=>x.kind!=='catalog' && x.url===item.url)) list.unshift(item); save('solo-watchlist', list); render(); };
$('sourceForm').onsubmit=e=>{ e.preventDefault(); fallback.play([formItem()]); };
const fallback = createFallback((item, index, total, fail, isActive) => {
  $('playError').textContent=index ? `Trying another source (${index+1}/${total})…` : '';
  playItem(item, fail, index>0, isActive);
}, () => { pendingFailure=null; $('playError').textContent='All selected sources failed. Choose another title or search again.'; });
async function playItem(item, fail, isFallback = false, isActive = () => true) {
  if (!isFallback) $('playError').textContent=''; $('playing').textContent='Preparing…';
  try {
    const url = item.proxy || (await post('/api/source', {url:item.url, format:item.format})).url;
    if (!isActive()) return;
    current=item; pendingFailure=null; if(uploadUrl){ URL.revokeObjectURL(uploadUrl); uploadUrl=null; uploadTrack=null; } $('subtitleFile').value=''; $('back10').disabled=false; $('forward10').disabled=false; updateNext(); const video=$('video'); video.querySelectorAll('track').forEach(track=>track.remove()); externalTrack=null; if (hls) { hls.destroy(); hls=null; } video.pause(); video.removeAttribute('src'); video.load();
    $('server').replaceChildren(); const variants=item.variants || [item]; variants.forEach((source,i)=>$('server').add(new Option(`${source.provider || 'Direct'} · ${source.quality ? source.quality+'p' : 'source'} · ${(source.format || 'file').toUpperCase()}`,String(i)))); $('server').disabled=variants.length<2; const serverIndex=variants.findIndex(source=>source.proxy ? source.proxy===item.proxy : source===item); $('server').value=String(Math.max(0,serverIndex));
    $('quality').replaceChildren(new Option(item.quality ? `${item.quality}p` : 'Source quality', 'current')); if(item.format==='file' && item.variants){ const files=item.variants.filter(x=>x.format==='file' && x.provider===item.provider && x.quality>0).sort((a,b)=>a.quality-b.quality); if(files.length){ $('quality').replaceChildren(); files.forEach(x=>$('quality').add(new Option(`${x.quality}p`, `file:${item.variants.indexOf(x)}`))); const index=item.variants.findIndex(x=>x.proxy===item.proxy); if(index>=0) $('quality').value=`file:${index}`; } } $('subtitles').replaceChildren(new Option('Off', '-1')); $('audio').replaceChildren(new Option('Default', '-1')); $('placeholder').classList.add('hidden'); video.classList.remove('hidden'); $('playing').textContent=item.title;
    const resume=()=>{ const progress=load('solo-progress'); const match=progress.find(x=>x.url===(item.progressKey || item.url)); const time=Number.isFinite(item.resumeAt) ? item.resumeAt : match?.time; if(Number.isFinite(time) && time>0 && (!Number.isFinite(video.duration) || time<video.duration-1)) video.currentTime=time; };
    video.onloadedmetadata=resume; video.playbackRate=Number($('speed').value); pendingFailure=fail;
    if (item.subtitleRequest) {
      post(item.subtitleRequest.path,item.subtitleRequest.data).then(result=>{
        if (!result.url || current!==item) return;
        const track=document.createElement('track'); track.kind='subtitles'; track.label='English (provider)'; track.srclang='en'; track.src=result.url; track.default=!uploadTrack; video.append(track); externalTrack=track; $('subtitles').add(new Option('English (provider)', 'external')); if(!uploadTrack) $('subtitles').value='external'; track.addEventListener('load',()=>{ if (current===item && $('subtitles').value==='external') track.track.mode='showing'; });
      }).catch(()=>{});
    }
    // hls.js can detect a playlist whose URL itself is opaque.
    if (item.format === 'hls' && Hls.isSupported()) {
      hls=new Hls({maxBufferLength:45,maxMaxBufferLength:60,backBufferLength:30}); const player=hls; player.loadSource(url); player.attachMedia(video);
      player.on(Hls.Events.MANIFEST_PARSED, (_event, data)=>{ if(current!==item || hls!==player) return; const levels=data.levels.map((level,i)=>({level,i})).sort((a,b)=>(a.level.height || 0)-(b.level.height || 0) || (a.level.bitrate || 0)-(b.level.bitrate || 0)); $('quality').replaceChildren(); levels.forEach(({level,i})=>$('quality').add(new Option(`${level.height ? level.height+'p' : 'Quality'}${level.bitrate ? ' · '+Math.round(level.bitrate/1000)+' kbps':''}`, String(i)))); $('quality').add(new Option('Auto (adaptive)', '-1')); if(levels.length){ player.currentLevel=levels[0].i; $('quality').value=String(levels[0].i); } if(item.wasPaused!==true) video.play().catch(()=>{}); });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event,data)=>{ $('subtitles').replaceChildren(new Option('Off', '-1')); (data.subtitleTracks || []).forEach((track,i)=>$('subtitles').add(new Option(track.name || track.lang || `Track ${i+1}`, String(i)))); if(externalTrack) $('subtitles').add(new Option('English (provider)','external')); if(uploadTrack){ $('subtitles').add(new Option('Uploaded subtitles','upload')); $('subtitles').value='upload'; } else if(externalTrack) $('subtitles').value='external'; });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event,data)=>{ $('audio').replaceChildren(new Option('Default', '-1')); (data.audioTracks || []).forEach((track,i)=>$('audio').add(new Option(track.name || track.lang || `Track ${i+1}`, String(i)))); });
      hls.on(Hls.Events.ERROR, (_event,data)=>{ if(data.fatal && current===item && pendingFailure===fail) { pendingFailure=null; fail(); } });
    } else { video.src=url; if(item.wasPaused!==true) video.play().catch(()=>{}); }
  } catch(e) { if(isActive()) { pendingFailure=null; fail(); } }
}
$('quality').onchange=()=>{ const value=$('quality').value; if(hls && /^-?\d+$/.test(value)) { hls.currentLevel=Number(value); return; } if(value.startsWith('file:') && current?.variants){ const chosen=current.variants[Number(value.slice(5))]; if(chosen && chosen.proxy!==current.proxy){ const video=$('video'); const next={...chosen,resumeAt:video.currentTime,wasPaused:video.paused}; fallback.play([next,...current.variants.filter(x=>x!==chosen)]); } } };
$('subtitles').onchange=()=>{ const value=$('subtitles').value; if(uploadTrack) uploadTrack.track.mode=value==='upload'?'showing':'disabled'; if(externalTrack) externalTrack.track.mode=value==='external'?'showing':'disabled'; if(hls) hls.subtitleTrack=(value==='external'||value==='upload')?-1:Number(value); };
$('audio').onchange=()=>{ if(hls && Number($('audio').value)>=0) hls.audioTrack=Number($('audio').value); };
$('speed').onchange=()=>{ $('video').playbackRate=Number($('speed').value); };
$('server').onchange=()=>{ if(!current?.variants) return; const picked=current.variants[Number($('server').value)]; if(!picked || picked.proxy===current.proxy) return; const video=$('video'); fallback.play([{...picked,resumeAt:video.currentTime,wasPaused:video.paused},...current.variants.filter(x=>x!==picked)]); };
$('subtitleFile').onchange=async()=>{
  const file=$('subtitleFile').files[0], item=current; if(!file || !item) return;
  if(file.size>2*1024*1024 || !/\.(srt|vtt)$/i.test(file.name)){ $('playError').textContent='Choose an SRT or VTT subtitle file under 2 MB.'; return; }
  try {
    let text=(await file.text()).replace(/^\uFEFF/,'').trim(); if(current!==item) return;
    if(!text.includes('-->') || /^<(!doctype|html)/i.test(text)) throw Error('Invalid subtitle file');
    text=text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,'$1.$2'); if(!/^WEBVTT(?:\s|$)/.test(text)) text='WEBVTT\n\n'+text;
    if(uploadTrack) uploadTrack.remove(); if(uploadUrl) URL.revokeObjectURL(uploadUrl);
    uploadUrl=URL.createObjectURL(new Blob([text],{type:'text/vtt'})); uploadTrack=document.createElement('track'); uploadTrack.kind='subtitles'; uploadTrack.label='Uploaded subtitles'; uploadTrack.srclang='en'; uploadTrack.src=uploadUrl; $('video').append(uploadTrack);
    $('subtitles').querySelector('option[value="upload"]')?.remove(); $('subtitles').add(new Option('Uploaded subtitles','upload')); $('subtitles').value='upload'; $('subtitles').dispatchEvent(new Event('change')); const track=uploadTrack; track.addEventListener('load',()=>{if(uploadTrack===track && $('subtitles').value==='upload') track.track.mode='showing';}); $('playError').textContent='';
  } catch { if(current===item) $('playError').textContent='Could not read that subtitle file.'; }
};
$('video').ontimeupdate=()=>{ if(!current || Date.now()-lastSave<5000) return; lastSave=Date.now(); const key=current.progressKey || current.url; const progress=load('solo-progress').filter(x=>x.url!==key); progress.unshift({url:key,time:$('video').currentTime}); save('solo-progress', progress.slice(0,100)); };
$('video').onerror=()=>{ if(current && pendingFailure && $('video').currentSrc) { const fail=pendingFailure; pendingFailure=null; fail(); } };
api('/api/session').then(x=>loggedIn(x.authenticated)).catch(()=>loggedIn(false));

async function selectTitle(item) {
  selected=item; episodes=[]; updateNext(); $('selectedTitle').textContent=item.title; $('overview').textContent=item.overview;
  $('episodeFields').classList.toggle('hidden', item.type!=='series'); $('episodeCatalog').classList.add('hidden'); $('selection').classList.remove('hidden'); $('streams').replaceChildren(); $('providersNotice').textContent='';
  if(item.type==='series') {
    $('season').value='1'; $('episode').value='1';
    $('episodeNotice').textContent='Loading episode list…'; $('episodeCatalog').classList.remove('hidden'); $('episodeSelect').replaceChildren();
    try { const data=await post('/api/episodes',{id:item.id}); if(selected!==item) return; episodes=data.episodes.slice().sort((a,b)=>a.season-b.season || a.episode-b.episode); for(const e of episodes){ const option=new Option(`S${e.season} E${e.episode} · ${e.title}`, `${e.season}:${e.episode}`); $('episodeSelect').add(option); } $('episodeNotice').textContent=data.episodes.length ? `Episode data from ${data.source}; you can also enter numbers below.` : 'No episode list available; enter numbers below.'; if(data.episodes.length) $('episodeSelect').dispatchEvent(new Event('change')); updateNext(); } catch { if(selected===item) $('episodeNotice').textContent='Episode list unavailable; enter numbers below.'; }
  }
}
async function searchTitles(query, saved = null) {
  const sequence=++searchSequence; selected=null; updateNext(); $('searchError').textContent=''; $('results').replaceChildren(); $('selection').classList.add('hidden'); $('streams').replaceChildren();
  try {
    const data=await post('/api/search', {query});
    if(sequence!==searchSequence) return;
    $('searchError').textContent=(data.providers || []).filter(p=>p.error).map(p=>`${p.provider}: ${p.error}`).join(' · ');
    if(!data.results.length) { $('searchError').textContent += ' No titles found.'; return; }
    for(const item of data.results) {
      const btn=document.createElement('button'); btn.className='result';
      const title=document.createElement('strong'); title.textContent=item.title;
      const meta=document.createElement('small'); meta.textContent=`${item.source || 'MovieBox'} · ${item.type === 'series' ? 'Series' : 'Movie'} · ${item.year || 'Year unknown'}`;
      btn.append(title,meta); btn.onclick=()=>selectTitle(item); $('results').append(btn);
    }
    if(saved) {
      const candidates=data.results.filter(item=>item.title===saved.title && item.type===saved.type && (!saved.year || item.year===saved.year));
      const item=(saved.source && candidates.find(x=>x.source===saved.source)) || (candidates.length===1 ? candidates[0] : null);
      if (!item) { $('searchError').textContent='Saved title not found unambiguously. Select a result above.'; return; }
      await selectTitle(item);
      if(sequence===searchSequence && selected===item) await findStreams(true);
    }
  } catch(err) { if(sequence===searchSequence) $('searchError').textContent=err.message; }
}
$('searchForm').onsubmit=e=>{ e.preventDefault(); searchTitles($('query').value.trim()); };
$('saveTitle').onclick=()=>{ if(!selected) return; const list=load('solo-watchlist'); if (!list.some(x=>x.kind==='catalog' && x.title===selected.title && x.year===selected.year && x.type===selected.type)) list.unshift({kind:'catalog',title:selected.title,year:selected.year,type:selected.type,source:selected.source}); save('solo-watchlist',list); render(); };
$('episodeSelect').onchange=()=>{ const [s,e]=$('episodeSelect').value.split(':').map(Number); if(s && e){ $('season').value=s; $('episode').value=e; } };
async function findStreams(autoplay = false) {
  if(!selected || $('findStreams').disabled) return; const chosen=selected; $('searchError').textContent=''; $('streams').replaceChildren(); $('findStreams').disabled=true; $('findStreams').textContent='Looking for streams…';
  const season=Number($('season').value), episode=Number($('episode').value);
  try {
    const data=await post('/api/resolve',{id:chosen.id, season, episode});
    if (selected!==chosen) return;
    $('providersNotice').textContent=data.providers.map(p=>`${p.provider}: ${p.count ? p.count+' stream(s)' : (p.error || 'no streams')}`).join(' · ');
    const items=data.streams.map(stream=>({title:`${data.title}${chosen.type === 'series' ? ` S${season} E${episode}` : ''}`,proxy:stream.url,format:stream.format,subtitleRequest:chosen.source==='kisskh'?{path:'/api/kiss-subtitle',data:{id:chosen.id,season,episode}}:stream.captionId?{path:'/api/moviebox-subtitle',data:{id:stream.captionId}}:null,progressKey:`${chosen.source}:${chosen.title}:${chosen.year}:${chosen.type}:${season}:${episode}`,provider:stream.provider,quality:stream.quality,context:chosen.type==='series'?{id:chosen.id,season,episode}:null}));
    items.sort((a,b)=>(a.quality || Infinity)-(b.quality || Infinity)); items.forEach(item=>{item.variants=items;});
    for(let i=0;i<items.length;i++){
      const item=items[i], btn=document.createElement('button'); btn.textContent=`${item.provider} · ${item.quality ? item.quality+'p' : 'Auto'} · ${item.format.toUpperCase()}`;
      btn.onclick=()=>fallback.play([item,...items.filter((_,n)=>n!==i)]);
      $('streams').append(btn);
    }
    if(items.length){ const auto=document.createElement('button'); auto.textContent='Play automatically →'; auto.onclick=()=>fallback.play(items); $('streams').prepend(auto); if (autoplay) fallback.play(items); } else if(autoplay) $('playError').textContent='No streams available for this saved title.';

  } catch(err) { if(selected===chosen) $('searchError').textContent=err.message; }
  finally { $('findStreams').disabled=false; $('findStreams').textContent='Find available streams →'; }
}
$('findStreams').onclick=()=>findStreams(false);

function updateNext(){
  const ctx=current?.context;
  $('nextEpisode').disabled=!ctx || !selected || selected.id!==ctx.id;
}
function skip(seconds){
  const video=$('video'); if(!current || !Number.isFinite(video.currentTime)) return;
  const end=Number.isFinite(video.duration) ? video.duration : Infinity;
  video.currentTime=Math.max(0,Math.min(end,video.currentTime+seconds));
}
$('back10').onclick=()=>skip(-10);
$('forward10').onclick=()=>skip(10);
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
