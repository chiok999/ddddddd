'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path');
const { JSDOM }=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('UI searches, lists sources, and switches after fatal playback errors', async () => {
  const html=fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8');
  const dom=new JSDOM(html,{url:'https://cinema.example/',runScripts:'outside-only'});
  const w=dom.window; w.scrollTo=()=>{}; const instances=[];
  w.HTMLMediaElement.prototype.pause=function(){}; w.HTMLMediaElement.prototype.load=function(){}; w.HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
  class Hls { constructor(){this.listeners={}; instances.push(this);} static isSupported(){return true;} loadSource(url){this.url=url;} attachMedia(){} on(event,cb){this.listeners[event]=cb;} destroy(){} emit(event,data){this.listeners[event]?.(event,data);} }
  Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'}; w.Hls=Hls;
  w.fetch=async (url,opts={})=>({ok:true,json:async()=>{
    if(url==='/api/session') return {authenticated:true};
    if(url==='/api/search') return {results:[{id:'a',title:'Test Movie',type:'movie',source:'moviebox',year:'2024',overview:''}],providers:[]};
    if(url==='/api/resolve') return {title:'Test Movie',providers:[{provider:'moviebox',count:1},{provider:'vaplayer',count:1}],streams:[{provider:'moviebox',format:'hls',quality:720,url:'/media/first'},{provider:'vaplayer',format:'hls',quality:0,url:'/media/second'}]};
    throw Error('unexpected fetch '+url);
  }});
  try {
    w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));
    await tick(); w.document.getElementById('query').value='Test Movie';
    w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})); await tick();
    w.document.querySelector('.result').click(); await tick();
    const buttons=w.document.querySelectorAll('#streams button'); assert.equal(buttons.length,3); assert.equal(w.document.getElementById('view-watch').classList.contains('hidden'),false);
    assert.equal(instances.length,1); assert.equal(instances[0].url,'/media/first');
    instances[0].emit('manifest',{levels:[{height:720,bitrate:1000000}]});
    instances[0].emit('subs',{subtitleTracks:[{name:'English',lang:'en'}]});
    instances[0].emit('audio',{audioTracks:[{name:'English',lang:'en'}]});
    for (const id of ['quality','subtitles','audio']) { const select=w.document.getElementById(id); select.value='0'; select.dispatchEvent(new w.Event('change')); }
    assert.equal(instances[0].currentLevel,0); assert.equal(instances[0].subtitleTrack,0); assert.equal(instances[0].audioTrack,0);
    instances[0].emit('error',{fatal:true,details:'failed'}); await tick(); assert.equal(instances.length,2); assert.equal(instances[1].url,'/media/second');
    instances[0].emit('error',{fatal:true,details:'late'}); await tick(); assert.equal(instances.length,2);
    instances[1].emit('error',{fatal:true,details:'failed'}); await tick(); assert.match(w.document.getElementById('playError').textContent,/All selected sources failed/);
  } finally {w.close();}
});

test('watchlist Play actually resolves the saved title and starts its stream', async () => {
  const html=fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8');
  const dom=new JSDOM(html,{url:'https://cinema.example/',runScripts:'outside-only'}); const w=dom.window; w.scrollTo=()=>{}; const instances=[];
  w.localStorage.setItem('solo-watchlist',JSON.stringify([{kind:'catalog',title:'Merry Berry Love',type:'series',year:'2026',source:'moviebox'}]));
  w.scrollTo=()=>{}; w.HTMLMediaElement.prototype.pause=function(){}; w.HTMLMediaElement.prototype.load=function(){}; w.HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
  class Hls {constructor(){instances.push(this)} static isSupported(){return true} loadSource(url){this.url=url} attachMedia(){} on(){} destroy(){}}
  Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'}; w.Hls=Hls;
  let request;
  w.fetch=async(url,opts={})=>({ok:true,json:async()=>{
    if(url==='/api/session') return {authenticated:true};
    if(url==='/api/search') return {results:[{id:'a',title:'Merry Berry Love',type:'series',source:'moviebox',year:'2026',overview:''}],providers:[]};
    if(url==='/api/episodes') return {source:'fixture',episodes:[{season:1,episode:1,title:'Episode 1'}]};
    if(url==='/api/resolve') { request=JSON.parse(opts.body); return {title:'Merry Berry Love',providers:[{provider:'moviebox',count:1}],streams:[{provider:'moviebox',format:'hls',quality:720,url:'/media/test'}]}; }
    throw Error('unexpected fetch '+url);
  }});
  try {
    w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8')); w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8')); await tick();
    w.document.querySelector('#list .item button').click(); await tick(); await tick();
    assert.equal(request.id,'a'); assert.equal(request.season,1); assert.equal(request.episode,1); assert.equal(instances[0].url,'/media/test');
  } finally {w.close();}
});

