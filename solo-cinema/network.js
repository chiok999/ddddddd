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
async function getRemote(input, headers, signal, fetch, agent) {
  let url = safeUrl(input);
  let forwarded=new Headers(headers);
  for (let n = 0; n <= 5; n++) {
    const response = await fetch(url, { dispatcher: agent, headers:forwarded, redirect: 'manual', signal });
    if (![301,302,303,307,308].includes(response.status)) return { response, url };
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || n === 5) throw Error('Invalid redirect');
    const next=safeUrl(new URL(location, url));
    if(next.origin!==url.origin){for(const name of ['authorization','proxy-authorization','cookie','cookie2'])forwarded.delete(name);}
    url=next;
  }
}
module.exports = { safeUrl, publicLookup, getRemote };
