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
