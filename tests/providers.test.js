const test = require('node:test');
const assert = require('node:assert/strict');
const { needsRefresh, fetchProviders, refreshProviders } = require('../scripts/refresh-providers.js');
const now = new Date('2026-09-20T12:00:00Z');
const payload = { results: { US: { link: 'https://www.themoviedb.org/movie/1/watch?locale=US', rent: [{ provider_id: 2, provider_name: 'Apple TV', logo_path: '/logo.jpg' }] } } };
const response = (status, data = payload, headers = {}) => ({ ok: status === 200, status, json: async () => data, headers: new Headers(headers) });
const options = { apiKey: 'test-only', now, pause: async () => {}, log: () => {} };

test('provider refresh includes historical movies and skips data checked within seven days', async () => {
  const movies = [{ id: 1, release_date: '2020-01-01' }, { id: 2, watchProviders: {}, providersUpdatedAt: now.toISOString() }];
  const calls = [];
  const result = await refreshProviders(movies, { ...options, fetchImpl: async url => { calls.push(url.pathname); return response(200); } });
  assert.deepEqual(calls, ['/3/movie/1/watch/providers']);
  assert.equal(result.withListings, 1);
  assert.equal(movies[0].watchProviders.US.rent[0].name, 'Apple TV');
  assert.equal(movies[0].providersUpdatedAt, now.toISOString());
  assert(needsRefresh({ watchProviders: {}, providersUpdatedAt: '2026-09-13T12:00:00Z' }, now.getTime()));
});

test('provider refresh honors throttling and rejects incomplete payloads', async () => {
  let count = 0; const waits = [];
  const data = await fetchProviders(1, { ...options, fetchImpl: async () => ++count === 1 ? response(429, {}, { 'Retry-After': '3' }) : response(200), pause: async ms => waits.push(ms) });
  assert.deepEqual(waits, [3000]);
  assert.equal(data.US.rent[0].name, 'Apple TV');
  await assert.rejects(fetchProviders(1, { ...options, fetchImpl: async () => response(200, {}) }), /incomplete/);
});

test('authentication failure leaves the complete provider cache untouched', async () => {
  const movies = [{ id: 1 }, { id: 2, watchProviders: { US: {} }, providersUpdatedAt: '2026-01-01' }];
  const before = structuredClone(movies);
  await assert.rejects(refreshProviders(movies, { ...options, fetchImpl: async url => response(url.pathname.includes('/1/') ? 200 : 401) }), /401/);
  assert.deepEqual(movies, before);
});

test('transient failures retain old listings and their actual check date', async () => {
  const movie = { id: 1, watchProviders: { US: { rent: [{ id: 2, name: 'Apple TV' }] } }, providersUpdatedAt: '2026-01-01' };
  const before = structuredClone(movie);
  const result = await refreshProviders([movie], { ...options, fetchImpl: async () => response(503) });
  assert.equal(result.failed, 1);
  assert.deepEqual(movie, before);
});

test('empty availability replaces stale offers; removed movies have no listings', async () => {
  const movie = { id: 1, watchProviders: { US: { rent: [{ id: 2, name: 'Apple TV' }] } } };
  await refreshProviders([movie], { ...options, fetchImpl: async () => response(200, { results: {} }) });
  assert.deepEqual(movie.watchProviders, {});
  assert.equal(movie.providersUpdatedAt, now.toISOString());
  assert.deepEqual(await fetchProviders(2, { ...options, fetchImpl: async () => response(404) }), {});
});
