// Fetch an HLS manifest without allowing redirects or DNS to reach private
// networks. This protects verification only, not external HLS downloaders.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Agent } = require('undici');
const { safeUrl, publicLookup } = require('../../../publicMediaDownload');

const dispatcher = new Agent({ connect: { lookup: publicLookup() } });
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export async function fetchManifest(url, { headers = {}, signal } = {}) {
  let current = safeUrl(url);
  let currentHeaders = { ...headers };
  for (let hop = 0; hop <= 5; hop++) {
    let response;
    try { response = await fetch(current.href, { headers: currentHeaders, signal, redirect: 'manual', dispatcher }); }
    catch (error) {
      if (error?.code === 'UNSAFE_SOURCE' || error?.cause?.code === 'UNSAFE_SOURCE') {
        throw Object.assign(new Error('Unsafe HLS host'), { code: 'UNSAFE_SOURCE', cause: error });
      }
      throw error;
    }
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get('location');
    try { await response.body?.cancel(); } catch { /* ignore */ }
    if (!location || hop === 5) throw Object.assign(new Error('HLS redirect limit reached'), { code: 'UNSAFE_SOURCE' });
    let next;
    try { next = safeUrl(new URL(location, current).href); }
    catch (error) {
      throw Object.assign(new Error('Unsafe HLS redirect'), { code: 'UNSAFE_SOURCE', cause: error });
    }
    if (next.origin !== current.origin) {
      currentHeaders = Object.fromEntries(Object.entries(currentHeaders).filter(([name]) => !/^(authorization|cookie|proxy-authorization)$/i.test(name)));
    }
    current = next;
  }
  throw Object.assign(new Error('HLS redirect limit reached'), { code: 'UNSAFE_SOURCE' });
}
