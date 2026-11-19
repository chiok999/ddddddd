// Checks for the thing that decides whether a tapped card can be opened.
//
// The bug this exists for: only /ranking stored catalog entries, so every card
// tapped from Home or Explore opened a page that said the title no longer
// existed. The store is now filled by the API layer, which is what these assert.
import assert from 'node:assert/strict';

// sessionStorage does not exist in Node; the store only needs the same shape.
const session = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (session.has(k) ? session.get(k) : null),
  setItem: (k, v) => session.set(k, v),
  removeItem: (k) => session.delete(k),
};

let seen = [];
let mode = {};
globalThis.fetch = async (url, init) => {
  seen.push({ url, body: init?.body ? JSON.parse(init.body) : null });
  const r = mode[url];
  if (r === undefined) throw new TypeError('fetch failed');
  return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
};

const { api } = await import('../dist-test/api.mjs');
const { itemStore } = await import('../dist-test/item-store.mjs');

const t = async (name, fn) => {
  seen = [];
  session.clear();
  try {
    await fn();
    console.log('ok   ' + name);
  } catch (e) {
    console.log('FAIL ' + name + '\n     ' + e.message);
    process.exitCode = 1;
  }
};

await t('a card from the home screen can be opened', async () => {
  // This is the reported bug: the entry was never stored, so /title/<id> had
  // nothing to render and refused to work.
  mode = {
    '/api/discover': {
      body: {
        sections: [
          { id: 'trending', items: [{ id: 'home1', title: 'A Film', type: 'movie', year: 2001 }] },
          { id: 'quiet', items: [] },
        ],
      },
    },
  };
  const sections = await api.discover();
  assert.equal(sections.length, 2);
  assert.equal(itemStore.get('home1')?.title, 'A Film');
});

await t('a search result can be opened', async () => {
  mode = { '/api/search': { body: { results: [{ id: 's1', title: 'Found' }], providers: [] } } };
  await api.search('found');
  assert.equal(itemStore.get('s1')?.title, 'Found');
});

await t('a category page can be opened, including its later pages', async () => {
  mode = { '/api/category': { body: { items: [{ id: 'c1', title: 'Ranked' }], hasMore: true, page: 2 } } };
  await api.category('42', 2);
  assert.equal(itemStore.get('c1')?.title, 'Ranked');
});

await t('a section with no items is harmless', async () => {
  mode = { '/api/discover': { body: { sections: [{ id: 'empty' }, { id: 'null', items: null }] } } };
  await api.discover();
  assert.equal(itemStore.get('empty'), undefined);
});

await t('one failed response does not store a partial catalog', async () => {
  mode = { '/api/search': { status: 502, body: { error: 'Search unavailable (MovieBox: ECONNRESET)' } } };
  await assert.rejects(api.search('x'));
  assert.equal(itemStore.get('anything'), undefined);
});

await t('an expired entry is found again by its title, with a fresh id', async () => {
  // The old id is unreachable; the new one resolves. The store keeps both
  // mappings so a page holding the old id still lands on the right title.
  mode = {
    '/api/search': {
      body: {
        results: [
          { id: 'other', title: 'A Different Film', type: 'movie', year: 2001 },
          { id: 'fresh', title: 'A Film', type: 'movie', year: 2001 },
        ],
        providers: [],
      },
    },
  };
  itemStore.put({ id: 'stale', title: 'A Film', type: 'movie', year: 2001 });
  const recovered = await itemStore.recover('stale');
  assert.equal(recovered?.id, 'fresh', 'the matching title is chosen, not the first result');
  assert.equal(seen[0].body.query, 'A Film', 'the title is the search query');
  assert.equal(itemStore.get('stale')?.id, 'fresh', 'the old id now points at the recovered entry');
});

await t('recovery prefers the right year, then the right type', async () => {
  itemStore.put({ id: 's2', title: 'Remake', type: 'series', year: 2020 });
  mode = {
    '/api/search': {
      body: {
        results: [
          { id: 'a', title: 'Remake', type: 'movie', year: 1990 },
          { id: 'b', title: 'Remake', type: 'series', year: 2020 },
          { id: 'c', title: 'Remake', type: 'movie', year: 2020 },
        ],
        providers: [],
      },
    },
  };
  assert.equal((await itemStore.recover('s2'))?.id, 'b');
});

await t('recovery gives up rather than guessing when nothing matches', async () => {
  itemStore.put({ id: 's3', title: 'Vanished Title' });
  mode = { '/api/search': { body: { results: [{ id: 'x', title: 'Something Else' }], providers: [] } } };
  assert.equal(await itemStore.recover('s3'), null, 'a wrong guess is worse than a clear failure');
});

await t('recovery of an id nobody has seen returns null without a request', async () => {
  mode = { '/api/search': { body: { results: [], providers: [] } } };
  assert.equal(await itemStore.recover('never-seen'), null);
  assert.equal(seen.length, 0, 'nothing to look up means no search is made');
});

await t('recovery survives the search being unavailable', async () => {
  itemStore.put({ id: 's4', title: 'A Film' });
  mode = { '/api/search': { status: 502, body: { error: 'Search unavailable' } } };
  assert.equal(await itemStore.recover('s4'), null);
});

console.log(process.exitCode ? '\nfailures above' : '\nall store checks passed');
