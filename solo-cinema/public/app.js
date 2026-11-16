'use strict';
const $ = id => document.getElementById(id);
let hls = null, current = null, lastSave = 0, selected = null;
const load = key => { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } };
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
async function api(url, options = {}) {
  const response = await fetch(url, options); const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed'); return result;
}
const post = (url, data) => api(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(data) });
function loggedIn(on) { $('login').classList.toggle('hidden', on); $('app').classList.toggle('hidden', !on); $('logout').classList.toggle('hidden', !on); if (on) render(); }
$('loginForm').onsubmit = async e => { e.preventDefault(); $('loginError').textContent = ''; try { await post('/api/login', {password:$('password').value}); $('password').value=''; loggedIn(true); } catch (err) { $('loginError').textContent=err.message; } };
$('logout').onclick = async () => { await post('/api/logout', {}); if (hls) hls.destroy(); $('video').pause(); $('video').removeAttribute('src'); $('video').load(); loggedIn(false); };
function render() {
  const list=load('solo-watchlist'); $('empty').classList.toggle('hidden', list.length > 0); $('list').replaceChildren();
  list.forEach((item, index) => { const div=document.createElement('div'); div.className='item'; const title=document.createElement('strong'); title.textContent=item.title; const note=document.createElement('small'); note.textContent=item.kind==='catalog' ? `${item.type} · ${item.year || 'year unknown'}` : 'Saved stream'; const play=document.createElement('button'); play.textContent='Play'; play.onclick=()=>{ if(item.kind==='catalog'){ $('query').value=item.title; $('searchForm').requestSubmit(); window.scrollTo({top:0,behavior:'smooth'}); } else playItem(item); }; const del=document.createElement('button'); del.className='secondary'; del.textContent='Remove'; del.onclick=()=>{ list.splice(index,1); save('solo-watchlist',list); render(); }; div.append(title,note,play,del); $('list').append(div); });
}
function formItem() { return { title:$('title').value.trim(), url:$('url').value.trim(), format:$('format').value }; }
$('save').onclick=()=>{ if (!$('sourceForm').reportValidity()) return; const item=formItem(), list=load('solo-watchlist'); if (!list.some(x=>x.kind!=='catalog' && x.url===item.url)) list.unshift(item); save('solo-watchlist', list); render(); };
$('sourceForm').onsubmit=e=>{ e.preventDefault(); playItem(formItem()); };
async function playItem(item) {
  $('playError').textContent=''; $('playing').textContent='Preparing…';
  try {
    const url = item.proxy || (await post('/api/source', {url:item.url, format:item.format})).url;
    current=item; const video=$('video'); if (hls) { hls.destroy(); hls=null; } video.pause(); video.removeAttribute('src'); video.load();
    $('quality').replaceChildren(new Option('Auto', '-1')); $('subtitles').replaceChildren(new Option('Off', '-1')); $('audio').replaceChildren(new Option('Default', '-1')); $('placeholder').classList.add('hidden'); video.classList.remove('hidden'); $('playing').textContent=item.title;
    const resume=()=>{ const progress=load('solo-progress'); const match=progress.find(x=>x.url===(item.progressKey || item.url)); if(match && match.time>5 && Number.isFinite(video.duration) && match.time<video.duration-10) video.currentTime=match.time; };
    video.addEventListener('loadedmetadata', resume, {once:true});
    // hls.js can detect a playlist whose URL itself is opaque.
    if (item.format === 'hls' && Hls.isSupported()) {
      hls=new Hls(); hls.loadSource(url); hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data)=>{ data.levels.forEach((level,i)=>$('quality').add(new Option(`${level.height || '?'}p${level.bitrate ? ' · '+Math.round(level.bitrate/1000)+' kbps':''}`, String(i)))); video.play().catch(()=>{}); });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event,data)=>{ $('subtitles').replaceChildren(new Option('Off', '-1')); (data.subtitleTracks || []).forEach((track,i)=>$('subtitles').add(new Option(track.name || track.lang || `Track ${i+1}`, String(i)))); });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event,data)=>{ $('audio').replaceChildren(new Option('Default', '-1')); (data.audioTracks || []).forEach((track,i)=>$('audio').add(new Option(track.name || track.lang || `Track ${i+1}`, String(i)))); });
      hls.on(Hls.Events.ERROR, (_event,data)=>{ if(data.fatal) $('playError').textContent='Playback failed: '+data.details; });
    } else { video.src=url; video.play().catch(()=>{}); }
  } catch(e) { $('playing').textContent='Nothing playing yet'; $('playError').textContent=e.message; }
}
$('quality').onchange=()=>{ if(hls) hls.currentLevel=Number($('quality').value); };
$('subtitles').onchange=()=>{ if(hls) hls.subtitleTrack=Number($('subtitles').value); };
$('audio').onchange=()=>{ if(hls && Number($('audio').value)>=0) hls.audioTrack=Number($('audio').value); };
$('video').ontimeupdate=()=>{ if(!current || Date.now()-lastSave<5000) return; lastSave=Date.now(); const key=current.progressKey || current.url; const progress=load('solo-progress').filter(x=>x.url!==key); progress.unshift({url:key,time:$('video').currentTime}); save('solo-progress', progress.slice(0,100)); };
$('video').onerror=()=>{ if(current) $('playError').textContent='The stream could not be played. Check the URL and browser format support.'; };
api('/api/session').then(x=>loggedIn(x.authenticated)).catch(()=>loggedIn(false));

