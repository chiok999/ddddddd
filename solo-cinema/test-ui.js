'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path');
const { JSDOM }=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
// UI fixtures emulate the automatic converter: the browser only receives generated HLS.
function mockConversion(w) {
 const original=w.fetch; w.fetch=async(url,opts={})=>{
  if(url==='/api/transcode'){const source=JSON.parse(opts.body).url.split('/').pop();return {ok:true,json:async()=>({id:source,url:`/transcode/${source}/master.m3u8`})};}
  if(url==='/api/transcode/stop')return {ok:true,json:async()=>({stopped:true})};
  return original(url,opts);
 };
}


test('UI searches, lists sources, and switches after fatal playback errors', async () => {
  const html=fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8');
  const dom=new JSDOM(html,{url:'https://cinema.example/',runScripts:'outside-only'});
  const w=dom.window; w.scrollTo=()=>{}; const instances=[];
  w.HTMLMediaElement.prototype.pause=function(){}; w.HTMLMediaElement.prototype.load=function(){}; w.HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
  class Hls { constructor(){this.listeners={}; instances.push(this);} static isSupported(){return true;} loadSource(url){this.url=url;} attachMedia(){} on(event,cb){this.listeners[event]=cb;} destroy(){} emit(event,data){this.listeners[event]?.(event,data);} }
  Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'}; w.Hls=Hls;
  w.fetch=async (url,opts={})=>({ok:true,json:async()=>{
    if(url==='/api/session') return {authenticated:true,relay:false};
    if(url==='/api/search') return {results:[{id:'a',title:'Test Movie',type:'movie',source:'moviebox',year:'2024',overview:''}],providers:[]};
    if(url==='/api/resolve') return {title:'Test Movie',providers:[{provider:'moviebox',count:1},{provider:'vaplayer',count:1}],streams:[{provider:'moviebox',format:'file',quality:720,url:'/media/first'},{provider:'vaplayer',format:'file',quality:0,url:'/media/second'}]};
    throw Error('unexpected fetch '+url);
  }});
  mockConversion(w);
  try {
    w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));
    await tick(); w.document.getElementById('query').value='Test Movie';
    w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})); await tick();
    w.document.querySelector('.result').click(); await tick();
    const buttons=w.document.querySelectorAll('#streams button'); assert.equal(buttons.length,3); assert.equal(w.document.getElementById('view-watch').classList.contains('hidden'),false);
    assert.equal(instances.length,1); assert.equal(instances[0].url,'/transcode/first/master.m3u8');
    instances[0].emit('manifest',{levels:[{height:240,bitrate:250000},{height:360,bitrate:600000}]});
    instances[0].emit('subs',{subtitleTracks:[{name:'English',lang:'en'}]});
    instances[0].emit('audio',{audioTracks:[{name:'English',lang:'en'}]});
    for (const id of ['subtitles','audio']) { const select=w.document.getElementById(id); select.value='0'; select.dispatchEvent(new w.Event('change')); }
    assert.equal(instances[0].currentLevel,0); assert.equal(instances[0].subtitleTrack,0); assert.equal(instances[0].audioTrack,0);
    w.document.getElementById('saveTitle').click(); assert.equal(JSON.parse(w.localStorage.getItem('solo-watchlist'))[0].title,'Test Movie');
    w.document.getElementById('saveTitle').click(); assert.equal(JSON.parse(w.localStorage.getItem('solo-watchlist')).length,0);
    w.document.getElementById('video').currentTime=23;
    instances[0].emit('error',{fatal:true,details:'bufferStalledError'});await tick();assert.equal(instances.length,1);
    instances[0].emit('error',{fatal:true,details:'failed'}); await tick(); assert.equal(instances.length,2); assert.equal(instances[1].url,'/transcode/first/master.m3u8');
    instances[0].emit('error',{fatal:true,details:'late'}); await tick(); assert.equal(instances.length,2);
    instances[1].emit('error',{fatal:true,details:'failed'}); await tick(); assert.equal(instances[2].url,'/transcode/second/master.m3u8');
    instances[2].emit('error',{fatal:true,details:'failed'}); await tick(); assert.equal(instances[3].url,'/transcode/second/master.m3u8');
    instances[3].emit('error',{fatal:true,details:'failed'}); await tick(); assert.match(w.document.getElementById('playError').textContent,/No source could be played/);
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
    if(url==='/api/session') return {authenticated:true,relay:false};
    if(url==='/api/search') return {results:[{id:'a',title:'Merry Berry Love',type:'series',source:'moviebox',year:'2026',overview:''}],providers:[]};
    if(url==='/api/episodes') return {source:'fixture',episodes:[{season:1,episode:1,title:'Episode 1'}]};
    if(url==='/api/resolve') { request=JSON.parse(opts.body); return {title:'Merry Berry Love',providers:[{provider:'moviebox',count:1}],streams:[{provider:'moviebox',format:'file',quality:720,url:'/media/test'}]}; }
    throw Error('unexpected fetch '+url);
  }});
  mockConversion(w);
  try {
    w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8')); w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8')); await tick();
    w.document.querySelector('#list .item button').click(); await tick(); await tick();
    assert.equal(request.id,'a'); assert.equal(request.season,1); assert.equal(request.episode,1); assert.equal(instances[0].url,'/transcode/test/master.m3u8');
  } finally {w.close();}
});

test('series controls select low quality, seek and advance to the next episode', async () => {
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}); const w=dom.window, requests=[]; let hls; w.scrollTo=()=>{};
  w.HTMLMediaElement.prototype.pause=function(){}; w.HTMLMediaElement.prototype.load=function(){}; w.HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
  class Hls {constructor(){hls=this;this.listeners={}} static isSupported(){return true} loadSource(){} attachMedia(){} on(e,cb){this.listeners[e]=cb} destroy(){} emit(e,d){this.listeners[e]?.(e,d)}}
  Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'}; w.Hls=Hls;
  w.fetch=async(url,opts={})=>({ok:true,json:async()=>{
    if(url==='/api/session')return {authenticated:true,relay:false};
    if(url==='/api/search')return {results:[{id:'a',title:'Show',type:'series',source:'moviebox'}]};
    if(url==='/api/episodes')return {source:'fixture',episodes:[{season:1,episode:1,title:'One'},{season:1,episode:2,title:'Two'}]};
    if(url==='/api/resolve'){requests.push(JSON.parse(opts.body)); return {title:'Show',providers:[],streams:[{provider:'moviebox',format:'file',quality:0,url:'/media/a'}]};}
    throw Error('unexpected');
  }});
  mockConversion(w);
  try {
    w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8')); w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8')); await tick();
    w.document.getElementById('query').value='Show'; w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true})); await tick(); w.document.querySelector('.result').click(); await tick();
    w.document.getElementById('findStreams').click(); await tick(); w.document.querySelector('#streams button').click(); await tick();
    hls.emit('manifest',{levels:[{height:360,bitrate:600000},{height:240,bitrate:250000}]});
    assert.equal(hls.currentLevel,1); assert.deepEqual([...w.document.getElementById('quality').options].map(o=>o.value),['240','360']);
    const v=w.document.getElementById('video'); v.currentTime=20; w.document.getElementById('back10').click(); assert.equal(v.currentTime,10); w.document.getElementById('forward10').click(); assert.equal(v.currentTime,20);
    w.document.getElementById('nextEpisode').click(); await tick(); assert.equal(requests.at(-1).episode,2); w.document.getElementById('nextEpisode').click(); await tick(); assert.match(w.document.getElementById('playError').textContent,/No later episode/);
  } finally {dom.window.close();}
});

test('server selector switches converted sources and speed changes playback', async () => {
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}); const w=dom.window; w.scrollTo=()=>{};
  w.HTMLMediaElement.prototype.pause=function(){}; w.HTMLMediaElement.prototype.load=function(){}; w.HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
  w.Hls=class {static isSupported(){return false}};
  w.fetch=async(url)=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false}; if(url==='/api/search')return {results:[{id:'a',title:'Film',type:'movie',source:'moviebox'}]}; if(url==='/api/resolve')return {title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',quality:360,url:'/media/a'},{provider:'vidsrc',format:'file',quality:720,url:'/media/b'}]}; throw Error('unexpected');}});
  mockConversion(w);
  try {
    w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8')); w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8')); await tick();
    w.document.getElementById('query').value='Film'; w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true})); await tick(); w.document.querySelector('.result').click(); w.document.getElementById('findStreams').click(); await tick(); w.document.querySelector('#streams button').click(); await tick();
    const video=w.document.getElementById('video'), server=w.document.getElementById('server'), speed=w.document.getElementById('speed'); assert.equal(server.options.length,2); assert.equal(server.disabled,false); video.currentTime=43; speed.value='1.5'; speed.dispatchEvent(new w.Event('change')); assert.equal(video.playbackRate,1.5);
    server.value='1'; server.dispatchEvent(new w.Event('change')); await tick(); video.currentTime=0; video.dispatchEvent(new w.Event('loadedmetadata')); assert.match(video.src,/\/transcode\/b\/240\/index\.m3u8$/); assert.equal(video.currentTime,0); assert.equal(server.value,'1'); assert.equal(video.playbackRate,1.5);
  } finally {w.close();}
});

