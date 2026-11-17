'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { Agent, fetch } = require('undici');
const { safeUrl, publicLookup, getRemote } = require('./network');
const { describe } = require('./diagnostics');

// Botkeep writes variables to .env rather than exporting them. Node loads the
// file from the process working directory without overriding real environment
// variables supplied by the host. Never log the values.
try { process.loadEnvFile(path.resolve(process.cwd(), '.env')); }
catch (err) { if (err.code !== 'ENOENT') { console.error('Unable to load .env file.'); process.exit(1); } }

const password = process.env.CINEMA_PASSWORD || '';
if (password.length < 12) { console.error('Set CINEMA_PASSWORD to at least 12 characters.'); process.exit(1); }
const sessions = new Map();
const sources = new Map();
let loginFailures = [];
const catalog = new Map();
const captions = new Map();
const captionSources = new Map();
const agent = new Agent({ connect: { lookup: publicLookup() } });
const fail = msg => { throw new Error(msg); };
function remember(url, sid, referer = null, format = null, origin = null, userAgent = null) {
  if (sources.size > 10000) for (const [id, entry] of sources) { if (entry.expires < Date.now()) sources.delete(id); }
  if (sources.size > 12000) fail('Too many media links; restart the server');
  const id = crypto.randomBytes(24).toString('base64url');
  sources.set(id, { url: safeUrl(url).href, sid, referer, format, origin, userAgent, expires: Date.now() + 6 * 3600000 });
  return `/media/${id}`;
}
const { rewritePlaylist } = require('./playlist');
// Provider API responses are bounded, redirects are forbidden, and credentials
// never follow a redirect. Every connection uses the public-IP-pinning agent.
async function providerRequest(url, opts = {}) {
  safeUrl(url);
  const { timeoutMs = 15000, ...fetchOpts } = opts;
  const response = await fetch(url, { ...fetchOpts, dispatcher: agent, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(15000, timeoutMs))) });
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
  if (session && session < Date.now()) sessions.delete(sid);
  const authorized = session && session >= Date.now();
  try {
    if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'Origin rejected' });
    if (url.pathname === '/api/login' && req.method === 'POST') {
      loginFailures = loginFailures.filter(t => t > Date.now() - 60000);
      if (loginFailures.length >= 8) return send(res, 429, { error: 'Too many attempts; wait a minute' });
      const submitted = (await body(req)).password;
      const a = crypto.createHash('sha256').update(typeof submitted === 'string' ? submitted : '').digest();
      const b = crypto.createHash('sha256').update(password).digest();
      if (!crypto.timingSafeEqual(a, b)) { loginFailures.push(Date.now()); return send(res, 401, { error: 'Incorrect password' }); }
      loginFailures = [];
      if (sid) sessions.delete(sid);
      const token = crypto.randomBytes(32).toString('base64url'); sessions.set(token, Date.now() + 24 * 3600000);
      res.setHeader('Set-Cookie', `cinema=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : ''}`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/session' && req.method === 'GET') return send(res, 200, { authenticated: !!authorized });
    if (url.pathname === '/api/logout' && req.method === 'POST') { sessions.delete(sid); res.setHeader('Set-Cookie', 'cinema=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'); return send(res, 200, { ok: true }); }
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
      return send(res, 200, { episodes: await episodes(await enrichItem(selected)), source:'Cinemeta / TVMaze' });
    }
    if (url.pathname === '/api/kiss-subtitle' && req.method === 'POST') {
      if (!authorized) return send(res, 401, { error: 'Login required' });
      const data = await body(req); const selected = catalog.get(data.id);
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
      for (const [id, entry] of captions) if (entry.expires < Date.now()) captions.delete(id);
      if (captions.size > 100) fail('Too many subtitles; restart the server');
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
      let result;
      if (selected.item.source === 'kisskh') {
        try { const r=await kisskh.resolve(selected.item,Number(data.season),Number(data.episode)); result={ streams:r.streams.map(s=>({...s,provider:'kisskh',referer:r.referer,origin:r.origin})), providers:[{provider:'kisskh',count:r.streams.length,error:null}] }; }
        catch (err) { result={streams:[],providers:[{provider:'kisskh',count:0,error:String(err?.message || 'Unavailable').slice(0,160)}]}; }
      } else result = await resolveProviders({ moviebox, providers, movy, vidlink, item:await enrichItem(selected), season:Number(data.season), episode:Number(data.episode) });
      for (const [id, entry] of captionSources) if (entry.expires<Date.now()) captionSources.delete(id);
      const streams = result.streams.map(stream => {
        let captionId=null;
        if(stream.captionInfo && captionSources.size<1000){ captionId=crypto.randomBytes(20).toString('base64url'); captionSources.set(captionId,{sid,info:stream.captionInfo,provider:stream.provider.startsWith('movy:')?'movy':stream.provider==='7movies'?'7movies':'moviebox',expires:Date.now()+6*3600000}); }
        return { provider:stream.provider, quality:stream.quality, format:stream.format, captionId, url:remember(stream.url, sid, stream.referer, stream.format, stream.origin, stream.userAgent) };
      });
      return send(res, 200, { title:selected.item.title, streams, providers:result.providers });
    }
    if (url.pathname === '/api/source' && req.method === 'POST') {
      if (!authorized) return send(res, 401, { error: 'Login required' });
      const data = await body(req);
      return send(res, 200, { url: remember(data.url, sid, null, data.format === 'hls' ? 'hls' : null) });
    }
    if (url.pathname.startsWith('/media/') && req.method === 'GET') {
      if (!authorized) return send(res, 401, { error: 'Login required' });
      const entry = sources.get(url.pathname.slice(7));
      if (!entry || entry.sid !== sid || entry.expires < Date.now()) return send(res, 404, { error: 'Source expired' });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      res.on('close', () => { clearTimeout(timer); controller.abort(); });
      const headers = {}; if (entry.userAgent) headers['user-agent'] = entry.userAgent; if (entry.referer) headers.referer = entry.referer; if (entry.origin) headers.origin = entry.origin; if (/^bytes=\d*-\d*$/.test(req.headers.range || '')) headers.range = req.headers.range;
      const { response, url: finalUrl } = await getRemote(entry.url, headers, controller.signal, fetch, agent);
      clearTimeout(timer); // The timeout is for connecting, not the duration of a movie.
      if (!response.ok) { await response.body?.cancel(); return send(res, 502, { error: `Source returned ${response.status}` }); }
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const isPlaylist = entry.format === 'hls' || /mpegurl/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(finalUrl.href);
      if (isPlaylist) {
        const reader = response.body.getReader(); let length = 0, parts = [];
        while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 2 * 1024 * 1024) { await reader.cancel(); fail('Playlist too large'); } parts.push(Buffer.from(value)); }
        const text = Buffer.concat(parts).toString('utf8'); if (!text.trimStart().startsWith('#EXTM3U')) fail('Invalid playlist');
        const rewritten = rewritePlaylist(text, finalUrl, sid, entry.referer, (url, session, referer, format) => remember(url, session, referer, format, entry.origin, entry.userAgent));
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }); return res.end(rewritten);
      }
      const out = { 'Content-Type': /^(video\/|audio\/|text\/vtt|application\/octet-stream)/i.test(contentType) ? contentType : 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' };
      for (const name of ['content-length','content-range','accept-ranges']) { const value = response.headers.get(name); if (value) out[name] = value; }
      res.writeHead(response.status, out);
      if (!response.body) return res.end();
      const stream = Readable.fromWeb(response.body); stream.on('error', () => res.destroy()); stream.pipe(res); return;
    }
    if (req.method === 'GET' && staticFiles[url.pathname]) {
      const [file, mime] = staticFiles[url.pathname]; res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }); return fs.createReadStream(path.join(__dirname, file)).pipe(res);
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) { if (!res.headersSent) send(res, 400, { error: e.message || 'Request failed' }); else res.destroy(); }
});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Troy is listening'));