test('series controls select low quality, seek and advance to the next episode', async () => {
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}); const w=dom.window, requests=[]; let hls;
  w.HTMLMediaElement.prototype.pause=function(){}; w.HTMLMediaElement.prototype.load=function(){}; w.HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
  class Hls {constructor(){hls=this;this.listeners={}} static isSupported(){return true} loadSource(){} attachMedia(){} on(e,cb){this.listeners[e]=cb} destroy(){} emit(e,d){this.listeners[e]?.(e,d)}}
  Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'}; w.Hls=Hls;
  w.fetch=async(url,opts={})=>({ok:true,json:async()=>{
    if(url==='/api/session')return {authenticated:true};
    if(url==='/api/search')return {results:[{id:'a',title:'Show',type:'series',source:'moviebox'}]};
    if(url==='/api/episodes')return {source:'fixture',episodes:[{season:1,episode:1,title:'One'},{season:1,episode:2,title:'Two'}]};
    if(url==='/api/resolve'){requests.push(JSON.parse(opts.body)); return {title:'Show',providers:[],streams:[{provider:'moviebox',format:'hls',quality:0,url:'/media/a'}]};}
    throw Error('unexpected');
  }});
  try {
    w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8')); w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8')); await tick();
    w.document.getElementById('query').value='Show'; w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true})); await tick(); w.document.querySelector('.result').click(); await tick();
    w.document.getElementById('findStreams').click(); await tick(); w.document.querySelector('#streams button').click(); await tick();
    hls.emit('manifest',{levels:[{height:1080,bitrate:3000000},{height:360,bitrate:400000},{height:720,bitrate:1000000}]});
    assert.equal(hls.currentLevel,-1); assert.deepEqual([...w.document.getElementById('quality').options].map(o=>o.value),['-1','1','2','0']);
    const v=w.document.getElementById('video'); v.currentTime=20; w.document.getElementById('back10').click(); assert.equal(v.currentTime,10); w.document.getElementById('forward10').click(); assert.equal(v.currentTime,20);
    w.document.getElementById('nextEpisode').click(); await tick(); assert.equal(requests.at(-1).episode,2); w.document.getElementById('nextEpisode').click(); await tick(); assert.match(w.document.getElementById('playError').textContent,/No later episode/);
  } finally {dom.window.close();}
});

test('server selector switches returned sources at the current position and speed changes playback', async () => {
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}); const w=dom.window; w.scrollTo=()=>{};
  w.HTMLMediaElement.prototype.pause=function(){}; w.HTMLMediaElement.prototype.load=function(){}; w.HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
  w.Hls=class {static isSupported(){return false}};
  w.fetch=async(url)=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true}; if(url==='/api/search')return {results:[{id:'a',title:'Film',type:'movie',source:'moviebox'}]}; if(url==='/api/resolve')return {title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',quality:360,url:'/media/a'},{provider:'vidsrc',format:'file',quality:720,url:'/media/b'}]}; throw Error('unexpected');}});
  try {
    w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8')); w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8')); await tick();
    w.document.getElementById('query').value='Film'; w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true})); await tick(); w.document.querySelector('.result').click(); w.document.getElementById('findStreams').click(); await tick(); w.document.querySelector('#streams button').click(); await tick();
    const video=w.document.getElementById('video'), server=w.document.getElementById('server'), speed=w.document.getElementById('speed'); assert.equal(server.options.length,2); assert.equal(server.disabled,false); video.currentTime=43; speed.value='1.5'; speed.dispatchEvent(new w.Event('change')); assert.equal(video.playbackRate,1.5);
    server.value='1'; server.dispatchEvent(new w.Event('change')); await tick(); video.dispatchEvent(new w.Event('loadedmetadata')); assert.match(video.src,/\/media\/b$/); assert.equal(video.currentTime,43); assert.equal(server.value,'1'); assert.equal(video.playbackRate,1.5);
  } finally {w.close();}
});

