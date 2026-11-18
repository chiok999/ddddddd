'use strict';
// Choosing a route is the thing that decides whether a title plays, so it is
// tested against the shapes that were actually seen in production: a 426 to this
// address, a 427 through the Worker, and a dead Worker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRouter, ROUTE_FAILURES } = require('./route');

const body = (text) => ({ body: { cancel: async () => {} }, text });
const response = (status, marker = '') => ({
  status,
  marker,
  headers: { get: () => null },
  body: { cancel: async () => {} },
});

// A route that answers from a script and records that it was asked.
function scripted(name, steps) {
  const calls = [];
  let index = 0;
  const fn = async (url, headers, signal) => {
    calls.push({ url, headers });
    const step = steps[Math.min(index++, steps.length - 1)];
    if (step instanceof Error) throw step;
    return response(step, name);
  };
  fn.calls = calls;
  return fn;
}

test('a refused direct fetch is served by the relay instead', async () => {
  const direct = scripted('direct', [426]);
  const relay = scripted('relay', [200]);
  const { remote } = createRouter({ direct, relay, order: ['direct', 'relay'] });
  const result = await remote('https://cdn.example/film.mp4', {}, undefined);
  assert.equal(result.status, 200);
  assert.equal(result.marker, 'relay');
  assert.equal(direct.calls.length, 1);
  assert.equal(relay.calls.length, 1);
});

test('a rate-limited relay is served by this address instead', async () => {
  const direct = scripted('direct', [200]);
  const relay = scripted('relay', [427]);
  const { remote } = createRouter({ direct, relay, order: ['relay', 'direct'] });
  const result = await remote('https://cdn.example/film.mp4', {}, undefined);
  assert.equal(result.status, 200);
  assert.equal(result.marker, 'direct');
});

test('a 404 is not retried on the other route: the file is the problem', async () => {
  const direct = scripted('direct', [404]);
  const relay = scripted('relay', [200]);
  const { remote } = createRouter({ direct, relay, order: ['direct', 'relay'] });
  const result = await remote('https://cdn.example/film.mp4', {}, undefined);
  assert.equal(result.status, 404);
  assert.equal(relay.calls.length, 0, 'asking again cannot change a missing file');
});

test('a 403 is not retried either', async () => {
  const direct = scripted('direct', [403]);
  const relay = scripted('relay', [200]);
  const { remote } = createRouter({ direct, relay, order: ['direct', 'relay'] });
  assert.equal((await remote('https://cdn.example/f.mp4', {}, undefined)).status, 403);
  assert.equal(relay.calls.length, 0);
});

test('a range request that the first route bounces is replayed exactly', async () => {
  const direct = scripted('direct', [426]);
  const relay = scripted('relay', [206]);
  const { remote } = createRouter({ direct, relay, order: ['direct', 'relay'] });
  const headers = { range: 'bytes=1000-', 'if-range': '"v1"' };
  const result = await remote('https://cdn.example/film.mp4', headers, undefined);
  assert.equal(result.status, 206);
  assert.deepEqual(relay.calls[0].headers, headers, 'no range state is lost in the switch');
});

test('a thrown route failure moves to the other route', async () => {
  const direct = async () => {
    throw Error('Relay unreachable (connect ECONNREFUSED)');
  };
  const relay = scripted('relay', [200]);
  const { remote } = createRouter({ direct, relay, order: ['direct', 'relay'] });
  const result = await remote('https://cdn.example/film.mp4', {}, undefined);
  assert.equal(result.status, 200);
  assert.equal(result.marker, 'relay');
});

test('when both routes fail the status is real, not a generic error', async () => {
  const direct = scripted('direct', [426]);
  const relay = scripted('relay', [427]);
  const { remote } = createRouter({ direct, relay, order: ['direct', 'relay'] });
  const result = await remote('https://cdn.example/film.mp4', {}, undefined);
  assert.equal(result.status, 427, 'the last real status reaches the caller');
  assert.deepEqual(result.routeTrail, ['direct:426', 'relay:427'], 'and the trail says why');
});

test('both routes throwing produces one error naming each', async () => {
  const direct = async () => {
    throw Error('boom');
  };
  const relay = async () => {
    throw Error('Relay unreachable (timed out)');
  };
  const { remote } = createRouter({ direct, relay, order: ['direct', 'relay'] });
  await assert.rejects(remote('https://cdn.example/f.mp4', {}, undefined), /boom.*Relay unreachable/);
});

test('a winning route is remembered per host, and only for a while', async () => {
  let clock = 0;
  const direct = scripted('direct', [426, 426]);
  const relay = scripted('relay', [200, 200]);
  const { remote, preferredFor } = createRouter({ direct, relay, order: ['direct', 'relay'], now: () => clock });
  await remote('https://a.example/f.mp4', {}, undefined);
  assert.deepEqual(preferredFor('a.example'), ['relay', 'direct'], 'the host that needed the relay asks it first next time');
  await remote('https://a.example/other.mp4', {}, undefined);
  assert.equal(direct.calls.length, 1, 'and does not pay for the refusal again');
  // A different host is unaffected.
  assert.deepEqual(preferredFor('b.example'), ['direct', 'relay']);
  // Memory expires, so a CDN that recovers is not penalised forever.
  clock = 11 * 60 * 1000;
  assert.deepEqual(preferredFor('a.example'), ['direct', 'relay']);
});

test('a host that fails on both routes is not remembered as working', async () => {
  const direct = scripted('direct', [426]);
  const relay = scripted('relay', [427]);
  const { remote, preferredFor } = createRouter({ direct, relay, order: ['direct', 'relay'] });
  await remote('https://c.example/f.mp4', {}, undefined);
  assert.deepEqual(preferredFor('c.example'), ['direct', 'relay'], 'no false memory');
});

test('with no relay configured nothing changes', async () => {
  const direct = scripted('direct', [426]);
  const { remote } = createRouter({ direct, relay: null, order: ['direct'] });
  assert.equal((await remote('https://cdn.example/f.mp4', {}, undefined)).status, 426);
  assert.equal(direct.calls.length, 1, 'no pointless second request');
});

test('route failures are the only ones worth a second route', () => {
  for (const status of [426, 427, 428, 429, 451, 502, 503, 504]) assert.ok(ROUTE_FAILURES.has(status), String(status));
  for (const status of [200, 206, 400, 401, 403, 404, 410, 416]) assert.ok(!ROUTE_FAILURES.has(status), String(status));
});

test('prefetch learns the working route before playback commits', async () => {
  // The Worker is rate-limited here, so the direct route is the healthy one.
  const direct = scripted('direct', [200]);
  const relay = scripted('relay', [427]);
  const { prefetch, preferredFor, remote } = createRouter({ direct, relay, order: ['relay', 'direct'] });
  await prefetch(['https://a.example/1.mp4', 'https://a.example/2.mp4']);
  assert.equal(preferredFor('a.example')[0], 'direct', 'the healthy route is tried first from now on');
  const before = direct.calls.length + relay.calls.length;
  const result = await remote('https://a.example/1.mp4', {}, undefined);
  assert.equal(result.status, 200);
  assert.equal(direct.calls.length + relay.calls.length - before, 1, 'the play costs one request, not several');
});

test('prefetch never fails a resolve, even with unusable URLs', async () => {
  const direct = async () => {
    throw Error('nope');
  };
  const { prefetch } = createRouter({ direct, relay: null, order: ['direct'] });
  await prefetch(['not a url', 'https://c.example/f.mp4']);
  await prefetch([]);
});