test('local subtitle upload converts SRT to a selectable VTT track', async () => {
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}); const w=dom.window; w.scrollTo=()=>{}; let blob;
  w.HTMLMediaElement.prototype.pause=function(){}; w.HTMLMediaElement.prototype.load=function(){}; w.HTMLMediaElement.prototype.play=function(){return Promise.resolve();}; w.URL.createObjectURL=b=>{blob=b;return 'blob:https://cinema.example/subtitle'}; w.URL.revokeObjectURL=()=>{}; w.Hls=class{static isSupported(){return false}};
  w.fetch=async(url)=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false}; if(url==='/api/source')return {url:'/media/direct'}; throw Error('unexpected');}});
  mockConversion(w);
  try {
    w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8')); w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8')); await tick();
    w.document.getElementById('title').value='Test'; w.document.getElementById('url').value='https://example.com/file.mp4'; w.document.getElementById('sourceForm').dispatchEvent(new w.Event('submit',{cancelable:true})); await tick();
    const input=w.document.getElementById('subtitleFile'); Object.defineProperty(input,'files',{configurable:true,value:[{name:'test.srt',size:100,text:async()=> '1\n00:00:01,000 --> 00:00:02,000\nHello'}]}); input.dispatchEvent(new w.Event('change')); await tick();
    assert.equal(blob.type,'text/vtt'); assert.equal(w.document.getElementById('subtitles').value,'upload'); assert.equal(w.document.querySelector('video track').src,'blob:https://cinema.example/subtitle');
  } finally {w.close();}
});

test('category cards open the matching player directly and back returns to the category', async()=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}), w=dom.window; w.scrollTo=()=>{}; let request,searches=0;
  w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve(); w.Hls=class{static isSupported(){return false}};
  w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false}; if(url==='/api/discover')return {sections:[{id:'popular-movies',items:[{id:'movie-id',source:'cinemeta',title:'A Film',year:'2026',type:'movie',poster:'https://images.metahub.space/p.jpg'}]}]}; if(url==='/api/search'){searches++;return {results:[]}} if(url==='/api/resolve'){request=JSON.parse(opts.body);return {title:'A Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]}};throw Error('unexpected '+url)}});
  mockConversion(w);
  try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8')); w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8')); await tick(); await tick(); w.location.hash='#movies'; w.dispatchEvent(new w.HashChangeEvent('hashchange')); assert.equal(w.document.querySelectorAll('#popular-movies .catalog-card').length,1); w.document.querySelector('#popular-movies .catalog-card').click(); await tick(); assert.equal(searches,0);assert.equal(request.id,'movie-id');assert.equal(w.document.getElementById('view-watch').classList.contains('hidden'),false);assert.match(w.document.getElementById('video').src,/transcode\/a\/240\/index\.m3u8/);assert.ok(w.document.getElementById('saveTitle')); w.document.getElementById('backToSearch').click();assert.equal(w.document.getElementById('view-home').classList.contains('hidden'),false);assert.equal(w.location.hash,'#movies');}finally{w.close();}
});

test('subtitle appearance persists and late HLS track updates preserve the selected option', async()=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window; w.scrollTo=()=>{}; let player;
  w.HTMLMediaElement.prototype.pause=function(){}; w.HTMLMediaElement.prototype.load=function(){}; w.HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
  class Hls{constructor(){player=this;this.listeners={}} static isSupported(){return true} loadSource(){} attachMedia(){} on(e,f){this.listeners[e]=f} destroy(){} emit(e,d){this.listeners[e]?.(e,d)}}
  Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'};w.Hls=Hls;
  w.fetch=async u=>({ok:true,json:async()=>u==='/api/session'?{authenticated:true,relay:false}:u==='/api/source'?{url:'/media/a'}:{sections:[]}});
  mockConversion(w);
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();
    const size=w.document.getElementById('subtitleSize'),color=w.document.getElementById('subtitleColor'),video=w.document.getElementById('video'); size.value='large';size.dispatchEvent(new w.Event('change'));color.value='yellow';color.dispatchEvent(new w.Event('change')); assert.ok(video.classList.contains('caption-large')); assert.ok(video.classList.contains('caption-yellow')); assert.equal(JSON.parse(w.localStorage.getItem('solo-caption-style')).size,'large');
    w.document.getElementById('title').value='Test';w.document.getElementById('url').value='https://example.com/video.mp4';w.document.getElementById('sourceForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
    player.emit('subs',{subtitleTracks:[{name:'English'}]}); const select=w.document.getElementById('subtitles');select.value='0'; select.dispatchEvent(new w.Event('change'));player.emit('subs',{subtitleTracks:[{name:'English'}]});assert.equal(select.value,'0');select.value='-1';select.dispatchEvent(new w.Event('change'));player.emit('subs',{subtitleTracks:[{name:'English'}]});assert.equal(select.value,'-1');
    player.emit('audio',{audioTracks:[{name:'English'}]});const audio=w.document.getElementById('audio');audio.value='0';audio.dispatchEvent(new w.Event('change'));audio.value='-1';audio.dispatchEvent(new w.Event('change'));assert.equal(player.audioTrack,-1);
  }finally{w.close();}
});

test('sign out failure stays visible and reports an error; successful sign out hides app',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window; w.scrollTo=()=>{}; let fail=true;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.Hls=class{};
 w.fetch=async url=>{if(url==='/api/logout' && fail)throw Error('offline');return {ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:{sections:[]}}};
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
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false};if(url==='/api/search')return {results:[{id:'a',title:'Film',type:'movie',source:'moviebox'}],providers:[]};if(url==='/api/resolve')return {title:'Film',providers:[],streams:[{provider:'movy:miami',format:'file',url:'/media/a',captionId:'caption-id'}]};if(url==='/api/movy-subtitle'){captionRequest=JSON.parse(opts.body);return {url:'/caption/a'}};return {sections:[]}}});
 mockConversion(w);
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();w.document.getElementById('query').value='Film';w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();w.document.querySelector('.result').click();w.document.getElementById('findStreams').click();await tick();w.document.querySelector('#streams button').click();await tick();await tick();assert.equal(captionRequest.id,'caption-id');assert.equal(w.document.getElementById('subtitles').value,'external');}finally{w.close()}
});

test('search results are ranked and selecting one opens the player and auto-resolves without saving',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};let resolves=0;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=function(){return Promise.resolve()};w.Hls=class{static isSupported(){return false}};
 w.fetch=async url=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false};if(url==='/api/search')return {results:[{id:'b',title:'Film Again',type:'series',year:'2020',source:'moviebox'},{id:'a',title:'Film',type:'movie',year:'2021',source:'moviebox',poster:'https://images.metahub.space/poster/small/tt123/img'}]};if(url==='/api/resolve'){resolves++;return {title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',quality:720,url:'/media/a'}]}};return {sections:[]}}});
 mockConversion(w);
  try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();w.document.getElementById('query').value='Film';w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(w.document.querySelector('.result strong').textContent,'Film');assert.equal(w.document.querySelectorAll('.result').length,2);assert.ok(w.document.querySelector('.result img'));w.document.querySelector('.result').click();await tick();assert.equal(resolves,1);assert.equal(w.document.getElementById('view-watch').classList.contains('hidden'),false);assert.equal(w.document.getElementById('view-search').classList.contains('hidden'),true);assert.match(w.document.getElementById('video').src,/transcode\/a\/240\/index\.m3u8/);assert.equal(w.localStorage.getItem('solo-watchlist'),null);w.document.getElementById('backToSearch').click();assert.equal(w.document.getElementById('view-search').classList.contains('hidden'),false);}finally{w.close()}
});

