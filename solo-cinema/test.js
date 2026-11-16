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

test('stream adapters reject local source URLs and preserve provider identity', async () => {
  const { createProviders } = require('./providers');
  const calls=[];
  const request=async (url, opts) => { calls.push({url,opts});
    if (url.startsWith('https://streamdata.vaplayer.ru/')) return {json:{status_code:'200',data:{stream_urls:['https://cdn.example/master.m3u8','http://127.0.0.1/private','https://127.0.0.1/private']}}};
    if (url.startsWith('https://vidsrc.net/')) return {text:'<div data-hash="abc123">'};
    if (url.startsWith('https://cloudorizon.com/')) return {text:'https://cdn.example/stream.m3u8 https://127.0.0.1/private.m3u8'};
    throw Error('unexpected');
  };
  const safeUrl=value=>{ const u=new URL(value); if(u.protocol!=='https:' || u.hostname==='127.0.0.1') throw Error('unsafe'); return u; };
  const p=createProviders({request,safeUrl}); const item={imdbId:'tt12345',tmdbId:'321',type:'series'};
  const va=await p.vaplayer(item,2,3); assert.equal(va.streams.length,1); assert.equal(va.origin,'https://nextgencloudfabric.com');
  assert.match(calls[0].url,/season=2&episode=3/);
  const vid=await p.vidsrc(item,2,3); assert.equal(vid.streams.length,1); assert.equal(vid.streams[0].url,'https://cdn.example/stream.m3u8');
  await assert.rejects(p.vaplayer({...item,imdbId:'tt1/evil'},1,1),/IMDb ID/);
  await assert.rejects(p.vidsrc({...item,tmdbId:'1\/evil'},1,1),/TMDB ID/);
});

test('one failed provider does not prevent another offering playback', async () => {
  const { resolveProviders } = require('./providers');
  const moviebox={resolve:async()=>{ throw Error('offline'); }};
  const providers={vaplayer:async()=>({streams:[{url:'https://cdn.example/a',format:'hls'}],referer:'https://player.example/'}),vidsrc:async()=>({streams:[]})};
  const item={type:'series'}; const r=await resolveProviders({moviebox,providers,item,season:1,episode:2});
  assert.equal(r.streams.length,1); assert.equal(r.streams[0].provider,'vaplayer'); assert.equal(r.providers[0].error,'offline'); assert.equal(r.providers[2].count,0);
  await assert.rejects(resolveProviders({moviebox,providers,item,season:0,episode:2}),/valid season/);
});

test('TVMaze episode lookup requires exact IMDb ID and uses numeric show ID', async () => {
  const create=require('./episodes'); const urls=[];
  const request=async url=>{urls.push(url); return url.includes('/lookup/')?{json:{id:123}}:{json:[{season:1,number:2,name:'Pilot',airdate:'2025-01-01'}, {season:0,number:1,name:'special'}, {season:1,number:null}]};};
  const getEpisodes=create({request}); assert.deepEqual(await getEpisodes({type:'series',imdbId:'tt123'}),[{season:1,episode:2,title:'Pilot',airdate:'2025-01-01'}]);
  assert.equal(urls[1],'https://api.tvmaze.com/shows/123/episodes'); assert.deepEqual(await getEpisodes({type:'series',imdbId:'tt1/evil'}),[]);
});

test('Cinemeta enrichment refuses ambiguous and wrong-year matches', async () => {
  const create=require('./metadata'); let metas=[];
  const enrich=create({request:async()=>({json:{metas}})});
  const item={title:'Same Name',year:'2020',type:'series'};
  metas=[{name:'Same Name',id:'tt1',releaseInfo:'2018–'}, {name:'Same Name',id:'tt2',releaseInfo:'2020–'}];
  assert.equal((await enrich(item)).imdbId,'tt2');
  metas.push({name:'Same Name',id:'tt3',releaseInfo:'2020–'});
  assert.equal((await enrich(item)).imdbId,undefined);
});

