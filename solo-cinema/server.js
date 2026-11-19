'use strict';
const { createReadStream } = require('node:fs');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Agent, fetch } = require('undici');
const { safeUrl, publicLookup, getRemote } = require('./network');
const config = require('./config');
const { createStatic } = require('./static');
const { describe } = require('./diagnostics');
const {scope:providerScope}=require('./provider-timeout');

// Botkeep writes variables to .env rather than exporting them. Node loads the
// file from the process working directory without overriding real environment
// variables supplied by the host. Never log the values.
try { process.loadEnvFile(path.resolve(process.cwd(), '.env')); }
catch (err) { if (err.code !== 'ENOENT') { console.error('Unable to load .env file.'); process.exit(1); } }

const password = config.password();
if (password.length < 12) { console.error('Set CINEMA_PASSWORD to at least 12 characters.'); process.exit(1); }
const sessions = new Map();
const sources = require('./source-store').createSourceStore();
const loginLimiter=require('./login-limiter').createLoginLimiter();
let activeRangeProbes = 0;
const catalog = new Map();
const captions = new Map();
const captionSources = new Map();
const agent = new Agent({ connect: { lookup: publicLookup() } });
// Second agent that offers HTTP/2 via ALPN. Some provider edges answer 426
// (upgrade required) to HTTP/1.1 for certain endpoints, which is why a series
// can fail where a movie plays. Same pinned DNS lookup, same validation.
const h2Agent = new Agent({ allowH2: true, connect: { lookup: publicLookup() } });
/** A failure that already knows the status code the client should be told. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
const fail = msg => { throw new HttpError(400, msg); };
function remember(url, sid, referer = null, format = null, origin = null, userAgent = null, refresh = null, refreshAfterMs = null) {
  const id = crypto.randomBytes(24).toString('base64url');
  sources.set(id, { url: safeUrl(url).href, sid, referer, format, origin, userAgent, refresh, refreshAt:Number.isFinite(refreshAfterMs) && refreshAfterMs>0 ? Date.now()+refreshAfterMs : null, expires: Date.now() + 6 * 3600000 });
  return `/media/${id}`;
}
// Conversion writes growing HLS segments for the whole runtime of whatever is
// playing. On a container whose /tmp is tmpfs that output is held in RAM, so a
// feature-length title can exhaust the box and be killed mid-playback. Pick a
// disk-backed directory instead, and only fall back to tmp if there is none.
const TMPFS_MAGIC=0x01021994;
function filesystemType(dir){try{return Number(fs.statfsSync(dir).type);}catch{return null;}}
function freeBytes(dir){try{const s=fs.statfsSync(dir);return Number(s.bavail)*Number(s.bsize);}catch{return null;}}
function resolveTranscodeTmp(){
  if(config.tmpdirOverride()) return {dir:config.tmpdirOverride(),reason:'CINEMA_TMPDIR'};
  const systemTmp=require('node:os').tmpdir();
  if(process.platform!=='linux' || filesystemType(systemTmp)!==TMPFS_MAGIC) return {dir:systemTmp,reason:'system temp'};
  // System temp is RAM. Use a directory beside the application instead.
  for(const candidate of [path.join(process.cwd(),'.troy-media'),path.join(require('node:os').homedir(),'.troy-media')]){
    try{fs.mkdirSync(candidate,{recursive:true});if(filesystemType(candidate)!==TMPFS_MAGIC)return {dir:candidate,reason:'disk (system temp is tmpfs)'};}catch{/* try the next one */}
  }
  return {dir:systemTmp,reason:'system temp (no disk-backed option)'};
}
const {dir:transcodeTmp,reason:transcodeTmpReason}=resolveTranscodeTmp();
// The direct path: this machine's address, pinned to public DNS answers.
const directRemote=async(url,headers,signal)=>(await getRemote(url,headers,signal,fetch,agent,h2Agent)).response;
// Some CDNs refuse this machine's address outright (426 for every protocol and
// header combination); others accept it but rate-limit it, or rate-limit the
// Worker's shared egress instead. Which of the two is currently healthy is a
// property of the CDN and the minute, not of the code, so both routes are kept
// and the one that answers is chosen per fetch. See route.js.
const {relayStatus}=require('./relay');
const {config:relay,error:relayError}=relayStatus();
const relayRemote=relay ? require('./relay').createRelayRemote({
  config:relay,
  send:(url,headers,signal)=>fetch(url,{dispatcher:agent,headers,redirect:'manual',signal}),
  direct:directRemote,
}) : null;
const routes=require('./route').createRouter({
  direct:directRemote,
  relay:relayRemote,
  order:relay ? ['relay','direct'] : ['direct'],
  remember:config.routeMemory(),
});
const remote=routes.remote;
const openSource=require('./source-opener').createSourceOpener({safeUrl,remote});
const transcoder=require('./transcode').createTranscoder({open:openSource,tmpdir:transcodeTmp,authorize:sid=>(sessions.get(sid)||0)>=Date.now()});
// Provider API responses are bounded, redirects are forbidden, and credentials
// never follow a redirect. Every connection uses the public-IP-pinning agent.
async function providerRequest(url, opts = {}) {
  safeUrl(url);
  const { timeoutMs = 15000, ...fetchOpts } = opts;
  const signals=[AbortSignal.timeout(Math.max(1, Math.min(15000, timeoutMs))),providerScope.getStore(),fetchOpts.signal].filter(Boolean);
  const response = await fetch(url, { ...fetchOpts, dispatcher: agent, redirect: 'manual', signal: AbortSignal.any(signals) });
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
// The read is bounded before anything is buffered, and the parser's own error
// never reaches the client: a JSON syntax message describes the payload, not the
// request, and reads like an internal fault to anyone who sees it.
async function readJsonBody(req, maxBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}
function send(res, status, message) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(message)); }
function sameOrigin(req) {
  if (!req.headers.origin) return false;
  try { return new URL(req.headers.origin).host === req.headers.host && ['http:', 'https:'].includes(new URL(req.headers.origin).protocol); } catch { return false; }
}
// The interface is a built app in `app/dist`, and it is the only one. The build
// output is committed, which keeps the panel's `npm start` free of a build step.
// `createStatic` resolves against `<root>/public`, so pointing it at `app/dist`
// makes `/assets/...` and `/favicon.ico` resolve without a prefix in the URLs.
const appFiles = createStatic({ root: path.join(__dirname, 'app', 'dist') });
const APP_SHELL = path.join(__dirname, 'app', 'dist', 'public', '_shell.html');
// Pages the shell owns. Anything else is a 404, not the app: a typo in a static
// path should say so instead of silently rendering the home screen.
const APP_ROUTES = [/^\/$/, /^\/browse$/, /^\/ranking$/, /^\/me$/, /^\/title\/[\w-]{1,64}$/, /^\/watch\/[\w-]{1,64}$/];

