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
  assert.equal((await post('/api/transcode/reclaim',{})).status,401);
  const page=await fetch(base+'/'); assert.match(page.headers.get('content-security-policy'),/frame-src 'none'/);
  for(const asset of ['/player-ui.js','/player.css']){const response=await fetch(base+asset);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),asset.endsWith('.css')?/text\/css/:/javascript/);}
  assert.equal((await post('/api/login',{password:'wrong'})).status,401);
  assert.equal((await post('/api/login',{password:'a-strong-test-password'},{origin:'https://evil.test'})).status,403);
  const login=await post('/api/login',{password:'a-strong-test-password'}); assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/transcode/reclaim',{},{cookie})).status,200);
  assert.equal((await post('/api/vidrift',{id:'x'},{cookie})).status,404);
  assert.equal((await post('/api/embed',{id:'x'},{cookie})).status,404);
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
  const resolved=await adapter.resolve(results[0],1,2); assert.deepEqual(resolved.streams.map(x=>x.quality),[720,1080]); assert.equal(resolved.streams[0].duration,3600); assert.equal(resolved.streams[1].duration,undefined);
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
  assert.equal(calls,3); // search fallback is also attempted, but the private player is never requested.
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
  assert.equal(urls[2],'https://api.tvmaze.com/shows/123/episodes'); assert.deepEqual(await getEpisodes({type:'series',imdbId:'tt1/evil'}),[]);
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

test('playback fallback tries each candidate once and ignores stale errors', () => {
  const create=require('./public/fallback'); const attempts=[], failures=[]; let exhausted=0;
  const fallback=create((item,index,total,fail,active)=>{ attempts.push({item,index,total,active}); failures.push(fail); },()=>exhausted++);
  fallback.play(['first','second','third']); assert.equal(attempts[0].item,'first'); assert.equal(attempts[0].active(),true);
  failures[0](); assert.equal(attempts[1].item,'second'); assert.equal(attempts[0].active(),false);
  failures[0](); assert.equal(attempts.length,2); failures[1](); assert.equal(attempts[2].item,'third'); failures[2](); assert.equal(exhausted,1);
  fallback.play(['new']); fallback.cancel(); assert.equal(attempts[3].active(),false); failures[3](); assert.equal(exhausted,1);
});

test('HTTP flow authenticates, resolves a fixture and blocks direct playback', async () => {
  const probe=net.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r)); const port=probe.address().port; await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,['--require',require('node:path').join(__dirname,'test-fixtures/mock-upstream.cjs'),'server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),CINEMA_PASSWORD:'fixture-password-123'},stdio:['ignore','pipe','pipe']});
  try {
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve); child.once('exit',reject);});
    const base=`http://127.0.0.1:${port}`;
    const post=(path,data,cookie)=>fetch(base+path,{method:'POST',headers:{origin:base,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(data)});
    const login=await post('/api/login',{password:'fixture-password-123'}); const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/vidrift',{id:'x'},{cookie})).status,404);
  assert.equal((await post('/api/embed',{id:'x'},{cookie})).status,404);
    const found=await (await post('/api/search',{query:'Fixture'},cookie)).json(); assert.equal(found.results.length,1);
    const resolved=await (await post('/api/resolve',{id:found.results[0].id,season:1,episode:1},cookie)).json();
    assert.equal(resolved.streams.length,1); assert.equal(resolved.streams[0].provider,'moviebox');
    const direct=resolved.streams[0].url;
    assert.equal((await post('/api/source/probe',{url:direct},cookie)).status,400);
    const range=(await (await post('/api/source',{url:'https://cdn.example/range.mp4',format:'file'},cookie)).json()).url;
    assert.equal((await post('/api/source/probe',{url:range})).status,401);
    const another=await post('/api/login',{password:'fixture-password-123'});const otherCookie=another.headers.get('set-cookie').split(';')[0];
    assert.equal((await post('/api/source/probe',{url:range},otherCookie)).status,404);
    assert.deepEqual(await (await post('/api/source/probe',{url:range},cookie)).json(),{addressable:true,size:100,status:206});
    assert.equal((await fetch(base+range,{headers:{cookie}})).status,403);
    assert.equal((await fetch(base+direct)).status,401);
    assert.equal((await fetch(base+direct,{headers:{cookie}})).status,403);
    const converted=await post('/api/transcode',{url:direct},cookie);
    assert.equal(converted.status,400);
    assert.match((await converted.json()).error,/not HLS/);
    await post('/api/logout',{},cookie); assert.equal((await fetch(base+direct,{headers:{cookie}})).status,401);
  } finally {child.kill();}
});

