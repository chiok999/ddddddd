'use strict';
const $ = id => document.getElementById(id);
let hls = null, current = null, lastSave = 0, selected = null, externalTrack = null, pendingFailure = null, searchSequence = 0, episodes = [], uploadTrack = null, uploadUrl = null, subtitleTouched = false;
const load = key => { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } };
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
async function api(url, options = {}) {
  const response = await fetch(url, options); const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed'); return result;
}
const post = (url, data) => api(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(data) });
let route='home', resolveSequence=0;
function showRoute(name, updateHash=true) {
  if(!['home','movies','shows','anime','search','watch','list'].includes(name)) name='home';
  const previous=route; route=name;
  const view=['movies','shows','anime'].includes(name)?'home':name;
  for(const id of ['home','search','watch','list']) $('view-'+id).classList.toggle('hidden',id!==view);
  document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===name));
  document.querySelectorAll('#catalogRows .catalog-section').forEach(el=>{ const groups={movies:['popular-movies','new-movies','top-rated'],shows:['popular-series','new-series'],anime:['anime','animation']}; el.classList.toggle('hidden',!!groups[name]&&!groups[name].includes(el.id)); });
  if(previous==='watch' && view!=='watch') {++resolveSequence; fallback.cancel(); $('findStreams').disabled=false; $('video').pause();}
  if(updateHash && location.hash!=='#'+name) location.hash=name;
  if(typeof window.scrollTo==='function') window.scrollTo(0,0);
}
window.addEventListener('hashchange',()=>showRoute(location.hash.slice(1),false));
$('backToSearch').onclick=()=>showRoute('search');
function loggedIn(on) { $('login').classList.toggle('hidden', on); $('app').classList.toggle('hidden', !on); $('logout').classList.toggle('hidden', !on); $('mainNav').classList.toggle('hidden', !on); if (on) { render(); showRoute(location.hash.slice(1)||'home',false); loadDiscovery(); } }
$('loginForm').onsubmit = async e => { e.preventDefault(); $('loginError').textContent = ''; try { await post('/api/login', {password:$('password').value}); $('password').value=''; loggedIn(true); } catch (err) { $('loginError').textContent=err.message; } };
$('logout').onclick = async () => { try { await post('/api/logout', {}); } catch(err) { $('playError').textContent='Sign out failed: '+err.message; return; } ++searchSequence; ++resolveSequence; selected=null; episodes=[]; fallback.cancel(); current=null; pendingFailure=null; if(uploadUrl){ URL.revokeObjectURL(uploadUrl); uploadUrl=null; uploadTrack=null; } $('server').replaceChildren(new Option('No sources yet','')); $('server').disabled=true; $('back10').disabled=true; $('forward10').disabled=true; updateNext(); if (hls) hls.destroy(); $('video').pause(); $('video').removeAttribute('src'); $('video').load(); $('video').classList.add('hidden'); $('placeholder').classList.remove('hidden'); $('playing').textContent='Nothing playing yet'; $('selection').classList.add('hidden'); $('results').replaceChildren(); $('streams').replaceChildren(); $('playError').textContent=''; loggedIn(false); };
function render() {
  const list=load('solo-watchlist'); $('empty').classList.toggle('hidden', list.length > 0); $('list').replaceChildren();
  list.forEach((item, index) => { const div=document.createElement('div'); div.className='item'; const title=document.createElement('strong'); title.textContent=item.title; const note=document.createElement('small'); note.textContent=item.kind==='catalog' ? `${item.type} · ${item.year || 'year unknown'}` : 'Saved stream'; const play=document.createElement('button'); play.textContent='Play'; play.onclick=()=>{ if(item.kind==='catalog'){ $('query').value=item.title; showRoute('watch'); searchTitles(item.title,item); } else {showRoute('watch'); fallback.play([item]);} }; const del=document.createElement('button'); del.className='secondary'; del.textContent='Remove'; del.onclick=()=>{ list.splice(index,1); save('solo-watchlist',list); render(); }; div.append(title,note,play,del); $('list').append(div); });
}
function formItem() { return { title:$('title').value.trim(), url:$('url').value.trim(), format:$('format').value }; }
$('save').onclick=()=>{ if (!$('sourceForm').reportValidity()) return; const item=formItem(), list=load('solo-watchlist'); if (!list.some(x=>x.kind!=='catalog' && x.url===item.url)) list.unshift(item); save('solo-watchlist', list); render(); };
$('sourceForm').onsubmit=e=>{ e.preventDefault(); ++resolveSequence; selected=null; updateNext(); showRoute('watch'); $('selection').classList.add('hidden'); fallback.play([formItem()]); };
const fallback = createFallback((item, index, total, fail, isActive) => {
  $('playError').textContent=index ? `Trying another source (${index+1}/${total})…` : '';
  playItem(item, fail, index>0, isActive);
}, () => { pendingFailure=null; $('playError').textContent='All selected sources failed. Choose another title or search again.'; });
async function playItem(item, fail, isFallback = false, isActive = () => true) {
  if (!isFallback) $('playError').textContent=''; $('playing').textContent='Preparing…';
  try {
    const url = item.proxy || (await post('/api/source', {url:item.url, format:item.format})).url;
    if (!isActive()) return;
    current=item; pendingFailure=null; subtitleTouched=false; if(uploadUrl){ URL.revokeObjectURL(uploadUrl); uploadUrl=null; uploadTrack=null; } $('subtitleFile').value=''; $('back10').disabled=false; $('forward10').disabled=false; updateNext(); const video=$('video'); video.querySelectorAll('track').forEach(track=>track.remove()); externalTrack=null; if (hls) { hls.destroy(); hls=null; } video.pause(); video.removeAttribute('src'); video.load();
    $('server').replaceChildren(); const variants=item.variants || [item]; variants.forEach((source,i)=>$('server').add(new Option(`${source.provider || 'Direct'} · ${source.quality ? source.quality+'p' : 'source'} · ${(source.format || 'file').toUpperCase()}`,String(i)))); $('server').disabled=variants.length<2; const serverIndex=variants.findIndex(source=>source.proxy ? source.proxy===item.proxy : source===item); $('server').value=String(Math.max(0,serverIndex));
    $('quality').replaceChildren(new Option(item.quality ? `${item.quality}p` : 'Source quality', 'current')); if(item.format==='file' && item.variants){ const files=item.variants.filter(x=>x.format==='file' && x.provider===item.provider && x.quality>0).sort((a,b)=>a.quality-b.quality); if(files.length){ $('quality').replaceChildren(); files.forEach(x=>$('quality').add(new Option(`${x.quality}p`, `file:${item.variants.indexOf(x)}`))); const index=item.variants.findIndex(x=>x.proxy===item.proxy); if(index>=0) $('quality').value=`file:${index}`; } } $('subtitles').replaceChildren(new Option('Off', '-1')); $('audio').replaceChildren(new Option('Default', '-1')); $('placeholder').classList.add('hidden'); video.classList.remove('hidden'); $('playing').textContent=item.title;
    const resume=()=>{ const progress=load('solo-progress'); const match=progress.find(x=>x.url===(item.progressKey || item.url)); const time=Number.isFinite(item.resumeAt) ? item.resumeAt : match?.time; if(Number.isFinite(time) && time>0 && (!Number.isFinite(video.duration) || time<video.duration-1)) video.currentTime=time; };
    video.onloadedmetadata=resume; video.playbackRate=Number($('speed').value); pendingFailure=fail;
    if (item.subtitleRequest) {
      post(item.subtitleRequest.path,item.subtitleRequest.data).then(result=>{
        if (!result.url || current!==item) return;
        const track=document.createElement('track'); track.kind='subtitles'; track.label='English (provider)'; track.srclang='en'; track.src=result.url; track.default=!uploadTrack && !subtitleTouched; video.append(track); externalTrack=track; $('subtitles').add(new Option('English (provider)', 'external')); if(!uploadTrack && !subtitleTouched) { $('subtitles').value='external'; if(hls) hls.subtitleTrack=-1; } track.addEventListener('load',()=>{ if (current===item && $('subtitles').value==='external') track.track.mode='showing'; });
      }).catch(()=>{});
    }
    // hls.js can detect a playlist whose URL itself is opaque.
    if (item.format === 'hls' && Hls.isSupported()) {
      hls=new Hls({maxBufferLength:45,maxMaxBufferLength:60,backBufferLength:30}); const player=hls; player.loadSource(url); player.attachMedia(video);
      player.on(Hls.Events.MANIFEST_PARSED, (_event, data)=>{ if(current!==item || hls!==player) return; const levels=data.levels.map((level,i)=>({level,i})).sort((a,b)=>(a.level.height || 0)-(b.level.height || 0) || (a.level.bitrate || 0)-(b.level.bitrate || 0)); $('quality').replaceChildren(); levels.forEach(({level,i})=>$('quality').add(new Option(`${level.height ? level.height+'p' : 'Quality'}${level.bitrate ? ' · '+Math.round(level.bitrate/1000)+' kbps':''}`, String(i)))); $('quality').add(new Option('Auto (adaptive)', '-1')); if(levels.length){ player.currentLevel=levels[0].i; $('quality').value=String(levels[0].i); } if(item.wasPaused!==true) video.play().catch(()=>{if(current===item) $('playError').textContent='Tap play on the video to start.';}); });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event,data)=>{ if(current!==item || hls!==player) return; const previous=$('subtitles').value; $('subtitles').replaceChildren(new Option('Off', '-1')); (data.subtitleTracks || []).forEach((track,i)=>$('subtitles').add(new Option(track.name || track.lang || `Track ${i+1}`, String(i)))); if(externalTrack) $('subtitles').add(new Option('English (provider)','external')); if(uploadTrack) $('subtitles').add(new Option('Uploaded subtitles','upload')); if([...$('subtitles').options].some(o=>o.value===previous)) $('subtitles').value=previous; });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event,data)=>{ if(current!==item || hls!==player) return; const previous=$('audio').value; $('audio').replaceChildren(new Option('Default', '-1')); (data.audioTracks || []).forEach((track,i)=>$('audio').add(new Option(track.name || track.lang || `Track ${i+1}`, String(i)))); if([...$('audio').options].some(o=>o.value===previous)) $('audio').value=previous; });
      hls.on(Hls.Events.ERROR, (_event,data)=>{ if(data.fatal && current===item && pendingFailure===fail) { pendingFailure=null; fail(); } });
    } else { video.src=url; if(item.wasPaused!==true) video.play().catch(()=>{if(current===item) $('playError').textContent='Tap play on the video to start.';}); }
  } catch(e) { if(isActive()) { pendingFailure=null; fail(); } }
}
$('quality').onchange=()=>{ const value=$('quality').value; if(hls && /^-?\d+$/.test(value)) { hls.currentLevel=Number(value); return; } if(value.startsWith('file:') && current?.variants){ const chosen=current.variants[Number(value.slice(5))]; if(chosen && chosen.proxy!==current.proxy){ const video=$('video'); const next={...chosen,resumeAt:video.currentTime,wasPaused:video.paused}; fallback.play([next,...current.variants.filter(x=>x!==chosen)]); } } };
$('subtitles').onchange=()=>{ subtitleTouched=true; const value=$('subtitles').value; if(uploadTrack) uploadTrack.track.mode=value==='upload'?'showing':'disabled'; if(externalTrack) externalTrack.track.mode=value==='external'?'showing':'disabled'; if(hls) hls.subtitleTrack=(value==='external'||value==='upload')?-1:Number(value); };
$('audio').onchange=()=>{ if(hls) hls.audioTrack=Number($('audio').value); };
$('speed').onchange=()=>{ $('video').playbackRate=Number($('speed').value); };
function applyCaptionAppearance(){ const video=$('video'); for(const value of ['small','large','xlarge','yellow']) video.classList.remove(`caption-${value}`); const size=$('subtitleSize').value, color=$('subtitleColor').value; if(['small','large','xlarge'].includes(size)) video.classList.add(`caption-${size}`); if(color==='yellow') video.classList.add('caption-yellow'); try {localStorage.setItem('solo-caption-style',JSON.stringify({size,color}));} catch {} }
$('subtitleSize').onchange=applyCaptionAppearance; $('subtitleColor').onchange=applyCaptionAppearance;
try {const settings=JSON.parse(localStorage.getItem('solo-caption-style') || '{}'); if(['normal','small','large','xlarge'].includes(settings.size)) $('subtitleSize').value=settings.size; if(['white','yellow'].includes(settings.color)) $('subtitleColor').value=settings.color;} catch {} applyCaptionAppearance();
$('server').onchange=()=>{ if(!current?.variants) return; const picked=current.variants[Number($('server').value)]; if(!picked || picked.proxy===current.proxy) return; const video=$('video'); fallback.play([{...picked,resumeAt:video.currentTime,wasPaused:video.paused},...current.variants.filter(x=>x!==picked)]); };
$('subtitleFile').onchange=async()=>{
  const file=$('subtitleFile').files[0], item=current; if(!file) return; if(!item){ $('playError').textContent='Start a stream before uploading subtitles.'; $('subtitleFile').value=''; return; }
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
  selected=item; episodes=[]; $('season').value='1'; $('episode').value='1'; updateNext(); $('selectedTitle').textContent=item.title; $('overview').textContent=item.overview;
  $('episodeFields').classList.toggle('hidden', item.type!=='series'); $('episodeCatalog').classList.add('hidden'); $('selection').classList.remove('hidden'); $('streams').replaceChildren(); $('providersNotice').textContent=''; $('findStreams').textContent=item.type==='series'?'Play selected episode':'Play again';
  if(item.type==='series') {
    $('season').value='1'; $('episode').value='1';
    $('episodeNotice').textContent='Loading episode list…'; $('episodeCatalog').classList.remove('hidden'); $('episodeSelect').replaceChildren();
    try { const data=await post('/api/episodes',{id:item.id}); if(selected!==item) return; episodes=data.episodes.slice().sort((a,b)=>a.season-b.season || a.episode-b.episode); for(const e of episodes){ const option=new Option(`S${e.season} E${e.episode} · ${e.title}`, `${e.season}:${e.episode}`); $('episodeSelect').add(option); } $('episodeNotice').textContent=data.episodes.length ? `Episode data from ${data.source}; you can also enter numbers below.` : 'No episode list available; enter numbers below.'; if(data.episodes.some(e=>e.season===1 && e.episode===1)) $('episodeSelect').value='1:1'; updateNext(); } catch { if(selected===item) $('episodeNotice').textContent='Episode list unavailable; enter numbers below.'; }
  }
}
async function searchTitles(query, saved = null) {
  const sequence=++searchSequence; ++resolveSequence; selected=null; updateNext(); $('searchError').textContent=''; $('results').replaceChildren(); $('selection').classList.add('hidden'); $('streams').replaceChildren();
  try {
    const data=await post('/api/search', {query});
    if(sequence!==searchSequence) return;
    $('searchError').textContent=(data.providers || []).filter(p=>p.error).map(p=>`${p.provider}: ${p.error}`).join(' · ');
    if(!data.results.length) { $('resultCount').textContent='No titles found'; return; }
    $('resultCount').textContent=`${data.results.length} titles found`;
    const normalized=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); const q=normalized(query); const rank=x=>{const n=normalized(x.title);return n===q?0:n.startsWith(q)?1:n.includes(q)?2:3;};
    for(const item of data.results.slice().sort((a,b)=>rank(a)-rank(b))) {
      const btn=document.createElement('button'); btn.className='result';
      const art=document.createElement('div'); art.className='result-art'; const placeholder=document.createElement('span'); placeholder.className='art-fallback'; placeholder.textContent=item.title; art.append(placeholder); if(item.poster){try{const u=new URL(item.poster); if(u.protocol==='https:' && ['images.metahub.space','live.metahub.space'].includes(u.hostname)){const img=document.createElement('img');img.src=u.href;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.onerror=()=>img.remove();art.append(img);}}catch{}}
      const title=document.createElement('strong'); title.textContent=item.title;
      const meta=document.createElement('small'); meta.textContent=`${item.type === 'series' ? 'Series' : 'Movie'} · ${item.year || 'Year unknown'} · ${item.source || 'MovieBox'}`;
      btn.append(art,title,meta); btn.onclick=()=>openTitle(item); $('results').append(btn);
    }
    if(saved) {
      const candidates=data.results.filter(item=>item.title===saved.title && item.type===saved.type && (!saved.year || item.year===saved.year));
      const item=(saved.source && candidates.find(x=>x.source===saved.source)) || (candidates.length===1 ? candidates[0] : null);
      if (!item) { showRoute('search'); $('searchError').textContent='Saved title not found unambiguously. Select a result above.'; return; }
      openTitle(item);
    }
  } catch(err) { if(sequence===searchSequence) { if(saved) showRoute('search'); $('searchError').textContent=err.message; $('resultCount').textContent='Search unavailable'; } }
}
$('searchForm').onsubmit=e=>{ e.preventDefault(); showRoute('search'); searchTitles($('query').value.trim()); };
function openTitle(item){ fallback.cancel(); ++resolveSequence; if(hls){hls.destroy();hls=null;} current=null; pendingFailure=null; $('video').pause(); $('video').removeAttribute('src'); $('video').load(); $('video').classList.add('hidden'); $('placeholder').classList.remove('hidden'); $('placeholder').querySelector('p').textContent='Looking for a stream…'; $('playError').textContent=''; showRoute('watch'); selectTitle(item); findStreams(true); }
$('saveTitle').onclick=()=>{ if(!selected) return; const list=load('solo-watchlist'); if (!list.some(x=>x.kind==='catalog' && x.title===selected.title && x.year===selected.year && x.type===selected.type && x.source===selected.source)) list.unshift({kind:'catalog',title:selected.title,year:selected.year,type:selected.type,source:selected.source}); save('solo-watchlist',list); render(); };
$('episodeSelect').onchange=()=>{ const [s,e]=$('episodeSelect').value.split(':').map(Number); if(s && e){ $('season').value=s; $('episode').value=e; } };
async function findStreams(autoplay = false) {
  if(!selected) return; const sequence=++resolveSequence; const chosen=selected; $('playError').textContent=''; $('streams').replaceChildren(); $('findStreams').disabled=true; $('findStreams').textContent='Looking for streams…';
  const season=Number($('season').value), episode=Number($('episode').value);
  try {
    const data=await post('/api/resolve',{id:chosen.id, season, episode});
    if (selected!==chosen || sequence!==resolveSequence) return;
    $('providersNotice').textContent=data.providers.map(p=>`${p.provider}: ${p.count ? p.count+' stream(s)' : (p.error || 'no streams')}`).join(' · ');
    const items=data.streams.map(stream=>({title:`${data.title}${chosen.type === 'series' ? ` S${season} E${episode}` : ''}`,proxy:stream.url,format:stream.format,subtitleRequest:chosen.source==='kisskh'?{path:'/api/kiss-subtitle',data:{id:chosen.id,season,episode}}:stream.captionId?{path:stream.provider.startsWith('movy:')?'/api/movy-subtitle':stream.provider==='7movies'?'/api/vidlink-subtitle':'/api/moviebox-subtitle',data:{id:stream.captionId}}:null,progressKey:`${chosen.source}:${chosen.title}:${chosen.year}:${chosen.type}:${season}:${episode}`,provider:stream.provider,quality:stream.quality,context:chosen.type==='series'?{id:chosen.id,season,episode}:null}));
    items.sort((a,b)=>(a.quality || Infinity)-(b.quality || Infinity)); items.forEach(item=>{item.variants=items;});
    for(let i=0;i<items.length;i++){
      const item=items[i], btn=document.createElement('button'); btn.textContent=`${item.provider} · ${item.quality ? item.quality+'p' : 'Auto'} · ${item.format.toUpperCase()}`;
      btn.onclick=()=>fallback.play([item,...items.filter((_,n)=>n!==i)]);
      $('streams').append(btn);
    }
    if(items.length){ const auto=document.createElement('button'); auto.textContent='Play automatically →'; auto.onclick=()=>fallback.play(items); $('streams').prepend(auto); if (autoplay) fallback.play(items); } else { $('playError').textContent='No playable streams found for this title or episode. Open Available sources for provider details.'; $('placeholder').querySelector('p').textContent='No stream available'; }

  } catch(err) { if(selected===chosen && sequence===resolveSequence){ $('playError').textContent=err.message; $('placeholder').querySelector('p').textContent='Could not find a stream';} }
  finally { if(sequence===resolveSequence){$('findStreams').disabled=false; $('findStreams').textContent=chosen.type==='series'?'Play selected episode':'Play again';} }
}
$('findStreams').onclick=()=>findStreams(true);

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