test('local subtitle upload converts SRT to a selectable VTT track', async () => {
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}); const w=dom.window; w.scrollTo=()=>{}; let blob;
  w.HTMLMediaElement.prototype.pause=function(){}; w.HTMLMediaElement.prototype.load=function(){}; w.HTMLMediaElement.prototype.play=function(){return Promise.resolve();}; w.URL.createObjectURL=b=>{blob=b;return 'blob:https://cinema.example/subtitle'}; w.URL.revokeObjectURL=()=>{}; w.Hls=class{static isSupported(){return false}};
  w.fetch=async(url)=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true}; if(url==='/api/source')return {url:'/media/direct'}; throw Error('unexpected');}});
  try {
    w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8')); w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8')); await tick();
    w.document.getElementById('title').value='Test'; w.document.getElementById('url').value='https://example.com/file.mp4'; w.document.getElementById('sourceForm').dispatchEvent(new w.Event('submit',{cancelable:true})); await tick();
    const input=w.document.getElementById('subtitleFile'); Object.defineProperty(input,'files',{configurable:true,value:[{name:'test.srt',size:100,text:async()=> '1\n00:00:01,000 --> 00:00:02,000\nHello'}]}); input.dispatchEvent(new w.Event('change')); await tick();
    assert.equal(blob.type,'text/vtt'); assert.equal(w.document.getElementById('subtitles').value,'upload'); assert.equal(w.document.querySelector('video track').src,'blob:https://cinema.example/subtitle');
  } finally {w.close();}
});

test('category cards open the matching player directly and back returns to the category', async()=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}), w=dom.window; w.scrollTo=()=>{}; let request,searches=0;
  w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){}; w.Hls=class{static isSupported(){return false}};
  w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true}; if(url==='/api/discover')return {sections:[{id:'popular-movies',items:[{id:'movie-id',source:'cinemeta',title:'A Film',year:'2026',type:'movie',poster:'https://images.metahub.space/p.jpg'}]}]}; if(url==='/api/search'){searches++;return {results:[]}} if(url==='/api/resolve'){request=JSON.parse(opts.body);return {title:'A Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]}};throw Error('unexpected '+url)}});
  try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8')); w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8')); await tick(); await tick(); w.location.hash='#movies'; w.dispatchEvent(new w.HashChangeEvent('hashchange')); assert.equal(w.document.querySelectorAll('#popular-movies .catalog-card').length,1); w.document.querySelector('#popular-movies .catalog-card').click(); await tick(); assert.equal(searches,0);assert.equal(request.id,'movie-id');assert.equal(w.document.getElementById('view-watch').classList.contains('hidden'),false);assert.match(w.document.getElementById('video').src,/media\/a/);assert.equal(w.document.getElementById('saveTitle'),null);w.document.getElementById('backToSearch').click();assert.equal(w.document.getElementById('view-home').classList.contains('hidden'),false);assert.equal(w.location.hash,'#movies');}finally{w.close();}
});