test('category navigation uses live catalog sections and play episode resolves selected numbers',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};let requests=[];
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=function(){return Promise.resolve()};w.Hls=class{static isSupported(){return false}};
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false};if(url==='/api/discover')return {sections:[{id:'popular-movies',items:[]},{id:'anime',items:[{title:'Anime from catalog',type:'series'}]}]};if(url==='/api/search')return {results:[{id:'a',title:'Show',type:'series',source:'moviebox'}]};if(url==='/api/episodes')return {source:'fixture',episodes:[{season:1,episode:1,title:'One'},{season:1,episode:2,title:'Two'}]};if(url==='/api/resolve'){requests.push(JSON.parse(opts.body));return {title:'Show',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]}};throw Error('unexpected')}});
 mockConversion(w);
  try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();await tick();w.location.hash='#anime';w.dispatchEvent(new w.HashChangeEvent('hashchange'));assert.equal(w.document.querySelector('#anime .catalog-card strong').textContent,'Anime from catalog');assert.ok(w.document.getElementById('popular-movies').classList.contains('hidden'));w.document.getElementById('query').value='Show';w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();w.document.querySelector('.result').click();await tick();await tick();assert.equal(requests[0].episode,1);const ep=w.document.getElementById('episodeSelect');ep.value='1:2';ep.dispatchEvent(new w.Event('change'));w.document.getElementById('findStreams').click();await tick();assert.equal(requests.at(-1).episode,2);assert.equal(w.document.getElementById('playing').textContent,'Show S1 E2');}finally{w.close()}
});




test('series category card opens episode one directly without search or save',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};let called,searches=0;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();w.Hls=class{static isSupported(){return false}};
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false};if(url==='/api/discover')return {sections:[{id:'popular-series',items:[{id:'series-id',source:'cinemeta',title:'Show',type:'series',year:'2024'}]}]};if(url==='/api/episodes')return {episodes:[{season:1,episode:1,title:'Pilot'}],source:'fixture'};if(url==='/api/resolve'){called=JSON.parse(opts.body);return {title:'Show',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]}};if(url==='/api/search')searches++;throw Error('unexpected '+url)}});
 mockConversion(w);
  try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();await tick();w.location.hash='#shows';w.dispatchEvent(new w.HashChangeEvent('hashchange'));w.document.querySelector('#popular-series .catalog-card').click();await tick();await tick();assert.equal(searches,0);assert.equal(called.id,'series-id');assert.equal(called.season,1);assert.equal(called.episode,1);assert.match(w.document.getElementById('video').src,/transcode\/a\/240\/index\.m3u8/);assert.ok(w.document.getElementById('saveTitle')); }finally{w.close()}
});

test('MovieBox categories render upstream names, filter titles by type and play the selected card',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};let selected;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();w.Hls=class{static isSupported(){return false}};
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false};if(url==='/api/discover')return {sections:[{id:'moviebox-0',title:'New on MovieBox',source:'MovieBox',groups:['movies','shows'],items:[{id:'m',source:'moviebox',title:'Film',type:'movie'},{id:'s',source:'moviebox',title:'Series',type:'series'}]}]};if(url==='/api/resolve'){selected=JSON.parse(opts.body);return {title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]}};throw Error('unexpected '+url)}});
 mockConversion(w);
  try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();await tick();assert.equal(w.document.querySelector('#moviebox-0 h2').textContent,'New on MovieBox');assert.equal(w.document.querySelector('#moviebox-0 .row-head span').textContent,'MovieBox');w.location.hash='#movies';w.dispatchEvent(new w.HashChangeEvent('hashchange'));const cards=w.document.querySelectorAll('#moviebox-0 .catalog-card');assert.equal(cards[0].classList.contains('hidden'),false);assert.ok(cards[1].classList.contains('hidden'));cards[0].click();await tick();assert.equal(selected.id,'m');assert.match(w.document.getElementById('video').src,/transcode\/a\/240\/index\.m3u8/);}finally{w.close()}
});


test('player page has no embedded third-party frames or popup links',()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'));
 try{assert.equal(dom.window.document.querySelectorAll('iframe, frame, a[target="_blank"]').length,0);assert.equal(dom.window.document.getElementById('embedProvider'),null);}finally{dom.window.close()}
});

test('late direct lookup cannot start playback after leaving the watch page',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};let finish;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.Hls=class{};
 w.fetch=async(url)=>{if(url==='/api/resolve')return new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]})})});return {ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie',source:'moviebox'}]}:{sections:[]}}};
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();w.document.getElementById('query').value='Film';w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();w.document.querySelector('.result').click();await tick();w.document.getElementById('backToSearch').click();finish();await tick();assert.equal(w.document.getElementById('video').hasAttribute('src'),false);assert.ok(w.document.getElementById('view-watch').classList.contains('hidden'));}finally{w.close()}
});

test('data saver limits adaptive levels and persists a height preference without relying on level indices', async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};Object.defineProperty(w.navigator,'connection',{value:{saveData:true}});let player;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
 class Hls{constructor(cfg){player=this;this.cfg=cfg;this.listeners={}}static isSupported(){return true}loadSource(){}attachMedia(){}on(e,cb){this.listeners[e]=cb}destroy(){}emit(e,d){this.listeners[e]?.(e,d)}} Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'};w.Hls=Hls;
 w.fetch=async(url)=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie'}]}:url==='/api/resolve'?{title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]}:{sections:[]}});
 mockConversion(w);
  try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();assert.equal(w.document.getElementById('dataSaver').getAttribute('aria-pressed'),'true');w.document.getElementById('query').value='Film';w.document.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();w.document.querySelector('.result').click();await tick();player.emit('manifest',{levels:[{height:360,bitrate:600000},{height:240,bitrate:250000}]});assert.equal(player.cfg.startLevel,0);assert.equal(player.cfg.startPosition,0);assert.equal(player.cfg.liveDurationInfinity,false);assert.equal(player.currentLevel,1);let select=w.document.getElementById('quality');assert.deepEqual([...select.options].map(x=>x.value),['240','360']);select.value='360';select.dispatchEvent(new w.Event('change'));assert.equal(player.currentLevel,0);assert.equal(w.localStorage.getItem('solo-quality-height'),'360');w.document.getElementById('dataSaver').click();assert.equal(w.localStorage.getItem('solo-data-saver'),'false');w.document.getElementById('findStreams').click();await tick();player.emit('manifest',{levels:[{height:240},{height:360}]});assert.equal(player.currentLevel,1);}finally{w.close()}
});

test('data saver limits rows and loads resized posters only as cards are revealed',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};w.localStorage.setItem('solo-data-saver','true');w.Hls=class{};
 const items=Array.from({length:9},(_,i)=>({id:String(i),title:'Film '+i,type:'movie',poster:'https://pbcdn.aoneroom.com/'+i+'.jpg'}));
 w.fetch=async url=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:{sections:[{id:'moviebox-0',title:'New',groups:['movies'],items}]}});
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();await tick();const cards=w.document.querySelectorAll('.catalog-card');assert.equal(w.document.querySelectorAll('.saver-hidden').length,3);assert.equal(cards[6].querySelector('img').hasAttribute('src'),false);const poster=new URL(cards[0].querySelector('img').src);assert.equal(poster.hostname,'wsrv.nl');assert.equal(poster.searchParams.get('w'),'140');assert.equal(cards[0].querySelector('img').decoding,'async');w.document.querySelector('.more-cards').click();assert.equal(w.document.querySelectorAll('.saver-hidden').length,0);assert.ok(cards[8].querySelector('img').hasAttribute('src'));w.document.getElementById('dataSaver').click();assert.equal(new URL(cards[0].querySelector('img').src).searchParams.get('w'),'240');}finally{w.close()}
});

