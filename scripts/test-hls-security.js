'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test('HLS verification blocks local URLs and private redirects', async () => {
  const { resolveCandidate } = await import('../lib/movies/engine/core/resolver.js');
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.end('#EXTM3U\n#EXTINF:10,\nsegment.ts\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}/private`;
  const originalFetch = global.fetch;
  try {
    await assert.rejects(resolveCandidate({ provider: 'vaplayer', kind: 'hls', title: 'fixture', url: local }), { code: 'UNSAFE_SOURCE' });
    assert.equal(hits, 0);
    let calls = 0;
    global.fetch = async () => { calls++; return new Response('', { status: 302, headers: { location: local } }); };
    await assert.rejects(resolveCandidate({ provider: 'vaplayer', kind: 'hls', title: 'fixture', url: 'https://fixture.invalid/master' }), { code: 'UNSAFE_SOURCE' });
    assert.equal(calls, 1);
    global.fetch = async () => new Response('', { status: 302, headers: { location: 'http://[invalid' } });
    await assert.rejects(resolveCandidate({ provider: 'vaplayer', kind: 'hls', title: 'fixture', url: 'https://fixture.invalid/master' }), { code: 'UNSAFE_SOURCE' });
    assert.equal(hits, 0);
  } finally { global.fetch = originalFetch; await new Promise(resolve => server.close(resolve)); }
});

test('native HLS downloader refuses private hosts and private redirect hops', async () => {
  const { downloadHlsNative } = await import('../lib/movies/engine/media/hls.js');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hls-ssrf-')), 'out.ts');
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.end('#EXTM3U\n#EXT-X-ENDLIST'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const originalFetch = global.fetch;
  try {
    // Direct private playlist: blocked before any request is made.
    await assert.rejects(
      downloadHlsNative(`http://127.0.0.1:${server.address().port}/index.m3u8`, dest),
      { code: 'UNSAFE_SOURCE' },
    );
    assert.equal(hits, 0);
    // Public playlist redirecting onto the LAN: the hop is blocked too.
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return new Response('', { status: 302, headers: { location: `http://127.0.0.1:${server.address().port}/private` } });
    };
    await assert.rejects(downloadHlsNative('https://cdn.example.test/master.m3u8', dest), { code: 'UNSAFE_SOURCE' });
    assert.equal(calls, 1);
    assert.equal(hits, 0);
  } finally {
    global.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
  }
});

test('unsafe HLS candidates cannot return as unverified fallback links', async () => {
  await import('../lib/movies/engine/media/index.js');
  const registry = (await import('../lib/movies/engine/core/registry.js')).default;
  const resolver = (await import('../lib/movies/engine/core/resolver.js')).default;
  const provider = registry.get('moviebox');
  const original = provider.search;
  provider.search = async () => [{ provider: 'moviebox', kind: 'hls', title: 'fixture', quality: 720, url: 'http://127.0.0.1/private' }];
  try {
    await assert.rejects(resolver.resolve({ type: 'series', title: 'unsafe fixture' }, {
      season: 1, episode: 1, want: 720,
      exclude: registry.providers.filter(p => p.id !== 'moviebox').map(p => p.id),
    }));
  } finally { provider.search = original; }
});