test('subtitle appearance persists and late HLS track updates preserve the selected option', async()=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window; w.scrollTo=()=>{}; let player;
  w.HTMLMediaElement.prototype.pause=function(){}; w.HTMLMediaElement.prototype.load=function(){}; w.HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
  class Hls{constructor(){player=this;this.listeners={}} static isSupported(){return true} loadSource(){} attachMedia(){} on(e,f){this.listeners[e]=f} destroy(){} emit(e,d){this.listeners[e]?.(e,d)}}
  Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'};w.Hls=Hls;
  w.fetch=async u=>({ok:true,json:async()=>u==='/api/session'?{authenticated:true}:u==='/api/source'?{url:'/media/a'}:{sections:[]}});
  try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();
    const size=w.document.getElementById('subtitleSize'),color=w.document.getElementById('subtitleColor'),video=w.document.getElementById('video'); size.value='large';size.dispatchEvent(new w.Event('change'));color.value='yellow';color.dispatchEvent(new w.Event('change')); assert.ok(video.classList.contains('caption-large')); assert.ok(video.classList.contains('caption-yellow')); assert.equal(JSON.parse(w.localStorage.getItem('solo-caption-style')).size,'large');
    w.document.getElementById('title').value='Test';w.document.getElementById('url').value='https://example.com/video.m3u8';w.document.getElementById('sourceForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
    player.emit('subs',{subtitleTracks:[{name:'English'}]}); const select=w.document.getElementById('subtitles');select.value='0'; select.dispatchEvent(new w.Event('change'));player.emit('subs',{subtitleTracks:[{name:'English'}]});assert.equal(select.value,'0');select.value='-1';select.dispatchEvent(new w.Event('change'));player.emit('subs',{subtitleTracks:[{name:'English'}]});assert.equal(select.value,'-1');
    player.emit('audio',{audioTracks:[{name:'English'}]});const audio=w.document.getElementById('audio');audio.value='0';audio.dispatchEvent(new w.Event('change'));audio.value='-1';audio.dispatchEvent(new w.Event('change'));assert.equal(player.audioTrack,-1);
  }finally{w.close();}
});

test('sign out failure stays visible and reports an error; successful sign out hides app',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window; w.scrollTo=()=>{}; let fail=true;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.Hls=class{};
 w.fetch=async url=>{if(url==='/api/logout' && fail)throw Error('offline');return {ok:true,json:async()=>url==='/api/session'?{authenticated:true}:{sections:[]}}};
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();w.document.getElementById('logout').click();await tick();assert.match(w.document.getElementById('playError').textContent,/Sign out failed/);assert.equal(w.document.getElementById('app').classList.contains('hidden'),false);fail=false;w.document.getElementById('logout').click();await tick();assert.ok(w.document.getElementById('app').classList.contains('hidden'));assert.ok(w.document.getElementById('mainNav').classList.contains('hidden'));}finally{w.close()}
});

test('login, direct stream save and remove work through their controls',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window; w.scrollTo=()=>{}; let password;
 w.Hls=class{};w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:false};if(url==='/api/discover')return {sections:[]};if(url==='/api/login'){password=JSON.parse(opts.body).password;return {ok:true}}; throw Error('unexpected')}});
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();assert.ok(w.document.getElementById('app').classList.contains('hidden'));w.document.getElementById('password').value='test password';w.document.getElementById('loginForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(password,'test password');assert.equal(w.document.getElementById('app').classList.contains('hidden'),false);
 w.document.getElementById('title').value='My video';w.document.getElementById('url').value='https://example.com/video.mp4';w.document.getElementById('save').click();assert.equal(w.document.querySelectorAll('#list .item').length,1);w.document.querySelector('#list .secondary').click();assert.equal(w.document.querySelectorAll('#list .item').length,0);
 }finally{w.close()}
});

test('Movy stream requests its own session-bound provider subtitle',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window; w.scrollTo=()=>{};let captionRequest;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=function(){return Promise.resolve()};w.Hls=class{static isSupported(){return false}};
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true};if(url==='/api/search')return {results:[{id:'a',title:'Film',type:'movie',source:'moviebox'}],providers:[]};if(url==='/api/resolve')return {title:'Film',providers:[],streams:[{provider:'movy:miami',format:'hls',url:'/media/a',captionId:'caption-id'}]};if(url==='/api/movy-subtitle'){captionRequest=JSON.parse(opts.body);return {url:'/caption/a'}};return {sections:[]}}});
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();w.document.getElementById('query').value='Film';w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();w.document.querySelector('.result').click();w.document.getElementById('findStreams').click();await tick();w.document.querySelector('#streams button').click();await tick();await tick();assert.equal(captionRequest.id,'caption-id');assert.equal(w.document.getElementById('subtitles').value,'external');}finally{w.close()}
});