test('reference player controls handle play, seek, gestures, settings, locking and browser features',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};let paused=true,pip=0,fullscreen=0;
 const v=d.getElementById('video');Object.defineProperties(v,{paused:{get:()=>paused},duration:{get:()=>100},buffered:{get:()=>({length:1,start:()=>0,end:()=>80})}});v.play=()=>{paused=false;v.dispatchEvent(new w.Event('play'));return Promise.resolve()};v.pause=()=>{paused=true;v.dispatchEvent(new w.Event('pause'))};v.load=()=>{};d.getElementById('screen').getBoundingClientRect=()=>({left:0,top:0,width:400,height:200});d.getElementById('screen').requestFullscreen=async()=>{fullscreen++};Object.defineProperty(d,'pictureInPictureEnabled',{value:true});v.requestPictureInPicture=async()=>{pip++};
 w.fetch=async(url)=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie',source:'moviebox'}]}:url==='/api/resolve'?{title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]}:{sections:[]}});
 mockConversion(w);
  try{for(const file of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();assert.equal(d.getElementById('playing').textContent,'Film');d.getElementById('playerPlay').click();assert.equal(paused,true);d.getElementById('playerPlay').click();await tick();assert.equal(paused,false);
 v.currentTime=25;v.dispatchEvent(new w.Event('timeupdate'));v.dispatchEvent(new w.Event('progress'));assert.equal(d.getElementById('playerCurrent').textContent,'0:25');assert.equal(d.getElementById('playerDuration').textContent,'1:40');assert.equal(d.getElementById('playerBuffer').style.width,'80%');const seek=d.getElementById('playerSeek');seek.value='500';seek.dispatchEvent(new w.Event('input'));seek.dispatchEvent(new w.Event('change'));assert.equal(v.currentTime,50);
 d.getElementById('playerSettings').click();assert.equal(d.getElementById('playerSettings').getAttribute('aria-expanded'),'true');d.getElementById('playerSaver').click();assert.equal(w.localStorage.getItem('solo-data-saver'),'true');d.getElementById('playerSettings').click();d.getElementById('playerPip').click();d.getElementById('playerFullscreen').click();await tick();assert.equal(pip,1);assert.equal(fullscreen,1);
 const gest=d.getElementById('playerGesture');const evt=(type,x,y)=>{const e=new w.Event(type);Object.assign(e,{pointerId:1,pointerType:'touch',clientX:x,clientY:y});gest.dispatchEvent(e)};evt('pointerdown',60,100);evt('pointerup',60,100);evt('pointerdown',60,100);evt('pointerup',60,100);assert.equal(v.currentTime,40);evt('pointerdown',350,100);evt('pointermove',350,80);evt('pointermove',350,130);evt('pointerup',350,130);assert.ok(v.volume<1);
 evt('pointerdown',200,100);evt('pointerup',200,100);await new Promise(resolve=>setTimeout(resolve,400));assert.equal(d.getElementById('screen').classList.contains('player-hide'),false);
 d.getElementById('playerLock').click();assert.ok(d.getElementById('screen').classList.contains('player-locked'));d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(v.currentTime,40);d.getElementById('playerUnlock').click();d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(v.currentTime,50);d.getElementById('playerBack').click();assert.ok(d.getElementById('view-watch').classList.contains('hidden'));
 }finally{w.close()}
});

test('previous episode and automatic next use the known episode list',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document,requests=[];w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false};if(url==='/api/search')return {results:[{id:'s',title:'Show',type:'series',source:'moviebox'}]};if(url==='/api/episodes')return {source:'fixture',episodes:[{season:1,episode:1,title:'One'},{season:1,episode:2,title:'Two'}]};if(url==='/api/resolve'){requests.push(JSON.parse(opts.body));return {title:'Show',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]};}return {sections:[]}}});
 mockConversion(w);
 try{for(const file of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('query').value='Show';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();await tick();assert.equal(d.getElementById('prevEpisode').disabled,true);d.getElementById('video').dispatchEvent(new w.Event('ended'));await tick();assert.equal(requests.at(-1).episode,2);assert.equal(d.getElementById('prevEpisode').disabled,false);d.getElementById('prevEpisode').click();await tick();assert.equal(requests.at(-1).episode,1);}finally{w.close()}
});

test('reference menu drives adaptive quality and remembers playback speed',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};let player;
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
 class Hls{constructor(){player=this;this.listeners={}}static isSupported(){return true}loadSource(){}attachMedia(){}on(e,cb){this.listeners[e]=cb}destroy(){}emit(e,d){this.listeners[e]?.(e,d)}}Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'};w.Hls=Hls;
 w.fetch=async(url)=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie'}]}:url==='/api/resolve'?{title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]}:{sections:[]}});
 mockConversion(w);
  try{for(const file of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();player.emit('manifest',{levels:[{height:240,bitrate:250000},{height:360,bitrate:600000},{height:1080,bitrate:3000000}]});d.getElementById('playerSettings').click();const clickRow=text=>{const row=[...d.querySelectorAll('.player-menu-row')].find(x=>x.textContent.includes(text));assert.ok(row,text);row.click()};clickRow('Quality');assert.match(d.getElementById('playerMenuRows').textContent,/240p/);assert.doesNotMatch(d.getElementById('playerMenuRows').textContent,/1080p/);clickRow('360p');assert.equal(player.currentLevel,1);assert.equal(w.localStorage.getItem('solo-quality-height'),'360');clickRow('Speed');clickRow('1.5×');assert.equal(d.getElementById('video').playbackRate,1.5);assert.equal(w.localStorage.getItem('solo-playback-speed'),'1.5');}finally{w.close()}
});

test('native browser subtitle tracks can be selected and disabled',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
 const tracks=new w.EventTarget();tracks.length=1;tracks[0]={kind:'subtitles',language:'en',label:'Native English',mode:'disabled'};Object.defineProperty(d.getElementById('video'),'textTracks',{value:tracks});const audio=new w.EventTarget();audio.length=2;audio[0]={label:'English',enabled:true};audio[1]={label:'Other',enabled:false};Object.defineProperty(d.getElementById('video'),'audioTracks',{value:audio});
 w.fetch=async url=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie'}]}:url==='/api/resolve'?{title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]}:{sections:[]}});
 mockConversion(w);
 try{for(const file of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();tracks.dispatchEvent(new w.Event('addtrack'));const select=d.getElementById('subtitles');select.value='native:0';select.dispatchEvent(new w.Event('change'));assert.equal(tracks[0].mode,'showing');select.value='-1';select.dispatchEvent(new w.Event('change'));assert.equal(tracks[0].mode,'disabled');audio.dispatchEvent(new w.Event('addtrack'));const audioSelect=d.getElementById('audio');audioSelect.value='1';audioSelect.dispatchEvent(new w.Event('change'));assert.equal(audio[0].enabled,false);assert.equal(audio[1].enabled,true);}finally{w.close()}
});

test('transcode starts from a session source, selects its HLS player and stops on leaving',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document,calls=[];w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false};if(url==='/api/search')return {results:[{id:'a',title:'Film',type:'movie',source:'moviebox'}]};if(url==='/api/resolve')return {title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/abc'}]};if(url==='/api/transcode'){calls.push(JSON.parse(opts.body));return {id:'testjob',url:'/transcode/testjob/master.m3u8'}}if(url==='/api/transcode/stop'){calls.push(JSON.parse(opts.body));return {stopped:true}}return {sections:[]}}});
 try{for(const file of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();assert.equal(calls[0].url,'/media/abc');assert.match(d.getElementById('video').src,/transcode\/testjob\/240\/index\.m3u8/);assert.deepEqual([...d.getElementById('quality').options].map(x=>x.value),['240','360']);const video=d.getElementById('video');Object.defineProperty(video,'duration',{configurable:true,value:100});video.currentTime=25;d.getElementById('quality').value='360';d.getElementById('quality').dispatchEvent(new w.Event('change'));assert.match(video.src,/transcode\/testjob\/360\/index\.m3u8/);video.currentTime=0;video.dispatchEvent(new w.Event('loadedmetadata'));assert.equal(video.currentTime,25);d.getElementById('backToSearch').click();await tick();assert.equal(calls[1].id,'testjob');}finally{w.close()}
});

test('late conversion is stopped instead of starting after leaving the player',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();let complete,stopped;
 w.fetch=async(url,opts={})=>{if(url==='/api/transcode')return new Promise(resolve=>complete=()=>resolve({ok:true,json:async()=>({id:'job',url:'/transcode/job/master.m3u8'})}));if(url==='/api/transcode/stop'){stopped=JSON.parse(opts.body).id;return {ok:true,json:async()=>({stopped:true})}}return {ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie'}]}:url==='/api/resolve'?{title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/abc'}]}:{sections:[]}}};
 try{for(const file of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();d.getElementById('backToSearch').click();complete();await tick();assert.equal(stopped,'job');assert.doesNotMatch(d.getElementById('video').src,/transcode/);}finally{w.close()}
});

