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
  list.forEach((item, index) => { const div=document.createElement('div'); div.className='item'; const title=document.createElement('strong'); title.textContent=item.title; const note=document.createElement('small'); note.textContent='Saved stream'; const play=document.createElement('button'); play.textContent='Play'; play.onclick=()=>playItem(item); const del=document.createElement('button'); del.className='secondary'; del.textContent='Remove'; del.onclick=()=>{ list.splice(index,1); save('solo-watchlist',list); render(); }; div.append(title,note,play,del); $('list').append(div); });
}
function formItem() { return { title:$('title').value.trim(), url:$('url').value.trim(), format:$('format').value }; }
$('save').onclick=()=>{ if (!$('sourceForm').reportValidity()) return; const item=formItem(), list=load('solo-watchlist'); if (!list.some(x=>x.url===item.url)) list.unshift(item); save('solo-watchlist', list); render(); };
$('sourceForm').onsubmit=e=>{ e.preventDefault(); playItem(formItem()); };
async function playItem(item) {
  $('playError').textContent=''; $('playing').textContent='Preparing…';
  try {
    const url = item.proxy || (await post('/api/source', {url:item.url, format:item.format})).url;
    current=item; const video=$('video'); if (hls) { hls.destroy(); hls=null; } video.pause(); video.removeAttribute('src'); video.load();
    $('quality').replaceChildren(new Option('Auto', '-1')); $('placeholder').classList.add('hidden'); video.classList.remove('hidden'); $('playing').textContent=item.title;
    const resume=()=>{ const progress=load('solo-progress'); const match=progress.find(x=>x.url===(item.progressKey || item.url)); if(match && match.time>5 && Number.isFinite(video.duration) && match.time<video.duration-10) video.currentTime=match.time; };
    video.addEventListener('loadedmetadata', resume, {once:true});
    // hls.js can detect a playlist whose URL itself is opaque.
    if (item.format === 'hls' && Hls.isSupported()) {
      hls=new Hls(); hls.loadSource(url); hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data)=>{ data.levels.forEach((level,i)=>$('quality').add(new Option(`${level.height || '?'}p${level.bitrate ? ' · '+Math.round(level.bitrate/1000)+' kbps':''}`, String(i)))); video.play().catch(()=>{}); });
      hls.on(Hls.Events.ERROR, (_event,data)=>{ if(data.fatal) $('playError').textContent='Playback failed: '+data.details; });
    } else { video.src=url; video.play().catch(()=>{}); }
  } catch(e) { $('playing').textContent='Nothing playing yet'; $('playError').textContent=e.message; }
}
$('quality').onchange=()=>{ if(hls) hls.currentLevel=Number($('quality').value); };
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
      btn.append(title,meta); btn.onclick=()=>{
        selected=item; $('selectedTitle').textContent=item.title; $('overview').textContent=item.overview;
        $('episodeFields').classList.toggle('hidden', item.type!=='series'); $('selection').classList.remove('hidden'); $('streams').replaceChildren(); $('searchError').textContent='';
      }; $('results').append(btn);
    }
  } catch(err) { $('searchError').textContent=err.message; }
};
$('findStreams').onclick=async()=>{
  if(!selected) return; $('searchError').textContent=''; $('streams').replaceChildren(); $('findStreams').disabled=true; $('findStreams').textContent='Looking for streams…';
  const season=Number($('season').value), episode=Number($('episode').value);
  try {
    const data=await post('/api/resolve',{id:selected.id, season, episode});
    for(const stream of data.streams){
      const btn=document.createElement('button'); btn.textContent=`${stream.quality ? stream.quality+'p' : 'Auto'} · ${stream.format.toUpperCase()}`;
      btn.onclick=()=>playItem({title:`${data.title}${selected.type === 'series' ? ` S${season} E${episode}` : ''}`,proxy:stream.url,format:stream.format,progressKey:`moviebox:${selected.title}:${selected.year}:${selected.type}:${season}:${episode}`});
      $('streams').append(btn);
    }
  } catch(err) { $('searchError').textContent=err.message; }
  finally { $('findStreams').disabled=false; $('findStreams').textContent='Find available streams →'; }
};