$('searchForm').onsubmit = async e => {
  e.preventDefault(); $('searchError').textContent=''; $('results').replaceChildren(); $('selection').classList.add('hidden'); $('streams').replaceChildren();
  try {
    const data=await post('/api/search', {query:$('query').value.trim()});
    if(!data.results.length) { $('searchError').textContent='No titles found.'; return; }
    for(const item of data.results) {
      const btn=document.createElement('button'); btn.className='result';
      const title=document.createElement('strong'); title.textContent=item.title;
      const meta=document.createElement('small'); meta.textContent=`${item.type === 'series' ? 'Series' : 'Movie'} · ${item.year || 'Year unknown'}`;
      btn.append(title,meta); btn.onclick=async()=>{
        selected=item; $('selectedTitle').textContent=item.title; $('overview').textContent=item.overview;
        $('episodeFields').classList.toggle('hidden', item.type!=='series'); $('episodeCatalog').classList.add('hidden'); $('selection').classList.remove('hidden'); $('streams').replaceChildren(); $('providersNotice').textContent=''; $('searchError').textContent='';
        if(item.type==='series') {
          $('episodeNotice').textContent='Loading episode list…'; $('episodeCatalog').classList.remove('hidden'); $('episodeSelect').replaceChildren();
          try { const data=await post('/api/episodes',{id:item.id}); if(selected!==item) return; for(const e of data.episodes){ const option=new Option(`S${e.season} E${e.episode} · ${e.title}`, `${e.season}:${e.episode}`); $('episodeSelect').add(option); } $('episodeNotice').textContent=data.episodes.length ? 'Episode data from TVMaze; you can also enter numbers below.' : 'No episode list available; enter numbers below.'; if(data.episodes.length) $('episodeSelect').dispatchEvent(new Event('change')); } catch { if(selected===item) $('episodeNotice').textContent='Episode list unavailable; enter numbers below.'; }
        }
      }; $('results').append(btn);
    }
  } catch(err) { $('searchError').textContent=err.message; }
};
$('saveTitle').onclick=()=>{ if(!selected) return; const list=load('solo-watchlist'); if (!list.some(x=>x.kind==='catalog' && x.title===selected.title && x.year===selected.year && x.type===selected.type)) list.unshift({kind:'catalog',title:selected.title,year:selected.year,type:selected.type}); save('solo-watchlist',list); render(); };
$('episodeSelect').onchange=()=>{ const [s,e]=$('episodeSelect').value.split(':').map(Number); if(s && e){ $('season').value=s; $('episode').value=e; } };
$('findStreams').onclick=async()=>{
  if(!selected) return; $('searchError').textContent=''; $('streams').replaceChildren(); $('findStreams').disabled=true; $('findStreams').textContent='Looking for streams…';
  const season=Number($('season').value), episode=Number($('episode').value);
  try {
    const data=await post('/api/resolve',{id:selected.id, season, episode});
    $('providersNotice').textContent=data.providers.map(p=>`${p.provider}: ${p.count ? p.count+' stream(s)' : (p.error || 'no streams')}`).join(' · ');
    for(const stream of data.streams){
      const btn=document.createElement('button'); btn.textContent=`${stream.provider} · ${stream.quality ? stream.quality+'p' : 'Auto'} · ${stream.format.toUpperCase()}`;
      btn.onclick=()=>playItem({title:`${data.title}${selected.type === 'series' ? ` S${season} E${episode}` : ''}`,proxy:stream.url,format:stream.format,progressKey:`moviebox:${selected.title}:${selected.year}:${selected.type}:${season}:${episode}`});
      $('streams').append(btn);
    }
  } catch(err) { $('searchError').textContent=err.message; }
  finally { $('findStreams').disabled=false; $('findStreams').textContent='Find available streams →'; }
};