test('search results are ranked and selecting one opens the player and auto-resolves without saving',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};let resolves=0;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=function(){return Promise.resolve()};w.Hls=class{static isSupported(){return false}};
 w.fetch=async url=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true};if(url==='/api/search')return {results:[{id:'b',title:'Film Again',type:'series',year:'2020',source:'moviebox'},{id:'a',title:'Film',type:'movie',year:'2021',source:'moviebox',poster:'https://images.metahub.space/poster/small/tt123/img'}]};if(url==='/api/resolve'){resolves++;return {title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',quality:720,url:'/media/a'}]}};return {sections:[]}}});
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();w.document.getElementById('query').value='Film';w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(w.document.querySelector('.result strong').textContent,'Film');assert.equal(w.document.querySelectorAll('.result').length,2);assert.ok(w.document.querySelector('.result img'));w.document.querySelector('.result').click();await tick();assert.equal(resolves,1);assert.equal(w.document.getElementById('view-watch').classList.contains('hidden'),false);assert.equal(w.document.getElementById('view-search').classList.contains('hidden'),true);assert.match(w.document.getElementById('video').src,/media\/a/);assert.equal(w.localStorage.getItem('solo-watchlist'),null);w.document.getElementById('backToSearch').click();assert.equal(w.document.getElementById('view-search').classList.contains('hidden'),false);}finally{w.close()}
});

test('category navigation uses live catalog sections and play episode resolves selected numbers',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};let requests=[];
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=function(){return Promise.resolve()};w.Hls=class{static isSupported(){return false}};
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true};if(url==='/api/discover')return {sections:[{id:'popular-movies',items:[]},{id:'anime',items:[{title:'Anime from catalog',type:'series'}]}]};if(url==='/api/search')return {results:[{id:'a',title:'Show',type:'series',source:'moviebox'}]};if(url==='/api/episodes')return {source:'fixture',episodes:[{season:1,episode:1,title:'One'},{season:1,episode:2,title:'Two'}]};if(url==='/api/resolve'){requests.push(JSON.parse(opts.body));return {title:'Show',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]}};throw Error('unexpected')}});
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();await tick();w.location.hash='#anime';w.dispatchEvent(new w.HashChangeEvent('hashchange'));assert.equal(w.document.querySelector('#anime .catalog-card strong').textContent,'Anime from catalog');assert.ok(w.document.getElementById('popular-movies').classList.contains('hidden'));w.document.getElementById('query').value='Show';w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();w.document.querySelector('.result').click();await tick();await tick();assert.equal(requests[0].episode,1);const ep=w.document.getElementById('episodeSelect');ep.value='1:2';ep.dispatchEvent(new w.Event('change'));w.document.getElementById('findStreams').click();await tick();assert.equal(requests.at(-1).episode,2);assert.equal(w.document.getElementById('playing').textContent,'Show S1 E2');}finally{w.close()}
});




test('series category card opens episode one directly without search or save',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};let called,searches=0;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.Hls=class{};
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true};if(url==='/api/discover')return {sections:[{id:'popular-series',items:[{id:'series-id',source:'cinemeta',title:'Show',type:'series',year:'2024'}]}]};if(url==='/api/episodes')return {episodes:[{season:1,episode:1,title:'Pilot'}],source:'fixture'};if(url==='/api/resolve'){called=JSON.parse(opts.body);return {title:'Show',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]}};if(url==='/api/search')searches++;throw Error('unexpected '+url)}});
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();await tick();w.location.hash='#shows';w.dispatchEvent(new w.HashChangeEvent('hashchange'));w.document.querySelector('#popular-series .catalog-card').click();await tick();await tick();assert.equal(searches,0);assert.equal(called.id,'series-id');assert.equal(called.season,1);assert.equal(called.episode,1);assert.match(w.document.getElementById('video').src,/media\/a/);assert.equal(w.document.getElementById('saveTitle'),null);}finally{w.close()}
});

