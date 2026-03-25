'use strict';

const fs   = require('fs');
const path = require('path');

const API_KEY  = process.env.TMDB_API_KEY || '75c5a1d45830643e055bd8265fffb3b5';
const BASE_URL = 'https://api.themoviedb.org/3';

const DATA_DIR      = path.join(__dirname, '..', 'data');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
const MOVIES_PATH   = path.join(DATA_DIR, 'movies.json');
const MOVIE_DIR     = path.join(__dirname, '..', 'movie');

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

  // type 3 = Theatrical; fall back to earliest available date if no theatrical entry
  const TYPE_PRIORITY = [3, 4, 5, 6, 1, 2]; // theatrical → digital → physical → TV → premiere → limited
  const countryReleases = {};
  (releaseDates.results || []).forEach(r => {
    for (const type of TYPE_PRIORITY) {
      const entry = r.release_dates.find(d => d.type === type && d.release_date);
      if (entry) { countryReleases[r.iso_3166_1] = entry.release_date.slice(0, 10); break; }
    }
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
        // Fall back to TMDB id when title produces an empty slug (e.g. CJK-only titles)
        let newSlug = baseSlug || `movie-${id}`;
        if (slugToId[newSlug] && slugToId[newSlug] !== id) {
          newSlug = `${newSlug}-${year}`;
        }
        // Last resort: append TMDB id
        if (slugToId[newSlug] && slugToId[newSlug] !== id) {
          newSlug = `${baseSlug || 'movie'}-${id}`;
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
      // Fall back to TMDB id when title produces an empty slug (e.g. CJK-only titles)
      let slug = baseSlug || `movie-${id}`;
      if (slugToId[slug]) slug = `${slug}-${year}`;
      if (slugToId[slug] && slugToId[slug] !== id) slug = `${baseSlug || 'movie'}-${id}`;

      manifest[id] = { title: movie.title, slug, previousSlugs: [] };
      slugToId[slug] = id;
    }

    movie.slug = manifest[id].slug;
  }

  return manifest;
}

// ── Static page generation ────────────────────────────────────────────────────

const IMG_BASE = 'https://image.tmdb.org/t/p/';
const SITE_BASE = 'https://moviereleaseradar.com';

const COUNTRY_NAMES = {
  AR:'Argentina', AU:'Australia', AT:'Austria', BE:'Belgium', BR:'Brazil',
  BG:'Bulgaria', CA:'Canada', CL:'Chile', CN:'China', CO:'Colombia',
  HR:'Croatia', CY:'Cyprus', CZ:'Czech Republic', DK:'Denmark', EE:'Estonia',
  FI:'Finland', FR:'France', DE:'Germany', GR:'Greece', HK:'Hong Kong',
  HU:'Hungary', IN:'India', ID:'Indonesia', IE:'Ireland', IL:'Israel',
  IT:'Italy', JP:'Japan', LV:'Latvia', LT:'Lithuania', LU:'Luxembourg',
  MY:'Malaysia', MT:'Malta', MX:'Mexico', NL:'Netherlands', NZ:'New Zealand',
  NO:'Norway', PH:'Philippines', PL:'Poland', PT:'Portugal', RO:'Romania',
  RU:'Russia', SA:'Saudi Arabia', SG:'Singapore', SK:'Slovakia', SI:'Slovenia',
  ZA:'South Africa', KR:'South Korea', ES:'Spain', SE:'Sweden', CH:'Switzerland',
  TW:'Taiwan', TH:'Thailand', TR:'Turkey', UA:'Ukraine', AE:'UAE',
  GB:'United Kingdom', US:'United States', VN:'Vietnam',
};

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSchema(movie, canonicalUrl) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Movie',
    name: movie.title,
    url: canonicalUrl,
  };
  if (movie.overview)        schema.description   = movie.overview;
  if (movie.release_date)    schema.datePublished = movie.release_date;
  if (movie.poster_path)     schema.image         = `${IMG_BASE}w500${movie.poster_path}`;
  if (movie.genres?.length)  schema.genre         = movie.genres;
  if (movie.runtime)         schema.duration      = `PT${Math.floor(movie.runtime / 60)}H${movie.runtime % 60}M`;
  if (movie.directors?.length) {
    schema.director = movie.directors.map(n => ({ '@type': 'Person', name: n }));
  }
  if (movie.cast?.length) {
    schema.actor = movie.cast.map(n => ({ '@type': 'Person', name: n }));
  }
  if (movie.vote_count > 0) {
    schema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: movie.vote_average.toFixed(1),
      ratingCount: movie.vote_count,
      bestRating: 10,
      worstRating: 1,
    };
  }
  return JSON.stringify(schema);
}

