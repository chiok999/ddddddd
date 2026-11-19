// Contract checks for the API layer.
//
// Each body asserted below mirrors one Troy handler's validation. Troy answers
// 400 for a wrongly shaped request, and a 400 reads like a provider fault in the
// UI, so the shape is worth pinning rather than discovering in production.
//
// Run: node tools/build-api-fixture.mjs && node tools/api-check.mjs

import assert from 'node:assert/strict';
let seen = [];
let mode = {};
globalThis.fetch = async (url, init) => {
  seen.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null });
  const r = mode[url];
  if (r === undefined) throw new TypeError('fetch failed');   // network down
  if (r instanceof Error) throw r;
  return { ok: r.status === undefined || r.status < 400, status: r.status ?? 200, json: async () => r.body };
};
const { api, ApiError } = await import('/home/user/ddddddd/reelbox-src/dist-test/api.mjs');

const t = async (name, fn) => {
  seen = [];
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
};

await t('a dropped connection is reported as unreachable, not as a provider fault', async () => {
  mode = {};
  await assert.rejects(api.discover(), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 0);
    assert.match(e.message, /Cannot reach Troy/);
    return true;
  });
});

await t('a 401 carries the server message and the status', async () => {
  mode = { '/api/discover': { status: 401, body: { error: 'Login required' } } };
  await assert.rejects(api.discover(), (e) => e.status === 401 && e.message === 'Login required');
});

await t('a 502 keeps the provider detail instead of a generic message', async () => {
  mode = { '/api/search': { status: 502, body: { error: 'Search unavailable (MovieBox: ECONNRESET)' } } };
  await assert.rejects(api.search('x'), (e) => /ECONNRESET/.test(e.message));
});

await t('every call posts the exact body Troy validates', async () => {
  mode = {
    '/api/category': { body: { items: [], hasMore: false, page: 2 } },
    '/api/search': { body: { results: [], providers: [] } },
    '/api/episodes': { body: { episodes: [], source: 'x' } },
    '/api/resolve': { body: { title: 't', streams: [], providers: [] } },
    '/api/transcode': { body: { id: 'a'.repeat(32), url: '/transcode/x/master.m3u8' } },
    '/api/transcode/status': { body: { canPlay: true } },
    '/api/transcode/stop': { body: { stopped: true } },
    '/api/transcode/cancel': { body: { stopped: true } },
    '/api/source': { body: { url: '/media/x' } },
  };
  await api.category('1234', 2);
  await api.search('a title');
  await api.episodes('id1');
  await api.resolve('id1', 2, 5);
  await api.transcode('/media/x', 120, 'f'.repeat(32));
  await api.transcodeStatus('a'.repeat(32), 42);
  await api.stopTranscode('a'.repeat(32));
  await api.cancelTranscode('f'.repeat(32));
  await api.source('/media/x', 'file');
  const byUrl = Object.fromEntries(seen.map((c) => [c.url, c]));
  // Troy rejects anything that is not shaped exactly like this; the 400s it
  // returns were the reason each of these was checked against its handler.
  assert.deepEqual(byUrl['/api/category'].body, { genreTopId: '1234', page: 2 });
  assert.deepEqual(byUrl['/api/search'].body, { query: 'a title' });
  assert.deepEqual(byUrl['/api/episodes'].body, { id: 'id1' });
  assert.deepEqual(byUrl['/api/resolve'].body, { id: 'id1', season: 2, episode: 5 });
  assert.deepEqual(byUrl['/api/transcode'].body, { url: '/media/x', offset: 120, requestId: 'f'.repeat(32) });
  assert.deepEqual(byUrl['/api/transcode/status'].body, { id: 'a'.repeat(32), position: 42 });
  assert.deepEqual(byUrl['/api/transcode/stop'].body, { id: 'a'.repeat(32) });
  assert.deepEqual(byUrl['/api/transcode/cancel'].body, { requestId: 'f'.repeat(32) });
  assert.deepEqual(byUrl['/api/source'].body, { url: '/media/x', format: 'file' });
  for (const [url, call] of Object.entries(byUrl)) {
    if (url === '/api/discover' || url === '/api/session') continue;
    assert.equal(call.method, 'POST', url + ' must be a POST');
  }
});

await t('session and discover are GETs and return the unwrapped value', async () => {
  mode = {
    '/api/session': { body: { authenticated: true } },
    '/api/discover': { body: { sections: [{ id: 'x', items: [] }] } },
  };
  assert.equal(await api.session(), true);
  assert.deepEqual(await api.discover(), [{ id: 'x', items: [] }]);
  assert.deepEqual(seen.map((c) => c.method), ['GET', 'GET']);
});

// Subtitle routing. Each provider serves its captions from its own endpoint, and
// asking the wrong one with a valid id comes back empty rather than failing, so
// the mapping is worth pinning exactly.
await t('subtitle requests go to the provider that owns the caption', async () => {
  const { subtitleRequest } = await import('/home/user/ddddddd/reelbox-src/dist-test/api.mjs');
  const ids = { id: 'title1', season: 2, episode: 5 };

  const kiss = subtitleRequest('kisskh', {}, 'kisskh', ids);
  assert.deepEqual(kiss, { path: '/api/kiss-subtitle', data: ids });

  const movy = subtitleRequest('movy:x', { captionId: 'cap1' }, 'moviebox', ids);
  assert.deepEqual(movy, { path: '/api/movy-subtitle', data: { id: 'cap1' } });

  const vidlink = subtitleRequest('7movies', { captionId: 'cap2' }, 'moviebox', ids);
  assert.deepEqual(vidlink, { path: '/api/vidlink-subtitle', data: { id: 'cap2' } });

  const moviebox = subtitleRequest('moviebox', { captionId: 'cap3' }, 'moviebox', ids);
  assert.deepEqual(moviebox, { path: '/api/moviebox-subtitle', data: { id: 'cap3' } });

  // No caption offered is the normal case and must not produce a request.
  assert.equal(subtitleRequest('moviebox', {}, 'moviebox', ids), null);
  assert.equal(subtitleRequest('moviebox', { captionId: null }, 'moviebox', ids), null);
});

await t('a caption URL is session-scoped and only ever returned as-is', async () => {
  mode = {
    '/api/moviebox-subtitle': { body: { url: '/caption/abc123' } },
    '/api/kiss-subtitle': { body: { url: null } },
  };
  const { api } = await import('/home/user/ddddddd/reelbox-src/dist-test/api.mjs');
  assert.deepEqual(await api.subtitle('/api/moviebox-subtitle', { id: 'cap3' }), { url: '/caption/abc123' });
  assert.deepEqual(await api.subtitle('/api/kiss-subtitle', { id: 'x', season: 1, episode: 1 }), { url: null });
  assert.equal(seen[0].method, 'POST');
});
