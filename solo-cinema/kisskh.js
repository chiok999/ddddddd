'use strict';
// KissKh's changing token script runs in a fresh, resource-limited QuickJS WASM
// runtime. No Node, filesystem, network or host callbacks are exposed to it.
const { getQuickJS } = require('quickjs-emscripten');
const crypto = require('node:crypto');
const { describe } = require('./diagnostics');
const BASE = 'https://kisskh.is/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';
const SUB_GUID = 'VgV52sWhwvBSf8BsM3BRY9weWiiCbtGp';
const VIDEO_GUID = '62f176f3bb1b5b8e70e39932ad34a0c7';
async function runToken(code, episodeId, guid = VIDEO_GUID) {
  if (typeof code !== 'string' || code.length > 1024 * 1024 || !Number.isSafeInteger(episodeId) || episodeId <= 0) throw Error('Invalid token input');
  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(24 * 1024 * 1024); runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 1500;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const ctx = runtime.newContext();
  try {
    const result = ctx.evalCode(`${code}\n;_0x54b991(${episodeId},null,"2.8.10",${JSON.stringify(guid)},4830201,"kisskh","kisskh","kisskh","kisskh","kisskh","kisskh")`);
    if (result.error) { result.error.dispose(); throw Error('KissKh token script failed or exceeded limits'); }
    try { const value = ctx.dump(result.value); if (typeof value !== 'string' || !value || value.length > 8192) throw Error('Invalid KissKh token'); return value; }
    finally { result.value.dispose(); }
  } finally { ctx.dispose(); runtime.dispose(); }
}
module.exports = function createKisskh({ request, safeUrl, tokenRunner = runToken, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  // KissKh's bot client retries rate-limited and transient responses. Keep
  // retries bounded and GET-only; never retry a 403 or bypass host validation.
  async function fetchKiss(url, opts) {
    for (let attempt=0;;attempt++) {
      try { return await request(url, opts); }
      catch (error) {
        if (attempt>=2 || ![429,500,502,503,504].includes(Number(error?.status))) throw error;
        await sleep(500 * (attempt + 1));
      }
    }
  }
  let script = null, scriptAt = 0;
  const headers = { 'user-agent': UA, referer: BASE, accept:'application/json, */*' };
  async function search(query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 150) throw Error('Enter a title up to 150 characters');
    const groups = await Promise.allSettled([1,2,3,4].map(async type => {
      const { json } = await fetchKiss(`${BASE}api/DramaList/Search?q=${encodeURIComponent(query.trim())}&type=${type}`, { headers, timeoutMs:5000 });
      if (!Array.isArray(json)) throw Object.assign(Error('Invalid KissKh response'),{code:'INVALID_PROVIDER_RESPONSE'});
      return json.slice(0,8).map(row => {
        const id=Number(row.id), title=String(row.title || '').trim().slice(0,150);
        if (!Number.isSafeInteger(id) || id < 1 || !title) return null;
        return { source:'kisskh', kissId:id, title, type:type===2 ? 'movie' : 'series', year:'', overview:'', kind:['','Drama','Movie','Anime','Hollywood'][type] };
      }).filter(Boolean);
    }));
    if (groups.every(g=>g.status==='rejected')) {
      const reasons=[...new Set(groups.map(g=>describe(g.reason)))];
      throw Object.assign(Error('KissKh search unavailable'), { code:'KISSKH_SEARCH_FAILED', reasons });
    }
    const seen=new Set(); return groups.flatMap(g=>g.status==='fulfilled' ? g.value : []).filter(item=>{ if (seen.has(item.kissId)) return false; seen.add(item.kissId); return true; });
  }
  async function details(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw Error('Invalid KissKh title');
    const {json} = await fetchKiss(`${BASE}api/DramaList/Drama/${id}`, {headers});
    const list = Array.isArray(json?.episodes) ? json.episodes : [];
    return list.slice(0,5000).map(e=>({ id:Number(e.id), number:Number(e.number) })).filter(e=>Number.isSafeInteger(e.id) && e.id>0 && Number.isSafeInteger(e.number) && e.number>0 && e.number<=9999).sort((a,b)=>a.number-b.number);
  }
  async function tokenScript() {
    if (script && Date.now()-scriptAt < 30*60000) return script;
    const html = (await fetchKiss(`${BASE}index.html`,{headers})).text;
    const src = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(x=>x[1]).find(x=>x.includes('common'));
    if (!src) throw Error('KissKh token script not found');
    const url = safeUrl(new URL(src,BASE));
    if (url.origin !== new URL(BASE).origin) throw Error('KissKh token script is not on the expected host');
    const text = (await fetchKiss(url.href,{headers})).text;
    if (typeof text !== 'string' || text.length > 1024*1024) throw Error('KissKh token script is too large');
    script=text; scriptAt=Date.now(); return script;
  }
  async function resolve(item, season, episode) {
    if (!item || item.source !== 'kisskh') throw Error('Invalid KissKh title');
    const number=item.type==='movie' ? 1 : episode;
    if (item.type==='series' && season!==1) throw Error('KissKh episodes are listed under season 1');
    if (!Number.isInteger(number) || number < 1 || number > 9999) throw Error('Choose a valid episode');
    const list=await details(item.kissId); const ep=list.find(x=>x.number===number);
    if (!ep) throw Error('KissKh episode not found');
    let token; try { token=await tokenRunner(await tokenScript(),ep.id); } catch(e) { script=null; throw e; }
    const params=new URLSearchParams({kkey:token});
    const {json}=await fetchKiss(`${BASE}api/DramaList/Episode/${ep.id}.png?${params}`,{headers});
    const url=safeUrl(json?.Video);
    if (url.hostname.endsWith('tickcounter.com')) throw Error('Episode not released yet');
    const format=/\.m3u8$/i.test(url.pathname) ? 'hls' : /\.mp4$/i.test(url.pathname) ? 'file' : null;
    if (!format) throw Error('Unsupported KissKh stream format');
    return {streams:[{url:url.href,format,quality:0}],referer:BASE,origin:new URL(BASE).origin};
  }
  async function subtitle(item, season, episode) {
    if (!item || item.source !== 'kisskh') throw Error('Invalid KissKh title');
    const number=item.type==='movie' ? 1 : episode;
    if (item.type==='series' && season!==1) throw Error('KissKh episodes are listed under season 1');
    if (!Number.isInteger(number) || number < 1 || number > 9999) throw Error('Choose a valid episode');
    const ep=(await details(item.kissId)).find(e=>e.number===number);
    if (!ep) throw Error('KissKh episode not found');
    let token; try { token=await tokenRunner(await tokenScript(),ep.id,SUB_GUID); } catch(e) { script=null; throw e; }
    const params=new URLSearchParams({kkey:token});
    const list=(await fetchKiss(`${BASE}api/Sub/${ep.id}?${params}`,{headers})).json;
    const pick=Array.isArray(list) ? list.find(s=>String(s?.label || '').toLowerCase().includes('english')) : null;
    if (!pick?.src) return null;
    const url=safeUrl(pick.src); const ext=url.pathname.split('.').pop().toLowerCase();
    const raw=(await fetchKiss(url.href,{headers})).text;
    if (!raw || raw.length > 2*1024*1024) return null;
    const keys={txt:['8056483646328763','6852612370185273'],txt1:['AmSmZVcH93UQUezi','ReBKWW8cqdjPEnF6'],other:['sWODXX04QRTkHdlZ','8pwhapJeC4hrS9hO']};
    const pair=ext==='srt' || ext==='vtt' ? null : (keys[ext] || keys.other);
    const decoded=raw.replace(/^\uFEFF/,'').split(/\r?\n/).map(line=>{
      const t=line.trim(); if (!pair || !t || /^\d+$/.test(t) || t.includes('-->')) return line;
      try { const d=crypto.createDecipheriv('aes-128-cbc',Buffer.from(pair[0]),Buffer.from(pair[1])); return Buffer.concat([d.update(Buffer.from(t,'base64')),d.final()]).toString('utf8').trim(); } catch { return line; }
    }).join('\n').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,'$1.$2');
    if (!decoded.includes('-->')) return null;
    return decoded.startsWith('WEBVTT') ? decoded : `WEBVTT\n\n${decoded}`;
  }
  return {search,details,resolve,subtitle};
};
module.exports.runToken=runToken;
