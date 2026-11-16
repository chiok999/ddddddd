'use strict';
const $ = id => document.getElementById(id);
let hls = null, current = null, lastSave = 0, selected = null, externalTrack = null, pendingFailure = null, searchSequence = 0;
const load = key => { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } };
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
async function api(url, options = {}) {
  const response = await fetch(url, options); const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed'); return result;
}
const post = (url, data) => api(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(data) });
function loggedIn(on) { $('login').classList.toggle('hidden', on); $('app').classList.toggle('hidden', !on); $('logout').classList.toggle('hidden', !on); if (on) render(); }
$('loginForm').onsubmit = async e => { e.preventDefault(); $('loginError').textContent = ''; try { await post('/api/login', {password:$('password').value}); $('password').value=''; loggedIn(true); } catch (err) { $('loginError').textContent=err.message; } };
$('logout').onclick = async () => { fallback.cancel(); current=null; pendingFailure=null; await post('/api/logout', {}); if (hls) hls.destroy(); $('video').pause(); $('video').removeAttribute('src'); $('video').load(); loggedIn(false); };
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
    current=item; pendingFailure=null; const video=$('video'); video.querySelectorAll('track').forEach(track=>track.remove()); externalTrack=null; if (hls) { hls.destroy(); hls=null; } video.pause(); video.removeAttribute('src'); video.load();
    $('quality').replaceChildren(new Option('Auto', '-1')); $('subtitles').replaceChildren(new Option('Off', '-1')); $('audio').replaceChildren(new Option('Default', '-1')); $('placeholder').classList.add('hidden'); video.classList.remove('hidden'); $('playing').textContent=item.title;
    const resume=()=>{ const progress=load('solo-progress'); const match=progress.find(x=>x.url===(item.progressKey || item.url)); if(match && match.time>5 && Number.isFinite(video.duration) && match.time<video.duration-10) video.currentTime=match.time; };
    video.onloadedmetadata=resume; pendingFailure=fail;
    if (item.subtitleRequest) {
      post('/api/kiss-subtitle',item.subtitleRequest).then(result=>{
        if (!result.url || current!==item) return;
        const track=document.createElement('track'); track.kind='subtitles'; track.label='English (KissKh)'; track.srclang='en'; track.src=result.url; track.default=true; video.append(track); externalTrack=track; $('subtitles').add(new Option('English (KissKh)', 'external')); $('subtitles').value='external'; track.addEventListener('load',()=>{ if (current===item && $('subtitles').value==='external') track.track.mode='showing'; });
      }).catch(()=>{});
    }
    // hls.js can detect a playlist whose URL itself is opaque.
    if (item.format === 'hls' && Hls.isSupported()) {
      hls=new Hls(); hls.loadSource(url); hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data)=>{ data.levels.forEach((level,i)=>$('quality').add(new Option(`${level.height || '?'}p${level.bitrate ? ' · '+Math.round(level.bitrate/1000)+' kbps':''}`, String(i)))); video.play().catch(()=>{}); });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event,data)=>{ $('subtitles').replaceChildren(new Option('Off', '-1')); (data.subtitleTracks || []).forEach((track,i)=>$('subtitles').add(new Option(track.name || track.lang || `Track ${i+1}`, String(i)))); if(externalTrack){ $('subtitles').add(new Option('English (KissKh)','external')); $('subtitles').value='external'; } });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event,data)=>{ $('audio').replaceChildren(new Option('Default', '-1')); (data.audioTracks || []).forEach((track,i)=>$('audio').add(new Option(track.name || track.lang || `Track ${i+1}`, String(i)))); });
      hls.on(Hls.Events.ERROR, (_event,data)=>{ if(data.fatal && current===item && pendingFailure===fail) { pendingFailure=null; fail(); } });
    } else { video.src=url; video.play().catch(()=>{}); }
  } catch(e) { if(isActive()) { pendingFailure=null; fail(); } }
}
$('quality').onchange=()=>{ if(hls) hls.currentLevel=Number($('quality').value); };
$('subtitles').onchange=()=>{ const value=$('subtitles').value; if(externalTrack) externalTrack.track.mode=value==='external'?'showing':'disabled'; if(hls) hls.subtitleTrack=value==='external'?-1:Number(value); };
$('audio').onchange=()=>{ if(hls && Number($('audio').value)>=0) hls.audioTrack=Number($('audio').value); };
$('video').ontimeupdate=()=>{ if(!current || Date.now()-lastSave<5000) return; lastSave=Date.now(); const key=current.progressKey || current.url; const progress=load('solo-progress').filter(x=>x.url!==key); progress.unshift({url:key,time:$('video').currentTime}); save('solo-progress', progress.slice(0,100)); };
$('video').onerror=()=>{ if(current && pendingFailure && $('video').currentSrc) { const fail=pendingFailure; pendingFailure=null; fail(); } };
api('/api/session').then(x=>loggedIn(x.authenticated)).catch(()=>loggedIn(false));

async function selectTitle(item) {
  selected=item; $('selectedTitle').textContent=item.title; $('overview').textContent=item.overview;
  $('episodeFields').classList.toggle('hidden', item.type!=='series'); $('episodeCatalog').classList.add('hidden'); $('selection').classList.remove('hidden'); $('streams').replaceChildren(); $('providersNotice').textContent='';
  if(item.type==='series') {
    $('season').value='1'; $('episode').value='1';
    $('episodeNotice').textContent='Loading episode list…'; $('episodeCatalog').classList.remove('hidden'); $('episodeSelect').replaceChildren();
    try { const data=await post('/api/episodes',{id:item.id}); if(selected!==item) return; for(const e of data.episodes){ const option=new Option(`S${e.season} E${e.episode} · ${e.title}`, `${e.season}:${e.episode}`); $('episodeSelect').add(option); } $('episodeNotice').textContent=data.episodes.length ? `Episode data from ${data.source}; you can also enter numbers below.` : 'No episode list available; enter numbers below.'; if(data.episodes.length) $('episodeSelect').dispatchEvent(new Event('change')); } catch { if(selected===item) $('episodeNotice').textContent='Episode list unavailable; enter numbers below.'; }
  }
}
async function searchTitles(query, saved = null) {
  const sequence=++searchSequence; selected=null; $('searchError').textContent=''; $('results').replaceChildren(); $('selection').classList.add('hidden'); $('streams').replaceChildren();
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
  if(!selected) return; const chosen=selected; $('searchError').textContent=''; $('streams').replaceChildren(); $('findStreams').disabled=true; $('findStreams').textContent='Looking for streams…';
  const season=Number($('season').value), episode=Number($('episode').value);
  try {
    const data=await post('/api/resolve',{id:chosen.id, season, episode});
    if (selected!==chosen) return;
    $('providersNotice').textContent=data.providers.map(p=>`${p.provider}: ${p.count ? p.count+' stream(s)' : (p.error || 'no streams')}`).join(' · ');
    const items=data.streams.map(stream=>({title:`${data.title}${chosen.type === 'series' ? ` S${season} E${episode}` : ''}`,proxy:stream.url,format:stream.format,subtitleRequest:chosen.source==='kisskh'?{id:chosen.id,season,episode}:null,progressKey:`${chosen.source}:${chosen.title}:${chosen.year}:${chosen.type}:${season}:${episode}`,provider:stream.provider,quality:stream.quality}));
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