test('MovieBox categories render upstream names, filter titles by type and play the selected card',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};let selected;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.Hls=class{};
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true};if(url==='/api/discover')return {sections:[{id:'moviebox-0',title:'New on MovieBox',source:'MovieBox',groups:['movies','shows'],items:[{id:'m',source:'moviebox',title:'Film',type:'movie'},{id:'s',source:'moviebox',title:'Series',type:'series'}]}]};if(url==='/api/resolve'){selected=JSON.parse(opts.body);return {title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]}};throw Error('unexpected '+url)}});
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();await tick();assert.equal(w.document.querySelector('#moviebox-0 h2').textContent,'New on MovieBox');assert.equal(w.document.querySelector('#moviebox-0 .row-head span').textContent,'MovieBox');w.location.hash='#movies';w.dispatchEvent(new w.HashChangeEvent('hashchange'));const cards=w.document.querySelectorAll('#moviebox-0 .catalog-card');assert.equal(cards[0].classList.contains('hidden'),false);assert.ok(cards[1].classList.contains('hidden'));cards[0].click();await tick();assert.equal(selected.id,'m');assert.match(w.document.getElementById('video').src,/media\/a/);}finally{w.close()}
});


test('player page has no embedded third-party frames or popup links',()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'));
 try{assert.equal(dom.window.document.querySelectorAll('iframe, frame, a[target="_blank"]').length,0);assert.equal(dom.window.document.getElementById('embedProvider'),null);}finally{dom.window.close()}
});

test('late direct lookup cannot start playback after leaving the watch page',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};let finish;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.Hls=class{};
 w.fetch=async(url)=>{if(url==='/api/resolve')return new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]})})});return {ok:true,json:async()=>url==='/api/session'?{authenticated:true}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie',source:'moviebox'}]}:{sections:[]}}};
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();w.document.getElementById('query').value='Film';w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();w.document.querySelector('.result').click();await tick();w.document.getElementById('backToSearch').click();finish();await tick();assert.equal(w.document.getElementById('video').hasAttribute('src'),false);assert.ok(w.document.getElementById('view-watch').classList.contains('hidden'));}finally{w.close()}
});

test('data saver limits adaptive levels and persists a height preference without relying on level indices', async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};Object.defineProperty(w.navigator,'connection',{value:{saveData:true}});let player;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
 class Hls{constructor(cfg){player=this;this.cfg=cfg;this.listeners={}}static isSupported(){return true}loadSource(){}attachMedia(){}on(e,cb){this.listeners[e]=cb}destroy(){}emit(e,d){this.listeners[e]?.(e,d)}} Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'};w.Hls=Hls;
 w.fetch=async(url)=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie'}]}:url==='/api/resolve'?{title:'Film',providers:[],streams:[{provider:'moviebox',format:'hls',url:'/media/a'}]}:{sections:[]}});
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();assert.equal(w.document.getElementById('dataSaver').getAttribute('aria-pressed'),'true');w.document.getElementById('query').value='Film';w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();w.document.querySelector('.result').click();await tick();player.emit('manifest',{levels:[{height:240,bitrate:250000},{height:360,bitrate:600000},{height:720,bitrate:1800000}]});assert.equal(player.cfg.startLevel,0);assert.equal(player.currentLevel,-1);assert.equal(player.autoLevelCapping,1);assert.match(w.document.getElementById('quality').textContent,/270 MB\/hr/);let select=w.document.getElementById('quality');select.value='2';select.dispatchEvent(new w.Event('change'));assert.equal(player.currentLevel,2);assert.equal(w.localStorage.getItem('solo-quality-height'),'720');w.document.getElementById('dataSaver').click();assert.equal(player.autoLevelCapping,-1);assert.equal(w.localStorage.getItem('solo-data-saver'),'false');w.document.getElementById('findStreams').click();await tick();player.emit('manifest',{levels:[{height:360},{height:720}]});assert.equal(player.currentLevel,1);select.value='-1';select.dispatchEvent(new w.Event('change'));assert.equal(w.localStorage.getItem('solo-quality-height'),'0');}finally{w.close()}
});

