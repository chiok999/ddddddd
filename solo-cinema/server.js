'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Agent, fetch } = require('undici');
const { safeUrl, publicLookup, getRemote, getWithH2Fallback } = require('./network');
const { describe } = require('./diagnostics');
const {scope:providerScope}=require('./provider-timeout');

// Botkeep writes variables to .env rather than exporting them. Node loads the
// file from the process working directory without overriding real environment
// variables supplied by the host. Never log the values.
try { process.loadEnvFile(path.resolve(process.cwd(), '.env')); }
catch (err) { if (err.code !== 'ENOENT') { console.error('Unable to load .env file.'); process.exit(1); } }

const password = process.env.CINEMA_PASSWORD || '';
if (password.length < 12) { console.error('Set CINEMA_PASSWORD to at least 12 characters.'); process.exit(1); }
const sessions = new Map();
const sources = require('./source-store').createSourceStore();
const loginLimiter=require('./login-limiter').createLoginLimiter();
let activeRangeProbes = 0;
const catalog = new Map();
const captions = require('./source-store').createSourceStore({perSession:100,maxEntries:1000});
const captionSources = require('./source-store').createSourceStore({perSession:1000,maxEntries:4000});
const agent = new Agent({ connect: { lookup: publicLookup() } });
// Used for a single GET retry after HTTP 426; it retains pinned DNS validation.
const h2Agent = new Agent({ allowH2:true, connect: { lookup: publicLookup() } });
const fail = msg => { throw new Error(msg); };
function remember(url, sid, referer = null, format = null, origin = null, userAgent = null, refresh = null, refreshAfterMs = null) {
  const id = crypto.randomBytes(24).toString('base64url');
  sources.set(id, { url: safeUrl(url).href, sid, referer, format, origin, userAgent, refresh, refreshAt:Number.isFinite(refreshAfterMs) && refreshAfterMs>0 ? Date.now()+refreshAfterMs : null, expires: Date.now() + 6 * 3600000 });
  return `/media/${id}`;
}
// Informational only: never prevent playback based on storage detection.
const transcodeTmp=process.env.CINEMA_TMPDIR || require('node:os').tmpdir();
if(process.platform==='linux') fs.statfs(transcodeTmp,(err,stat)=>{if(!err && Number(stat.type)===0x01021994)console.warn('Troy temporary output is on tmpfs and may consume RAM.');});
const openSource=require('./source-opener').createSourceOpener({safeUrl,remote:async(url,headers,signal)=>(await getRemote(url,headers,signal,fetch,agent,h2Agent)).response});
const openHlsResource=async(source,signal,range)=>{
  const headers={'accept-encoding':'identity','user-agent':source.userAgent || require('./source-opener').DEFAULT_USER_AGENT};if(range)headers.range=range;
  if(source.userAgent)headers['user-agent']=source.userAgent;if(source.referer)headers.referer=source.referer;if(source.origin)headers.origin=source.origin;
  return (await getRemote(source.url,headers,signal,fetch,agent,h2Agent)).response;
};
const transcoder=require('./transcode').createTranscoder({open:openSource,openHlsResource,tmpdir:transcodeTmp,authorize:sid=>(sessions.get(sid)||0)>=Date.now()});
// Same-origin relay for direct playback. Provider CDNs often reject requests
// that do not come from a browser, and a browser cannot add Referer headers to
// cross-origin media while satisfying CORS. Set CINEMA_RELAY=0 to keep the old
// conversion-only behaviour.
const relayEnabled=process.env.CINEMA_RELAY!=='0';
const mediaProxy=require('./media-proxy').createMediaProxy({
  safeUrl,
  openMedia:(entry,headers,signal,head)=>getRemote(entry.url,headers,signal,fetch,agent,h2Agent,{method:head?'HEAD':'GET'}),
  createHandle:(entry,sid)=>remember(entry.url,sid,entry.referer,entry.format,entry.origin,entry.userAgent),
  perSession:Number(process.env.CINEMA_RELAY_STREAMS)||6,
});
// Provider API responses are bounded, redirects are forbidden, and credentials
// never follow a redirect. Every connection uses the public-IP-pinning agent.
async function providerRequest(url, opts = {}) {
  safeUrl(url);
  const { timeoutMs = 15000, ...fetchOpts } = opts;
  const signals=[AbortSignal.timeout(Math.max(1, Math.min(15000, timeoutMs))),providerScope.getStore(),fetchOpts.signal].filter(Boolean);
  const options={...fetchOpts,redirect:'manual',signal:AbortSignal.any(signals)};
  // Provider GETs can return the same 426 as media requests. Do not replay POSTs.
  const response=(!options.method || options.method.toUpperCase()==='GET')
    ? await getWithH2Fallback(url,options,fetch,agent,h2Agent)
    : await fetch(url,{...options,dispatcher:agent});
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`Provider HTTP ${response.status}`), { status: response.status }); }
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.length; if (total > 2 * 1024 * 1024) { await reader.cancel(); fail('Provider response too large'); }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* token response may have no JSON */ }
  return { headers:response.headers, json, text };
}
const catalogSearch = require('./catalog-search')({request:providerRequest});
const moviebox = require('./moviebox')({ request:providerRequest, safeUrl });
const discover = require('./discover')({request:providerRequest,moviebox});
const kisskh = require('./kisskh')({ request:providerRequest, safeUrl });
const { createProviders, resolveProviders } = require('./providers');
const providers = createProviders({ request:providerRequest, safeUrl });
const movy = require('./movy').createMovy({request:providerRequest,safeUrl});
const vidlink = require('./vidlink')({request:providerRequest,safeUrl});
const episodes = require('./episodes')({ request:providerRequest });
const enrich = require('./metadata')({ request:providerRequest });
async function enrichItem(entry) {
  if (!entry.enriched) { entry.enriched = await enrich(entry.item).catch(() => entry.item); }
  return entry.enriched;
}
async function resolveTitle(selected, season, episode, onlyProvider=null) {
  if (selected.item.source === 'kisskh') {
    try { const r=await kisskh.resolve(selected.item,season,episode);return {streams:r.streams.map(s=>({...s,provider:'kisskh',referer:r.referer,origin:r.origin})),providers:[{provider:'kisskh',count:r.streams.length,error:null}]}; }
    catch(err){return {streams:[],providers:[{provider:'kisskh',count:0,error:String(err?.message || 'Unavailable').slice(0,160)}]};}
  }
  return resolveProviders({moviebox,providers,movy,vidlink,item:await enrichItem(selected),season,episode,onlyProvider});
}
async function body(req, max = 16384) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) fail('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
function send(res, status, message) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(message)); }
function sameOrigin(req) {
  if (!req.headers.origin) return false;
  try { return new URL(req.headers.origin).host === req.headers.host && ['http:', 'https:'].includes(new URL(req.headers.origin).protocol); } catch { return false; }
}
const staticFiles = {
  '/cinema-hero.jpg': ['public/cinema-hero.jpg', 'image/jpeg'],
  '/': ['public/index.html', 'text/html; charset=utf-8'], '/fallback.js': ['public/fallback.js', 'text/javascript; charset=utf-8'], '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'], '/player.css': ['public/player.css', 'text/css; charset=utf-8'], '/player-ui.js': ['public/player-ui.js', 'text/javascript; charset=utf-8'], '/hls.js': ['node_modules/hls.js/dist/hls.min.js', 'text/javascript; charset=utf-8']
};
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; img-src 'self' data: https://wsrv.nl; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'");
  const url = new URL(req.url, 'http://local');
  const sid = /(?:^|;\s*)cinema=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
  const session = sessions.get(sid);
  if (session && session < Date.now()) { sessions.delete(sid); void transcoder.stopSession(sid); }
  const authorized = session && session >= Date.now();
  try {
    if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'Origin rejected' });
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const peer=req.socket.remoteAddress || 'unknown';
      if (loginLimiter.blocked(peer)) return send(res, 429, { error: 'Too many attempts; wait a minute' });
      const submitted = (await body(req)).password;
      const a = crypto.createHash('sha256').update(typeof submitted === 'string' ? submitted : '').digest();
      const b = crypto.createHash('sha256').update(password).digest();
      if (!crypto.timingSafeEqual(a, b)) { loginLimiter.failure(peer); return send(res, 401, { error: 'Incorrect password' }); }
      loginLimiter.success(peer);
      if (sid) { sessions.delete(sid); await transcoder.stopSession(sid); }
      const token = crypto.randomBytes(32).toString('base64url'); sessions.set(token, Date.now() + 24 * 3600000);
      res.setHeader('Set-Cookie', `cinema=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : ''}`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/session' && req.method === 'GET') return send(res, 200, { authenticated: !!authorized, relay: relayEnabled });
    if (url.pathname === '/api/logout' && req.method === 'POST') { sessions.delete(sid); await transcoder.stopSession(sid); res.setHeader('Set-Cookie', 'cinema=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'); return send(res, 200, { ok: true }); }
    if (url.pathname === '/api/discover' && req.method === 'GET') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const sections=require('./catalog-session').bindDiscovery(await discover(),catalog,sid);
      return send(res,200,{sections});
    }
    if (url.pathname === '/api/search' && req.method === 'POST') {
      if (!authorized) return send(res, 401, { error: 'Login required' });
      const { query } = await body(req);
      if (typeof query !== 'string' || !query.trim() || query.length > 150) fail('Enter a title up to 150 characters');
      const searches = await Promise.allSettled([moviebox.search(query), kisskh.search(query), catalogSearch(query)]);
      if (searches.every(s => s.status === 'rejected')) {
        const detail=searches.map((s,i)=>`${['MovieBox','KissKh','Cinemeta'][i]}: ${s.reason?.code==='KISSKH_SEARCH_FAILED' ? s.reason.reasons.join(', ') : describe(s.reason)}`).join(' · ');
        return send(res, 502, {error:`Search unavailable (${detail})`});
      }
      const results = searches.flatMap((s,i) => s.status === 'fulfilled' ? s.value.map(item => ({...item, source: ['moviebox','kisskh','cinemeta'][i]})) : []);
      // Merge only unambiguous exact title/type/year matches; retain distinct remakes.
      const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
      const metadata=results.filter(x=>x.source==='cinemeta'), merged=new Set();
      for(const item of results.filter(x=>x.source==='moviebox' && x.year)) {
        const matches=metadata.filter(m=>m.type===item.type && m.year===item.year && norm(m.title)===norm(item.title) && (!item.imdbId || item.imdbId===m.imdbId));
        if(matches.length===1){item.imdbId=item.imdbId||matches[0].imdbId;item.poster=matches[0].poster;merged.add(matches[0]);}
      }
      const seenTitles=new Set(); const uniqueResults=results.filter(x=>{if(merged.has(x)) return false; if(x.source!=='moviebox' || !x.year) return true; const key=`${norm(x.title)}:${x.type}:${x.year}`; if(seenTitles.has(key)) return false; seenTitles.add(key); return true;});
      const searchStatus = searches.map((s,i) => ({ provider: ['moviebox','kisskh','cinemeta'][i], error: s.status === 'rejected' ? `Search unavailable (${s.reason?.code==='KISSKH_SEARCH_FAILED' ? s.reason.reasons.join(', ') : describe(s.reason)})` : null }));
      for (const [id, entry] of catalog) if (entry.expires < Date.now()) catalog.delete(id);
      if (catalog.size > 3000) fail('Too many searches; restart the server');
      const entries = uniqueResults.map(item => {
        const id = crypto.randomBytes(20).toString('base64url');
        catalog.set(id, { item, sid, expires:Date.now() + 3600000 });
        return { id, title:item.title, type:item.type, year:item.year, overview:item.overview, source:item.source, poster:item.poster || null };
      });
      return send(res, 200, { results:entries, providers:searchStatus });
    }
    if (url.pathname === '/api/episodes' && req.method === 'POST') {
      if (!authorized) return send(res, 401, { error: 'Login required' });
      const data = await body(req); const selected = catalog.get(data.id);
      if (!selected || selected.sid !== sid || selected.expires < Date.now()) return send(res, 404, { error:'Search result expired; search again' });
      if (selected.item.source === 'kisskh') {
        const list = await kisskh.details(selected.item.kissId);
        return send(res, 200, { episodes:list.map(e => ({ season:1, episode:e.number, title:`Episode ${e.number}` })), source:'KissKh' });
      }
      if(selected.item.source==='moviebox'){
        try{const list=await moviebox.episodes(selected.item);if(list.length)return send(res,200,{episodes:list,source:'MovieBox'});}catch{/* fall back to independent episode metadata */}
      }
      return send(res, 200, { episodes: await episodes(await enrichItem(selected)), source:'Cinemeta / TVMaze' });
    }
    if (url.pathname === '/api/kiss-subtitle' && req.method === 'POST') {
      if (!authorized) return send(res, 401, { error: 'Login required' });
      const data = await body(req); const selected = catalog.get(data.id);
      if (!selected || selected.sid !== sid || selected.expires < Date.now() || selected.item.source !== 'kisskh') return send(res, 404, { error:'Search result expired; search again' });
      const text=await kisskh.subtitle(selected.item,Number(data.season),Number(data.episode));
      if (!text) return send(res,200,{ url:null });
      const id=crypto.randomBytes(24).toString('base64url'); captions.set(id,{sid,text,expires:Date.now()+6*3600000});
      return send(res,200,{url:`/caption/${id}`});
    }
    if ((url.pathname === '/api/moviebox-subtitle' || url.pathname === '/api/movy-subtitle' || url.pathname === '/api/vidlink-subtitle') && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const data=await body(req); const source=captionSources.get(data.id);
      if (!source || source.sid!==sid || source.expires<Date.now()) return send(res,404,{error:'Subtitle source expired'});
      const expected=url.pathname === '/api/movy-subtitle' ? 'movy' : url.pathname === '/api/vidlink-subtitle' ? '7movies' : 'moviebox';
      if(source.provider!==expected) return send(res,404,{error:'Subtitle source expired'});
      let text;
      if(expected==='movy' || expected==='7movies') {
        const response=await providerRequest(source.info.url,{headers:expected==='movy'?{referer:'https://www.movy.sx/',origin:'https://www.movy.sx','user-agent':'okhttp/4.12.0'}:{'user-agent':'okhttp/4.12.0'}});
        const raw=response.text.replace(/^\uFEFF/,'').trim();
        if(raw.includes('-->') && !/^<(!doctype|html)/i.test(raw)) {const converted=raw.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,'$1.$2'); text=/^WEBVTT(?:\s|$)/i.test(converted)?converted:`WEBVTT\n\n${converted}`;}
      } else text=await moviebox.subtitle(source.info);
      if (!text) return send(res,200,{url:null});
      const id=crypto.randomBytes(24).toString('base64url'); captions.set(id,{sid,text,expires:Date.now()+6*3600000});
      return send(res,200,{url:`/caption/${id}`});
    }
    if (url.pathname.startsWith('/caption/') && req.method === 'GET') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const entry=captions.get(url.pathname.slice(9));
      if (!entry || entry.sid!==sid || entry.expires<Date.now()) return send(res,404,{error:'Subtitle expired'});
      res.writeHead(200,{'Content-Type':'text/vtt; charset=utf-8','Cache-Control':'no-store'}); return res.end(entry.text);
    }
    if (url.pathname === '/api/resolve' && req.method === 'POST') {
      if (!authorized) return send(res, 401, { error: 'Login required' });
      const data = await body(req); const selected = catalog.get(data.id);
      if (!selected || selected.sid !== sid || selected.expires < Date.now()) return send(res, 404, { error:'Search result expired; search again' });
      const season=Number(data.season),episode=Number(data.episode);
      const result=await resolveTitle(selected,season,episode);
      const streams = result.streams.map(stream => {
        let captionId=null;
        if(stream.captionInfo){ captionId=crypto.randomBytes(20).toString('base64url'); captionSources.set(captionId,{sid,info:stream.captionInfo,provider:stream.provider.startsWith('movy:')?'movy':stream.provider==='7movies'?'7movies':'moviebox',expires:Date.now()+6*3600000}); }
        const refresh=async()=>{
          const refreshed=await resolveTitle(selected,season,episode,stream.provider);
          const matching=refreshed.streams.filter(s=>s.provider===stream.provider && s.format===stream.format && s.quality===stream.quality);
          return matching.length===1?matching[0]:null;
        };
        return { provider:stream.provider, quality:stream.quality, format:stream.format, duration:Number.isFinite(stream.duration) && stream.duration>0 ? stream.duration : null, captionId, url:remember(stream.url, sid, stream.referer, stream.format, stream.origin, stream.userAgent, refresh, stream.refreshAfterMs) };
      });
      return send(res, 200, { title:selected.item.title, streams, providers:result.providers });
    }
    if (url.pathname === '/api/source' && req.method === 'POST') {
      if (!authorized) return send(res, 401, { error: 'Login required' });
      const data = await body(req);
      return send(res, 200, { url: remember(data.url, sid, null, data.format === 'hls' ? 'hls' : null) });
    }
    if (url.pathname === '/api/source/probe' && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const data=await body(req);
      if(typeof data.url!=='string' || !/^\/media\/[A-Za-z0-9_-]+$/.test(data.url)) return send(res,400,{error:'Invalid source handle'});
      const entry=sources.get(data.url.slice(7));
      if(!entry || entry.sid!==sid || entry.expires<Date.now())return send(res,404,{error:'Source expired'});
      if(entry.format==='hls')return send(res,400,{error:'This probe is for progressive files, not playlists'});
      if(activeRangeProbes>=2)return send(res,429,{error:'Too many range probes'});
      activeRangeProbes++;
      try {
        const result=await require('./source-probe').probeRange(async(source,signal,start,end)=>{
          const headers={range:`bytes=${start}-${end}`,'accept-encoding':'identity'};
          if(source.userAgent)headers['user-agent']=source.userAgent;
          if(source.referer)headers.referer=source.referer;
          if(source.origin)headers.origin=source.origin;
          return (await getRemote(source.url,headers,signal,fetch,agent,h2Agent)).response;
        },entry);
        return send(res,200,result);
      } catch {return send(res,502,{error:'Range probe failed'});} finally {activeRangeProbes--;}
    }
    if (url.pathname === '/api/transcode' && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const data=await body(req);if(typeof data.url!=='string' || !/^\/media\/[A-Za-z0-9_-]+$/.test(data.url)) return send(res,400,{error:'Select an existing direct source'});
      const entry=sources.get(data.url.slice(7));if(!entry || entry.sid!==sid || entry.expires<Date.now())return send(res,404,{error:'Source expired'});
      if(data.requestId!==undefined && (typeof data.requestId!=='string' || !/^[a-f0-9]{32}$/.test(data.requestId)))return send(res,400,{error:'Invalid request ID'});
      const disconnected=new AbortController();
      const onClose=()=>{if(!res.writableEnded)disconnected.abort();};res.once('close',onClose);
      try{return send(res,200,await transcoder.start(entry,sid,data.offset===undefined?0:data.offset,data.requestId || null,disconnected.signal));}catch(e){if(!res.destroyed)return send(res,e.status||502,{error:e.message});}finally{res.removeListener('close',onClose);}
    }
    if (url.pathname === '/api/transcode/cancel' && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const data=await body(req);if(typeof data.requestId!=='string' || !/^[a-f0-9]{32}$/.test(data.requestId))return send(res,400,{error:'Invalid request ID'});
      return send(res,200,{stopped:await transcoder.stopRequest(data.requestId,sid)});
    }
    if (url.pathname === '/api/transcode/reclaim' && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});
      await body(req); return send(res,200,{stopped:await transcoder.stopAny()});
    }
    if (url.pathname === '/api/transcode/status' && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const data=await body(req);if(typeof data.id!=='string' || !/^[A-Za-z0-9_-]{32}$/.test(data.id))return send(res,400,{error:'Invalid job ID'});
      if(data.playhead!==undefined && (typeof data.playhead!=='number' || !Number.isFinite(data.playhead) || data.playhead<0))return send(res,400,{error:'Invalid playhead'});
      const status=transcoder.status(data.id,sid,data.playhead);if(!status)return send(res,404,{error:'Conversion unavailable'});return send(res,200,status);
    }
    if (url.pathname === '/api/transcode/stop' && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});const data=await body(req);if(typeof data.id!=='string')return send(res,400,{error:'Missing job ID'});
      return send(res,200,{stopped:await transcoder.stopFor(data.id,sid)});
    }
    if(url.pathname.startsWith('/transcode/') && req.method==='GET'){
      if(!authorized)return send(res,401,{error:'Login required'});const match=/^\/transcode\/([A-Za-z0-9_-]{32})\/(master\.m3u8|(?:240|360)\/(?:index\.m3u8|index\d+\.ts))$/.exec(url.pathname);
      if(!match)return send(res,404,{error:'Not found'});const result=await transcoder.read(match[1],sid,match[2]);if(!result)return send(res,404,{error:'Transcode unavailable'});
      res.writeHead(200,{'Content-Type':result.type,'Cache-Control':match[2].endsWith('.ts')?'private, max-age=3600, immutable':'no-store'});return res.end(result.data);
    }
    if (url.pathname.startsWith('/media/') && ['GET','HEAD'].includes(req.method)) {
      if (!authorized) return send(res, 401, { error: 'Login required' });
      const entry=sources.get(url.pathname.slice(7));
      if (!entry || entry.sid!==sid || entry.expires<Date.now()) return send(res, 404, { error:'Source expired; find the stream again' });
      if (!relayEnabled) return send(res, 403, { error: 'Direct playback is disabled; conversion is required' });
      const result=await mediaProxy.relay(req,res,entry,sid);
      if (!res.headersSent) return send(res, result.status, { error: result.error });
      return;
    }
    if (req.method === 'GET' && staticFiles[url.pathname]) {
      const [file, mime] = staticFiles[url.pathname]; res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }); return fs.createReadStream(path.join(__dirname, file)).pipe(res);
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) { if (!res.headersSent) send(res, 400, { error: e.message || 'Request failed' }); else res.destroy(); }
});
server.on('close',()=>{transcoder.close();});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.close();transcoder.close().finally(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref();});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Troy is listening'));
