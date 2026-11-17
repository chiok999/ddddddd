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
  const page=await fetch(base+'/'); assert.match(page.headers.get('content-security-policy'),/frame-src 'none'/);
  for(const asset of ['/player-ui.js','/player.css']){const response=await fetch(base+asset);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),asset.endsWith('.css')?/text\/css/:/javascript/);}
  assert.equal((await post('/api/login',{password:'wrong'})).status,401);
  assert.equal((await post('/api/login',{password:'a-strong-test-password'},{origin:'https://evil.test'})).status,403);
  const login=await post('/api/login',{password:'a-strong-test-password'}); assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
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
  assert.equal(calls,3); // search fallback is also attempted, but the private player is never requested.
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

test('HTTP flow authenticates, resolves a fixture, proxies HLS segments and blocks private redirects', async () => {
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
    const manifest=await fetch(base+resolved.streams[0].url,{headers:{cookie}}); assert.equal(manifest.status,200);
    const text=await manifest.text(), segment=text.split('\n').find(line=>line.startsWith('/media/')); assert.ok(segment);
    assert.equal((await fetch(base+segment)).status,401);
    assert.equal(await (await fetch(base+segment,{headers:{cookie}})).text(),'segment');
    const redirect=(await (await post('/api/source',{url:'https://cdn.example/redirect.m3u8',format:'hls'},cookie)).json()).url;
    assert.equal((await fetch(base+redirect,{headers:{cookie}})).status,400);
    await post('/api/logout',{},cookie); assert.equal((await fetch(base+segment,{headers:{cookie}})).status,401);
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
 const {safeUrl}=require('./network');let urls=[];const resolve=require('./vidlink')({safeUrl,request:async(url)=>{urls.push(url);if(url.includes('enc-dec.app')) return {json:{result:'abc_123'}};return {json:{stream:{headers:{Referer:'https://vidlink.pro/','Authorization':'secret'},qualities:{720:{url:'https://cdn.example/video',type:'mp4',headers:{Origin:'https://vidlink.pro'}},'1080p':{url:'https://127.0.0.1/video'}},playlist:'https://cdn.example/hls',captions:[{language:'English',url:'https://cdn.example/sub.vtt'}]}}};}});
 const r=await resolve({tmdbId:'123',type:'series'},2,3);assert.equal(r.streams.length,2);assert.equal(r.streams[0].quality,720);assert.equal(r.streams[0].referer,'https://vidlink.pro/');assert.equal(r.streams[0].origin,'https://vidlink.pro');assert.equal(r.streams[0].authorization,undefined);assert.equal(r.streams[1].format,'hls');assert.equal(r.captionInfo.url,'https://cdn.example/sub.vtt');assert.match(urls[1],/\/tv\/abc_123\/2\/3$/);
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
