'use strict';
// Presentation and interaction only; app.js owns sources, fallback, tracks and episodes.
(() => {
  const $=id=>document.getElementById(id), screen=$('screen'), video=$('video'), menu=$('playerMenu'), seek=$('playerSeek'), gesture=$('playerGesture');
  let hideTimer, toastTimer, adjustTimer, tapTimer, lastTap=0, pointer=null, seeking=false, locked=false, brightness=1, wakeLock=null, wakeGeneration=0;
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  const fmt=n=>{if(!Number.isFinite(n)||n<0)return '0:00';n=Math.floor(n);const h=Math.floor(n/3600),m=Math.floor(n/60)%60,s=n%60;return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`;};
  function toast(text){$('playerToast').textContent=text;$('playerToast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('playerToast').classList.remove('visible'),1800);}
  function poke(){screen.classList.remove('player-hide');clearTimeout(hideTimer);hideTimer=setTimeout(()=>{if(!video.paused && menu.classList.contains('hidden') && $('playerEpisodeDrawer').classList.contains('hidden') && !seeking)screen.classList.add('player-hide');},3000);}
  let menuView='main';
  function syncSaver(){$('playerSaver').textContent=`Data saver: ${$('dataSaver').getAttribute('aria-pressed')==='true'?'on':'off'}`;}
  function renderMenu(){
    const rows=$('playerMenuRows');rows.replaceChildren();$('playerSaver').classList.toggle('hidden',menuView!=='main');$('playerAdvanced').classList.toggle('hidden',menuView!=='advanced');
    const row=(label,value,action,selected=false)=>{const button=document.createElement('button');button.type='button';button.className='player-menu-row'+(selected?' selected':'');const name=document.createElement('span');name.textContent=label;const detail=document.createElement('span');detail.textContent=value||'';button.append(name,detail);button.onclick=()=>{action();poke();};rows.append(button);};
    if(menuView==='main'){
      for(const [id,label] of [['quality','Quality'],['speed','Speed'],['subtitles','Subtitles'],['subtitlePosition','Subtitle height']]){const select=$(id);row(label,(select.selectedOptions[0]?.textContent||'Unavailable')+' ›',()=>{menuView=id;renderMenu();});}
      row('Audio tracks',($('audio').selectedOptions[0]?.textContent||'Default')+' ›',()=>{menuView='audio';renderMenu();});
      row('Sources',($('server').selectedOptions[0]?.textContent||'Unavailable')+' ›',()=>{menuView='server';renderMenu();});
      row('More settings','›',()=>{menuView='advanced';renderMenu();});
    }else{
      row('‹ Back','',()=>{menuView='main';renderMenu();});
      if(menuView==='tracks'){
        for(const [id,label] of [['audio','Audio'],['subtitles','Subtitles'],['subtitlePosition','Subtitle height'],['subtitleSize','Subtitle size'],['subtitleColor','Subtitle color']]){const select=$(id);row(label,(select.selectedOptions[0]?.textContent||'Unavailable')+' ›',()=>{menuView=id;renderMenu();});}
        row('Upload subtitles','›',()=>{menuView='advanced';renderMenu();});
      }else if(menuView!=='advanced'){
        const select=$(menuView);for(const option of select.options){row(option.textContent,'',()=>{select.value=option.value;select.dispatchEvent(new Event('change'));menuView='main';renderMenu();},select.value===option.value);}
        if(menuView==='server'){
          const buttons=[...$('streams').querySelectorAll('button')];for(const source of buttons)row(source.textContent,'',()=>{closeMenu();source.click();});
          if(!$('selection').classList.contains('hidden'))row('Find sources again','↻',()=>{closeMenu();$('findStreams').click();});
        }
      }
    }
    syncSaver();
  }
  function closeMenu(){menu.classList.add('hidden');$('playerSettings').setAttribute('aria-expanded','false');menuView='main';}
  $('playerSettings').onclick=()=>{$('playerEpisodeDrawer').classList.add('hidden');if(menu.classList.contains('hidden')){menuView='main';renderMenu();menu.classList.remove('hidden');$('playerSettings').setAttribute('aria-expanded','true');}else closeMenu();poke();};
  $('playerSaver').onclick=()=>{$('dataSaver').click();syncSaver();poke();};
  function openMenu(view){if(!menu.classList.contains('hidden') && menuView===view){closeMenu();poke();return;}menuView=view;renderMenu();menu.classList.remove('hidden');$('playerSettings').setAttribute('aria-expanded','true');$('playerEpisodeDrawer').classList.add('hidden');poke();}
  $('playerSources').onclick=()=>openMenu('server');$('playerSpeed').onclick=()=>openMenu('speed');$('playerTracks').onclick=()=>openMenu('tracks');$('playerQuality').onclick=()=>openMenu('quality');
  function updateLabels(){const source=$('server').selectedOptions[0]?.textContent;const episode=$('episodeFields').classList.contains('hidden')?'':`S${$('season').value} E${$('episode').value}`;$('playerMeta').textContent=[episode,source && source!=='No sources yet'?source:''].filter(Boolean).join(' · ') || 'Troy';$('playerQuality').textContent=$('quality').selectedOptions[0]?.textContent || 'Quality';$('playerSpeed').textContent=`${$('speed').value}×`;$('playerEpisodes').disabled=$('episodeFields').classList.contains('hidden');}
  for(const id of ['server','quality','speed','season','episode'])$(id).addEventListener('change',updateLabels);
  $('episodeSelect').addEventListener('change',()=>queueMicrotask(updateLabels));
  new MutationObserver(updateLabels).observe($('server'),{childList:true,subtree:true});new MutationObserver(updateLabels).observe($('quality'),{childList:true,subtree:true});new MutationObserver(updateLabels).observe($('episodeFields'),{attributes:true,attributeFilter:['class']});updateLabels();
  $('playerAspect').onclick=()=>{const modes=[['Fit','contain'],['Fill','cover'],['Stretch','fill']],index=(modes.findIndex(x=>x[1]===video.style.objectFit)+1)%modes.length;video.style.objectFit=modes[index][1];$('playerAspect').textContent=modes[index][0];poke();};
  if(typeof video.webkitShowPlaybackTargetPicker==='function'){$('playerCast').classList.remove('hidden');$('playerCast').onclick=()=>{try{video.webkitShowPlaybackTargetPicker();}catch{toast('AirPlay is not available');}poke();};}
  function closeEpisodes(){$('playerEpisodeDrawer').classList.add('hidden');poke();}
  $('playerEpisodeClose').onclick=closeEpisodes;
  $('playerEpisodes').onclick=()=>{if(!$('playerEpisodeDrawer').classList.contains('hidden'))return closeEpisodes();closeMenu();const list=$('playerEpisodeList');list.replaceChildren();const select=$('episodeSelect');
    for(const option of select.options){if(!/^\d+:\d+$/.test(option.value))continue;const b=document.createElement('button');b.type='button';b.textContent=option.textContent;b.classList.toggle('selected',option.value===`${$('season').value}:${$('episode').value}`);b.onclick=()=>{select.value=option.value;select.dispatchEvent(new Event('change'));closeEpisodes();$('findStreams').click();};list.append(b);}
    if(!list.children.length){const note=document.createElement('p');note.textContent='Episode list unavailable. Choose a season and episode below.';list.append(note);}
    const group=document.createElement('div');for(const [id,label] of [['season','Season'],['episode','Episode']]){const wrap=document.createElement('label');wrap.textContent=label;const input=document.createElement('input');input.type='number';input.min='1';input.max=id==='season'?'999':'9999';input.value=$(id).value;input.dataset.target=id;wrap.append(input);group.append(wrap);}const go=document.createElement('button');go.type='button';go.textContent='Play selected episode';go.onclick=()=>{for(const input of group.querySelectorAll('input')){if(!input.reportValidity())return;$(input.dataset.target).value=input.value;}closeEpisodes();$('findStreams').click();};group.append(go);list.append(group);$('playerEpisodeDrawer').classList.remove('hidden');poke();};
  const message=$('playerMessage');const syncMessage=()=>{message.textContent=$('playError').textContent;message.classList.toggle('hidden',!message.textContent);};new MutationObserver(syncMessage).observe($('playError'),{childList:true,characterData:true,subtree:true});syncMessage();

  $('playerBack').onclick=()=>{closeMenu();closeEpisodes();if(document.fullscreenElement===screen)document.exitFullscreen?.().catch(()=>{});$('backToSearch').click();};
  async function toggle(){if(video.paused){try{await video.play();}catch{toast('Tap play when a source is ready');}}else video.pause();poke();}
  $('playerPlay').onclick=toggle;
  $('playerFullscreen').onclick=async()=>{try{if(document.fullscreenElement){await document.exitFullscreen();globalThis.screen.orientation?.unlock?.();}else if(screen.requestFullscreen){await screen.requestFullscreen();try{await globalThis.screen.orientation?.lock?.('landscape');}catch{}}else if(video.webkitEnterFullscreen)video.webkitEnterFullscreen();else toast('Fullscreen is not supported');}catch{toast('Fullscreen is not available');}poke();};
  $('playerPip').onclick=async()=>{try{if(document.pictureInPictureElement)await document.exitPictureInPicture();else if(document.pictureInPictureEnabled && video.requestPictureInPicture)await video.requestPictureInPicture();else toast('Picture in picture is not supported');}catch{toast('Picture in picture is not available');}poke();};
  $('playerLock').onclick=()=>{locked=true;screen.classList.add('player-locked');$('playerUnlock').classList.remove('hidden');closeMenu();toast('Controls locked');poke();};
  $('playerUnlock').onclick=()=>{locked=false;screen.classList.remove('player-locked');$('playerUnlock').classList.add('hidden');toast('Unlocked');poke();};
  async function wake(on){const gen=++wakeGeneration;if(!on){const old=wakeLock;wakeLock=null;try{await old?.release();}catch{}return;}if(wakeLock||!navigator.wakeLock||document.hidden)return;try{const lock=await navigator.wakeLock.request('screen');if(gen!==wakeGeneration || video.paused || document.hidden){await lock.release();return;}wakeLock=lock;lock.addEventListener('release',()=>{if(wakeLock===lock)wakeLock=null;});}catch{}}
  video.addEventListener('play',()=>{$('playerPlay').querySelector('path').setAttribute('d','M6 19h4V5H6v14zm8-14v14h4V5h-4z');$('playerPlay').setAttribute('aria-label','Pause');poke();wake(true);});
  video.addEventListener('pause',()=>{$('playerPlay').querySelector('path').setAttribute('d','M8 5v14l11-7z');$('playerPlay').setAttribute('aria-label','Play');screen.classList.remove('player-hide','player-buffering');wake(false);});
  video.addEventListener('waiting',()=>screen.classList.add('player-buffering'));video.addEventListener('playing',()=>screen.classList.remove('player-buffering'));
  document.addEventListener('visibilitychange',()=>{if(document.hidden)wake(false);else if(!video.paused)wake(true);});
  const timelineDuration=()=>window.troyTimeline?.duration() ?? video.duration;
  const timelineTime=()=>window.troyTimeline?.time() ?? video.currentTime;
  function updateTime(){const d=timelineDuration(),t=timelineTime(),p=Number.isFinite(d)&&d>0?clamp(t/d,0,1):0;$('playerCurrent').textContent=fmt(t);$('playerDuration').textContent=fmt(d);if(!seeking)seek.value=String(Math.round(p*1000));$('playerProgress').style.width=`${p*100}%`;}
  video.addEventListener('timeupdate',updateTime);video.addEventListener('durationchange',updateTime);video.addEventListener('emptied',()=>{updateTime();$('playerBuffer').style.width='0%';});
  video.addEventListener('progress',()=>{const b=video.buffered,d=timelineDuration(),base=timelineTime()-video.currentTime;let end=0;if(Number.isFinite(d)&&d>0)for(let i=0;i<b.length;i++)if(b.start(i)<=video.currentTime && b.end(i)>=video.currentTime){end=base+b.end(i);break;}$('playerBuffer').style.width=`${d>0?clamp(end/d*100,0,100):0}%`;});
  seek.addEventListener('input',()=>{const d=timelineDuration();if(!Number.isFinite(d)||d<=0)return;seeking=true;const p=Number(seek.value)/1000;$('playerProgress').style.width=`${p*100}%`;$('playerCurrent').textContent=fmt(p*d);poke();});
  seek.addEventListener('change',()=>{const d=timelineDuration();if(Number.isFinite(d)&&d>0){const t=Number(seek.value)/1000*d;if(window.troyTimeline)window.troyTimeline.seek(t);else video.currentTime=t;}seeking=false;updateTime();poke();});
  screen.addEventListener('mousemove',()=>{if(!locked)poke();});
  function showAdjust(which){const el=$(which==='brightness'?'brightnessIndicator':'volumeIndicator');$('brightnessIndicator').classList.remove('visible');$('volumeIndicator').classList.remove('visible');el.classList.add('visible');screen.classList.remove('player-hide');clearTimeout(adjustTimer);adjustTimer=setTimeout(()=>{el.classList.remove('visible');poke();},700);}
  function setBrightness(n){brightness=clamp(n,.15,1);$('playerDim').style.opacity=String(1-brightness);$('brightnessFill').style.height=`${(brightness-.15)/.85*100}%`;$('brightnessSlider').value=String(Math.round(brightness*100));$('brightnessValue').textContent=`${Math.round(brightness*100)}%`;}
  function setVolume(n){video.volume=clamp(n,0,1);video.muted=false;$('volumeFill').style.height=`${video.volume*100}%`;$('volumeSlider').value=String(Math.round(video.volume*100));$('volumeValue').textContent=`${Math.round(video.volume*100)}%`;}
  $('brightnessSlider').addEventListener('input',()=>{setBrightness(Number($('brightnessSlider').value)/100);poke();});$('volumeSlider').addEventListener('input',()=>{setVolume(Number($('volumeSlider').value)/100);poke();});video.addEventListener('volumechange',()=>{$('volumeSlider').value=String(Math.round(video.volume*100));$('volumeValue').textContent=video.muted?'Muted':`${Math.round(video.volume*100)}%`;});
  function ripple(id){const el=$(id);el.classList.remove('go');void el.offsetWidth;el.classList.add('go');}
  gesture.addEventListener('pointerdown',e=>{if(e.button!==0 && e.pointerType==='mouse')return;gesture.setPointerCapture?.(e.pointerId);const r=screen.getBoundingClientRect();if(!r.width||!r.height)return;pointer={id:e.pointerId,x:e.clientX,y:e.clientY,rx:(e.clientX-r.left)/r.width,h:r.height,side:e.clientX-r.left<r.width/2?'brightness':'volume',moved:false};});
  gesture.addEventListener('pointermove',e=>{if(!pointer||pointer.id!==e.pointerId||locked)return;const g=pointer,dy=g.y-e.clientY;if(!g.moved&&Math.abs(dy)>12&&Math.abs(dy)>Math.abs(e.clientX-g.x)){g.moved=true;g.start=g.side==='brightness'?brightness:video.volume;g.y0=e.clientY;}if(!g.moved)return;const d=(g.y0-e.clientY)/(g.h*.7);g.side==='brightness'?setBrightness(g.start+d*.85):setVolume(g.start+d);showAdjust(g.side);});
  gesture.addEventListener('pointercancel',()=>{pointer=null;});
  gesture.addEventListener('pointerup',e=>{if(!pointer||pointer.id!==e.pointerId)return;const g=pointer;pointer=null;if(g.moved)return;if(!menu.classList.contains('hidden')){closeMenu();poke();return;}if(locked){poke();return;}const now=Date.now();if(now-lastTap<300){clearTimeout(tapTimer);lastTap=0;if(g.rx<.35){$('back10').click();ripple('rippleLeft');}else if(g.rx>.65){$('forward10').click();ripple('rippleRight');}else toggle();poke();}else{lastTap=now;tapTimer=setTimeout(()=>{if(screen.classList.contains('player-hide'))poke();else screen.classList.add('player-hide');},250);}});
  document.addEventListener('keydown',e=>{if($('view-watch').classList.contains('hidden')||locked||e.ctrlKey||e.metaKey||e.altKey||/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)||e.target.isContentEditable)return;const k=e.key.toLowerCase();if(k===' '||k==='k'){e.preventDefault();toggle();}else if(k==='arrowleft')$('back10').click();else if(k==='arrowright')$('forward10').click();else if(k==='arrowup'||k==='arrowdown'){e.preventDefault();setVolume(video.volume+(k==='arrowup'?.1:-.1));showAdjust('volume');}else if(k==='f')$('playerFullscreen').click();else if(k==='m')video.muted=!video.muted;else return;poke();});
  document.addEventListener('fullscreenchange',()=>poke());
})();
