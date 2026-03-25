'use strict';

const fs   = require('fs');
const path = require('path');

const API_KEY  = process.env.TMDB_API_KEY || '75c5a1d45830643e055bd8265fffb3b5';
const BASE_URL = 'https://api.themoviedb.org/3';

const DATA_DIR     = path.join(__dirname, '..', 'data');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
const MOVIES_PATH   = path.join(DATA_DIR, 'movies.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(title) {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip diacritics
    .replace(/[^a-z0-9\s]/g, ' ')     // keep alphanumeric + spaces
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function loadJSON(filepath, fallback) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch { return fallback; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, attempt = 0) {
  try {
    const res = await fetch(url);
    if (res.status === 429) {
      const wait = (attempt + 1) * 2000;
      console.warn(`  Rate limited, waiting ${wait}ms...`);
      await sleep(wait);
      return fetchJSON(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (err) {
    if (attempt < 3) {
      await sleep(1000 * (attempt + 1));
      return fetchJSON(url, attempt + 1);
    }
    throw err;
  }
}

// ── TMDB fetching ─────────────────────────────────────────────────────────────

async function fetchAllMovies(fromDate, toDate) {
  const firstPage = await fetchJSON(
    `${BASE_URL}/discover/movie?api_key=${API_KEY}&language=en-US` +
    `&primary_release_date.gte=${fromDate}&primary_release_date.lte=${toDate}` +
    `&sort_by=popularity.desc&page=1`
  );

  const totalPages = Math.min(firstPage.total_pages || 1, 20);
  const movies = [...(firstPage.results || [])];

  for (let i = 2; i <= totalPages; i += 5) {
    const batch = [];
    for (let p = i; p <= Math.min(i + 4, totalPages); p++) batch.push(p);

    const pages = await Promise.all(batch.map(p =>
      fetchJSON(
        `${BASE_URL}/discover/movie?api_key=${API_KEY}&language=en-US` +
        `&primary_release_date.gte=${fromDate}&primary_release_date.lte=${toDate}` +
        `&sort_by=popularity.desc&page=${p}`
      )
    ));
    pages.forEach(r => movies.push(...(r.results || [])));
    if (i + 5 <= totalPages) await sleep(250);
  }

  return movies.filter(m => m.release_date);
}

async function fetchMovieDetails(id) {
  const [details, credits, releaseDates] = await Promise.all([
    fetchJSON(`${BASE_URL}/movie/${id}?api_key=${API_KEY}&language=en-US`),
    fetchJSON(`${BASE_URL}/movie/${id}/credits?api_key=${API_KEY}&language=en-US`),
    fetchJSON(`${BASE_URL}/movie/${id}/release_dates?api_key=${API_KEY}`),
  ]);

  const directors = (credits.crew || [])
    .filter(c => c.job === 'Director')
    .map(c => c.name);

  const cast = (credits.cast || []).slice(0, 5).map(c => c.name);

  // type 3 = Theatrical release
  const countryReleases = {};
  (releaseDates.results || []).forEach(r => {
    const theatrical = r.release_dates.find(d => d.type === 3);
    if (theatrical) countryReleases[r.iso_3166_1] = theatrical.release_date.slice(0, 10);
  });

  return {
    id:                details.id,
    title:             details.title,
    overview:          details.overview,
    release_date:      details.release_date,
    poster_path:       details.poster_path,
    backdrop_path:     details.backdrop_path,
    vote_average:      details.vote_average,
    vote_count:        details.vote_count,
    original_language: details.original_language,
    runtime:           details.runtime,
    genres:            (details.genres || []).map(g => g.name),
    genre_ids:         (details.genres || []).map(g => g.id),
    directors,
    cast,
    countryReleases,
  };
}

// ── Slug management ───────────────────────────────────────────────────────────

function assignSlugs(movies, manifest) {
  // Build reverse map: slug → id for collision detection
  const slugToId = {};
  for (const [id, entry] of Object.entries(manifest)) {
    slugToId[entry.slug] = id;
  }

  for (const movie of movies) {
    const id       = String(movie.id);
    const baseSlug = slugify(movie.title);
    const year     = (movie.release_date || '').slice(0, 4);

    if (manifest[id]) {
      const oldSlug = manifest[id].slug;

      // Title changed → assign new slug
      if (manifest[id].title !== movie.title) {
        let newSlug = baseSlug;
        if (slugToId[newSlug] && slugToId[newSlug] !== id) {
          newSlug = `${baseSlug}-${year}`;
        }
        // Last resort: append TMDB id
        if (slugToId[newSlug] && slugToId[newSlug] !== id) {
          newSlug = `${baseSlug}-${id}`;
        }

        console.log(`  Slug changed: "${manifest[id].title}" → "${movie.title}" (${oldSlug} → ${newSlug})`);

        if (!manifest[id].previousSlugs.includes(oldSlug)) {
          manifest[id].previousSlugs.push(oldSlug);
        }
        delete slugToId[oldSlug];
        slugToId[newSlug] = id;

        manifest[id].title = movie.title;
        manifest[id].slug  = newSlug;
      }
    } else {
      // New movie — pick a collision-free slug
      let slug = baseSlug;
      if (slugToId[slug]) slug = `${baseSlug}-${year}`;
      if (slugToId[slug] && slugToId[slug] !== id) slug = `${baseSlug}-${id}`;

      manifest[id] = { title: movie.title, slug, previousSlugs: [] };
      slugToId[slug] = id;
    }

    movie.slug = manifest[id].slug;
  }

  return manifest;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const manifest = loadJSON(MANIFEST_PATH, {});

  // 1 month back → 12 months forward
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to   = new Date(now.getFullYear(), now.getMonth() + 13, 0);
  const fromStr = `${from.getFullYear()}-${pad(from.getMonth() + 1)}-01`;
  const toStr   = `${to.getFullYear()}-${pad(to.getMonth() + 1)}-${pad(to.getDate())}`;

  console.log(`Fetching movies: ${fromStr} → ${toStr}`);
  const rawMovies = await fetchAllMovies(fromStr, toStr);
  console.log(`Found ${rawMovies.length} movies — fetching details...`);

  // Fetch details in batches of 10 (30 concurrent TMDB requests)
  const detailedMovies = [];
  const BATCH = 10;
  for (let i = 0; i < rawMovies.length; i += BATCH) {
    const batch = rawMovies.slice(i, i + BATCH);
    process.stdout.write(`  ${i + 1}–${Math.min(i + BATCH, rawMovies.length)} / ${rawMovies.length}\r`);

    const results = await Promise.allSettled(batch.map(m => fetchMovieDetails(m.id)));
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') detailedMovies.push(r.value);
      else console.error(`\n  Failed movie ${batch[idx].id}: ${r.reason.message}`);
    });

    if (i + BATCH < rawMovies.length) await sleep(300);
  }
  console.log(`\nFetched details for ${detailedMovies.length} movies`);

  // Assign slugs and update manifest
  assignSlugs(detailedMovies, manifest);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('manifest.json saved');

  fs.writeFileSync(MOVIES_PATH, JSON.stringify(detailedMovies, null, 2));
  console.log(`movies.json saved (${detailedMovies.length} movies)`);
}

main().catch(err => { console.error(err); process.exit(1); });