test('DNS pinning rejects mixed answers and DNS rebinding on each connection', async () => {
  const { publicLookup }=require('./network'); let calls=0;
  const lookup=publicLookup(async()=>{ calls++; return calls===1 ? [{address:'8.8.8.8',family:4}] : [{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]; });
  const resolve=()=>new Promise((ok,bad)=>lookup('cdn.example',{},(e,address)=>e?bad(e):ok(address)));
  assert.equal(await resolve(),'8.8.8.8'); await assert.rejects(resolve(),/Private/);
});

test('media redirects reject private targets before another network request', async () => {
  const { getRemote }=require('./network'); let calls=0;
  const fetch=async()=>{calls++; return {status:302,headers:{get:()=> 'https://127.0.0.1/private'},body:{cancel:async()=>{}}};};
  await assert.rejects(getRemote('https://cdn.example/master',{},undefined,fetch,{}),/public HTTPS/); assert.equal(calls,1);
});

test('KissKh token sandbox has no Node globals and interrupts infinite code', async () => {
  const {runToken}=require('./kisskh');
  const script='function _0x54b991(id){return typeof process + ":" + typeof require + ":" + id}';
  assert.equal(await runToken(script,123),'undefined:undefined:123');
  await assert.rejects(runToken('while(true){}',123),/failed or exceeded limits/);
  await assert.rejects(runToken('function _0x54b991(){return "x"}',-1),/Invalid token input/);
});

test('KissKh search, episode selection and HLS resolution use fixed safe endpoints', async () => {
  const create=require('./kisskh'); const urls=[];
  const request=async url=>{ urls.push(String(url));
    if(url.includes('/Search?')) return {json:[{id:44,title:'Fixture',episodesCount:2},{id:'bad',title:'Invalid'}]};
    if(url.includes('/Drama/44')) return {json:{episodes:[{id:102,number:2},{id:101,number:1}]}};
    if(url.endsWith('/index.html')) return {text:'<script src="/assets/common.js"></script>'};
    if(url.endsWith('/assets/common.js')) return {text:'function _0x54b991(){return "token"}'};
    if(url.includes('/Episode/102.png?')) return {json:{Video:'https://cdn.example/test.m3u8?sig=1'}};
    throw Error('unexpected request '+url);
  };
  const safeUrl=value=>{const u=new URL(value); if(u.protocol!=='https:' || u.hostname==='127.0.0.1') throw Error('unsafe'); return u;};
  const kk=create({request,safeUrl}); const items=await kk.search('Fixture'); assert.equal(items.length,1); assert.equal(items[0].source,'kisskh');
  assert.deepEqual((await kk.details(44)).map(x=>x.number),[1,2]);
  const result=await kk.resolve(items[0],1,2); assert.equal(result.streams[0].format,'hls'); assert.equal(result.origin,'https://kisskh.is'); assert.ok(urls.some(u=>u.includes('Episode/102.png?kkey=token')));
  await assert.rejects(kk.resolve(items[0],2,1),/season 1/);
});

test('KissKh refuses off-host token scripts', async () => {
  const create=require('./kisskh'); const request=async url=>{
    if(url.includes('/Drama/')) return {json:{episodes:[{id:1,number:1}]}};
    return {text:'<script src="https://evil.example/common.js"></script>'};
  };
  const kk=create({request,safeUrl:value=>new URL(value)});
  await assert.rejects(kk.resolve({source:'kisskh',kissId:4,type:'series'},1,1),/expected host/);
});

test('KissKh English subtitle decryption produces browser WebVTT', async () => {
  const create=require('./kisskh'), crypto=require('node:crypto');
  const c=crypto.createCipheriv('aes-128-cbc',Buffer.from('8056483646328763'),Buffer.from('6852612370185273'));
  const encoded=Buffer.concat([c.update('Hello there'),c.final()]).toString('base64');
  const request=async url=>{
    if(url.includes('/Drama/')) return {json:{episodes:[{id:102,number:2}]}};
    if(url.endsWith('/index.html')) return {text:'<script src="/common.js"></script>'};
    if(url.endsWith('/common.js')) return {text:'function _0x54b991(){return "abc"}'};
    if(url.includes('/api/Sub/102')) return {json:[{label:'English',src:'https://cdn.example/sub.txt'}]};
    if(url==='https://cdn.example/sub.txt') return {text:`1\n00:00:01,200 --> 00:00:03,400\n${encoded}\n`};
    throw Error('unexpected');
  };
  const kk=create({request,safeUrl:value=>new URL(value)});
  const sub=await kk.subtitle({source:'kisskh',kissId:44,type:'series'},1,2);
  assert.match(sub,/^WEBVTT\n\n/); assert.match(sub,/00:00:01\.200 --> 00:00:03\.400\nHello there/);
});