/**
 * The app shell carries two inline scripts written by the router at build time:
 * a scroll-restoration preamble and the hydration payload. Inline script is
 * normally forbidden here, so each one is allowed by hash instead of by
 * weakening `script-src`. The hashes are read from the committed shell once at
 * startup, which means a rebuilt shell cannot drift out of sync with the policy
 * without the server noticing on the next start.
 */
function inlineScriptHashes() {
  let shell;
  try {
    shell = fs.readFileSync(APP_SHELL, 'utf8');
  } catch {
    // Without the shell there is nothing to hash, and the app would render but
    // never hydrate. Say so at startup rather than leaving a mystery in the
    // browser console.
    console.warn('app shell missing at ' + APP_SHELL + '; the UI will not start. Run npm run build in reelbox-src.');
    return [];
  }
  const hashes = new Set();
  for (const match of shell.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = match[1];
    if (!body) continue;
    hashes.add(`'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  if (!hashes.size) console.warn('app shell has no inline scripts; the CSP may be out of date with the build.');
  return [...hashes];
}
const inlineHashes = inlineScriptHashes();
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  // blob: is used by the original player for uploaded subtitle files.
  "img-src 'self' data: blob: https://wsrv.nl",
  "style-src 'self'",
  // The app's CSS is a static file; the only inline style it needs is the seek
  // bar's custom property, so inline *attributes* are allowed but <style> is not.
  "style-src-attr 'unsafe-inline'",
  // Music and anime providers put their API behind a CDN; these are the hosts
  // wsrv.nl proxies for, and nothing else is reachable from the page.
  "connect-src 'self'",
  "font-src 'self' https://fonts.gstatic.com",
  "style-src-elem 'self' https://fonts.googleapis.com",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  `script-src 'self' ${inlineHashes.join(' ')}`.replace(/\s+$/, ''),
].join('; ');
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  const url = new URL(req.url, 'http://local');
  const sid = /(?:^|;\s*)cinema=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
  const session = sessions.get(sid);
  if (session && session < Date.now()) {
    sessions.delete(sid);
    // The browser is already gone, so nothing is waiting for this. An unhandled
    // rejection here would take the whole process down and end every other
    // stream with it, so the cleanup reports its own failure.
    transcoder.stopSession(sid).catch(error => console.warn(`expired session cleanup failed: ${error.message}`));
  }
  const authorized = session && session >= Date.now();
  try {
    if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'Origin rejected' });
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const peer=req.socket.remoteAddress || 'unknown';
      if (loginLimiter.blocked(peer)) return send(res, 429, { error: 'Too many attempts; wait a minute' });
      const submitted = (await readJsonBody(req)).password;
      const a = crypto.createHash('sha256').update(typeof submitted === 'string' ? submitted : '').digest();
      const b = crypto.createHash('sha256').update(password).digest();
      if (!crypto.timingSafeEqual(a, b)) { loginLimiter.failure(peer); return send(res, 401, { error: 'Incorrect password' }); }
      loginLimiter.success(peer);
      if (sid) { sessions.delete(sid); await transcoder.stopSession(sid); }
      const token = crypto.randomBytes(32).toString('base64url'); sessions.set(token, Date.now() + 24 * 3600000);
      res.setHeader('Set-Cookie', `cinema=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : ''}`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/session' && req.method === 'GET') return send(res, 200, { authenticated: !!authorized, routes: routes.status() });
    if (url.pathname === '/api/logout' && req.method === 'POST') { sessions.delete(sid); await transcoder.stopSession(sid); res.setHeader('Set-Cookie', 'cinema=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'); return send(res, 200, { ok: true }); }
    if (url.pathname === '/api/discover' && req.method === 'GET') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const sections=require('./catalog-session').bindDiscovery(await discover(),catalog,sid);
      return send(res,200,{sections});
    }
    if (url.pathname === '/api/category' && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const { genreTopId, page } = await readJsonBody(req);
      // A paged category is the same list the home row showed, so an invalid
      // identifier or page is the caller's mistake, not a provider failure.
      if (typeof genreTopId !== 'string' || !/^\d{1,25}$/.test(genreTopId)) fail('Invalid category');
      const wanted = page === undefined ? 1 : page;
      if (!Number.isInteger(wanted) || wanted < 1 || wanted > 500) fail('Invalid page');
      const result = await moviebox.ranking(genreTopId, wanted);
      const items = require('./catalog-session').bindItems(result.items, catalog, sid);
      return send(res,200,{items,hasMore:result.hasMore,page:wanted});
    }
    if (url.pathname === '/api/search' && req.method === 'POST') {
      if (!authorized) return send(res, 401, { error: 'Login required' });
      const { query } = await readJsonBody(req);
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
      const data = await readJsonBody(req); const selected = catalog.get(data.id);
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
      const data = await readJsonBody(req); const selected = catalog.get(data.id);
      if (!selected || selected.sid !== sid || selected.expires < Date.now() || selected.item.source !== 'kisskh') return send(res, 404, { error:'Search result expired; search again' });
      const text=await kisskh.subtitle(selected.item,Number(data.season),Number(data.episode));
      if (!text) return send(res,200,{ url:null });
      for (const [id, entry] of captions) if (entry.expires < Date.now()) captions.delete(id);
      if (captions.size > 100) fail('Too many subtitles; restart the server');
      const id=crypto.randomBytes(24).toString('base64url'); captions.set(id,{sid,text,expires:Date.now()+6*3600000});
      return send(res,200,{url:`/caption/${id}`});
    }
    if ((url.pathname === '/api/moviebox-subtitle' || url.pathname === '/api/movy-subtitle' || url.pathname === '/api/vidlink-subtitle') && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const data=await readJsonBody(req); const source=captionSources.get(data.id);
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
      for (const [id, entry] of captions) if (entry.expires < Date.now()) captions.delete(id);
      if (captions.size > 100) fail('Too many subtitles; restart the server');
      const id=crypto.randomBytes(24).toString('base64url'); captions.set(id,{sid,text,expires:Date.now()+6*3600000});
      return send(res,200,{url:`/caption/${id}`});
    }
    if (url.pathname.startsWith('/caption/') && req.method === 'GET') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const entry=captions.get(url.pathname.slice(9));
      if (!entry || entry.sid!==sid || entry.expires<Date.now()) return send(res,404,{error:'Subtitle expired'});
      // Captions are stored once, raw, against the full timeline. A converted
      // window starts near zero, so `from` moves the cues into it on read. Keeping
      // the text raw is what lets one download serve every window.
      const from=Number(url.searchParams.get('from'));
      const body=Number.isFinite(from) && from>0 ? require('./caption-shift').shift(entry.text,from) : entry.text;
      res.writeHead(200,{'Content-Type':'text/vtt; charset=utf-8','Cache-Control':'no-store'}); return res.end(body);
    }
    if (url.pathname === '/api/resolve' && req.method === 'POST') {
      if (!authorized) return send(res, 401, { error: 'Login required' });
      const data = await readJsonBody(req); const selected = catalog.get(data.id);
      if (!selected || selected.sid !== sid || selected.expires < Date.now()) return send(res, 404, { error:'Search result expired; search again' });
      const season=Number(data.season),episode=Number(data.episode);
      const result=await resolveTitle(selected,season,episode);
      for (const [id, entry] of captionSources) if (entry.expires<Date.now()) captionSources.delete(id);
      // The player has to know which route is being used before it commits to a
      // conversion, or it pays a full 12-second rate-limit wait to learn that the
      // other route was free. One bounded request per distinct host establishes
      // that, and the router remembers the answer for ten minutes.
      if (result.streams.length) await routes.prefetch(result.streams.map(stream => stream.url));
      const streams = result.streams.map(stream => {
        let captionId=null;
        if(stream.captionInfo && captionSources.size<1000){ captionId=crypto.randomBytes(20).toString('base64url'); captionSources.set(captionId,{sid,info:stream.captionInfo,provider:stream.provider.startsWith('movy:')?'movy':stream.provider==='7movies'?'7movies':'moviebox',expires:Date.now()+6*3600000}); }
        const refresh=async()=>{
          const refreshed=await resolveTitle(selected,season,episode,stream.provider);
          const matching=refreshed.streams.filter(s=>s.provider===stream.provider && s.format===stream.format && s.quality===stream.quality);
          return matching.length===1?matching[0]:null;
        };
        return { provider:stream.provider, quality:stream.quality, format:stream.format, duration:Number.isFinite(stream.duration) && stream.duration>0 && stream.duration<=86400 ? stream.duration : null, captionId, url:remember(stream.url, sid, stream.referer, stream.format, stream.origin, stream.userAgent, refresh, stream.refreshAfterMs) };
      });
      return send(res, 200, { title:selected.item.title, streams, providers:result.providers });
    }
    if (url.pathname === '/api/source' && req.method === 'POST') {
      if (!authorized) return send(res, 401, { error: 'Login required' });
      const data = await readJsonBody(req);
      // A rejected URL is the caller's mistake, not an upstream failure, so it
      // must answer 400. safeUrl throws a plain Error, and the generic handler
      // would otherwise classify it as a provider fault.
      let handle;
      try {
        handle = remember(data.url, sid, null, data.format === 'hls' ? 'hls' : null);
      } catch (error) {
        throw new HttpError(400, error.message || 'Only public HTTPS URLs are allowed');
      }
      return send(res, 200, { url: handle });
    }
    if (url.pathname === '/api/source/probe' && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const data=await readJsonBody(req);
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
          return remote(source.url,headers,signal);
        },entry);
        return send(res,200,result);
      } catch {return send(res,502,{error:'Range probe failed'});} finally {activeRangeProbes--;}
    }
    if (url.pathname === '/api/transcode' && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const data=await readJsonBody(req);if(typeof data.url!=='string' || !/^\/media\/[A-Za-z0-9_-]+$/.test(data.url)) return send(res,400,{error:'Select an existing direct source'});
      const entry=sources.get(data.url.slice(7));if(!entry || entry.sid!==sid || entry.expires<Date.now())return send(res,404,{error:'Source expired'});
      if(entry.format==='hls')return send(res,400,{error:'Transcoding currently supports direct MP4 sources, not HLS playlists'});
      if(data.requestId!==undefined && (typeof data.requestId!=='string' || !/^[a-f0-9]{32}$/.test(data.requestId)))return send(res,400,{error:'Invalid request ID'});
      const disconnected=new AbortController();
      const onClose=()=>{if(!res.writableEnded)disconnected.abort();};res.once('close',onClose);
      try{return send(res,200,await transcoder.start(entry,sid,data.offset===undefined?0:data.offset,data.requestId || null,disconnected.signal));}catch(e){if(!res.destroyed)return send(res,e.status||502,{error:e.message});}finally{res.removeListener('close',onClose);}
    }
    if (url.pathname === '/api/transcode/cancel' && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const data=await readJsonBody(req);if(typeof data.requestId!=='string' || !/^[a-f0-9]{32}$/.test(data.requestId))return send(res,400,{error:'Invalid request ID'});
      return send(res,200,{stopped:await transcoder.stopRequest(data.requestId,sid)});
    }
    if (url.pathname === '/api/transcode/reclaim' && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});
      await readJsonBody(req); return send(res,200,{stopped:await transcoder.stopAny()});
    }
    if (url.pathname === '/api/transcode/status' && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});
      const data=await readJsonBody(req);if(typeof data.id!=='string' || !/^[A-Za-z0-9_-]{32}$/.test(data.id))return send(res,400,{error:'Invalid job ID'});
      // The client reports where playback is, so the reply can say how far ahead
      // the encoder really is instead of guessing.
      const position=Number(data.position);
      const status=await transcoder.status(data.id,sid);if(!status)return send(res,404,{error:'Conversion unavailable'});
      if(Number.isFinite(position) && position>=0) transcoder.reportPosition(data.id,sid,position);
      return send(res,200,status);
    }
    if (url.pathname === '/api/transcode/stop' && req.method === 'POST') {
      if (!authorized) return send(res,401,{error:'Login required'});const data=await readJsonBody(req);if(typeof data.id!=='string')return send(res,400,{error:'Missing job ID'});
      return send(res,200,{stopped:await transcoder.stopFor(data.id,sid)});
    }
    if(url.pathname.startsWith('/transcode/') && req.method==='GET'){
      if(!authorized)return send(res,401,{error:'Login required'});const match=/^\/transcode\/([A-Za-z0-9_-]{32})\/(master\.m3u8|(?:240|360)\/(?:index\.m3u8|index\d+\.ts))$/.exec(url.pathname);
      if(!match)return send(res,404,{error:'Not found'});const result=await transcoder.read(match[1],sid,match[2]);if(!result)return send(res,404,{error:'Transcode unavailable'});
      const immutable=match[2].endsWith('.ts');
      const headers={'Content-Type':result.type,'Cache-Control':immutable?'private, max-age=3600, immutable':'no-store'};
      // A segment is immutable once written, so an ETag makes revalidation free
      // and Content-Length lets the player size its buffer. Segments are streamed
      // from disk rather than buffered in the heap.
      if(result.file){
        headers['Content-Length']=String(result.size);
        headers.ETag=`"${match[1]}-${match[2]}-${result.size}"`;
        res.writeHead(200,headers);
        const stream=createReadStream(result.file);
        stream.on('error',()=>res.destroy());
        res.on('close',()=>stream.destroy());
        return stream.pipe(res);
      }
      res.writeHead(200,headers);return res.end(result.data);
    }
    if (url.pathname.startsWith('/media/') && req.method === 'GET') return send(res, authorized ? 403 : 401, {error:authorized ? 'Direct playback is disabled; conversion is required' : 'Login required'});
    if (req.method === 'GET' || req.method === 'HEAD') {
      // Hashed bundle files are served directly. The shell is excluded because it
      // is only ever sent for a page route, never as a static file at its own
      // path.
      const appEntry = appFiles.lookup(url.pathname);
      if (appEntry && !appEntry.file.endsWith('_shell.html')) return appFiles.send(req, res, appEntry);
      // A page the app owns is answered with the shell, and the client router
      // renders it. Anything else falls through to the 404 below: a typo should
      // say so rather than quietly rendering the home screen.
      if (APP_ROUTES.some(pattern => pattern.test(url.pathname))) {
        const shell = appFiles.lookup('/_shell.html');
        if (!shell) return send(res, 503, { error: 'The app shell is missing; run the app build' });
        const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
        if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
        res.writeHead(200, headers);
        return createReadStream(shell.file).pipe(res);
      }
    }
    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    // Once the response has started there is no status line left to correct.
    // `req.destroyed` is NOT tested: on IncomingMessage it becomes true as soon
    // as the body has been read, so it means "stream finished", not "gone".
    if (res.headersSent) return res.destroy();
    const status = error instanceof HttpError ? error.status : 502;
    send(res, status, { error: error.message || 'Request failed' });
  }
});
server.on('close',()=>{transcoder.close();});
// This process is somebody's playback: a stray rejection must not end it.
require('./process-guard').installCrashGuard().install();

for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.close();transcoder.close().finally(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref();});
server.listen(config.port() ? Number(config.port()) : 3000, '0.0.0.0', () => {
  // Print the two facts that decide whether playback can work at all, so a
  // hosting panel's console log is enough to diagnose a dead deployment.
  const net = require('./network');
  console.log('Troy is listening');
  console.log(`  outbound: ${net.forceIPv4 ? 'IPv4 preferred' : 'both families'}` + (net.ipv6Unrouted ? ' (no IPv6 route detected)' : ''));
  const { chooseFfmpeg, ffmpegCandidates, staticFfmpegExpectedPath } = require('./transcode');
  // Conversion is the only playback path, so verify by running the same probes
  // a real job needs rather than only checking that the binary exists.
  chooseFfmpeg(config.ffmpegPath()
    ? [{ label: 'Configured FFmpeg', path: config.ffmpegPath() }]
    : ffmpegCandidates())
    .then(binary => console.log(`  ffmpeg:   ok  ${binary}`))
    .catch(error => {
      console.warn('  ffmpeg:   NOT USABLE');
      console.warn(`            ${error.message}`);
      console.warn('            Conversion is the only playback path, so nothing will play.');
      console.warn('            Two fixes, easiest first:');
      console.warn('              node troy-ffmpeg.js    (downloads a static build, no root)');
      console.warn('              apt-get install -y ffmpeg  (if the panel allows root)');
      if (fs.existsSync(staticFfmpegExpectedPath())) {
        console.warn(`            A downloaded build already exists: ${staticFfmpegExpectedPath()}`);
        console.warn('            Point CINEMA_FFMPEG at it.');
      }
    });
  if (relay) console.log(`  routes:   relay first  ${relay.origin}${relay.path}/  then this address if it fails`);
  else if (relayError) console.warn(`  routes:   direct only (relay unusable: ${relayError})`);
  else console.log('  routes:   direct only (no relay configured)');
  const free = freeBytes(transcodeTmp);
  console.log(`  temp:     ${transcodeTmp}  [${transcodeTmpReason}]` + (free === null ? '' : `  ${(free / 1073741824).toFixed(1)} GB free`));
  if (filesystemType(transcodeTmp) === TMPFS_MAGIC) {
    console.warn('            WARNING: this is tmpfs (RAM). A full-length title will');
    console.warn('            consume memory and can kill the server mid-playback.');
    console.warn('            Set CINEMA_TMPDIR to a disk-backed path.');
  } else if (free !== null && free < 2 * 1073741824) {
    console.warn('            WARNING: less than 2 GB free; a long title may run out.');
  }
});
