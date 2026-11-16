'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('MovieBox is first for movie and series resolution, quality selection, and fallback', async () => {
  const media = await import('../lib/movies/engine/media/index.js');
  const registry = (await import('../lib/movies/engine/core/registry.js')).default;
  const config = (await import('../lib/movies/engine/config.js')).default;
  const { rank } = await import('../lib/movies/engine/core/ranker.js');
  const { resetTierCache } = await import('../lib/movies/engine/core/resolver.js');
  const originalFetch = global.fetch;
  const originals = registry.providers.map(p => [p, p.search]);
  const calls = [];
  let mode = 'playable';
  const item = { title: 'Fixture', year: 2020, imdbId: 'tt1234567', tmdbId: 123 };
  const candidate = (provider, url, quality = 720) => ({ provider, url, quality, kind: 'hls', title: 'Fixture' });
  global.fetch = async url => {
    assert.match(String(url), /^https:\/\/fixture\.invalid\//, 'unexpected network request');
    return String(url).endsWith('/dead')
      ? new Response('', { status: 404 })
      : new Response('#EXTM3U\n#EXTINF:10,\nsegment.ts\n', { status: 200 });
  };
  for (const p of registry.providers) {
    p.search = async () => {
      calls.push(p.id);
      if (p.id === 'moviebox') {
        if (mode === 'empty') return [];
        return [candidate(p.id, `https://fixture.invalid/${mode === 'dead' ? 'dead' : 'live'}`)];
      }
      return p.id === 'vidsrc' ? [candidate(p.id, 'https://fixture.invalid/live')] : [];
    };
  }
  const reset = () => { calls.length = 0; resetTierCache(); };
  try {
    assert.equal(registry.table()[0].id, 'moviebox');
    assert.equal(config.preferProviders[0], 'moviebox');
    for (let i = 0; i < 5; i++) registry.recordFail('moviebox', new Error('fixture failure'));
    assert.ok(registry.liveProviders({ tier: 3, type: 'series' }).some(p => p.id === 'moviebox'));
    assert.equal(rank([
      { provider: 'vidsrc', kind: 'hls', quality: 1080 },
      { provider: 'moviebox', kind: 'file', quality: 720, sizeMB: 180 },
      { provider: 'torrentio', kind: 'torrent', seeds: 5000, quality: 1080 },
    ], { want: 1080, episode: 2 })[0].provider, 'moviebox');

    for (const type of ['movie', 'series']) {
      reset();
      const result = type === 'movie'
        ? await media.resolveMovie({ item, quality: 1080 })
        : await media.resolveEpisode({ item, season: 1, episode: 2, quality: 1080 });
      assert.equal(result.provider, 'moviebox');
      assert.equal(result.quality, 720);
      assert.deepEqual(calls, ['moviebox']);
    }
    reset();
    const quality = await media.qualityOptions({ item, type: 'series', season: 1, episode: 2 });
    assert.equal(quality.options[0].provider, 'moviebox');
    assert.deepEqual(calls, ['moviebox']);

    for (mode of ['empty', 'dead']) {
      reset();
      const result = await media.resolveEpisode({ item, season: 1, episode: 2 });
      assert.equal(result.provider, 'vidsrc');
      assert.equal(calls[0], 'moviebox');
      assert.ok(calls.includes('vidsrc'));
    }
  } finally {
    global.fetch = originalFetch;
    for (const [p, search] of originals) p.search = search;
  }
});