test('subtitle height defaults raised, follows changing cues and persists through the player menu',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),dom=new JSDOM(html,{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{};
 const track=new w.EventTarget(),list=new w.EventTarget(),cue={line:'auto',snapToLines:true,lineAlign:'start',vertical:'',text:'Subtitle text'},vertical={line:'auto',snapToLines:true,lineAlign:'start',vertical:'rl'};
 Object.assign(track,{kind:'subtitles',mode:'showing',activeCues:[cue,vertical]});Object.assign(list,{0:track,length:1});Object.defineProperty(d.getElementById('video'),'textTracks',{value:list});
 w.fetch=async url=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:{sections:[]}});
 try{for(const file of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();assert.equal(d.getElementById('subtitlePosition').value,'25');assert.equal(cue.line,75);assert.equal(cue.snapToLines,false);assert.equal(cue.lineAlign,'end');assert.equal(cue.text,'Subtitle text');assert.equal(vertical.line,'auto');
 d.getElementById('playerSettings').click();const click=text=>{const el=[...d.querySelectorAll('.player-menu-row')].find(x=>x.textContent.includes(text));assert.ok(el,text);el.click();};click('Subtitle height');click('40% from bottom');assert.equal(cue.line,60);assert.equal(JSON.parse(w.localStorage.getItem('solo-caption-style')).position,40);
 const next={line:'auto',snapToLines:true,lineAlign:'start',vertical:''};track.activeCues=[next];track.dispatchEvent(new w.Event('cuechange'));assert.equal(next.line,60);assert.equal(next.snapToLines,false);
 const extra=new w.EventTarget(),extraCue={line:10,snapToLines:true,lineAlign:'start',vertical:''};Object.assign(extra,{kind:'captions',mode:'showing',activeCues:[extraCue]});list[1]=extra;list.length=2;const event=new w.Event('addtrack');event.track=extra;list.dispatchEvent(event);assert.equal(extraCue.line,60);extraCue.line=15;d.getElementById('video').dispatchEvent(new w.Event('timeupdate'));assert.equal(extraCue.line,60);
 }finally{w.close()}
 const restored=new JSDOM(html,{url:'https://cinema.example/',runScripts:'outside-only'}),v=restored.window;v.scrollTo=()=>{};v.Hls=class{};v.localStorage.setItem('solo-caption-style',JSON.stringify({size:'large',color:'yellow',position:40}));v.fetch=async()=>({ok:true,json:async()=>({authenticated:false})});try{v.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));v.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));assert.equal(v.document.getElementById('subtitlePosition').value,'40');assert.ok(v.document.getElementById('video').classList.contains('caption-large'));assert.ok(v.document.getElementById('video').classList.contains('caption-yellow'));await tick();}finally{v.close()}
});

test('subtitle positioning tolerates unavailable, read-only and non-caption tracks',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};w.Hls=class{};const track=new w.EventTarget(),list=new w.EventTarget(),readonly=Object.freeze({line:'auto',snapToLines:true,lineAlign:'start',vertical:''});Object.assign(track,{kind:'subtitles',mode:'showing',activeCues:[readonly]});Object.assign(list,{0:track,1:{kind:'metadata',activeCues:[{line:5}]},length:2});Object.defineProperty(w.document.getElementById('video'),'textTracks',{value:list});w.fetch=async()=>({ok:true,json:async()=>({authenticated:false})});try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));const pos=w.document.getElementById('subtitlePosition');pos.value='50';assert.doesNotThrow(()=>pos.dispatchEvent(new w.Event('change')));assert.equal(readonly.line,'auto');assert.equal(list[1].activeCues[0].line,5);await tick();}finally{w.close()}
});

test('uploaded VTT cues move using the selected height and keep their text',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();w.URL.createObjectURL=()=> 'blob:https://cinema.example/subtitle';w.URL.revokeObjectURL=()=>{};
 const cue={line:'auto',snapToLines:true,lineAlign:'start',vertical:'',text:'Hello there'},track=new w.EventTarget();Object.assign(track,{kind:'subtitles',mode:'disabled',activeCues:[cue]});Object.defineProperty(w.HTMLTrackElement.prototype,'track',{configurable:true,get:()=>track});
 w.fetch=async url=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/source'?{url:'/media/a'}:{sections:[]}});
 mockConversion(w);
 try{w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));await tick();d.getElementById('title').value='Test';d.getElementById('url').value='https://example.com/a.mp4';d.getElementById('format').value='file';d.getElementById('sourceForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();const field=d.getElementById('subtitleFile');Object.defineProperty(field,'files',{configurable:true,value:[{name:'file.vtt',size:100,text:async()=> 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello there'}]});field.dispatchEvent(new w.Event('change'));await tick();d.querySelector('video track').dispatchEvent(new w.Event('load'));assert.equal(track.mode,'showing');assert.equal(cue.line,75);const pos=d.getElementById('subtitlePosition');pos.value='40';pos.dispatchEvent(new w.Event('change'));track.dispatchEvent(new w.Event('cuechange'));assert.equal(cue.line,60);assert.equal(cue.text,'Hello there');}finally{w.close()}
});

test('automatic conversion fails closed without starting original video',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};let plays=0;w.HTMLMediaElement.prototype.play=function(){plays++;return Promise.resolve()};let attempts=0;
 w.fetch=async(url)=>{if(url==='/api/transcode'){attempts++;return {ok:false,json:async()=>({error:'HLS input unsupported'})}}return {ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie'}]}:url==='/api/resolve'?{title:'Film',providers:[],streams:[{provider:'moviebox',format:'hls',url:'/media/abc'}]}:{sections:[]}}};
 try{for(const file of ['fallback.js','app.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();assert.equal(attempts,1);assert.equal(plays,0);assert.equal(d.getElementById('video').getAttribute('src'),null);assert.match(d.getElementById('playError').textContent,/HLS input unsupported/);}finally{w.close()}
});

test('malformed conversion response fails closed and does not start playback',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};let plays=0;w.HTMLMediaElement.prototype.play=()=>{plays++;return Promise.resolve()};
 w.fetch=async url=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/source'?{url:'/media/a'}:url==='/api/transcode'?{id:'job',url:'https://untrusted.example/video'}:{sections:[]}});
 try{for(const file of ['fallback.js','app.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('title').value='Test';d.getElementById('url').value='https://example.com/a.mp4';d.getElementById('format').value='file';d.getElementById('sourceForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(plays,0);assert.equal(d.getElementById('video').getAttribute('src'),null);assert.match(d.getElementById('playError').textContent,/Invalid conversion response/);}finally{w.close()}
});

test('full MP4 timeline seeks ahead by replacing the conversion and keeps absolute time',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document,calls=[];w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
 const video=d.getElementById('video');Object.defineProperty(video,'duration',{configurable:true,value:20});
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false};if(url==='/api/source')return {url:'/media/a'};if(url==='/api/transcode'){const data=JSON.parse(opts.body);calls.push(data);const id='job'+calls.length;return {id,url:`/transcode/${id}/master.m3u8`,duration:100,offset:data.offset}}if(url==='/api/transcode/stop'){calls.push({stop:JSON.parse(opts.body).id});return {stopped:true}}return {sections:[]}}});
 try{for(const f of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',f),'utf8'));await tick();d.getElementById('title').value='Film';d.getElementById('url').value='https://example.com/video.mp4';d.getElementById('format').value='file';d.getElementById('sourceForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(calls[0].offset,0);video.currentTime=5;video.dispatchEvent(new w.Event('timeupdate'));assert.equal(d.getElementById('playerDuration').textContent,'1:40');
 const seek=d.getElementById('playerSeek');seek.value='700';seek.dispatchEvent(new w.Event('input'));seek.dispatchEvent(new w.Event('change'));await tick();assert.equal(calls[1].stop,'job1');assert.equal(calls[2].offset,70);assert.equal(calls[2].url,'/media/a');assert.match(video.src,/transcode\/job3\/240\/index\.m3u8/);video.currentTime=2;video.dispatchEvent(new w.Event('timeupdate'));assert.equal(d.getElementById('playerCurrent').textContent,'1:12');assert.equal(d.getElementById('playerDuration').textContent,'1:40');
 seek.value='750';seek.dispatchEvent(new w.Event('change'));assert.equal(video.currentTime,5);assert.equal(calls.length,3);
 }finally{w.close()}
});

