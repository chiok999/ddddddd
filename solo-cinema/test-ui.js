'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path');
const { JSDOM }=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('UI searches, lists sources, and switches after fatal playback errors', async () => {
  const html=fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8');
  const dom=new JSDOM(html,{url:'https://cinema.example/',runScripts:'outside-only'});
  const w=dom.window; const instances=[];
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
    w.document.querySelector('.result').click(); w.document.getElementById('findStreams').click(); await tick();
    const buttons=w.document.querySelectorAll('#streams button'); assert.equal(buttons.length,3); buttons[0].click(); await tick();
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
  const dom=new JSDOM(html,{url:'https://cinema.example/',runScripts:'outside-only'}); const w=dom.window; const instances=[];
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
    assert.equal(hls.currentLevel,1); assert.deepEqual([...w.document.getElementById('quality').options].map(o=>o.value),['1','2','0','-1']);
    const v=w.document.getElementById('video'); v.currentTime=20; w.document.getElementById('back10').click(); assert.equal(v.currentTime,10); w.document.getElementById('forward10').click(); assert.equal(v.currentTime,20);
    w.document.getElementById('nextEpisode').click(); await tick(); assert.equal(requests.at(-1).episode,2); w.document.getElementById('nextEpisode').click(); await tick(); assert.match(w.document.getElementById('playError').textContent,/No later episode/);
  } finally {dom.window.close();}
});

test('server selector switches returned sources at the current position and speed changes playback', async () => {
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}); const w=dom.window;
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
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}); const w=dom.window; let blob;
  w.HTMLMediaElement.prototype.pause=function(){}; w.HTMLMediaElement.prototype.load=function(){}; w.HTMLMediaElement.prototype.play=function(){return Promise.resolve();}; w.URL.createObjectURL=b=>{blob=b;return 'blob:https://cinema.example/subtitle'}; w.URL.revokeObjectURL=()=>{}; w.Hls=class{static isSupported(){return false}};
  w.fetch=async(url)=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true}; if(url==='/api/source')return {url:'/media/direct'}; throw Error('unexpected');}});
  try {
    w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8')); w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8')); await tick();
    w.document.getElementById('title').value='Test'; w.document.getElementById('url').value='https://example.com/file.mp4'; w.document.getElementById('sourceForm').dispatchEvent(new w.Event('submit',{cancelable:true})); await tick();
    const input=w.document.getElementById('subtitleFile'); Object.defineProperty(input,'files',{configurable:true,value:[{name:'test.srt',size:100,text:async()=> '1\n00:00:01,000 --> 00:00:02,000\nHello'}]}); input.dispatchEvent(new w.Event('change')); await tick();
    assert.equal(blob.type,'text/vtt'); assert.equal(w.document.getElementById('subtitles').value,'upload'); assert.equal(w.document.querySelector('video track').src,'blob:https://cinema.example/subtitle');
  } finally {w.close();}
});

test('discovery cards search the catalog without assuming a playable source', async()=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}), w=dom.window; let searched;
  w.HTMLElement.prototype.scrollIntoView=function(){}; w.Hls=class{static isSupported(){return false}};
  w.fetch=async(url,opts={})=>({ok:true,json:async()=>{ if(url==='/api/session')return {authenticated:true}; if(url==='/api/discover')return {sections:[{id:'popular-movies',items:[{title:'A Film',year:'2026',type:'movie',poster:'https://images.example/p.jpg'}]}]}; if(url==='/api/search'){searched=JSON.parse(opts.body).query;return {results:[{id:'a',title:'A Film',type:'movie',source:'moviebox'}],providers:[]}} throw Error('unexpected');}});
  try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8')); w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8')); await tick(); await tick(); assert.equal(w.document.querySelectorAll('#popular-movies .catalog-card').length,1); w.document.querySelector('#popular-movies .catalog-card').click(); await tick(); assert.equal(searched,'A Film'); assert.equal(w.document.querySelector('.result strong').textContent,'A Film'); assert.ok(w.document.querySelector('#selection').classList.contains('hidden'));}finally{w.close();}
});

test('subtitle appearance persists and late HLS track updates preserve the selected option', async()=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window; let player;
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
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window; let fail=true;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.Hls=class{};
 w.fetch=async url=>{if(url==='/api/logout' && fail)throw Error('offline');return {ok:true,json:async()=>url==='/api/session'?{authenticated:true}:{sections:[]}}};
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();w.document.getElementById('logout').click();await tick();assert.match(w.document.getElementById('playError').textContent,/Sign out failed/);assert.equal(w.document.getElementById('app').classList.contains('hidden'),false);fail=false;w.document.getElementById('logout').click();await tick();assert.ok(w.document.getElementById('app').classList.contains('hidden'));assert.ok(w.document.getElementById('mainNav').classList.contains('hidden'));}finally{w.close()}
});

test('login, direct stream save and remove work through their controls',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window; let password;
 w.Hls=class{};w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:false};if(url==='/api/discover')return {sections:[]};if(url==='/api/login'){password=JSON.parse(opts.body).password;return {ok:true}}; throw Error('unexpected')}});
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();assert.ok(w.document.getElementById('app').classList.contains('hidden'));w.document.getElementById('password').value='test password';w.document.getElementById('loginForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(password,'test password');assert.equal(w.document.getElementById('app').classList.contains('hidden'),false);
 w.document.getElementById('title').value='My video';w.document.getElementById('url').value='https://example.com/video.mp4';w.document.getElementById('save').click();assert.equal(w.document.querySelectorAll('#list .item').length,1);w.document.querySelector('#list .secondary').click();assert.equal(w.document.querySelectorAll('#list .item').length,0);
 }finally{w.close()}
});
