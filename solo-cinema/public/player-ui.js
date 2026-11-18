'use strict';
// Presentation and interaction only; app.js owns sources, fallback, tracks and episodes.
(() => {
  const $=id=>document.getElementById(id), screen=$('screen'), video=$('video'), menu=$('playerMenu'), seek=$('playerSeek'), gesture=$('playerGesture');
  let hideTimer, toastTimer, adjustTimer, tapTimer, lastTap=0, pointer=null, seeking=false, locked=false, brightness=1, wakeLock=null, wakeGeneration=0;
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));

  // The frame follows the picture, the way a desktop player does. Telling
  // portrait from landscape is what decides whether the width or the height
  // drives the layout, so it is worked out here rather than in the stylesheet.
  // A near-16:9 source is left alone: snapping it to the default avoids a
  // visible resize for the common case and for odd anamorphic sizes.
  const DEFAULT_RATIO = 16/9;
  const RATIO_TOLERANCE = 0.02;
  function resetFrameRatio() {
    screen.style.removeProperty('--player-ratio');
    screen.classList.remove('portrait');
  }
  function setFrameRatio(width, height) {
    const ratio = width > 0 && height > 0 ? width / height : 0;
    if (!Number.isFinite(ratio) || ratio <= 0) { resetFrameRatio(); return; }
    if (Math.abs(ratio - DEFAULT_RATIO) < RATIO_TOLERANCE) { resetFrameRatio(); return; }
    screen.style.setProperty('--player-ratio', `${width} / ${height}`);
    screen.classList.toggle('portrait', ratio < 1);
  }
  const syncFrameRatio = () => setFrameRatio(video.videoWidth, video.videoHeight);
  video.addEventListener('loadedmetadata', syncFrameRatio);
  // A browser can learn the size after metadata, and a source switch can change
  // it, so both are followed rather than only the first.
  video.addEventListener('resize', syncFrameRatio);
  video.addEventListener('emptied', resetFrameRatio);
  const fmt=n=>{if(!Number.isFinite(n)||n<0)return '0:00';n=Math.floor(n);const h=Math.floor(n/3600),m=Math.floor(n/60)%60,s=n%60;return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`;};
  function toast(text){$('playerToast').textContent=text;$('playerToast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('playerToast').classList.remove('visible'),1800);}
  function poke(){screen.classList.remove('player-hide');clearTimeout(hideTimer);hideTimer=setTimeout(()=>{if(!video.paused && menu.classList.contains('hidden') && !seeking)screen.classList.add('player-hide');},3000);}
  let menuView='main';
  function syncSaver(){$('playerSaver').textContent=`Data saver: ${$('dataSaver').getAttribute('aria-pressed')==='true'?'on':'off'}`;}
  function renderMenu(){
    const rows=$('playerMenuRows');rows.replaceChildren();$('playerSaver').classList.toggle('hidden',menuView!=='main');$('playerAdvanced').classList.toggle('hidden',menuView!=='advanced');
    const row=(label,value,action,selected=false)=>{const button=document.createElement('button');button.type='button';button.className='player-menu-row'+(selected?' selected':'');const name=document.createElement('span');name.textContent=label;const detail=document.createElement('span');detail.textContent=value||'';button.append(name,detail);button.onclick=()=>{action();poke();};rows.append(button);};
    if(menuView==='main'){
      for(const [id,label] of [['quality','Quality'],['speed','Speed'],['subtitles','Subtitles'],['subtitlePosition','Subtitle height']]){const select=$(id);row(label,(select.selectedOptions[0]?.textContent||'Unavailable')+' ›',()=>{menuView=id;renderMenu();});}
      row('More settings','›',()=>{menuView='advanced';renderMenu();});
    }else{
      row('‹ Back','',()=>{menuView='main';renderMenu();});
      if(menuView!=='advanced'){const select=$(menuView);for(const option of select.options){row(option.textContent,'',()=>{select.value=option.value;select.dispatchEvent(new Event('change'));menuView='main';renderMenu();},select.value===option.value);}}
    }
    syncSaver();
  }
  function closeMenu(){menu.classList.add('hidden');$('playerSettings').setAttribute('aria-expanded','false');menuView='main';}
  $('playerSettings').onclick=()=>{if(menu.classList.contains('hidden')){menuView='main';renderMenu();menu.classList.remove('hidden');$('playerSettings').setAttribute('aria-expanded','true');}else closeMenu();poke();};
  $('playerSaver').onclick=()=>{$('dataSaver').click();syncSaver();poke();};
  $('playerBack').onclick=()=>{closeMenu();if(document.fullscreenElement===screen)document.exitFullscreen?.().catch(()=>{});$('backToSearch').click();};
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
  // The brightness/volume pills are transient: they exist for the length of a
  // gesture and must never outlive it. A stale `visible` class is what left a
  // 100% brightness pill sitting over a video that had failed to start.
  const adjustPills = ['brightnessIndicator','volumeIndicator'];
  function hideAdjust(){for(const id of adjustPills) $(id).classList.remove('visible');}
  function showAdjust(which){
    hideAdjust();
    $(which==='brightness'?'brightnessIndicator':'volumeIndicator').classList.add('visible');
    screen.classList.remove('player-hide');
    clearTimeout(adjustTimer);
    adjustTimer=setTimeout(()=>{hideAdjust();poke();},700);
  }
  // Playback stopping is the end of any gesture in progress.
  video.addEventListener('emptied',hideAdjust);
  video.addEventListener('error',hideAdjust);
  function setBrightness(n){brightness=clamp(n,.15,1);$('playerDim').style.opacity=String(1-brightness);$('brightnessFill').style.height=`${(brightness-.15)/.85*100}%`;}
  function setVolume(n){video.volume=clamp(n,0,1);video.muted=false;$('volumeFill').style.height=`${video.volume*100}%`;}
  function ripple(id){const el=$(id);el.classList.remove('go');void el.offsetWidth;el.classList.add('go');}
  gesture.addEventListener('pointerdown',e=>{if(e.button!==0 && e.pointerType==='mouse')return;gesture.setPointerCapture?.(e.pointerId);const r=screen.getBoundingClientRect();if(!r.width||!r.height)return;pointer={id:e.pointerId,x:e.clientX,y:e.clientY,rx:(e.clientX-r.left)/r.width,h:r.height,side:e.clientX-r.left<r.width/2?'brightness':'volume',moved:false};});
  gesture.addEventListener('pointermove',e=>{if(!pointer||pointer.id!==e.pointerId||locked)return;const g=pointer,dy=g.y-e.clientY;if(!g.moved&&Math.abs(dy)>12&&Math.abs(dy)>Math.abs(e.clientX-g.x)){g.moved=true;g.start=g.side==='brightness'?brightness:video.volume;g.y0=e.clientY;}if(!g.moved)return;const d=(g.y0-e.clientY)/(g.h*.7);g.side==='brightness'?setBrightness(g.start+d*.85):setVolume(g.start+d);showAdjust(g.side);});
  gesture.addEventListener('pointercancel',()=>{pointer=null;});
  gesture.addEventListener('pointerup',e=>{if(!pointer||pointer.id!==e.pointerId)return;const g=pointer;pointer=null;if(g.moved)return;if(!menu.classList.contains('hidden')){closeMenu();poke();return;}if(locked){poke();return;}const now=Date.now();if(now-lastTap<300){clearTimeout(tapTimer);lastTap=0;if(g.rx<.35){$('back10').click();ripple('rippleLeft');}else if(g.rx>.65){$('forward10').click();ripple('rippleRight');}else toggle();poke();}else{lastTap=now;tapTimer=setTimeout(()=>{if(screen.classList.contains('player-hide'))poke();else screen.classList.add('player-hide');},250);}});
  document.addEventListener('keydown',e=>{if($('view-watch').classList.contains('hidden')||locked||e.ctrlKey||e.metaKey||e.altKey||/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)||e.target.isContentEditable)return;const k=e.key.toLowerCase();if(k===' '||k==='k'){e.preventDefault();toggle();}else if(k==='arrowleft')$('back10').click();else if(k==='arrowright')$('forward10').click();else if(k==='arrowup'||k==='arrowdown'){e.preventDefault();setVolume(video.volume+(k==='arrowup'?.1:-.1));showAdjust('volume');}else if(k==='f')$('playerFullscreen').click();else if(k==='m')video.muted=!video.muted;else return;poke();});
  document.addEventListener('fullscreenchange',()=>poke());
})();