test('data saver limits rows and loads resized posters only as cards are revealed',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};w.localStorage.setItem('solo-data-saver','true');w.Hls=class{};
 const items=Array.from({length:9},(_,i)=>({id:String(i),title:'Film '+i,type:'movie',poster:'https://pbcdn.aoneroom.com/'+i+'.jpg'}));
 w.fetch=async url=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true}:{sections:[{id:'moviebox-0',title:'New',groups:['movies'],items}]}});
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();await tick();const cards=w.document.querySelectorAll('.catalog-card');assert.equal(w.document.querySelectorAll('.saver-hidden').length,3);assert.equal(cards[6].querySelector('img').hasAttribute('src'),false);const poster=new URL(cards[0].querySelector('img').src);assert.equal(poster.hostname,'wsrv.nl');assert.equal(poster.searchParams.get('w'),'140');assert.equal(cards[0].querySelector('img').decoding,'async');w.document.querySelector('.more-cards').click();assert.equal(w.document.querySelectorAll('.saver-hidden').length,0);assert.ok(cards[8].querySelector('img').hasAttribute('src'));w.document.getElementById('dataSaver').click();assert.equal(new URL(cards[0].querySelector('img').src).searchParams.get('w'),'240');}finally{w.close()}
});

test('reference player controls handle play, seek, gestures, settings, locking and browser features',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};let paused=true,pip=0,fullscreen=0;
 const v=d.getElementById('video');Object.defineProperties(v,{paused:{get:()=>paused},duration:{get:()=>100},buffered:{get:()=>({length:1,start:()=>0,end:()=>80})}});v.play=()=>{paused=false;v.dispatchEvent(new w.Event('play'));return Promise.resolve()};v.pause=()=>{paused=true;v.dispatchEvent(new w.Event('pause'))};v.load=()=>{};d.getElementById('screen').getBoundingClientRect=()=>({left:0,top:0,width:400,height:200});d.getElementById('screen').requestFullscreen=async()=>{fullscreen++};Object.defineProperty(d,'pictureInPictureEnabled',{value:true});v.requestPictureInPicture=async()=>{pip++};
 w.fetch=async(url)=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie',source:'moviebox'}]}:url==='/api/resolve'?{title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]}:{sections:[]}});
 try{for(const file of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();assert.equal(d.getElementById('playing').textContent,'Film');d.getElementById('playerPlay').click();assert.equal(paused,true);d.getElementById('playerPlay').click();await tick();assert.equal(paused,false);
 v.currentTime=25;v.dispatchEvent(new w.Event('timeupdate'));v.dispatchEvent(new w.Event('progress'));assert.equal(d.getElementById('playerCurrent').textContent,'0:25');assert.equal(d.getElementById('playerDuration').textContent,'1:40');assert.equal(d.getElementById('playerBuffer').style.width,'80%');const seek=d.getElementById('playerSeek');seek.value='500';seek.dispatchEvent(new w.Event('input'));seek.dispatchEvent(new w.Event('change'));assert.equal(v.currentTime,50);
 d.getElementById('playerSettings').click();assert.equal(d.getElementById('playerSettings').getAttribute('aria-expanded'),'true');d.getElementById('playerSaver').click();assert.equal(w.localStorage.getItem('solo-data-saver'),'true');d.getElementById('playerSettings').click();d.getElementById('playerPip').click();d.getElementById('playerFullscreen').click();await tick();assert.equal(pip,1);assert.equal(fullscreen,1);
 const gest=d.getElementById('playerGesture');const evt=(type,x,y)=>{const e=new w.Event(type);Object.assign(e,{pointerId:1,pointerType:'touch',clientX:x,clientY:y});gest.dispatchEvent(e)};evt('pointerdown',60,100);evt('pointerup',60,100);evt('pointerdown',60,100);evt('pointerup',60,100);assert.equal(v.currentTime,40);evt('pointerdown',350,100);evt('pointermove',350,80);evt('pointermove',350,130);evt('pointerup',350,130);assert.ok(v.volume<1);
 d.getElementById('playerLock').click();assert.ok(d.getElementById('screen').classList.contains('player-locked'));d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(v.currentTime,40);d.getElementById('playerUnlock').click();d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(v.currentTime,50);d.getElementById('playerBack').click();assert.ok(d.getElementById('view-watch').classList.contains('hidden'));
 }finally{w.close()}
});

