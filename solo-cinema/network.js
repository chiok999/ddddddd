'use strict';
const dns = require('node:dns').promises;
const net = require('node:net');
const ipaddr = require('ipaddr.js');

function safeUrl(input) {
  const url = new URL(input);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 8192 || net.isIP(host.replace(/^\[|\]$/g, '')) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw Error('Only public HTTPS URLs are allowed');
  return url;
}
function publicLookup(resolve = dns.lookup) {
  return (host, options, callback) => {
    Promise.resolve().then(() => resolve(host, { all: true, verbatim: true })).then(rows => {
      if (!rows.length || rows.some(r => { try { return ipaddr.process(r.address).range() !== 'unicast'; } catch { return true; } })) throw Error('Private or invalid address');
      const matches = options.family ? rows.filter(r => r.family === options.family) : rows;
      if (!matches.length) throw Error('No address');
      if (options.all) callback(null, matches); else callback(null, matches[0].address, matches[0].family);
    }).catch(callback);
  };
}
// A 426 is a transport refusal: the edge wants the request resent on a
// different connection, usually HTTP/2 over ALPN. Browsers simply retry, which
// is why the same URL plays in a browser tab but not from Node.
// Only idempotent methods are replayed, and each attempt must make progress or
// we stop rather than loop against a wall.
function h2Signal(response){
  const upgrade=response.headers.get('upgrade');
  // An absent Upgrade header is not a reason to give up: broken edges omit it.
  if(!upgrade) return true;
  return /(?:^|[,\s])h2(?:$|[,\s])/i.test(upgrade);
}
async function getWithH2Fallback(url,options,fetch,agent,h2Agent){
  const method=(options.method || 'GET').toUpperCase();
  const first=await fetch(url,{...options,dispatcher:agent});
  if(method!=='GET' || first.status!==426 || !h2Signal(first)) return first;
  await first.body?.cancel().catch(()=>{});
  // Order: HTTP/2 first (the usual fix), then one replay on a fresh HTTP/1
  // connection for edges that reject the first connection but accept a retry.
  const attempts=[...(h2Agent?[h2Agent]:[]),agent];
  let last=first;
  for(const dispatcher of attempts){
    let response;
    try{response=await fetch(url,{...options,dispatcher});}
    catch(error){if(options.signal?.aborted)throw error;continue;}
    if(response.status!==426){return response;}
    await response.body?.cancel().catch(()=>{});
    last=response;
    if(!h2Signal(response)) break;
  }
  return last;
}
// `options` reaches the request as-is. It used to be accepted as a seventh
// argument and silently dropped, so a caller asking for HEAD still sent GET.
async function getRemote(input, headers, signal, fetch, agent, h2Agent = null, options = {}) {
  let url = safeUrl(input);
  let forwarded=new Headers(headers);
  for (let n = 0; n <= 5; n++) {
    const response = await getWithH2Fallback(url,{...options,headers:forwarded,redirect:'manual',signal},fetch,agent,h2Agent);
    if (![301,302,303,307,308].includes(response.status)) return { response, url };
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || n === 5) throw Error('Invalid redirect');
    const next=safeUrl(new URL(location, url));
    if(next.origin!==url.origin){for(const name of ['authorization','proxy-authorization','cookie','cookie2'])forwarded.delete(name);}
    url=next;
  }
}
module.exports = { safeUrl, publicLookup, getRemote, getWithH2Fallback };