test('rapid seek cancels the in-flight conversion and the newest target wins',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document,calls=[];w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();Object.defineProperty(d.getElementById('video'),'duration',{configurable:true,value:10});let finish;
 w.fetch=async(url,opts={})=>{if(url==='/api/transcode'){const data=JSON.parse(opts.body);calls.push(data);if(data.offset===50)return new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({id:'old',url:'/transcode/old/master.m3u8',duration:100})})});return {ok:true,json:async()=>({id:'job'+data.offset,url:`/transcode/job${data.offset}/master.m3u8`,duration:100})}}if(url==='/api/transcode/cancel'){calls.push({cancel:JSON.parse(opts.body).requestId});return {ok:true,json:async()=>({stopped:true})}}if(url==='/api/transcode/stop'){calls.push({stop:JSON.parse(opts.body).id});return {ok:true,json:async()=>({stopped:true})}}return {ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/source'?{url:'/media/a'}:{sections:[]}}};
 try{for(const f of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',f),'utf8'));await tick();d.getElementById('title').value='Film';d.getElementById('url').value='https://example.com/video.mp4';d.getElementById('format').value='file';d.getElementById('sourceForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();w.troyTimeline.seek(50);await tick();const request=calls.find(x=>x.offset===50);assert.ok(request);w.troyTimeline.seek(80);await tick();assert.ok(calls.some(x=>x.cancel===request.requestId));finish();await tick();await tick();assert.ok(calls.some(x=>x.offset===80));assert.ok(calls.some(x=>x.stop==='old'));assert.match(d.getElementById('video').src,/transcode\/job80\/240\/index\.m3u8/);}finally{w.close()}
});

test('uploaded subtitle cues remain selected and shift to the restarted timeline',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();w.URL.createObjectURL=()=> 'blob:https://cinema.example/subtitle';w.URL.revokeObjectURL=()=>{};Object.defineProperty(d.getElementById('video'),'duration',{configurable:true,value:10});
 const cues=[{startTime:1,endTime:3},{startTime:55,endTime:57}],track=new w.EventTarget();Object.assign(track,{kind:'subtitles',mode:'disabled',activeCues:[],cues,removeCue(cue){cues.splice(cues.indexOf(cue),1)}});Object.defineProperty(w.HTMLTrackElement.prototype,'track',{configurable:true,get:()=>track});
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/source'?{url:'/media/a'}:url==='/api/transcode'?{id:'job'+JSON.parse(opts.body).offset,url:`/transcode/job${JSON.parse(opts.body).offset}/master.m3u8`,duration:100}:url==='/api/transcode/stop'?{stopped:true}:{sections:[]}});
 try{for(const f of ['fallback.js','app.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',f),'utf8'));await tick();d.getElementById('title').value='Film';d.getElementById('url').value='https://example.com/video.mp4';d.getElementById('format').value='file';d.getElementById('sourceForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();const field=d.getElementById('subtitleFile');Object.defineProperty(field,'files',{configurable:true,value:[{name:'a.vtt',size:100,text:async()=> 'WEBVTT\n\n00:00:55.000 --> 00:00:57.000\nHello'}]});field.dispatchEvent(new w.Event('change'));await tick();w.troyTimeline.seek(50);await tick();assert.equal(d.getElementById('subtitles').value,'upload');d.querySelector('video track').dispatchEvent(new w.Event('load'));assert.equal(cues.length,1);assert.equal(cues[0].startTime,5);assert.equal(cues[0].endTime,7);assert.equal(track.mode,'showing');}finally{w.close()}
});

test('manual reclaim asks for confirmation before stopping a conversion',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};let calls=0;w.Hls=class{static isSupported(){return false}};
 w.fetch=async url=>({ok:true,json:async()=>{if(url==='/api/transcode/reclaim'){calls++;return {stopped:true}}return url==='/api/session'?{authenticated:true,relay:false}:{sections:[]}}});
 try{for(const file of ['fallback.js','app.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();w.confirm=()=>false;d.getElementById('reclaimTranscode').click();await tick();assert.equal(calls,0);w.confirm=()=>true;d.getElementById('reclaimTranscode').click();await tick();assert.equal(calls,1);assert.match(d.getElementById('playError').textContent,/Conversion stopped/);}finally{w.close()}
});

test('seek retains other providers and source switching uses absolute time',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document,calls=[];w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
 const video=d.getElementById('video');Object.defineProperty(video,'duration',{configurable:true,value:10});let failSeek=false;
 w.fetch=async(url,opts={})=>{if(url==='/api/transcode'){const data=JSON.parse(opts.body);calls.push(data);if(failSeek && data.url==='/media/first'){return {ok:false,json:async()=>({error:'failed seek'})}}return {ok:true,json:async()=>({id:'j'+calls.length,url:`/transcode/j${calls.length}/master.m3u8`,duration:100})}}return {ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie'}]}:url==='/api/resolve'?{title:'Film',providers:[],streams:[{provider:'one',format:'file',quality:100,url:'/media/first'},{provider:'two',format:'file',quality:200,url:'/media/second'}]}:{sections:[]}}};
 try{for(const f of ['fallback.js','app.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',f),'utf8'));await tick();d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();failSeek=true;w.troyTimeline.seek(50);await tick();await tick();assert.equal(calls[1].url,'/media/first');assert.equal(calls[1].offset,50);assert.equal(calls[2].url,'/media/second');assert.equal(calls[2].offset,50);video.currentTime=7;failSeek=false;d.getElementById('server').value='0';d.getElementById('server').dispatchEvent(new w.Event('change'));await tick();assert.equal(calls.at(-1).offset,57);assert.equal(calls.at(-1).url,'/media/first');}finally{w.close()}
});

test('native infinite duration seeks inside actual seekable range without restarting',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();let calls=0;
 const video=d.getElementById('video');Object.defineProperty(video,'duration',{value:Infinity,configurable:true});Object.defineProperty(video,'seekable',{value:{length:1,start:()=>0,end:()=>30},configurable:true});
 w.fetch=async(url)=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/source'?{url:'/media/a'}:url==='/api/transcode'?(calls++,{id:'j',url:'/transcode/j/master.m3u8'}):{sections:[]}});
 try{for(const f of ['fallback.js','app.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',f),'utf8'));await tick();d.getElementById('title').value='Film';d.getElementById('url').value='https://example.com/a.mp4';d.getElementById('format').value='file';d.getElementById('sourceForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(w.troyTimeline.duration(),30);w.troyTimeline.seek(20);assert.equal(video.currentTime,20);assert.equal(calls,1);video.dispatchEvent(new w.Event('timeupdate'));assert.equal(JSON.parse(w.localStorage.getItem('solo-progress'))[0].time,20);}finally{w.close()}
});

test('provider ordering uses actual recent playback starts and failures',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document,calls=[];w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
 w.fetch=async(url,opts={})=>{if(url==='/api/transcode'){const src=JSON.parse(opts.body).url;calls.push(src);if(src==='/media/a')return {ok:false,json:async()=>({error:'bad'})};return {ok:true,json:async()=>({id:'b',url:'/transcode/b/master.m3u8'})}}return {ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/search'?{results:[{id:'a',title:'Film',type:'movie'}]}:url==='/api/resolve'?{title:'Film',providers:[],streams:[{provider:'first',format:'file',quality:240,url:'/media/a'},{provider:'second',format:'file',quality:720,url:'/media/b'}]}:{sections:[]}}};
 try{for(const f of ['fallback.js','app.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',f),'utf8'));await tick();d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();await tick();assert.deepEqual(calls,['/media/a','/media/b']);d.getElementById('video').dispatchEvent(new w.Event('playing'));d.getElementById('findStreams').click();await tick();await tick();assert.equal(calls[2],'/media/b');}finally{w.close()}
});

test('non-JSON API errors show status instead of a parser error',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.fetch=async url=>url==='/api/session'?{ok:true,json:async()=>({authenticated:true,relay:false})}:url==='/api/search'?{ok:false,status:502,json:async()=>{throw SyntaxError('unexpected token')}}:{ok:true,json:async()=>({sections:[]})};
 try{for(const f of ['fallback.js','app.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',f),'utf8'));await tick();d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.match(d.getElementById('searchError').textContent,/HTTP 502/);}finally{w.close()}
});

test('featured carousel uses live catalog titles and real watchlist and playback actions',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();let resolved;
 const items=[{id:'one',title:'Real Film',type:'movie',year:'2024',source:'moviebox',overview:'A real catalog description',poster:'https://pbcdn.aoneroom.com/poster.jpg'},{id:'two',title:'Real Series',type:'series',year:'2022',source:'moviebox'}];
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false};if(url==='/api/discover')return {sections:[{id:'actual',title:'Available titles',items,groups:['movies','shows']}]};if(url==='/api/resolve'){resolved=JSON.parse(opts.body);return {title:'Real Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]};}return {sections:[],episodes:[]};}});mockConversion(w);
 try{for(const f of ['fallback.js','app.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',f),'utf8'));await tick();await tick();assert.equal(d.getElementById('heroTitle').textContent,'Real Film');assert.equal(d.getElementById('heroDescription').textContent,'A real catalog description');assert.match(d.getElementById('heroImage').src,/wsrv/);d.getElementById('heroSave').click();assert.equal(JSON.parse(w.localStorage.getItem('solo-watchlist'))[0].title,'Real Film');d.getElementById('heroNext').click();assert.equal(d.getElementById('heroTitle').textContent,'Real Series');w.location.hash='#movies';w.dispatchEvent(new w.HashChangeEvent('hashchange'));assert.equal(d.getElementById('heroTitle').textContent,'Real Film');d.getElementById('heroPlay').click();await tick();assert.equal(resolved.id,'one');assert.match(d.getElementById('video').src,/transcode\/a/);}finally{w.close()}
});