test('previous episode and automatic next use the known episode list',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document,requests=[];w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true};if(url==='/api/search')return {results:[{id:'s',title:'Show',type:'series',source:'moviebox'}]};if(url==='/api/episodes')return {source:'fixture',episodes:[{season:1,episode:1,title:'One'},{season:1,episode:2,title:'Two'}]};if(url==='/api/resolve'){requests.push(JSON.parse(opts.body));return {title:'Show',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]};}return {sections:[]}}});
 try{for(const file of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('query').value='Show';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();await tick();assert.equal(d.getElementById('prevEpisode').disabled,true);d.getElementById('video').dispatchEvent(new w.Event('ended'));await tick();assert.equal(requests.at(-1).episode,2);assert.equal(d.getElementById('prevEpisode').disabled,false);d.getElementById('prevEpisode').click();await tick();assert.equal(requests.at(-1).episode,1);}finally{w.close()}
});

test('reference menu drives adaptive quality and remembers playback speed',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};let player;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
 class Hls{constructor(){player=this;this.listeners={}}static isSupported(){return true}loadSource(){}attachMedia(){}on(e,cb){this.listeners[e]=cb}destroy(){}emit(e,d){this.listeners[e]?.(e,d)}}Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'};w.Hls=Hls;
 w.fetch=async(url)=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie'}]}:url==='/api/resolve'?{title:'Film',providers:[],streams:[{provider:'moviebox',format:'hls',url:'/media/a'}]}:{sections:[]}});
 try{for(const file of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();player.emit('manifest',{levels:[{height:240,bitrate:250000},{height:360,bitrate:600000},{height:1080,bitrate:3000000}]});d.getElementById('playerSettings').click();const clickRow=text=>{const row=[...d.querySelectorAll('.player-menu-row')].find(x=>x.textContent.includes(text));assert.ok(row,text);row.click()};clickRow('Quality');assert.match(d.getElementById('playerMenuRows').textContent,/240p/);assert.match(d.getElementById('playerMenuRows').textContent,/1080p/);clickRow('1080p');assert.equal(player.currentLevel,2);assert.equal(w.localStorage.getItem('solo-quality-height'),'1080');clickRow('Speed');clickRow('1.5×');assert.equal(d.getElementById('video').playbackRate,1.5);assert.equal(w.localStorage.getItem('solo-playback-speed'),'1.5');}finally{w.close()}
});

test('native browser subtitle tracks can be selected and disabled',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
 const tracks=new w.EventTarget();tracks.length=1;tracks[0]={kind:'subtitles',language:'en',label:'Native English',mode:'disabled'};Object.defineProperty(d.getElementById('video'),'textTracks',{value:tracks});const audio=new w.EventTarget();audio.length=2;audio[0]={label:'English',enabled:true};audio[1]={label:'Other',enabled:false};Object.defineProperty(d.getElementById('video'),'audioTracks',{value:audio});
 w.fetch=async url=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie'}]}:url==='/api/resolve'?{title:'Film',providers:[],streams:[{provider:'moviebox',format:'hls',url:'/media/a'}]}:{sections:[]}});
 try{for(const file of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();tracks.dispatchEvent(new w.Event('addtrack'));const select=d.getElementById('subtitles');select.value='native:0';select.dispatchEvent(new w.Event('change'));assert.equal(tracks[0].mode,'showing');select.value='-1';select.dispatchEvent(new w.Event('change'));assert.equal(tracks[0].mode,'disabled');audio.dispatchEvent(new w.Event('addtrack'));const audioSelect=d.getElementById('audio');audioSelect.value='1';audioSelect.dispatchEvent(new w.Event('change'));assert.equal(audio[0].enabled,false);assert.equal(audio[1].enabled,true);}finally{w.close()}
});
