'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
let server;
after(() => server?.kill());
test('login, origin, and private URL protections', async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve)); const port=probe.address().port; await new Promise(resolve=>probe.close(resolve));
  server=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),CINEMA_PASSWORD:'a-strong-test-password'},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{ server.stdout.once('data',resolve); server.once('exit',reject); });
  const base=`http://127.0.0.1:${port}`;
  const post=(p,data,extra={})=>fetch(base+p,{method:'POST',headers:{origin:base,'content-type':'application/json',...extra},body:JSON.stringify(data)});
  assert.equal((await post('/api/source',{url:'https://example.com/video'})).status,401);
  assert.equal((await post('/api/login',{password:'wrong'})).status,401);
  assert.equal((await post('/api/login',{password:'a-strong-test-password'},{origin:'https://evil.test'})).status,403);
  const login=await post('/api/login',{password:'a-strong-test-password'}); assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  for(const url of ['http://127.0.0.1/','https://127.0.0.1/','https://localhost/','https://example.com:8443/','https://user:pass@example.com/']) {
    const res=await post('/api/source',{url},{cookie}); assert.equal(res.status,400,url);
  }
  const res=await post('/api/source',{url:'https://example.com/video'},{cookie}); assert.equal(res.status,200); assert.match((await res.json()).url,/^\/media\//);
});

test('MovieBox catalog and streams are normalized and unsafe URLs rejected', async () => {
  const create = require('./moviebox'); const requests=[];
  const safeUrl = value => { const u=new URL(value); if(u.protocol!=='https:' || /^(localhost|127\.)/.test(u.hostname)) throw Error('unsafe'); return u; };
  const request=async (url, options={})=>{
    requests.push({url,options});
    if(url.includes('/home?')) return {headers:{get:()=>'{"token":"guest"}'}};
    if(url.includes('/subject/search')) return {json:{data:{items:[{subject:{subjectId:'123',detailPath:'show',title:'A Show',subjectType:2,releaseDate:'2024-01-01'}},{subject:{title:'invalid'}}]}}};
    if(url.includes('/get-domain')) return {json:{data:'https://player.example'}};
    if(url.includes('/subject/play')) return {json:{data:{streams:[{url:'https://cdn.example/movie.mp4',resolutions:720,duration:3600},{url:'https://127.0.0.1/private',resolutions:1080}],hls:[{url:'https://cdn.example/master.m3u8',resolutions:1080}]}}};
    throw Error('unexpected request');
  };
  const adapter=create({request,safeUrl}); const results=await adapter.search('A Show'); assert.equal(results.length,1); assert.equal(results[0].type,'series');
  const resolved=await adapter.resolve(results[0],1,2); assert.deepEqual(resolved.streams.map(x=>x.quality),[720,1080]);
  assert.ok(requests.find(r=>r.url.includes('/subject/play')).url.includes('ep=2'));
  assert.equal(requests.find(r=>r.url.includes('/subject/play')).options.headers.authorization,undefined);
  await assert.rejects(adapter.resolve(results[0],0,2),/valid season/);
});

test('MovieBox player host is checked before requesting streams', async () => {
  const create=require('./moviebox'); let calls=0;
  const adapter=create({safeUrl:url=>{ if(String(url).includes('127.0.0.1')) throw Error('unsafe'); return new URL(url); }, request:async url=>{
    calls++; if(url.includes('/home?')) return {headers:{get:()=>'{"token":"guest"}'}};
    if(url.includes('/get-domain')) return {json:{data:'https://127.0.0.1'}};
    throw Error('unexpected request');
  }});
  await assert.rejects(adapter.resolve({type:'movie',title:'x',subjectId:'1',detailPath:'x'},1,1),/unsafe/);
  assert.equal(calls,2);
});

test('HLS playlists rewrite variants, segments, keys and alternate audio through the proxy', () => {
  const { rewritePlaylist } = require('./playlist'); const seen=[];
  const remember = (url,sid,referer,format) => { seen.push({url:String(url),sid,referer,format}); return `/media/${seen.length}`; };
  const playlist=['#EXTM3U','#EXT-X-MEDIA:TYPE=AUDIO,URI="audio"','#EXT-X-STREAM-INF:BANDWIDTH=500000','video','#EXT-X-KEY:METHOD=AES-128,URI="key"','#EXTINF:10,','segment.ts'].join('\n');
  const out=rewritePlaylist(playlist,'https://cdn.example/master.m3u8','abc','https://player.example/',remember);
  assert.match(out,/#EXT-X-MEDIA:TYPE=AUDIO,URI="\/media\/1"/);
  assert.match(out,/#EXT-X-STREAM-INF:BANDWIDTH=500000\n\/media\/2/);
  assert.match(out,/#EXT-X-KEY:METHOD=AES-128,URI="\/media\/3"/);
  assert.match(out,/\/media\/4$/);
  assert.deepEqual(seen.map(x=>x.format),['hls','hls',null,null]);
  assert.ok(seen.every(x=>x.sid==='abc' && x.referer==='https://player.example/'));
});