test('startup loads Botkeep .env and exported environment takes precedence', async () => {
  const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'solo-cinema-env-'));
  const probe=net.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r)); const port=probe.address().port; await new Promise(r=>probe.close(r));
  fs.writeFileSync(path.join(dir,'.env'),'CINEMA_PASSWORD=from-env-file-123\n');
  const baseEnv={...process.env,PORT:String(port)}; delete baseEnv.CINEMA_PASSWORD;
  async function run(env,valid,invalid) {
    const child=spawn(process.execPath,[path.join(__dirname,'server.js')],{cwd:dir,env,stdio:['ignore','pipe','pipe']});
    try {
      await new Promise((resolve,reject)=>{child.stdout.once('data',resolve); child.once('exit',reject);});
      const base=`http://127.0.0.1:${port}`;
      const login=password=>fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password})});
      assert.equal((await login(invalid)).status,401); assert.equal((await login(valid)).status,200);
    } finally { const done=new Promise(r=>child.once('exit',r)); child.kill(); await done; }
  }
  try {
    await run(baseEnv,'from-env-file-123','exported-value-123');
    await run({...baseEnv,CINEMA_PASSWORD:'exported-value-123'},'exported-value-123','from-env-file-123');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('search diagnostics show safe failure codes without exposing provider URLs', async () => {
  const {describe}=require('./diagnostics');
  assert.equal(describe(Object.assign(new Error('secret https://example.com/?token=x'),{status:403})), 'HTTP 403');
  assert.equal(describe(Object.assign(new Error('fetch failed'),{cause:{code:'ENOTFOUND'}})), 'ENOTFOUND');
  assert.equal(describe(new Error('secret https://example.com/?token=x')), 'network or provider error');
  const kk=require('./kisskh')({request:async()=>{ throw Object.assign(new Error('sensitive url'),{status:403}); },safeUrl:u=>new URL(u)});
  await assert.rejects(kk.search('Example'),err=>{ assert.equal(err.code,'KISSKH_SEARCH_FAILED'); assert.deepEqual(err.reasons,['HTTP 403']); return true; });
});

test('Cinemeta details provide TMDB ID and episode list when catalog and TVMaze lack them', async () => {
  const request=async url=>{
    if(url.includes('/catalog/')) return {json:{metas:[{id:'tt38937897',name:'Merry Berry Love',releaseInfo:'2026'}]}};
    if(url==='https://cinemeta-live.strem.io/meta/series/tt38937897.json') return {json:{meta:{id:'tt38937897',moviedb_id:305551,videos:[{season:1,episode:6,title:'Episode 6',released:'2026-11-11T00:00:00Z'}]}}};
    throw Error('TVMaze unavailable');
  };
  const item=await require('./metadata')({request})({title:'Merry Berry Love',year:'2026',type:'series'});
  assert.equal(item.imdbId,'tt38937897'); assert.equal(item.tmdbId,'305551');
  const list=await require('./episodes')({request})(item);
  assert.deepEqual(list,[{season:1,episode:6,title:'Episode 6',airdate:'2026-11-11'}]);
});

test('MovieBox refreshes an empty player and retries an exact matching duplicate', async () => {
  const calls=[]; let domains=0;
  const request=async(url,opts={})=>{calls.push({url,opts});
    if(url.includes('/home?')) return {headers:{get:()=>'{"token":"guest"}'}};
    if(url.includes('/get-domain')) {domains++; return {json:{data:'https://player.example'}};}
    if(url.includes('/subject/search')) return {json:{data:{items:[{subject:{subjectId:'2',detailPath:'correct',title:'Merry Berry Love',subjectType:2,releaseDate:'2026-01-01'}},{subject:{subjectId:'3',detailPath:'wrong',title:'Merry Berry Love',subjectType:2,releaseDate:'2025-01-01'}}]}}};
    if(url.includes('/subject/play')) return {json:{data:{streams:url.includes('subjectId=2')?[{url:'https://cdn.example/video.mp4',resolutions:720,duration:3600}]:[]}}};
    throw Error('unexpected');
  };
  const mb=require('./moviebox')({request,safeUrl:u=>new URL(u)});
  const r=await mb.resolve({subjectId:'1',detailPath:'empty',title:'Merry Berry Love',year:'2026',type:'series'},1,6);
  assert.equal(r.streams[0].quality,720); assert.ok(domains>=3); assert.match(r.referer,/spa\/videoPlayPage\/movies\/correct/);
  assert.ok(calls.some(x=>x.url.includes('subjectId=2'))); assert.ok(!calls.some(x=>x.url.includes('subjectId=3')));
});

test('MovieBox retries a matching language-labelled duplicate without selecting another year', async () => {
  const calls=[];
  const request=async(url)=>{calls.push(url);
    if(url.includes('/home?')) return {headers:{get:()=>'{"token":"guest"}'}};
    if(url.includes('/get-domain')) return {json:{data:'https://player.example'}};
    if(url.includes('/subject/search')) return {json:{data:{items:[{subject:{subjectId:'2',detailPath:'english',title:'Merry Berry Love [English]',subjectType:2,releaseDate:'2026-01-01'}},{subject:{subjectId:'3',detailPath:'old',title:'Merry Berry Love',subjectType:2,releaseDate:'2025-01-01'}}]}}};
    if(url.includes('/subject/play')) return {json:{data:{streams:url.includes('subjectId=2')?[{url:'https://cdn.example/video.mp4',resolutions:720,duration:3600}]:[]}}};
    throw Error('unexpected');
  };
  const mb=require('./moviebox')({request,safeUrl:u=>new URL(u)});
  const out=await mb.resolve({subjectId:'1',detailPath:'original',title:'Merry Berry Love',year:'2026',type:'series'},1,6);
  assert.equal(out.streams[0].quality,720); assert.ok(calls.some(x=>x.includes('subjectId=2'))); assert.ok(!calls.some(x=>x.includes('subjectId=3')));
});

test('KissKh retries temporary rate limits but does not retry forbidden responses', async () => {
  const attempts=new Map(), waits=[];
  const request=async(url)=>{ const n=(attempts.get(url)||0)+1; attempts.set(url,n); if(n<3) throw Object.assign(Error('rate limited'),{status:429}); return {json:[{id:1,title:'A'}]}; };
  const kk=require('./kisskh')({request,safeUrl:u=>new URL(u),sleep:async ms=>waits.push(ms)});
  assert.equal((await kk.search('A')).length,1); assert.equal(attempts.size,4); assert.ok([...attempts.values()].every(x=>x===3)); assert.equal(waits.length,8);
  let count=0; const forbidden=require('./kisskh')({request:async()=>{count++; throw Object.assign(Error('forbidden'),{status:403})},safeUrl:u=>new URL(u),sleep:async()=>{throw Error('must not sleep')}});
  await assert.rejects(forbidden.search('A'),{code:'KISSKH_SEARCH_FAILED'}); assert.equal(count,4);
});

test('MovieBox retrieves and converts an English caption using bounded injected requests', async () => {
  const seen=[];
  const request=async (url)=>{ seen.push(url); if(url.includes('/home?')) return {headers:{get:()=>'{"token":"guest"}'}}; if(url.includes('/subject/caption?')) return {json:{data:{captions:[{language:'en',url:'https://subs.example/one.srt'}]}}}; if(url==='https://subs.example/one.srt') return {text:'1\n00:00:01,000 --> 00:00:02,000\nHello'}; throw Error('unexpected'); };
  const mb=require('./moviebox')({request,safeUrl:u=>new URL(u)});
  assert.equal(await mb.subtitle({id:'123',format:'MP4',subjectId:'abc',detailPath:'detail'}),'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello');
  assert.ok(seen.some(x=>x.includes('subjectId=abc')));
});

test('discovery loads bounded Cinemeta catalogs with independent errors and caching', async()=>{
  const urls=[]; const discover=require('./discover')({now:()=>new Date('2026-11-16T00:00:00Z'), request:async url=>{
    urls.push(url); if(url.includes('/series/year/')) throw Error('offline');
    return {json:{metas:[{id:'tt123',name:'A Film',releaseInfo:'2026',poster:'https://images.metahub.space/poster.jpg'},{id:'bad',name:'Invalid'}]}};
  }});
  const sections=await discover(); assert.equal(sections.length,7); assert.equal(sections.find(s=>s.id==='new-series').error,'Catalog unavailable'); assert.equal(sections[0].items.length,1); assert.equal(sections[0].items[0].poster,'https://images.metahub.space/poster.jpg'); assert.ok(urls.some(u=>u.includes('/year/genre=2026.json'))); await discover(); assert.equal(urls.length,14);
});

test('Movy decrypts independent Python protocol vector and rejects stale seeds',()=>{
 const {decrypt}=require('./movy'); const body='UUXEqNmj0gylepVn5eDkew5tRHobkchsLrr8zzaK-yxfW21ej4HVVefKPk2c_kRQ2LuBlADfZzow5iKxaQ-chnyABMlXcEPB';
 assert.deepEqual(decrypt(body,'test-seed',1368337),{sources:[{url:'https://cdn.example/a.m3u8',quality:'1080p'}]});
 assert.throws(()=>decrypt(body,'stale',1368337),/seed mismatch/);
});

test('Movy walks servers serially, double encodes title, caches, and returns fixed playback headers',async()=>{
 const {createMovy}=require('./movy');const {safeUrl}=require('./network');const body='UUXEqNmj0gylepVn5eDkew5tRHobkchsLrr8zzaK-yxfW21ej4HVVefKPk2c_kRQ2LuBlADfZzow5iKxaQ-chnyABMlXcEPB';const urls=[];let seedCount=0;
 const request=async(url)=>{urls.push(url);if(url.includes('www.movy.sx'))return {text:`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:{details:{title:'The Odyssey',year:2026,imdbId:'tt33764258'}}}})}</script>`};if(url.includes('/seed?')){seedCount++;return {json:{seed:'test-seed'}}} if(url.includes('/miami/'))return {text:body};throw Error('unexpected');};
 const resolve=createMovy({request,safeUrl});const item={tmdbId:'1368337',type:'movie'};const [a,b]=await Promise.all([resolve(item,1,1),resolve(item,1,1)]);assert.equal(a.streams[0].provider,'movy:miami');assert.equal(a.streams[0].quality,1080);assert.equal(a.userAgent,'okhttp/4.12.0');assert.equal(a.origin,'https://www.movy.sx');assert.strictEqual(a,b);assert.equal(seedCount,1);assert.match(urls[2],/title=The%2520Odyssey/);assert.match(urls[2],/totalSeasons=0/);assert.equal(urls.length,3);
});

test('Movy retries a stale seed once and backs off on 429',async()=>{
 const {createMovy}=require('./movy');const {safeUrl}=require('./network');const body='UUXEqNmj0gylepVn5eDkew5tRHobkchsLrr8zzaK-yxfW21ej4HVVefKPk2c_kRQ2LuBlADfZzow5iKxaQ-chnyABMlXcEPB';let seeds=0, calls=0, clock=100000;
 const resolve=createMovy({safeUrl,now:()=>clock,request:async(url)=>{calls++;if(url.includes('www.movy.sx'))return {text:'<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{details:{title:'Test',year:2026}}}})+'</script>'};if(url.includes('/seed?'))return {json:{seed:++seeds===1?'stale':'test-seed'}};return {text:body};}});
 const r=await resolve({tmdbId:'1368337',type:'movie'},1,1);assert.equal(r.streams.length,1);assert.equal(seeds,2);
 let attempts=0;const limited=createMovy({safeUrl,now:()=>clock,request:async(url)=>{attempts++;if(url.includes('www.movy.sx'))return {text:'<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{details:{title:'Test',year:2026}}}})+'</script>'};throw Object.assign(Error('limit'),{status:429});}});
 await assert.rejects(limited({tmdbId:'1368337'},1,1),/rate limited/);await assert.rejects(limited({tmdbId:'1368337'},1,1),/rate limited/);assert.equal(attempts,2);
});

test('Movy recognizes opaque HLS URLs, numeric quality and payload captions',async()=>{
 const {createMovy}=require('./movy'); const {safeUrl}=require('./network');const ciphertext='UUXEqNmj0gylepVn5eDkew5tRHobkchsLrr8zzaK-yxfW21ej4HVVefKPk2SoEgS2OaBlADfZzow5iKxaQ-cgweaSZUOL2vOqfjPYYuv6MW6kNZ1qwxQaoFTyyovQrRgvN-ArfKeMv0rV6menCSlOjHnOYT9K8g7A4vYUnbSPz77obJAtgFPk2ZaMsNQgG-EGyVm02iOHLoXxIyymOzF87kkk_bnt5XzmElBQzGwWU_E_-8cMS9cQQlZIoLgPcN7';
 const timeouts=[];const resolve=createMovy({safeUrl,request:async(url,opts)=>{timeouts.push(opts.timeoutMs);if(url.includes('www.movy.sx'))return {text:'<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{details:{title:'Test',year:2026}}}})+'</script>'};if(url.includes('/seed?'))return {json:{seed:'test-seed',ttlMs:30000}};return {text:ciphertext}}});
 const r=await resolve({tmdbId:'1368337',type:'movie'},1,1);assert.deepEqual(r.streams.map(s=>[s.format,s.quality]),[['hls',2160],['hls',720]]);assert.equal(r.captionInfo.url,'https://subs.example/english.srt');assert.ok(timeouts.every(t=>t>0 && t<=3500));
});

test('Movy enforces a total lookup budget instead of walking indefinitely',async()=>{
 const {createMovy}=require('./movy'),{safeUrl}=require('./network');let clock=1;let calls=0;
 const resolve=createMovy({safeUrl,now:()=>clock,request:async url=>{calls++;clock+=4000;if(url.includes('www.movy.sx'))return {text:'<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{details:{title:'Test',year:2026}}}})+'</script>'};if(url.includes('/seed?'))return {json:{seed:'test-seed'}};throw Error('failed');}});
 await assert.rejects(resolve({tmdbId:'1368337',type:'movie'},1,1),/timed out/);assert.equal(calls,3);
});

test('Cinemeta search returns both media types with safe poster URLs',async()=>{
 const search=require('./catalog-search')({request:async url=>({json:{metas:[{id:url.includes('/movie/')?'tt123':'tt456',name:'Title',releaseInfo:'2023'}]}})});
 const results=await search('Title');assert.deepEqual(results.map(r=>r.type),['movie','series']);assert.equal(results[0].poster,'https://images.metahub.space/poster/small/tt123/img');
});

test('Cinemeta title uses only an unambiguous exact MovieBox year match',async()=>{
 const {resolveProviders}=require('./providers');let matched;const moviebox={search:async()=>[{title:'Film',type:'movie',year:'2020',subjectId:'yes'},{title:'Film',type:'movie',year:'2019',subjectId:'no'}],resolve:async item=>{matched=item;return {streams:[]}}};
 const providers={vaplayer:async()=>({streams:[]}),vidsrc:async()=>({streams:[]})};await resolveProviders({moviebox,providers,item:{source:'cinemeta',title:'Film',type:'movie',year:'2020'},season:1,episode:1});assert.equal(matched.subjectId,'yes');
 matched=null;await resolveProviders({moviebox,providers,item:{source:'cinemeta',title:'Film',type:'movie',year:''},season:1,episode:1});assert.equal(matched,null);
});

test('7Movies VidLink adapter parses quality variants, fixed header allowlist and captions',async()=>{
 const {safeUrl}=require('./network');let urls=[];const resolve=require('./vidlink')({safeUrl,request:async(url)=>{urls.push(url);if(url.includes('enc-dec.app')) return {json:{result:'abc_123'}};return {json:{stream:{TTL:3600,headers:{Referer:'https://vidlink.pro/','Authorization':'secret'},qualities:{720:{url:'https://cdn.example/video',type:'mp4',headers:{Origin:'https://vidlink.pro'}},'1080p':{url:'https://127.0.0.1/video'}},playlist:'https://cdn.example/hls',captions:[{language:'English',url:'https://cdn.example/sub.vtt'}]}}};}});
 const r=await resolve({tmdbId:'123',type:'series'},2,3);assert.equal(r.streams.length,2);assert.equal(r.streams[0].quality,720);assert.equal(r.streams[0].refreshAfterMs,2700000);assert.equal(r.streams[0].referer,'https://vidlink.pro/');assert.equal(r.streams[0].origin,'https://vidlink.pro');assert.equal(r.streams[0].authorization,undefined);assert.equal(r.streams[1].format,'hls');assert.equal(r.captionInfo.url,'https://cdn.example/sub.vtt');assert.match(urls[1],/\/tv\/abc_123\/2\/3$/);
});

test('metadata prefers exact release year over an undated namesake',async()=>{
 const enrich=require('./metadata')({request:async(url)=>url.includes('/catalog/')?{json:{metas:[{name:'Film',id:'tt1'},{name:'Film',id:'tt2',releaseInfo:'2020'}]}}:{json:{meta:{id:'tt2',moviedb_id:123}}}});
 const item=await enrich({title:'Film',type:'movie',year:'2020'});assert.equal(item.imdbId,'tt2');assert.equal(item.tmdbId,'123');
});



test('discovery produces per-session title IDs without changing the shared metadata cache',()=>{
 const {bindDiscovery}=require('./catalog-session');const item={title:'Film',type:'movie',year:'2024',imdbId:'tt123',tmdbId:'321',poster:null};const sections=[{id:'popular-movies',items:[item],error:null}],catalog=new Map();
 const first=bindDiscovery(sections,catalog,'alice',1000),second=bindDiscovery(sections,catalog,'bob',1000);
 assert.notEqual(first[0].items[0].id,second[0].items[0].id);assert.equal(catalog.get(first[0].items[0].id).sid,'alice');assert.equal(catalog.get(second[0].items[0].id).sid,'bob');assert.equal(catalog.get(first[0].items[0].id).item.imdbId,'tt123');assert.equal(catalog.get(first[0].items[0].id).item.tmdbId,'321');assert.equal(item.id,undefined);assert.equal(catalog.get(first[0].items[0].id).expires,1000+24*3600000);
});

test('MovieBox home uses provider category names and valid playable subjects, not fixed titles',()=>{
 const {normalizeHome}=require('./moviebox-home');const rows=normalizeHome({data:{operatingList:[{title:'Fresh from MovieBox',type:'SUBJECTS_MOVIE',subjects:[{subjectId:'100',subjectType:1,title:'Movie',detailPath:'movie-100',releaseDate:'2026-01-02',cover:{url:'https://pbcdn.aoneroom.com/image/a.jpg'}},{subjectId:'200',subjectType:2,title:'Show',detailPath:'show-200',cover:{url:'https://evil.example/a.jpg'}},{subjectId:'300',subjectType:1,title:'Hidden',detailPath:'bad',isPornographic:true},{subjectId:'bad',subjectType:1,title:'No path'}]},{title:'Anime now',subjects:[{subjectId:'500',subjectType:2,title:'Animated show',genre:'Anime,Action',detailPath:'anime-500'}]}]}});
 assert.equal(rows.length,2);assert.equal(rows[0].title,'Fresh from MovieBox');assert.deepEqual(rows[0].groups,['movies','shows']);assert.equal(rows[0].items.length,2);assert.equal(rows[0].items[0].source,'moviebox');assert.equal(rows[0].items[0].poster,'https://pbcdn.aoneroom.com/image/a.jpg');assert.equal(rows[0].items[1].poster,null);assert.ok(rows[1].groups.includes('anime'));
 assert.deepEqual(normalizeHome({data:{operatingList:[{title:'A different category',subjects:[{subjectId:'55',subjectType:1,title:'New title',detailPath:'new'}]}]}}).map(r=>r.title),['A different category']);assert.throws(()=>normalizeHome({data:{}}),/Invalid/);
});

test('discovery prefers MovieBox live sections, fills missing anime from Cinemeta, and falls back on failure',async()=>{
 const create=require('./discover');let homeCalls=0,requests=[];
 const row={id:'moviebox-0',title:'Live category',source:'MovieBox',groups:['movies','shows'],items:[{source:'moviebox',title:'A',type:'movie'}],error:null};
 const request=async url=>{requests.push(url);return {json:{metas:[{id:'tt100',name:'Anime title',releaseInfo:'2026'}]}}};
 const d=create({request,moviebox:{home:async()=>{homeCalls++;return [row]}}});const data=await d();assert.equal(data[0].title,'Live category');assert.equal(data[1].id,'anime');assert.equal(data[1].items[0].title,'Anime title');assert.equal(requests.length,1);await d();assert.equal(homeCalls,1);
 const fallback=create({request,moviebox:{home:async()=>{throw Error('offline')}}});const fallbackRows=await fallback();assert.equal(fallbackRows.length,7);assert.ok(fallbackRows.every(r=>r.source==='Cinemeta'));
});

test('session-bound MovieBox cards retain the subject needed by the real resolver',()=>{
 const {bindDiscovery}=require('./catalog-session');const catalog=new Map();const source={title:'MovieBox row',items:[{source:'moviebox',subjectId:'123',detailPath:'actual-123',type:'movie',title:'Title'}]};const rows=bindDiscovery([source],catalog,'session',1);const card=rows[0].items[0];assert.equal(card.source,'moviebox');assert.equal(card.subjectId,undefined);const entry=catalog.get(card.id);assert.equal(entry.item.subjectId,'123');assert.equal(entry.item.detailPath,'actual-123');assert.equal(entry.item.source,'moviebox');
});

test('transcode API rejects unauthenticated and invalid source requests',async()=>{
 // Reuse an isolated instance: the transcoder only accepts authenticated, session-bound /media handles.
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),CINEMA_PASSWORD:'a-strong-test-password'},stdio:['ignore','pipe','pipe']});
 try{await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',reject)});const base=`http://127.0.0.1:${port}`;const post=(p,data,cookie)=>fetch(base+p,{method:'POST',headers:{origin:base,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(data)});assert.equal((await post('/api/transcode',{url:'/media/whatever'})).status,401);const login=await post('/api/login',{password:'a-strong-test-password'}),cookie=login.headers.get('set-cookie').split(';')[0];assert.equal((await post('/api/transcode',{url:'https://example.com/video'},cookie)).status,400);assert.equal((await post('/api/transcode',{url:'/media/not-yours'},cookie)).status,404);const src=await (await post('/api/source',{url:'https://cdn.example/video.mp4',format:'file'},cookie)).json();assert.equal((await post('/api/transcode',{url:src.url,offset:-1},cookie)).status,400);assert.equal((await post('/api/transcode',{url:src.url,offset:2,requestId:'bad'},cookie)).status,400);assert.equal((await post('/api/transcode/cancel',{requestId:'f'.repeat(32)})).status,401);assert.equal((await post('/api/transcode/cancel',{requestId:'f'.repeat(32)},cookie)).status,200);assert.equal((await fetch(base+'/transcode/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/master.m3u8')).status,401);}finally{child.kill();}
});

test('transcoder reports missing ffmpeg and rejects playlist content',async()=>{
 const {createTranscoder}=require('./transcode');const {Readable}=require('node:stream');const make=(type)=>({ok:true,status:200,headers:new Headers({'content-type':type}),body:Readable.toWeb(Readable.from(Buffer.from('0000000866747970000000086d6f6f76','hex')))});
 let opened=0;const bad=createTranscoder({executable:'/definitely/not/a/real/ffmpeg',open:async()=>{opened++;return make('video/mp4')},startupMs:5000});try{await assert.rejects(bad.start({},'a'),/FFmpeg executable or its system loader was not found/);assert.equal(opened,0);assert.equal(await bad.read('bad','a','master.m3u8'),null);}finally{await bad.close()}
 const hls=createTranscoder({open:async()=>make('application/vnd.apple.mpegurl')});try{await assert.rejects(hls.start({},'a'),/Only uncompressed direct MP4/)}finally{await hls.close()}
});

const testFfmpeg=process.env.CINEMA_TEST_FFMPEG || require('./transcode').bundledFfmpeg();
test('real FFmpeg creates two session-bound playable HLS renditions and cleans up', {skip:!testFfmpeg,timeout:60000},async()=>{
 const {createTranscoder}=require('./transcode'),{Readable}=require('node:stream'),fs=require('node:fs'),fsp=fs.promises,os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');const bin=testFfmpeg;const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'troy-test-'));const fixture=path.join(dir,'sample.mp4');
 const input=spawnSync(bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=480x270:rate=20','-f','lavfi','-i','sine=frequency=440','-t','12','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-c:a','aac',fixture],{encoding:'utf8'});assert.equal(input.status,0,input.stderr);
 let opened=0;const t=createTranscoder({tmpdir:dir,executable:bin,startupMs:35000,open:async()=>{opened++;return {ok:true,status:200,headers:new Headers({'content-type':'video/mp4'}),body:Readable.toWeb(fs.createReadStream(fixture))}}});
 try{const job=await t.start({},'alice');assert.equal(opened,1);await assert.rejects(t.start({},'bob'),e=>e.status===409);assert.equal(await t.read(job.id,'bob','master.m3u8'),null);const master=await t.read(job.id,'alice','master.m3u8');assert.match(master.data.toString(),/RESOLUTION=426x240/);assert.match(master.data.toString(),/RESOLUTION=640x360/);assert.equal(await t.read(job.id,'alice','../sample.mp4'),null);
 for(const level of ['240','360']){const list=await t.read(job.id,'alice',`${level}/index.m3u8`);const name=list.data.toString().match(/index\d+\.ts/)[0];const segment=await t.read(job.id,'alice',`${level}/${name}`);assert.ok(segment.data.length>0);const decode=spawnSync(bin,['-hide_banner','-loglevel','error','-f','mpegts','-i','pipe:0','-map','0:v:0','-map','0:a:0','-f','null','-'],{input:segment.data,encoding:'buffer'});assert.equal(decode.status,0,String(decode.stderr));}
 assert.equal(await t.stopFor(job.id,'bob'),false);
 // Hold a segment read across stop: cleanup must not remove the file mid-read.
 const originalRead=fsp.readFile;let entered,release;const reading=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 fsp.readFile=async function(file,...args){if(String(file).endsWith('/240/index0.ts')){entered();await gate;}return originalRead.call(this,file,...args)};
 try{const inflight=t.read(job.id,'alice','240/index0.ts');await reading;let finished=false;const stopping=t.stopFor(job.id,'alice').then(value=>{finished=true;return value;});await new Promise(r=>setTimeout(r,50));assert.equal(finished,false);release();assert.ok((await inflight).data.length);assert.equal(await stopping,true);}finally{release();fsp.readFile=originalRead;}
 assert.equal(await t.read(job.id,'alice','master.m3u8'),null);assert.deepEqual((await fsp.readdir(dir)).sort(),['sample.mp4']);
 const silent=path.join(dir,'silent.mp4');const noAudio=spawnSync(bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=480x270:rate=20','-t','10','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',silent],{encoding:'utf8'});assert.equal(noAudio.status,0,noAudio.stderr);
 const statfs=fsp.statfs;let calls=0;fsp.statfs=async()=>{calls++;throw Error('statfs unavailable')};
 const uncapped=createTranscoder({tmpdir:dir,executable:bin,maxBytes:1,minFreeBytes:Number.MAX_SAFE_INTEGER,startupMs:35000,open:async()=>({ok:true,status:200,headers:new Headers({'content-type':'video/mp4'}),body:Readable.toWeb(fs.createReadStream(silent))})});
 try{const small=await uncapped.start({},'alice');await new Promise(r=>setTimeout(r,2500));assert.equal(uncapped.status(small.id,'alice').active,true);assert.equal(calls,0);}finally{fsp.statfs=statfs;await uncapped.close();}

 }finally{await t.close();await fsp.rm(dir,{recursive:true,force:true})}
});

test('fast-start gate rejects unsafe or non-seekable MP4 inputs without consuming the file',async()=>{
 const {fastStartGate}=require('./transcode'),{Readable}=require('node:stream'),{pipeline}=require('node:stream/promises'),{Writable}=require('node:stream');const box=(name,payload=Buffer.alloc(0))=>{const b=Buffer.alloc(8+payload.length);b.writeUInt32BE(b.length);b.write(name,4);payload.copy(b,8);return b};const read=async chunks=>{const data=[];await pipeline(Readable.from(chunks),fastStartGate(1024),new Writable({write(c,e,cb){data.push(c);cb()}}));return Buffer.concat(data)};
 const ok=Buffer.concat([box('ftyp'),box('free'),box('moov',Buffer.from('meta')),box('mdat',Buffer.from('data'))]);assert.deepEqual(await read([ok.subarray(0,3),ok.subarray(3,15),ok.subarray(15)]),ok);await assert.rejects(read([box('ftyp'),box('mdat'),box('moov')]),/not fast-start/);await assert.rejects(read([Buffer.from('#EXTM3U\n')]),/fast-start/);const giant=Buffer.alloc(8);giant.writeUInt32BE(2048);giant.write('moov',4);await assert.rejects(read([box('ftyp'),giant]),/limit/);
});

test('FFmpeg selection checks packaged executable, falls back safely, and distinguishes permission errors',async()=>{
 const {bundledFfmpeg,ffmpegCandidates,chooseFfmpeg,probeFfmpeg}=require('./transcode');const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 assert.equal(bundledFfmpeg('win32','x64'),null);assert.equal(bundledFfmpeg('linux','riscv64'),null);if(bundledFfmpeg()){const chosen=await chooseFfmpeg([{label:'Missing',path:'/does/not/exist'}, {label:'Packaged',path:bundledFfmpeg()}]);assert.equal(chosen,bundledFfmpeg());}
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'troy-probe-test-'));try{const file=path.join(dir,'blocked');await fs.writeFile(file,'#!/bin/sh\nexit 0\n',{mode:0o600});await assert.rejects(probeFfmpeg(file),/execution was denied/);await assert.rejects(chooseFfmpeg([{label:'Bundled FFmpeg',path:file},{label:'System FFmpeg',path:'/does/not/exist'}]),/execution was denied.*not found/);const limited=path.join(dir,'limited');await fs.writeFile(limited,"#!/bin/sh\nif [ \"$1\" = \"-version\" ]; then echo 'ffmpeg version test'; else echo ' V....D libx264 x264'; fi\n",{mode:0o700});// x264 is present but AAC is not, and the message names exactly that.
await assert.rejects(probeFfmpeg(limited),/missing the AAC encoder/);}finally{await fs.rm(dir,{recursive:true,force:true});}
 const old=process.env.CINEMA_FFMPEG;try{process.env.CINEMA_FFMPEG='/custom/path';assert.deepEqual(ffmpegCandidates().map(x=>x.path),['/custom/path']);}finally{if(old===undefined)delete process.env.CINEMA_FFMPEG;else process.env.CINEMA_FFMPEG=old;}
});

test('FFmpeg can discard to a later MP4 timestamp on a pipe, but pipe input is not range-seekable', {skip:!testFfmpeg,timeout:30000},async()=>{
 const {spawnSync}=require('node:child_process'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'troy-pipe-seek-')),file=path.join(dir,'source.mp4');
 try{
  const make=spawnSync(testFfmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=red:s=160x90:r=10:d=10','-f','lavfi','-i','color=blue:s=160x90:r=10:d=10','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-y',file],{encoding:'utf8',timeout:15000});assert.equal(make.status,0,make.stderr);
  const input=await fs.readFile(file);const seek=spawnSync(testFfmpeg,['-hide_banner','-loglevel','error','-protocol_whitelist','pipe','-format_whitelist','mov','-f','mov','-i','pipe:0','-ss','12','-t','1','-vf','scale=2:2','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{input,maxBuffer:1024*1024,timeout:15000});assert.equal(seek.status,0,String(seek.stderr));assert.ok(seek.stdout.length>=3);assert.ok(seek.stdout[2]>200 && seek.stdout[0]<30,'frame at 12s should be blue');
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});


test('range probe validates start and midpoint, cancels ignored bodies, rejects malformed and inconsistent responses',async()=>{
 const {probeRange}=require('./source-probe');let calls=[],cancelled=0;
 const fake=(status,headers)=>({status,headers:new Headers(headers),body:{cancel:async()=>{cancelled++}}});
 const ok=await probeRange(async(_entry,_signal,start,end)=>{calls.push([start,end]);return fake(206,{'content-range':`bytes ${start}-${end}/100`,'content-length':'2',etag:'"one"'})},{});
 assert.deepEqual(ok,{addressable:true,size:100,status:206});assert.deepEqual(calls,[[0,1],[50,51]]);assert.equal(cancelled,2);
 const ignored=await probeRange(async()=>fake(200,{'content-length':'100'}),{});assert.equal(ignored.addressable,false);assert.equal(cancelled,3);
 let n=0;const changed=await probeRange(async(_e,_s,start,end)=>fake(206,{'content-range':`bytes ${start}-${end}/${++n===1?100:101}`}),{});assert.equal(changed.addressable,false);assert.equal(cancelled,5);
 const compressed=await probeRange(async()=>fake(206,{'content-range':'bytes 0-1/100','content-encoding':'gzip'}),{});assert.equal(compressed.addressable,false);
 const bad=await probeRange(async()=>fake(206,{'content-range':'bytes 0-2/100'}),{});assert.equal(bad.addressable,false);
});


test('local seekable MP4 input-side seek produces the later scene', {skip:!testFfmpeg,timeout:30000},async()=>{
 const {spawnSync}=require('node:child_process'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'troy-local-seek-')),file=path.join(dir,'source.mp4');
 try{
  const make=spawnSync(testFfmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=red:s=160x90:r=10:d=10','-f','lavfi','-i','color=blue:s=160x90:r=10:d=10','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-y',file],{encoding:'utf8',timeout:15000});assert.equal(make.status,0,make.stderr);
  const seek=spawnSync(testFfmpeg,['-hide_banner','-loglevel','error','-ss','12','-i',file,'-t','1','-vf','scale=2:2','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:1024*1024,timeout:15000});assert.equal(seek.status,0,String(seek.stderr));assert.ok(seek.stdout.length>=3);assert.ok(seek.stdout[2]>200 && seek.stdout[0]<30,'frame at 12s should be blue');
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('FFmpeg EVENT retains early segments and ends a completed short fixture', {skip:!testFfmpeg,timeout:30000},async()=>{
 const {spawnSync}=require('node:child_process'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'troy-event-proof-'));
 try {
  const file=path.join(dir,'index.m3u8');
  const run=spawnSync(testFfmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=160x90:rate=10','-t','12','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-g','10','-sc_threshold','0','-f','hls','-hls_time','1','-hls_list_size','0','-hls_playlist_type','event','-hls_flags','independent_segments','-hls_segment_filename',path.join(dir,'index%d.ts'),file],{encoding:'utf8',timeout:20000});
  assert.equal(run.status,0,run.stderr);
  const manifest=await fs.readFile(file,'utf8');const segments=manifest.split('\n').filter(x=>/^index\d+\.ts$/.test(x));assert.match(manifest,/#EXT-X-PLAYLIST-TYPE:EVENT/);assert.match(manifest,/#EXT-X-ENDLIST/);assert.ok(segments.length>8);assert.equal(segments[0],'index0.ts');const first=await fs.readFile(path.join(dir,segments[0]));assert.ok(first.length>0);
  const decode=spawnSync(testFfmpeg,['-hide_banner','-loglevel','error','-f','mpegts','-i','pipe:0','-frames:v','1','-f','null','-'],{input:first,timeout:10000});assert.equal(decode.status,0,String(decode.stderr));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('production transcoder retains earlier segments throughout an EVENT and finalizes on completion', {skip:!testFfmpeg,timeout:100000},async()=>{
 const {createTranscoder}=require('./transcode'),{Readable}=require('node:stream'),fs=require('node:fs'),fsp=fs.promises,os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'troy-event-job-')),file=path.join(dir,'source.mp4');
 const input=spawnSync(testFfmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440','-t','44','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart','-c:a','aac',file],{encoding:'utf8',timeout:20000});assert.equal(input.status,0,input.stderr);
 const t=createTranscoder({tmpdir:dir,executable:testFfmpeg,startupMs:35000,idleMs:90000,open:async()=>({ok:true,status:200,headers:new Headers({'content-type':'video/mp4'}),body:Readable.toWeb(fs.createReadStream(file))})});
 try{
  const job=await t.start({},'alice');const start=await t.read(job.id,'alice','240/index.m3u8');assert.match(start.data.toString(),/#EXT-X-PLAYLIST-TYPE:EVENT/);assert.doesNotMatch(start.data.toString(),/#EXT-X-ENDLIST/);assert.match(start.data.toString(),/index0\.ts/);
  const deadline=Date.now()+65000;let manifests=[];
  while(Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));manifests=await Promise.all(['240','360'].map(q=>t.read(job.id,'alice',`${q}/index.m3u8`)));if(manifests.every(m=>m && /#EXT-X-ENDLIST/.test(m.data.toString())))break;}
  for(let i=0;i<2;i++){
   const quality=['240','360'][i],text=manifests[i].data.toString(),segments=text.split('\n').filter(s=>/^index\d+\.ts$/.test(s));
   assert.match(text,/#EXT-X-PLAYLIST-TYPE:EVENT/);assert.match(text,/#EXT-X-ENDLIST/);assert.ok(segments.length>8);assert.equal(segments[0],'index0.ts');assert.equal(await t.read(job.id,'bob',`${quality}/index0.ts`),null);
   const first=await t.read(job.id,'alice',`${quality}/index0.ts`),last=await t.read(job.id,'alice',`${quality}/${segments.at(-1)}`);assert.ok(first?.data.length);assert.ok(last?.data.length);
   for(const part of [first,last]){const decode=spawnSync(testFfmpeg,['-hide_banner','-loglevel','error','-f','mpegts','-i','pipe:0','-map','0:v:0','-map','0:a:0','-f','null','-'],{input:part.data,timeout:10000});assert.equal(decode.status,0,String(decode.stderr));}
  }
 }finally{await t.close();await fsp.rm(dir,{recursive:true,force:true});}
});

test('production transcoder starts a new conversion at an unconverted MP4 timestamp', {skip:!testFfmpeg,timeout:40000},async()=>{
 const {createTranscoder}=require('./transcode'),{Readable}=require('node:stream'),fs=require('node:fs'),fsp=fs.promises,os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'troy-offset-')),file=path.join(dir,'source.mp4');
 const input=spawnSync(testFfmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=red:s=160x90:r=10:d=10','-f','lavfi','-i','color=blue:s=160x90:r=10:d=10','-f','lavfi','-i','sine=frequency=440:duration=20','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-map','2:a','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',file],{encoding:'utf8',timeout:15000});assert.equal(input.status,0,input.stderr);
 let requestedOffset=null;const t=createTranscoder({tmpdir:dir,executable:testFfmpeg,startupMs:10000,open:async(_entry,_signal,offset=0)=>{requestedOffset=offset;return {ok:true,status:200,headers:new Headers({'content-type':'video/mp4'}),body:Readable.toWeb(fs.createReadStream(file))}}});
 try{
  await assert.rejects(t.start({},'alice',-1),/Invalid seek/);
  const job=await t.start({},'alice',12);assert.equal(requestedOffset,0,'seek still opens input at byte zero');assert.equal(job.offset,12);assert.ok(Math.abs(job.duration-20)<0.1,job.duration);
  for(const quality of ['240','360']){const list=await t.read(job.id,'alice',`${quality}/index.m3u8`);const first=list.data.toString().match(/index\d+\.ts/)[0];const segment=await t.read(job.id,'alice',`${quality}/${first}`);
   const decode=spawnSync(testFfmpeg,['-hide_banner','-loglevel','error','-f','mpegts','-i','pipe:0','-frames:v','1','-vf','scale=2:2','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{input:segment.data,timeout:10000});assert.equal(decode.status,0,String(decode.stderr));assert.ok(decode.stdout[2]>200 && decode.stdout[0]<30,`first frame should be blue, got ${[...decode.stdout.subarray(0,3)]}`);
   const audio=spawnSync(testFfmpeg,['-hide_banner','-loglevel','error','-f','mpegts','-i','pipe:0','-map','0:a:0','-f','null','-'],{input:segment.data,timeout:10000});assert.equal(audio.status,0,String(audio.stderr));}
  await t.stopFor(job.id,'alice');await assert.rejects(t.start({},'alice',21),/Cannot seek beyond/);
 }finally{await t.close();await fsp.rm(dir,{recursive:true,force:true});}
});

test('in-flight conversion cancellation is bound to request and session', {skip:!testFfmpeg,timeout:20000},async()=>{
 const {createTranscoder}=require('./transcode'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'troy-cancel-'));let opened;const ready=new Promise(resolve=>opened=resolve);
 const t=createTranscoder({tmpdir:dir,executable:testFfmpeg,open:async(_source,signal)=>{opened();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))}});
 try{const start=t.start({},'owner',25,'req1');const result=start.catch(e=>e);await ready;assert.equal(await t.stopRequest('req1','other'),false);assert.equal(await t.stopRequest('req2','owner'),false);assert.equal(await t.stopRequest('req1','owner'),true);assert.match((await result).message,/aborted|stopped/);assert.deepEqual(await fs.readdir(dir),[]);}finally{await t.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('MP4 duration parser handles mvhd versions and rejects unknown or malformed lengths',()=>{
 const {movieDuration}=require('./transcode');
 const box=(type,payload)=>{const out=Buffer.alloc(payload.length+8);out.writeUInt32BE(out.length,0);out.write(type,4);payload.copy(out,8);return out;};
 const v0=Buffer.alloc(20);v0.writeUInt32BE(1000,12);v0.writeUInt32BE(90500,16);const moov0=box('moov',box('mvhd',v0));assert.equal(movieDuration(moov0,0,moov0.length,8),90.5);
 const v1=Buffer.alloc(32);v1[0]=1;v1.writeUInt32BE(1000,20);v1.writeBigUInt64BE(120000n,24);const moov1=box('moov',box('mvhd',v1));assert.equal(movieDuration(moov1,0,moov1.length,8),120);
 v1.writeBigUInt64BE(0xffffffffffffffffn,24);const unknown=box('moov',box('mvhd',v1));assert.equal(movieDuration(unknown,0,unknown.length,8),null);
 const broken=Buffer.from(moov0);broken.writeUInt32BE(0xfffffff0,8);assert.equal(movieDuration(broken,0,broken.length,8),null);
});


test('actual filesystem-full FFmpeg failures are reported without leaking stderr',()=>{
 const {ffmpegExitError}=require('./transcode');assert.match(ffmpegExitError(1,'Error: No space left on device'),/filesystem is full/);assert.match(ffmpegExitError(1,'Disk quota exceeded'),/quota/);assert.doesNotMatch(ffmpegExitError(1,'secret upstream URL'),/secret/);
});

test('FFmpeg disk-full failure reaches the client error and cleans up',async()=>{
 const {createTranscoder}=require('./transcode'),{Readable}=require('node:stream'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'troy-full-test-')),exe=path.join(dir,'ffmpeg-fixture');
 const script=String.raw`#!/usr/bin/env node
if(process.argv.includes('-version')) console.log('fixture');
else if(process.argv.includes('-encoders')) console.log(' V..... libx264\n A..... aac');
else if(process.argv.includes('-muxers')) console.log(' E hls');
else if(process.argv.includes('-filters')) console.log(' ... scale\n ... pad');
else if(process.argv.includes('full')) console.log('-readrate <speed>\n-readrate_initial_burst <seconds>');
else if(process.argv.includes('muxer=hls')) console.log('temp_file');
else {process.stderr.write('No space left on device\n');process.exit(1);}
`;
 await fs.writeFile(exe,script,{mode:0o755});const box=name=>{const b=Buffer.alloc(8);b.writeUInt32BE(8);b.write(name,4);return b};
 const t=createTranscoder({tmpdir:dir,executable:exe,startupMs:5000,open:async()=>({ok:true,status:200,headers:new Headers({'content-type':'video/mp4'}),body:Readable.toWeb(Readable.from([Buffer.concat([box('ftyp'),box('moov')])]))})});
 try{await assert.rejects(t.start({},'owner'),/filesystem is full or its quota has been exceeded/);assert.deepEqual(await fs.readdir(dir),['ffmpeg-fixture']);}finally{await t.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('MovieBox detail seasons are bounded and tied to the selected subject', async () => {
  const createMoviebox=require('./moviebox'); let subject='42';
  const adapter=createMoviebox({safeUrl:u=>new URL(u),request:async url=>{
    if(url.includes('/home?'))return {headers:new Headers({'x-user':JSON.stringify({token:'test'})})};
    assert.match(url,/\/detail\?detailPath=/);
    return {json:{data:{subject:{subjectId:subject,subjectType:2},resource:{seasons:[{se:1,maxEp:2},{se:2,maxEp:1},{se:2,maxEp:20},{se:3,maxEp:100000}]}}}};
  }});
  const item={subjectId:'42',detailPath:'show-42',type:'series'};
  assert.deepEqual(await adapter.episodes(item),[{season:1,episode:1,title:'Episode 1'},{season:1,episode:2,title:'Episode 2'},{season:2,episode:1,title:'Episode 1'}]);
  subject='99';assert.deepEqual(await adapter.episodes(item),[]);
});

test('a session can replace its abandoned conversion without cancelling another session', {skip:!testFfmpeg,timeout:20000},async()=>{
 const {createTranscoder}=require('./transcode'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'troy-replace-'));let notify;const opened=new Promise(r=>notify=r);let count=0;
 const t=createTranscoder({tmpdir:dir,executable:testFfmpeg,open:async(_source,signal)=>{count++;notify();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))}});
 try{
  const first=t.start({},'owner',0,'first');first.catch(()=>{});await opened;
  await assert.rejects(t.start({},'other',0,'other'),/Another session/);
  const second=t.start({},'owner',0,'second');second.catch(()=>{});
  await assert.rejects(first,/aborted|stopped/);
  assert.equal(await t.stopRequest('first','owner'),false);
  await t.stopSession('owner');await assert.rejects(second,/aborted|stopped/);
 }finally{await t.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('disconnected startup is cancelled and authenticated manual reclaim can stop an abandoned job', {skip:!testFfmpeg,timeout:20000},async()=>{
 const {createTranscoder}=require('./transcode'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'troy-disconnect-'));let notify;const opened=new Promise(r=>notify=r);
 const t=createTranscoder({tmpdir:dir,executable:testFfmpeg,open:async(_source,signal)=>{notify();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))}});
 try{
  const controller=new AbortController();const pending=t.start({},'owner',0,'req',controller.signal);pending.catch(()=>{});await opened;controller.abort();await assert.rejects(pending,/aborted|stopped/);assert.deepEqual(await fs.readdir(dir),[]);
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(t.start({},'owner',0,'req',cancelled.signal),/disconnected/);
  const next=t.start({},'owner',0,'next');next.catch(()=>{});await new Promise(resolve=>{notify=resolve});assert.equal(await t.stopAny(),true);await assert.rejects(next,/aborted|stopped/);assert.equal(await t.stopAny(),false);
 }finally{await t.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('expired sessions cannot claim jobs',async()=>{
 const {createTranscoder}=require('./transcode');let opened=0;
 const t=createTranscoder({authorize:sid=>sid==='live',open:async()=>{opened++;throw Error('should not open')}});
 try{await assert.rejects(t.start({},'expired'),e=>e.status===401);assert.equal(opened,0);}finally{await t.close();}
});

test('a running converter is not expired just because the viewer pauses', {skip:!testFfmpeg,timeout:30000},async()=>{
 const {createTranscoder}=require('./transcode'),{Readable}=require('node:stream'),fs=require('node:fs'),fsp=fs.promises,os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'troy-pause-')),file=path.join(dir,'source.mp4');
 try{const generated=spawnSync(testFfmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=160x90:rate=10','-t','20','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',file],{timeout:15000});assert.equal(generated.status,0,String(generated.stderr));
 const t=createTranscoder({tmpdir:dir,executable:testFfmpeg,idleMs:1,open:async()=>({status:200,body:Readable.toWeb(fs.createReadStream(file)),headers:new Headers({'content-type':'video/mp4'})})});
 try{const job=await t.start({},'owner');await new Promise(r=>setTimeout(r,2300));assert.equal(t.status(job.id,'owner')?.active,true);}finally{await t.close();}
 }finally{await fsp.rm(dir,{recursive:true,force:true});}
});

test('provider extensions classify explicit MP4 without treating opaque links as MP4',async()=>{
 const {createProviders}=require('./providers');const {safeUrl}=require('./network');
 const providers=createProviders({safeUrl,request:async url=>url.includes('api.php')?{json:{status_code:'200',data:{stream_urls:['https://cdn.example/a.mp4?token=1','https://cdn.example/live.m3u8','https://cdn.example/opaque']}}}:url.includes('vidsrc.net')?{text:'<div data-hash="abc">'}:{text:'https://cdn.example/video.mp4?token=2 https://cdn.example/live.m3u8'}});
 const a=await providers.vaplayer({imdbId:'tt123',type:'movie'},1,1);assert.deepEqual(a.streams.map(x=>x.format),['file','hls','hls']);
 const b=await providers.vidsrc({tmdbId:'123',type:'movie'},1,1);assert.deepEqual(b.streams.map(x=>x.format),['file','hls']);
});

test('provider deadlines abort work, preserve independent results, and dedupe only identical playback contexts',async()=>{
 const {resolveProviders}=require('./providers'),{scope}=require('./provider-timeout');let aborted=false;
 const moviebox={resolve:async()=>({streams:[{url:'https://cdn.example/a.mp4',format:'file',quality:360}],referer:'https://ref.example/'})};
 const providers={vaplayer:async()=>{const signal=scope.getStore();return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'))},{once:true}));},vidsrc:async()=>({streams:[{url:'https://cdn.example/a.mp4',format:'file',quality:360}],referer:'https://ref.example/'})};
 const result=await resolveProviders({moviebox,providers,item:{source:'moviebox',type:'movie'},season:1,episode:1,deadlineMs:30});assert.equal(aborted,true);assert.equal(result.streams.length,1);assert.equal(result.providers.find(x=>x.provider==='vaplayer').count,0);
 let movieboxCalls=0;const only=await resolveProviders({moviebox:{resolve:async()=>{movieboxCalls++;return {streams:[]}}},providers,item:{source:'moviebox',type:'movie'},onlyProvider:'vidsrc',deadlineMs:30});assert.equal(movieboxCalls,0);assert.equal(only.providers.length,1);
 const separate=await resolveProviders({moviebox,providers:{vaplayer:async()=>({streams:[]}),vidsrc:async()=>({streams:[{url:'https://cdn.example/a.mp4',format:'file'}],referer:'https://different.example/'})},item:{source:'moviebox',type:'movie'},deadlineMs:30});assert.equal(separate.streams.length,2);
});

test('cross-origin redirects strip credentials while preserving same-origin redirects',async()=>{
 const {getRemote}=require('./network');const seen=[];let n=0;
 const fetch=async(url,opts)=>{seen.push({url:String(url),headers:new Headers(opts.headers)});n++;if(n===1)return {status:302,headers:new Headers({location:'/two'}),body:{cancel:async()=>{}}};if(n===2)return {status:302,headers:new Headers({location:'https://other.example/three'}),body:{cancel:async()=>{}}};return {status:200,headers:new Headers(),body:null};};
 await getRemote('https://cdn.example/one',{'Authorization':'Bearer secret','Cookie':'session=secret','user-agent':'Troy'},undefined,fetch,{});
 assert.equal(seen[1].headers.get('authorization'),'Bearer secret');assert.equal(seen[2].headers.get('authorization'),null);assert.equal(seen[2].headers.get('cookie'),null);assert.equal(seen[2].headers.get('user-agent'),'Troy');
});

test('login attempts have separate peer buckets and a global backstop',()=>{
 const {createLoginLimiter}=require('./login-limiter');let now=0;const limiter=createLoginLimiter({perPeer:2,global:3,windowMs:100,now:()=>now});
 limiter.failure('a');limiter.failure('a');assert.equal(limiter.blocked('a'),true);assert.equal(limiter.blocked('b'),false);limiter.failure('b');assert.equal(limiter.blocked('c'),true);now=101;assert.equal(limiter.blocked('a'),false);
});

test('source handles evict oldest entries per session without restart',()=>{
 const {createSourceStore}=require('./source-store');let now=1;const store=createSourceStore({perSession:2,maxEntries:3,now:()=>now});const add=(id,sid,expires=100)=>store.set(id,{sid,expires});
 add('a1','a');add('a2','a');add('b1','b');assert.ok(store.get('a1'));add('a3','a');assert.equal(store.get('a2'),null);assert.ok(store.get('b1'));add('c1','c');assert.equal(store.size,3);now=101;assert.equal(store.get('a1'),null);
});

test('KissKh episode details are cached, coalesced and returned as copies',async()=>{
 let calls=0;const kk=require('./kisskh')({safeUrl:u=>new URL(u),request:async()=>{calls++;await new Promise(r=>setTimeout(r,1));return {json:{episodes:[{id:12,number:1}]}}}});
 const [a,b]=await Promise.all([kk.details(123),kk.details(123)]);a[0].number=9;assert.equal(b[0].number,1);assert.equal((await kk.details(123))[0].number,1);assert.equal(calls,1);
});

test('Movy reports malformed detail metadata without leaking its contents',async()=>{
 const {createMovy}=require('./movy');const {safeUrl}=require('./network');const resolve=createMovy({safeUrl,request:async()=>({text:'<script id="__NEXT_DATA__">{bad and private}</script>'})});await assert.rejects(resolve({tmdbId:'123',type:'movie'},1,1),e=>e.message==='Movy detail data is invalid');
});

test('an unroutable IPv6 answer cannot be chosen when IPv4 is preferred', async () => {
  // A host with no working IPv6 route still receives AAAA records. The resolver
  // legitimately answers with an address this machine cannot reach, and every
  // safety check passes because the address is public and unicast.
  const fresh = () => { delete require.cache[require.resolve('./network')]; return require('./network'); };
  const dualStack = async () => [{ address: '2600:9000::1', family: 6 }, { address: '18.65.238.40', family: 4 }];

  const previous = process.env.CINEMA_IPV4;
  try {
    process.env.CINEMA_IPV4 = '1';
    const { publicLookup } = fresh();
    const pick = options => new Promise((ok, bad) => publicLookup(dualStack)('cdn.example', options, (e, a) => e ? bad(e) : ok(a)));
    assert.equal(await pick({}), '18.65.238.40', 'IPv4 is chosen over an earlier IPv6 answer');
    // An IPv6-only network still works when it asks for that family explicitly.
    assert.equal(await pick({ family: 6 }), '2600:9000::1');

    // Explicitly off: the resolver order is preserved, whatever the host.
    process.env.CINEMA_IPV4 = '0';
    const auto = fresh();
    const autoPick = options => new Promise((ok, bad) => auto.publicLookup(dualStack)('cdn.example', options, (e, a) => e ? bad(e) : ok(a)));
    assert.equal(await autoPick({}), '2600:9000::1');
    assert.equal(auto.forceIPv4, false);

    // Unset: decided by whether this machine actually has an IPv6 route, so
    // the same code does the right thing on either kind of host.
    delete process.env.CINEMA_IPV4;
    const detected = fresh();
    assert.equal(detected.forceIPv4, detected.ipv6Unrouted,
      'IPv4 is preferred exactly when the host has no IPv6 route');
  } finally {
    if (previous === undefined) delete process.env.CINEMA_IPV4; else process.env.CINEMA_IPV4 = previous;
    delete require.cache[require.resolve('./network')];
  }
});

test('preferring IPv4 never relaxes the private-address check', async () => {
  process.env.CINEMA_IPV4 = '1';
  delete require.cache[require.resolve('./network')];
  try {
    const { publicLookup } = require('./network');
    const lookup = publicLookup(async () => [{ address: '18.65.238.40', family: 4 }, { address: '10.0.0.5', family: 4 }]);
    await assert.rejects(new Promise((ok, bad) => lookup('cdn.example', {}, (e, a) => e ? bad(e) : ok(a))), /Private/);
  } finally {
    delete process.env.CINEMA_IPV4;
    delete require.cache[require.resolve('./network')];
  }
});

test('a 426 from the source is retried at offset 0 and never mid-file',async()=>{
  // The CDN edge refuses the first connection and accepts the next, which is
  // what a browser retry does. Mid-file a replay would leave a hole, so only
  // the opening request may be retried.
  const {createTranscoder}=require('./transcode');const {Readable}=require('node:stream');
  const {createSourceOpener}=require('./source-opener');
  const {safeUrl}=require('./network');
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'troy-ffstub-'));
  const stub=path.join(dir,'ffmpeg');
  // Satisfies every capability probe and then produces no output, so the job
  // reaches the source-open path and stops there on the startup deadline.
  fs.writeFileSync(stub,`#!/bin/sh
case "$*" in
  *"-encoders"*) printf ' V....D libx264\\n A....D aac\\n'; exit 0;;
  *"-muxers"*) printf ' E  hls\\n'; exit 0;;
  *"-filters"*) printf ' ..C scale\\n ..C pad\\n'; exit 0;;
  *"-h muxer=hls"*) printf ' temp_file\\n'; exit 0;;
  *"-h full"*) printf ' -readrate\\n -readrate_initial_burst\\n'; exit 0;;
  *"-version"*) printf 'ffmpeg version stub\\n'; exit 0;;
esac
exit 0
`);
  fs.chmodSync(stub,0o755);
  const head='0000000866747970000000086d6f6f76';
  const respond=status=>({ok:status===200,status,headers:new Headers({'content-type':'video/mp4'}),body:Readable.toWeb(Readable.from(Buffer.from(head,'hex')))});
  try{
    let opens=0;
    const open=createSourceOpener({safeUrl,remote:async()=>{opens++;return respond(opens===1?426:200);}});
    const t=createTranscoder({executable:stub,open,startupMs:4000,tmpdir:dir});
    try{await assert.rejects(t.start({},'a'),/did not start in time|Source returned/);}
    finally{await t.close()}
    assert.ok(opens>=2,'the refused opening request was retried rather than failing the source');

    // Mid-file the 426 is reported immediately, with no replay.
    let midFile=0;
    const open2=createSourceOpener({safeUrl,remote:async()=>{midFile++;return respond(426);}});
    const t2=createTranscoder({executable:stub,open:open2,startupMs:4000,tmpdir:dir});
    try{await assert.rejects(t2.start({},'a',120),/Source returned 426 \(the host refused this connection/);}
    finally{await t2.close()}
    assert.equal(midFile,1,'no replay once bytes may already have been consumed');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