function buildMoviePage(movie) {
  const year        = (movie.release_date || '').slice(0, 4);
  const title       = escHtml(movie.title);
  const overview    = escHtml(movie.overview || 'No synopsis available.');
  const backdrop    = movie.backdrop_path ? `${IMG_BASE}w1280${movie.backdrop_path}` : '';
  const poster      = movie.poster_path   ? `${IMG_BASE}w500${movie.poster_path}`   : '';
  const canonicalUrl = `${SITE_BASE}/movie/${movie.slug}/`;

  const releaseDate = movie.release_date
    ? new Date(movie.release_date + 'T00:00:00').toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
    : 'TBA';

  const rating = movie.vote_count > 0
    ? `&#9733; ${movie.vote_average.toFixed(1)} / 10 <span class="vote-count">(${movie.vote_count.toLocaleString()} votes)</span>`
    : '';

  const runtime = movie.runtime
    ? `${Math.floor(movie.runtime / 60)}h ${movie.runtime % 60}m`
    : '';

  const genreTagsHtml = (movie.genres || [])
    .map(g => `<span class="genre-tag">${escHtml(g)}</span>`)
    .join('');

  const directors = (movie.directors || []).map(d => escHtml(d)).join(', ');
  const cast       = (movie.cast      || []).map(c => escHtml(c)).join(', ');

  let countryEntries = Object.entries(movie.countryReleases || {})
    .sort(([, a], [, b]) => a.localeCompare(b));

  // No per-country entries but we have a primary release date — show it as Worldwide
  if (countryEntries.length === 0 && movie.release_date) {
    countryEntries = [['WW', movie.release_date]];
  }

  const releasesHtml = countryEntries.map(([code, date]) => {
    const name      = escHtml(code === 'WW' ? 'Worldwide' : (COUNTRY_NAMES[code] || code));
    const formatted = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
    return `<div class="release-item"><span class="release-country">${name}</span><span class="release-date">${formatted}</span></div>`;
  }).join('');

  const genreStr  = (movie.genres || []).slice(0, 3).join(', ');
  const metaDesc  = escHtml(
    `${movie.title}${year ? ` (${year})` : ''} release dates by country.` +
    `${genreStr ? ` ${genreStr}.` : ''}` +
    `${movie.overview ? ' ' + movie.overview.slice(0, 120) + '...' : ''}`
  );
  const ogImage = poster || (movie.backdrop_path ? `${IMG_BASE}w780${movie.backdrop_path}` : '');

  const GTM_CONSENT = `
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    (function(){
      var c; try { c = localStorage.getItem('cookie_consent'); } catch(e) {}
      var granted = c === 'accepted';
      gtag('consent', 'default', {
        analytics_storage:  granted ? 'granted' : 'denied',
        ad_storage:         granted ? 'granted' : 'denied',
        ad_user_data:       granted ? 'granted' : 'denied',
        ad_personalization: granted ? 'granted' : 'denied',
      });
    })();`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <script>${GTM_CONSENT}</script>
  <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-T3BJFZSV');</script>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}${year ? ` (${year})` : ''} &mdash; Release Dates &amp; Info | Movie Release Radar</title>
  <meta name="description" content="${metaDesc}" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="${canonicalUrl}" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <meta property="og:type"        content="website" />
  <meta property="og:url"         content="${canonicalUrl}" />
  <meta property="og:title"       content="${title}${year ? ` (${year})` : ''}" />
  <meta property="og:description" content="${metaDesc}" />
  ${ogImage ? `<meta property="og:image" content="${escHtml(ogImage)}" />` : ''}
  <script type="application/ld+json">${buildSchema(movie, canonicalUrl)}</script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0d0d0d; color: #e0e0e0; min-height: 100vh; }

    header { background: #0d0d0d; padding: 1.4rem 2rem; border-bottom: 1px solid #1e1e1e; display: flex; align-items: center; justify-content: center; }
    .site-brand { display: flex; align-items: center; gap: 0.85rem; text-decoration: none; }
    .brand-icon { width: 38px; height: 38px; flex-shrink: 0; }
    .brand-icon .sweep-group { transform-origin: 22px 22px; animation: radar-spin 3s linear infinite; }
    @keyframes radar-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .brand-name { font-size: 1.45rem; font-weight: 800; color: #fff; letter-spacing: 0.1em; text-transform: uppercase; }
    .brand-name span { color: #e94560; }

    .movie-page { max-width: 960px; margin: 0 auto; padding: 2rem; }
    .back-link { display: inline-flex; align-items: center; gap: 0.4rem; color: #e94560; text-decoration: none; font-size: 0.875rem; margin-bottom: 1.5rem; }
    .back-link:hover { text-decoration: underline; }

    .movie-hero { border-radius: 12px; overflow: hidden; margin-bottom: 2rem; background: #111; }
    .movie-hero img { width: 100%; height: 320px; object-fit: cover; object-position: center top; display: block; }

    .movie-main { display: flex; gap: 2rem; align-items: flex-start; }
    .movie-poster { flex-shrink: 0; width: 200px; }
    .movie-poster img { width: 100%; border-radius: 10px; display: block; box-shadow: 0 8px 32px rgba(0,0,0,0.6); }
    .movie-poster-placeholder { width: 100%; aspect-ratio: 2/3; background: #1e1e1e; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 0.85rem; color: #555; text-align: center; padding: 1rem; line-height: 1.4; }

    .movie-info { flex: 1; min-width: 0; }
    .movie-title { font-size: 2rem; font-weight: 800; color: #fff; line-height: 1.2; margin-bottom: 0.75rem; }
    .movie-meta { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1rem; font-size: 0.9rem; color: #aaa; }
    .vote-count { color: #777; font-size: 0.85em; }
    .movie-genres { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
    .genre-tag { background: #0f3460; color: #90caf9; border-radius: 20px; padding: 0.25rem 0.75rem; font-size: 0.78rem; }
    .movie-crew { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.875rem; color: #aaa; margin-bottom: 1rem; }
    .movie-crew strong { color: #ddd; }
    .movie-overview { font-size: 1rem; color: #ccc; line-height: 1.7; }

    .releases-section { margin-top: 2.5rem; }
    .section-heading { font-size: 0.78rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #555; margin-bottom: 0.75rem; padding-bottom: 0.4rem; border-bottom: 1px solid #222; }
    .releases-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 0.5rem; }
    .release-item { background: #141414; border: 1px solid #222; border-radius: 8px; padding: 0.6rem 0.9rem; display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
    .release-country { color: #ccc; font-weight: 500; }
    .release-date { color: #888; font-size: 0.8rem; white-space: nowrap; }

    footer { border-top: 1px solid #1e1e1e; margin-top: 3rem; padding: 1.4rem 2rem; }
    .footer-inner { max-width: 1300px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .footer-brand { font-size: 0.78rem; font-weight: 700; color: #333; letter-spacing: 0.1em; text-transform: uppercase; }
    .footer-attr { font-size: 0.75rem; color: #3a3a3a; }
    footer a { color: #e94560; text-decoration: none; }
    footer a:hover { text-decoration: underline; }

    @media (max-width: 640px) {
      .movie-page { padding: 1rem; }
      .movie-main { flex-direction: column; }
      .movie-poster { width: 140px; }
      .movie-title { font-size: 1.5rem; }
      .movie-hero img { height: 200px; }
    }
  </style>
</head>
<body>
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-T3BJFZSV" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>

<header>
  <a href="/" class="site-brand">
    <svg class="brand-icon" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="22" cy="22" r="20"   stroke="#2a2a2a" stroke-width="1.2"/>
      <circle cx="22" cy="22" r="13.5" stroke="#2a2a2a" stroke-width="1.2"/>
      <circle cx="22" cy="22" r="7"    stroke="#2a2a2a" stroke-width="1.2"/>
      <line x1="22" y1="2"  x2="22" y2="42" stroke="#1e1e1e" stroke-width="1"/>
      <line x1="2"  y1="22" x2="42" y2="22" stroke="#1e1e1e" stroke-width="1"/>
      <g class="sweep-group">
        <line x1="22" y1="22" x2="42" y2="22" stroke="#e94560" stroke-width="1.8" stroke-linecap="round" opacity="0.9"/>
        <circle cx="36" cy="22" r="2" fill="#e94560" opacity="0.85"/>
      </g>
      <circle cx="22" cy="22" r="2.5" fill="#e94560"/>
    </svg>
    <span class="brand-name">Movie Release <span>Radar</span></span>
  </a>
</header>

<main class="movie-page">
  <a href="/" class="back-link" id="back-link">&#8592; Back to calendar</a>
  <script>
    (function(){
      try {
        var s = sessionStorage.getItem('calendarMonth');
        if (s) {
          var parts = s.split('-').map(Number);
          if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            document.getElementById('back-link').href = '/?m=' + s;
          }
        }
      } catch(e) {}
    })();
  </script>

  ${backdrop ? `<div class="movie-hero"><img src="${backdrop}" alt="${title} backdrop" /></div>` : ''}

  <div class="movie-main">
    <div class="movie-poster">
      ${poster
        ? `<img src="${poster}" alt="${title} poster" />`
        : `<div class="movie-poster-placeholder">${title}</div>`}
    </div>
    <div class="movie-info">
      <h1 class="movie-title">${title}</h1>
      <div class="movie-meta">
        <span>&#128197; ${releaseDate}</span>
        ${rating  ? `<span>${rating}</span>`                                         : ''}
        ${runtime ? `<span>&#128336; ${runtime}</span>`                              : ''}
        ${movie.original_language ? `<span>&#127758; ${escHtml(movie.original_language.toUpperCase())}</span>` : ''}
      </div>
      ${genreTagsHtml ? `<div class="movie-genres">${genreTagsHtml}</div>` : ''}
      <div class="movie-crew">
        ${directors ? `<span>&#127916; Directed by <strong>${directors}</strong></span>` : ''}
        ${cast      ? `<span>&#127775; ${cast}</span>`                                   : ''}
      </div>
      <p class="movie-overview">${overview}</p>
    </div>
  </div>

  ${releasesHtml ? `
  <section class="releases-section">
    <div class="section-heading">Release Dates by Country</div>
    <div class="releases-grid">${releasesHtml}</div>
  </section>` : ''}
</main>

<footer>
  <div class="footer-inner">
    <div class="footer-brand">&#127916; Movie Release Radar</div>
    <div class="footer-attr">
      Created by <a href="https://serhiiomelchenko.com/" target="_blank" rel="noopener">Serhii Omelchenko</a>
      &nbsp;&middot;&nbsp;
      Data by <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a> &mdash; not endorsed or certified by TMDB.
    </div>
  </div>
</footer>
</body>
</html>`;
}

function generatePages(movies, manifest) {
  fs.mkdirSync(MOVIE_DIR, { recursive: true });

  // Build set of current active slugs
  const activeSlugs = new Set(movies.map(m => m.slug));

  // Write a page for every movie in the current window
  let written = 0;
  for (const movie of movies) {
    const dir = path.join(MOVIE_DIR, movie.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), buildMoviePage(movie));
    written++;
  }
  console.log(`Movie pages written: ${written}`);

  // Write redirect stubs for any previousSlugs whose target is still active
  let redirects = 0;
  for (const [, entry] of Object.entries(manifest)) {
    if (!activeSlugs.has(entry.slug)) continue; // target page not in current window
    for (const oldSlug of (entry.previousSlugs || [])) {
      const redirectDir = path.join(MOVIE_DIR, oldSlug);
      if (fs.existsSync(path.join(redirectDir, 'index.html'))) continue; // already exists
      fs.mkdirSync(redirectDir, { recursive: true });
      fs.writeFileSync(
        path.join(redirectDir, 'index.html'),
        `<!DOCTYPE html><html><head><meta charset="UTF-8" />`+
        `<link rel="canonical" href="${SITE_BASE}/movie/${entry.slug}/" />`+
        `<meta http-equiv="refresh" content="0;url=/movie/${entry.slug}/" />`+
        `<title>Redirecting...</title></head>`+
        `<body><a href="/movie/${entry.slug}/">Click here if not redirected.</a></body></html>`
      );
      redirects++;
    }
  }
  if (redirects > 0) console.log(`Redirect stubs written: ${redirects}`);
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

  // Generate static pages
  generatePages(detailedMovies, manifest);
}

main().catch(err => { console.error(err); process.exit(1); });