test('continue watching restores the actual saved series episode',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.Hls=class{static isSupported(){return false}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();let request;
 w.localStorage.setItem('solo-progress',JSON.stringify([{url:'moviebox:Real Series:2022:series:2:3',time:72,kind:'catalog',title:'Real Series',type:'series',year:'2022',source:'moviebox',season:2,episode:3}]));
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false};if(url==='/api/discover')return {sections:[]};if(url==='/api/search')return {results:[{id:'show',title:'Real Series',type:'series',year:'2022',source:'moviebox'}],providers:[]};if(url==='/api/episodes')return {episodes:[{season:1,episode:1,title:'One'},{season:2,episode:3,title:'Three'}],source:'Fixture'};if(url==='/api/resolve'){request=JSON.parse(opts.body);return {title:'Real Series',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]};}return {sections:[]};}});mockConversion(w);
 try{for(const f of ['fallback.js','app.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',f),'utf8'));await tick();await tick();assert.equal(d.getElementById('continueSection').classList.contains('hidden'),false);d.querySelector('.continue-card').click();await tick();await tick();assert.deepEqual(request,{id:'show',season:2,episode:3});assert.equal(d.getElementById('episodeSelect').value,'2:3');}finally{w.close()}
});

test('prototype player controls use actual selections, episode data and media state', async () => {
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document; w.scrollTo=()=>{};
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=function(){return Promise.resolve()};
 class Hls{constructor(){this.listeners={}} static isSupported(){return true} loadSource(){} attachMedia(){} on(e,cb){this.listeners[e]=cb} destroy(){}}
 Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'};w.Hls=Hls;const requests=[];
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false};if(url==='/api/search')return {results:[{id:'a',title:'Show',type:'series',source:'moviebox'}]};if(url==='/api/episodes')return {source:'fixture',episodes:[{season:1,episode:1,title:'One'},{season:1,episode:2,title:'Two'}]};if(url==='/api/resolve'){requests.push(JSON.parse(opts.body));return {title:'Show',providers:[],streams:[{provider:'test',format:'file',quality:720,url:'/media/a'}]};}throw Error(url)}});mockConversion(w);
 try{for(const file of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('query').value='Show';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();await tick();
 assert.equal(d.getElementById('screen').classList.contains('player-expanded'),true);assert.match(d.getElementById('playerMeta').textContent,/S1 E1/);
 d.getElementById('playerEpisodes').click();const episode=[...d.querySelectorAll('#playerEpisodeList button')].find(b=>b.textContent.includes('Two'));assert.ok(episode);episode.click();await tick();await tick();assert.equal(requests.at(-1).episode,2);assert.match(d.getElementById('playerMeta').textContent,/S1 E2/);
 d.getElementById('playerSpeed').click();[...d.querySelectorAll('#playerMenuRows button')].find(b=>b.textContent.includes('1.5')).click();assert.equal(d.getElementById('video').playbackRate,1.5);assert.equal(d.getElementById('playerSpeed').textContent,'1.5×');
 d.getElementById('playerSources').click();assert.match(d.getElementById('playerMenuRows').textContent,/test/);
 d.getElementById('playerAspect').click();[...d.querySelectorAll('#playerMenuRows button')].find(b=>b.textContent==='4:3').click();assert.equal(d.getElementById('screen').dataset.aspect,'4:3');assert.equal(d.getElementById('video').style.objectFit,'cover');
 const volume=d.getElementById('volumeSlider');volume.value='40';volume.dispatchEvent(new w.Event('input'));assert.equal(d.getElementById('video').volume,.4);
 d.getElementById('playerBack').click();assert.equal(d.getElementById('screen').classList.contains('player-expanded'),false);
 }finally{w.close()}
});

test('explore and search use real catalog data, exclude BL sections, and keep real history', async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.Hls=class{};
 const sections=[{id:'real',title:'Fresh titles',items:[{id:'a',title:'Actual Movie',type:'movie',year:'2023',source:'fixture'},{id:'b',title:'Actual Series',type:'series',year:'2024',source:'fixture'}]},{id:'boys-love',title:"Boys' Love",items:[{id:'c',title:'Hidden category title',type:'series',source:'fixture'}]}];let queries=[];
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false};if(url==='/api/discover')return {sections};if(url==='/api/search'){queries.push(JSON.parse(opts.body).query);return {results:[{id:'a',title:'Actual Movie',type:'movie',year:'2023'},{id:'b',title:'Actual Series',type:'series',year:'2024'}]};}throw Error(url)}});
 try{for(const f of ['fallback.js','app.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',f),'utf8'));await tick();await tick();assert.doesNotMatch(d.getElementById('catalogRows').textContent,/Boys' Love|Hidden category title/);
 w.location.hash='#categories';w.dispatchEvent(new w.Event('hashchange'));assert.match(d.getElementById('exploreGrid').textContent,/Actual Movie/);assert.doesNotMatch(d.getElementById('exploreSections').textContent,/Love/);d.querySelector('#exploreTypes [data-type="series"]').click();assert.doesNotMatch(d.getElementById('exploreGrid').textContent,/Actual Movie/);assert.match(d.getElementById('exploreGrid').textContent,/Actual Series/);d.getElementById('resetExplore').click();[...d.querySelectorAll('#exploreYears button')].find(b=>b.textContent==='2023').click();assert.match(d.getElementById('exploreGrid').textContent,/Actual Movie/);assert.doesNotMatch(d.getElementById('exploreGrid').textContent,/Actual Series/);
 w.location.hash='#search';w.dispatchEvent(new w.Event('hashchange'));assert.match(d.getElementById('searchSuggestions').textContent,/Actual Movie/);d.getElementById('query').value='Actual';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.deepEqual(queries,['Actual']);d.querySelector('#searchFilters [data-filter="movie"]').click();assert.match(d.getElementById('results').textContent,/Actual Movie/);assert.doesNotMatch(d.getElementById('results').textContent,/Actual Series/);assert.match(d.getElementById('searchHistory').textContent,/Actual/);d.getElementById('clearHistory').click();assert.deepEqual(JSON.parse(w.localStorage.getItem('solo-search-history')),[]);d.getElementById('clearSearch').click();assert.match(d.getElementById('results').textContent,/Actual Movie/);
 }finally{w.close()}
});

test('failed series playback exposes provider-specific source diagnostics',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.Hls=class{};
 w.fetch=async(url)=>{if(url==='/api/transcode')return {ok:false,json:async()=>({error:'Source returned 426'})};return {ok:true,json:async()=>{if(url==='/api/session')return {authenticated:true,relay:false};if(url==='/api/search')return {results:[{id:'a',title:'Example series',type:'series',source:'moviebox'}]};if(url==='/api/episodes')return {source:'fixture',episodes:[]};if(url==='/api/resolve')return {title:'Example series',providers:[{provider:'moviebox',count:1},{provider:'vaplayer',count:0,error:'Unavailable'}],streams:[{provider:'moviebox',format:'file',url:'/media/a'}]};return {sections:[]}}}};
 try{for(const f of ['fallback.js','app.js','player-ui.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',f),'utf8'));await tick();d.getElementById('query').value='Example series';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();await tick();assert.match(d.getElementById('playError').textContent,/426/);assert.equal(d.getElementById('playing').textContent,'Example series');d.getElementById('playerSources').click();assert.match(d.getElementById('playerMenuRows').textContent,/moviebox: Source returned 426/);assert.match(d.getElementById('playerMenuRows').textContent,/vaplayer: Unavailable/);}finally{w.close()}
});