const rowLabels = {
  'popular-movies':['Trending & popular movies','Cinemeta popular · not a live trend chart'], 'popular-series':['TV shows','Popular on Cinemeta'],
  'new-movies':['New movies','Current release year'], 'new-series':['New shows','Current release year'],
  'animation':['Cartoons & animation','Popular animated series'], 'anime':['Anime','Popular anime from Cinemeta'], 'top-rated':['Featured movies','Cinemeta featured catalog']
};
function titleCard(item){
  const card=document.createElement('button'); card.type='button'; card.className='catalog-card';
  const art=document.createElement('div'); art.className='catalog-art';
  if(item.poster){ const img=document.createElement('img'); img.loading='lazy'; img.decoding='async'; img.alt=''; img.referrerPolicy='no-referrer'; img.src=item.poster; img.onerror=()=>img.remove(); art.append(img); }
  const fallback=document.createElement('span'); fallback.className='art-fallback'; fallback.textContent=item.title; art.append(fallback);
  const name=document.createElement('strong'); name.textContent=item.title;
  const meta=document.createElement('small'); meta.textContent=`${item.year || 'Year unknown'} · ${item.type==='series'?'Series':'Movie'}`;
  card.append(art,name,meta); card.onclick=()=>{ $('query').value=item.title; showRoute('search'); searchTitles(item.title); }; return card;
}
let discoveryLoading=false, discoveryLoaded=false;
async function loadDiscovery(){
  if(discoveryLoading || discoveryLoaded) return; discoveryLoading=true;
  try {
    const data=await api('/api/discover'); const root=$('catalogRows'); root.replaceChildren();
    for(const section of data.sections){ const info=rowLabels[section.id]; if(!info) continue;
      const row=document.createElement('section'); row.className='catalog-section'; row.id=section.id;
      const heading=document.createElement('div'); heading.className='row-head'; const title=document.createElement('h2'); title.textContent=info[0]; const note=document.createElement('span'); note.textContent=info[1]; heading.append(title,note); row.append(heading);
      const rail=document.createElement('div'); rail.className='catalog-rail'; rail.setAttribute('role','group'); rail.setAttribute('aria-label',info[0]); rail.tabIndex=0;
      for(const item of section.items) rail.append(titleCard(item)); if(!section.items.length){ const empty=document.createElement('p'); empty.className='catalog-status'; empty.textContent=section.error || 'No titles available right now.'; rail.append(empty); }
      row.append(rail); root.append(row);
    }
    showRoute(route,false); discoveryLoaded=data.sections.every(section=>!section.error);
    if(!discoveryLoaded){ const retry=document.createElement('button'); retry.className='secondary'; retry.textContent='Retry unavailable catalogs'; retry.onclick=loadDiscovery; root.append(retry); }
  } catch { $('catalogRows').replaceChildren(); for(const id of ['popular-movies','popular-series']) {const anchor=document.createElement('div'); anchor.id=id; $('catalogRows').append(anchor);} const note=document.createElement('p'); note.className='catalog-status'; note.textContent='Catalog unavailable. Search is still available.'; const retry=document.createElement('button'); retry.className='secondary'; retry.textContent='Retry unavailable catalogs'; retry.onclick=loadDiscovery; $('catalogRows').append(note,retry); }
  finally {discoveryLoading=false;}
}
