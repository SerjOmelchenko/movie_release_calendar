'use strict';

// Provider availability changes independently of a movie's cinema release.
// Refresh the whole saved catalog, including movies outside discovery's window.
const fs = require('node:fs');
const path = require('node:path');
const { extractProviders } = require('../assets/radar-core.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const kinds = ['flatrate', 'free', 'ads', 'rent', 'buy'];

function needsRefresh(movie, now = Date.now()) {
  const checked = Date.parse(movie.providersUpdatedAt);
  return movie.watchProviders == null || !Number.isFinite(checked) || now - checked >= 7 * 86400000;
}

async function fetchProviders(id, { apiKey, fetchImpl = fetch, pause = sleep } = {}) {
  if (!apiKey) throw new Error('Set TMDB_API_KEY before refreshing provider data');
  const url = new URL(`https://api.themoviedb.org/3/movie/${id}/watch/providers`);
  url.searchParams.set('api_key', apiKey);
  for (let attempt = 0; attempt < 4; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
    } catch {
      if (attempt === 3) throw new Error('Provider request failed');
      await pause(1000 * 2 ** attempt);
      continue;
    }
    if (response.ok) return extractProviders(await response.json());
    // TMDB may remove old records; they no longer have viewing listings.
    if (response.status === 404) return {};
    const error = new Error(`Provider request returned HTTP ${response.status}`);
    error.status = response.status;
    if (response.status === 401 || response.status === 403 || attempt === 3) throw error;
    if (response.status !== 429 && response.status < 500) throw error;
    const retryAfter = response.headers.get('retry-after');
    const retryMs = /^\d+(\.\d+)?$/.test(retryAfter || '')
      ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    await pause(Math.max(1000 * 2 ** attempt, Number.isFinite(retryMs) ? retryMs : 0));
  }
}

async function refreshProviders(movies, { apiKey, fetchImpl, pause = sleep, now = new Date(), log = console.log } = {}) {
  const targets = movies.filter(movie => needsRefresh(movie, now.getTime()));
  const updates = new Map();
  let failed = 0;
  // At most 20 new requests per second, below TMDB's documented approximate
  // 40/sec ceiling. Retries back off and honor Retry-After.
  for (let i = 0; i < targets.length; i += 20) {
    const started = Date.now();
    const batch = targets.slice(i, i + 20);
    const results = await Promise.allSettled(batch.map(movie => fetchProviders(movie.id, { apiKey, fetchImpl, pause })));
    for (let n = 0; n < results.length; n++) {
      const result = results[n];
      if (result.status === 'fulfilled') updates.set(batch[n].id, result.value);
      else {
        // Do not replace any cached data if authentication is broken.
        if (!apiKey || result.reason.status === 401 || result.reason.status === 403) throw result.reason;
        failed++;
        log(`Movie ${batch[n].id}: ${result.reason.message}; retained previous provider data`);
      }
    }
    if ((i + 20) % 500 === 0 || i + 20 >= targets.length) log(`Providers: ${Math.min(i + 20, targets.length)}/${targets.length} checked; ${failed} failed`);
    if (i + 20 < targets.length) await pause(Math.max(0, 1000 - (Date.now() - started)));
  }
  for (const movie of movies) if (updates.has(movie.id)) {
    movie.watchProviders = updates.get(movie.id);
    movie.providersUpdatedAt = now.toISOString();
  }
  const withListings = movies.filter(movie => Object.values(movie.watchProviders || {}).some(entry => kinds.some(kind => entry[kind]?.length)));
  const summary = { total: movies.length, refreshed: updates.size, failed, withListings: withListings.length };
  log(JSON.stringify(summary));
  return summary;
}

async function main() {
  const file = path.join(__dirname, '..', 'data', 'movies.json');
  const movies = JSON.parse(fs.readFileSync(file, 'utf8'));
  const summary = await refreshProviders(movies, { apiKey: process.env.TMDB_API_KEY });
  if (!summary.withListings) throw new Error('No viewing-provider listings were obtained; existing data was retained');
  if (summary.refreshed) fs.writeFileSync(file, JSON.stringify(movies, null, 2));
  if (summary.failed) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { needsRefresh, fetchProviders, refreshProviders };