test('progressive episode streams are attempted before HLS at equal provider reliability',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;w.scrollTo=()=>{};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();let opened=[];
 class Hls{static isSupported(){return true}loadSource(url){opened.push(url)}attachMedia(){}on(){}destroy(){}}Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'};w.Hls=Hls;
 w.fetch=async(url)=>({ok:true,json:async()=>url==='/api/session'?{authenticated:true,relay:false}:url==='/api/search'?{results:[{id:'a',title:'Example',type:'series',source:'moviebox'}]}:url==='/api/episodes'?{episodes:[]}:url==='/api/resolve'?{title:'Example',providers:[],streams:[{provider:'moviebox',format:'hls',quality:240,url:'/media/hls'},{provider:'moviebox',format:'file',quality:720,url:'/media/file'}]}:{sections:[]}});mockConversion(w);
 try{for(const file of ['fallback.js','app.js'])w.eval(fs.readFileSync(path.join(__dirname,'public',file),'utf8'));await tick();d.getElementById('query').value='Example';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();d.querySelector('.result').click();await tick();await tick();assert.equal(opened[0],'/transcode/file/master.m3u8');}finally{w.close()}
});

// Direct relay is the default; conversion is only the fallback. These tests pin
// that contract so a future change cannot silently restore transcode-only play.
function relayEnv(w){
 w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.load=function(){};w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
}

test('relay playback starts the provider stream immediately without converting',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;
 w.scrollTo=()=>{};relayEnv(w);const transcodes=[];let player;
 class Hls{constructor(){player=this;this.listeners={}}static isSupported(){return true}loadSource(u){this.url=u}attachMedia(){}on(e,cb){this.listeners[e]=cb}destroy(){}emit(e,data){this.listeners[e]?.(e,data)}}
 Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'};Hls.ErrorTypes={MEDIA_ERROR:'mediaError'};w.Hls=Hls;
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{
   if(url==='/api/session')return {authenticated:true,relay:true};
   if(url==='/api/search')return {results:[{id:'a',title:'Film',type:'movie',source:'moviebox'}],providers:[]};
   if(url==='/api/resolve')return {title:'Film',providers:[],streams:[{provider:'moviebox',format:'hls',quality:0,url:'/media/first'}]};
   if(url==='/api/transcode'){transcodes.push(JSON.parse(opts.body));return {id:'job',url:'/transcode/job/master.m3u8'}}
   return {sections:[]};
 }});
 try{
  w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));
  await tick();
  d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
  d.querySelector('.result').click();await tick();
  assert.equal(transcodes.length,0,'no conversion job for a healthy relay');
  assert.equal(player.url,'/media/first','hls.js loads the relayed provider playlist');
  player.emit('manifest',{levels:[{height:360},{height:720},{height:1080}]});
  // 240p and 360p stay selectable even though this stream has no such level,
  // and the provider's real levels are added alongside them.
  assert.deepEqual([...d.getElementById('quality').options].map(o=>o.value),['240','360'],'exactly the two qualities this server produces');
  assert.equal(player.currentLevel,-1,'the provider stream is left to adapt until the viewer chooses');
  assert.equal(transcodes.length,0,'browsing qualities never starts a conversion by itself');
  // 240p is a real conversion the server can produce, so choosing it on a
  // relayed stream starts one instead of pretending to cap a provider level.
  d.getElementById('quality').value='240';d.getElementById('quality').dispatchEvent(new w.Event('change'));
  await tick();
  assert.equal(transcodes.length,1,'choosing 240p converts, it does not silently cap');
  assert.equal(transcodes[0].url,'/media/first','the conversion uses the session-bound handle');
  assert.equal(w.localStorage.getItem('solo-quality-height'),'240','the choice is remembered');
  assert.equal(d.getElementById('video').getAttribute('src'),null,'hls.js path does not set a native src');
 }finally{w.close()}
});

test('a failing relay falls back to conversion once, then moves on',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;
 w.scrollTo=()=>{};relayEnv(w);const transcodes=[];const players=[];
 class Hls{constructor(){this.listeners={};players.push(this)}static isSupported(){return true}loadSource(u){this.url=u}attachMedia(){}on(e,cb){this.listeners[e]=cb}destroy(){}emit(e,data){this.listeners[e]?.(e,data)}}
 Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'};Hls.ErrorTypes={MEDIA_ERROR:'mediaError'};w.Hls=Hls;
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{
   if(url==='/api/session')return {authenticated:true,relay:true};
   if(url==='/api/search')return {results:[{id:'a',title:'Film',type:'movie',source:'moviebox'}],providers:[]};
   if(url==='/api/resolve')return {title:'Film',providers:[],streams:[{provider:'moviebox',format:'hls',url:'/media/a'},{provider:'vidsrc',format:'hls',url:'/media/b'}]};
   if(url==='/api/transcode'){const data=JSON.parse(opts.body);transcodes.push(data);return {id:'job'+(transcodes.length),url:`/transcode/job${transcodes.length}/master.m3u8`,duration:300}}
   return {sections:[]};
 }});
 try{
  w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));
  await tick();
  d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
  d.querySelector('.result').click();await tick();
  d.getElementById('video').currentTime=42;
  // One unresponsive provider: convert that source once…
  players[0].emit('error',{fatal:true,type:Hls.ErrorTypes.MEDIA_ERROR,details:'manifestParsingError'});await tick();await tick();
  assert.equal(transcodes.length,1);
  assert.equal(transcodes[0].url,'/media/a');
  assert.equal(transcodes[0].offset,42,'the position is carried into the conversion');
 }finally{w.close()}
});

test('native progressive relay seeks natively across the whole file',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;
 w.scrollTo=()=>{};relayEnv(w);const seeks=[];w.Hls=class{static isSupported(){return false}};
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{
   if(url==='/api/session')return {authenticated:true,relay:true};
   if(url==='/api/search')return {results:[{id:'a',title:'Film',type:'movie'}]};
   if(url==='/api/resolve')return {title:'Film',providers:[],streams:[{provider:'moviebox',format:'file',url:'/media/first'}]};
   if(url==='/api/transcode')return {id:'job',url:'/transcode/job/master.m3u8'};
   return {sections:[]};
 }});
 try{
  w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));
  await tick();
  const video=d.getElementById('video');
  Object.defineProperty(video,'duration',{value:5400,configurable:true});
  const set=[];Object.defineProperty(video,'currentTime',{get:()=>0,set:v=>{set.push(v);seeks.push(v)},configurable:true});
  d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
  d.querySelector('.result').click();await tick();
  assert.equal(video.getAttribute('src'),'/media/first','native <video> uses the relayed URL');
  window_timeline_seek(w,3600);
  assert.deepEqual(seeks,[3600],'a late seek is a plain currentTime set, not a restart');
 }finally{w.close()}
});
function window_timeline_seek(w,t){w.troyTimeline.seek(t)}

test('quality selector always offers 240p and 360p and never claims conversion',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8');
 // Static guard: the shipped markup must not tell a relay-mode user that video
 // is being converted, which is what confused the live deployment.
 assert.doesNotMatch(html,/converted automatically|unconverted part/i);
 const dom=new JSDOM(html,{url:'https://cinema.example/',runScripts:'outside-only'}),w=dom.window,d=w.document;
 w.scrollTo=()=>{};relayEnv(w);let player;
 class Hls{constructor(){player=this;this.listeners={}}static isSupported(){return true}loadSource(){}attachMedia(){}on(e,cb){this.listeners[e]=cb}destroy(){}emit(e,data){this.listeners[e]?.(e,data)}}
 Hls.Events={MANIFEST_PARSED:'manifest',SUBTITLE_TRACKS_UPDATED:'subs',AUDIO_TRACKS_UPDATED:'audio',ERROR:'error'};Hls.ErrorTypes={MEDIA_ERROR:'mediaError'};w.Hls=Hls;
 w.fetch=async(url)=>({ok:true,json:async()=>{
   if(url==='/api/session')return {authenticated:true,relay:true};
   if(url==='/api/search')return {results:[{id:'a',title:'Film',type:'movie'}]};
   if(url==='/api/resolve')return {title:'Film',providers:[],streams:[{provider:'moviebox',format:'hls',url:'/media/a'}]};
   return {sections:[]};
 }});
 try{
  w.localStorage.setItem('solo-quality-height','240');
  w.eval(fs.readFileSync(path.join(__dirname,'public/fallback.js'),'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8'));
  await tick();
  d.getElementById('query').value='Film';d.getElementById('searchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
  d.querySelector('.result').click();await tick();
  const before=[...d.getElementById('quality').options].map(o=>o.value);
  assert.ok(before.includes('240') && before.includes('360'),'both presets are offered before the manifest arrives');
  assert.equal(d.getElementById('quality').value,'240','the saved preference is preselected');
  player.emit('manifest',{levels:[{height:1080}]});
  const after=[...d.getElementById('quality').options].map(o=>o.value);
  assert.deepEqual(after,['240','360'],'provider levels never leak into the menu');
  assert.equal(player.currentLevel,-1,'the relayed stream adapts until the viewer converts');
 }finally{w.close()}
});
