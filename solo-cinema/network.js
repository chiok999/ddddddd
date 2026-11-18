'use strict';
const dns = require('node:dns').promises;
const net = require('node:net');
const ipaddr = require('ipaddr.js');
const config = require('./config');

function safeUrl(input) {
  const url = new URL(input);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 8192 || net.isIP(host.replace(/^\[|\]$/g, '')) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw Error('Only public HTTPS URLs are allowed');
  return url;
}
// DNS answers arrive in server order, which is not reachability order. Many
// cheap VPS hosts, and many consumer networks, publish an AAAA record that the
// machine cannot actually route: the address is valid and unicast, so every
// safety check passes, and the connection then dies or is answered by an edge
// that refuses it. The host that only has working IPv4 looks fine; the host
// with a broken IPv6 route fails on every source.
//
// CINEMA_IPV4=1 forces IPv4 for all outbound source and provider traffic.
// "auto" (the default) keeps both families, because a dual-stack host works
// either way and IPv6-only networks must not be broken.
// Read once, at load, because it selects the agent built below.
const ipv4Mode = config.ipv4Mode();
const explicit = ipv4Mode === 'ipv4';
const forcedOff = ipv4Mode === 'ipv6';
// Detect the broken case ourselves instead of asking the operator to know it.
// Node cannot report route reachability, so this is decided once at startup:
// if the machine has no IPv6 route but DNS still hands out AAAA records, every
// source would fail for a reason unrelated to the provider.
const { execFileSync } = require('node:child_process');
function ipv6RouteMissing(){
  try{
    if(process.platform!=='linux') return false;
    const routes=require('node:fs').readFileSync('/proc/net/ipv6_route','utf8').trim().split('\n');
    // A default route is all zeros; anything else means no IPv6 egress.
    return !routes.some(line=>line.startsWith('0'.repeat(32)) && line.split(/\s+/).slice(-3,-2)[0]==='0'.repeat(32));
  }catch{return false;}
}
const ipv6Unrouted = !forcedOff && ipv6RouteMissing();
const forceIPv4 = !forcedOff && (explicit || ipv6Unrouted);
if (ipv6Unrouted && !explicit) {
  console.warn('[troy] No IPv6 route on this host but DNS returns IPv6 answers; preferring IPv4 automatically. Set CINEMA_IPV4=0 to override.');
}
function publicLookup(resolve = dns.lookup) {
  return (host, options, callback) => {
    Promise.resolve().then(() => resolve(host, { all: true, verbatim: true })).then(rows => {
      if (!rows.length || rows.some(r => { try { return ipaddr.process(r.address).range() !== 'unicast'; } catch { return true; } })) throw Error('Private or invalid address');
      let matches = options.family ? rows.filter(r => r.family === options.family) : rows;
      if (!matches.length) throw Error('No address');
      // Deterministic family preference: IPv4 first when asked for, otherwise
      // keep the resolver's order rather than silently reordering DNS.
      if (forceIPv4 && !options.family) {
        const v4 = matches.filter(r => r.family === 4);
        if (v4.length) matches = v4;
      }
      if (options.all) callback(null, matches); else callback(null, matches[0].address, matches[0].family);
    }).catch(callback);
  };
}
// A 426 means "upgrade required": the edge wants this request over HTTP/2.
// Some provider CDNs (series hosts especially) accept HTTP/1.1 for some
// endpoints and refuse it for others, which is why one title plays and another
// returns 426 from the same server. HTTP/2 is negotiated by TLS ALPN, so the
// fix is to offer it rather than to change any header.
// A named Upgrade must ask for h2. An absent header is ambiguous, so the
// caller decides: for a GET it is worth one retry, for anything that changes
// state it is not.
function h2Requested(response,{allowMissing=false}={}){
  const upgrade=response.headers.get('upgrade');
  if(!upgrade) return allowMissing;
  return /(?:^|[,\s])h2(?:$|[,\s])/i.test(upgrade);
}
// The client a browser presents when it plays a video. Only used to retry a
// source that refused an honest request, never to disguise the first attempt.
const PLAYER_USER_AGENT = config.playerUserAgent();
async function getRemote(input, headers, signal, fetch, agent, h2Agent = null) {
  let url = safeUrl(input);
  let forwarded=new Headers(headers);
  const finish = response => ({ response, url });
  for (let n = 0; n <= 5; n++) {
    let response = await fetch(url, { dispatcher: agent, headers:forwarded, redirect: 'manual', signal });
    // Retry once over HTTP/2 before following anything. Only GET-like reads are
    // ever reached here, and the body has not been consumed yet.
    // Escalate a 426 rather than giving up. Some edges want HTTP/2, some want a
    // player-like client, and some want both at once -- measured, not guessed:
    // see troy-426.js. Each step is a GET-like replay of the same URL, so it is
    // safe to repeat, and each step is bounded.
    if (response.status === 426 && h2Agent && h2Requested(response,{allowMissing:true})) {
      await response.body?.cancel().catch(()=>{});
      const retry = async (dispatcher, requestHeaders) => {
        try { return await fetch(url, { dispatcher, headers:requestHeaders, redirect: 'manual', signal }); }
        catch (error) { if (signal?.aborted) throw error; return null; }
      };
      // Step 1: the same request over HTTP/2.
      let next = await retry(h2Agent, forwarded);
      if (next && next.status !== 426) return finish(next);
      if (next) { await next.body?.cancel().catch(()=>{}); }
      // Step 2: HTTP/2 with a player-like client. A host can refuse HTTP/1.1 and
      // plain HTTP/2 while accepting the pair, so both are escalated together.
      const playerHeaders = new Headers(forwarded);
      if (!playerHeaders.has('user-agent')) playerHeaders.set('user-agent', PLAYER_USER_AGENT);
      if (!playerHeaders.has('accept')) playerHeaders.set('accept', '*/*');
      const escalated = await retry(h2Agent, playerHeaders);
      if (escalated) {
        if (escalated.status !== 426) return finish(escalated);
        await escalated.body?.cancel().catch(()=>{});
      }
      // Everything refused. Keep the original 426 rather than a bare failure.
    }
    if (![301,302,303,307,308].includes(response.status)) return finish(response);
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || n === 5) throw Error('Invalid redirect');
    const next=safeUrl(new URL(location, url));
    if(next.origin!==url.origin){for(const name of ['authorization','proxy-authorization','cookie','cookie2'])forwarded.delete(name);}
    url=next;
  }
}
module.exports = { safeUrl, publicLookup, getRemote, forceIPv4, ipv6Unrouted, h2Requested };
