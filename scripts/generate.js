'use strict';

const fs   = require('fs');
const path = require('path');

const API_KEY  = process.env.TMDB_API_KEY || '75c5a1d45830643e055bd8265fffb3b5';
const BASE_URL = 'https://api.themoviedb.org/3';

const DATA_DIR      = path.join(__dirname, '..', 'data');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
const MOVIES_PATH   = path.join(DATA_DIR, 'movies.json');
const MOVIE_DIR     = path.join(__dirname, '..', 'movie');
const CALENDAR_DIR  = path.join(DATA_DIR, 'calendar');
const TOP_MOVIES_DIR = path.join(__dirname, '..', 'top-movies');

// First month tracked by the Top Movies series
const TOP_MOVIES_START = '2026-02';

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

// Rate limiter: max 40 requests per 10 seconds (sliding window)
const rateLimiter = (() => {
  const times = [];
  return {
    async throttle() {
      const now = Date.now();
      while (times.length && now - times[0] >= 10000) times.shift();
      if (times.length >= 40) {
        const wait = 10000 - (now - times[0]) + 10;
        await sleep(wait);
        return this.throttle();
      }
      times.push(Date.now());
    },
  };
})();

async function fetchJSON(url, attempt = 0) {
  try {
    await rateLimiter.throttle();
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

async function fetchAllMoviesGlobal(fromDate, toDate) {
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

async function fetchMoviesForRegion(region, fromDate, toDate) {
  const base = `${BASE_URL}/discover/movie?api_key=${API_KEY}&language=en-US` +
    `&primary_release_date.gte=${fromDate}&primary_release_date.lte=${toDate}` +
    `&region=${region}&sort_by=popularity.desc`;

  const first = await fetchJSON(`${base}&page=1`);
  const totalPages = Math.min(first.total_pages || 1, 20);

  if (totalPages === 20 && (first.total_results || 0) >= 400) {
    console.warn(`\n  WARNING: ${region} ${fromDate.slice(0, 7)} may have hit the 500-movie cap`);
  }

  const movies = [...(first.results || [])];

  for (let i = 2; i <= totalPages; i += 5) {
    const batch = [];
    for (let p = i; p <= Math.min(i + 4, totalPages); p++) batch.push(p);
    const pages = await Promise.all(batch.map(p => fetchJSON(`${base}&page=${p}`)));
    pages.forEach(r => movies.push(...(r.results || [])));
  }

  return movies.filter(m => m.release_date);
}

async function fetchMovieDetails(id) {
  const [details, credits, videos] = await Promise.all([
    fetchJSON(`${BASE_URL}/movie/${id}?api_key=${API_KEY}&language=en-US`),
    fetchJSON(`${BASE_URL}/movie/${id}/credits?api_key=${API_KEY}&language=en-US`),
    fetchJSON(`${BASE_URL}/movie/${id}/videos?api_key=${API_KEY}&language=en-US`),
  ]);

  const trailerVideo = (videos.results || []).find(
    v => v.site === 'YouTube' && v.type === 'Trailer' && v.official
  ) || (videos.results || []).find(
    v => v.site === 'YouTube' && v.type === 'Trailer'
  ) || (videos.results || []).find(
    v => v.site === 'YouTube' && v.type === 'Teaser'
  ) || null;

  const trailerKey         = trailerVideo?.key         || null;
  const trailerName        = trailerVideo?.name        || null;
  const trailerPublishedAt = trailerVideo?.published_at || null;

  const directors = (credits.crew || [])
    .filter(c => c.job === 'Director')
    .map(c => c.name);

  const cast = (credits.cast || []).slice(0, 5).map(c => c.name);

  return {
    id:                details.id,
    title:             details.title,
    overview:          details.overview,
    release_date:      details.release_date,
    poster_path:       details.poster_path,
    backdrop_path:     details.backdrop_path,
    vote_average:      details.vote_average,
    vote_count:        details.vote_count,
    popularity:        details.popularity,
    original_language: details.original_language,
    runtime:           details.runtime,
    genres:            (details.genres || []).map(g => g.name),
    genre_ids:         (details.genres || []).map(g => g.id),
    directors,
    cast,
    trailerKey,
    trailerName,
    trailerPublishedAt,
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
      manifest[id].certification = movie.certification || null;
    } else {
      // New movie — pick a collision-free slug
      // Fall back to TMDB id when title produces an empty slug (e.g. CJK-only titles)
      let slug = baseSlug || `movie-${id}`;
      if (slugToId[slug]) slug = `${slug}-${year}`;
      if (slugToId[slug] && slugToId[slug] !== id) slug = `${baseSlug || 'movie'}-${id}`;

      manifest[id] = { title: movie.title, slug, previousSlugs: [], certification: movie.certification || null };
      slugToId[slug] = id;
    }

    movie.slug = manifest[id].slug;
  }

  return manifest;
}

// ── Static page generation ────────────────────────────────────────────────────

const IMG_BASE = 'https://image.tmdb.org/t/p/';
const SITE_BASE = 'https://moviereleaseradar.com';

// Countries shown in the UI region selector — calendar files are generated for these + WW
const SUPPORTED_COUNTRIES = [
  'AU','AT','BE','BR','BG','CA','CN','HR','CY','CZ','DK','EE','FI','FR',
  'DE','GR','HU','IN','IE','IT','JP','LV','LT','LU','MT','NL','PL','PT',
  'RO','SK','SI','KR','ES','SE','GB','UA','US',
];

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

// Fingerprint of fields that affect the generated movie page.
// dataUpdatedAt is only bumped when this changes between runs.
function movieFingerprint(m) {
  return [
    m.title, m.overview, m.release_date, m.poster_path, m.backdrop_path,
    m.vote_average, m.vote_count, m.runtime, m.trailerKey,
    JSON.stringify(m.genres), JSON.stringify(m.directors), JSON.stringify(m.cast),
  ].join('\0');
}

function buildSchema(movie, canonicalUrl) {
  const year = (movie.release_date || '').slice(0, 4);

  const movieSchema = {
    '@type': 'Movie',
    name: movie.title,
    url: canonicalUrl,
  };
  if (movie.overview)        movieSchema.description   = movie.overview;
  if (movie.release_date)    movieSchema.datePublished = movie.release_date;
  if (movie.poster_path)     movieSchema.image         = `${IMG_BASE}w500${movie.poster_path}`;
  if (movie.genres?.length)  movieSchema.genre         = movie.genres;
  if (movie.runtime)         movieSchema.duration      = `PT${Math.floor(movie.runtime / 60)}H${movie.runtime % 60}M`;
  if (movie.directors?.length) {
    movieSchema.director = movie.directors.map(n => ({ '@type': 'Person', name: n }));
  }
  if (movie.cast?.length) {
    movieSchema.actor = movie.cast.map(n => ({ '@type': 'Person', name: n }));
  }
  if (movie.vote_count > 0 && movie.vote_average >= 1) {
    movieSchema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: movie.vote_average.toFixed(1),
      ratingCount: movie.vote_count,
      bestRating: 10,
      worstRating: 1,
    };
  }

  const breadcrumbSchema = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_BASE}/` },
      { '@type': 'ListItem', position: 2, name: `${movie.title}${year ? ` (${year})` : ''}`, item: canonicalUrl },
    ],
  };

  const graph = [movieSchema, breadcrumbSchema];

  if (movie.trailerKey) {
    const videoSchema = {
      '@type':        'VideoObject',
      name:           `${movie.title} – Official Trailer`,
      description:    movie.overview || movie.title,
      thumbnailUrl:   `https://img.youtube.com/vi/${movie.trailerKey}/maxresdefault.jpg`,
      embedUrl:       `https://www.youtube.com/embed/${movie.trailerKey}`,
      url:            `https://www.youtube.com/watch?v=${movie.trailerKey}`,
    };
    if (movie.trailerPublishedAt) {
      videoSchema.uploadDate = new Date(movie.trailerPublishedAt).toISOString();
    }
    graph.push(videoSchema);
  }

  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph });
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

  const rating = movie.vote_count > 0 && movie.vote_average >= 1
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
  <link rel="icon" href="/favicon.ico" sizes="96x96" />
  <link rel="icon" type="image/png" href="/favicon.png" sizes="96x96" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="apple-touch-icon" href="/favicon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta property="og:type"        content="website" />
  <meta property="og:url"         content="${canonicalUrl}" />
  <meta property="og:title"       content="${title}${year ? ` (${year})` : ''}" />
  <meta property="og:description" content="${metaDesc}" />
  ${ogImage ? `<meta property="og:image" content="${escHtml(ogImage)}" />` : ''}
  <script type="application/ld+json">${buildSchema(movie, canonicalUrl)}</script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0d0d0d; color: #e0e0e0; min-height: 100vh; }

    header { background: #0d0d0d; padding: 1.4rem 2rem; border-bottom: 1px solid #1e1e1e; }
    .header-inner { max-width: 1300px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; }
    .site-brand { display: flex; align-items: center; gap: 0.85rem; text-decoration: none; }
    .brand-icon { width: 38px; height: 38px; flex-shrink: 0; }
    .brand-icon .sweep-group { transform-origin: 22px 22px; animation: radar-spin 3s linear infinite; }
    @keyframes radar-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .brand-name { font-size: 1.45rem; font-weight: 800; color: #fff; letter-spacing: 0.1em; text-transform: uppercase; }
    .brand-name span { color: #e94560; }
    .header-nav { display: flex; align-items: center; gap: 1.5rem; }
    .nav-link { color: #666; text-decoration: none; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; transition: color 0.15s; }
    .nav-link:hover { color: #fff; }
    .nav-link.active { color: #fff; }

    .movie-page { max-width: 960px; margin: 0 auto; padding: 2rem; }
    .back-link { display: inline-flex; align-items: center; gap: 0.4rem; color: #e94560; text-decoration: none; font-size: 0.875rem; margin-bottom: 1.5rem; }
    .back-link:hover { text-decoration: underline; }

    .movie-hero { border-radius: 16px; overflow: hidden; margin-bottom: 2rem; background: #111; }
    .movie-hero img { width: 100%; height: 320px; object-fit: cover; object-position: center top; display: block; }

    .movie-main { display: flex; gap: 2rem; align-items: flex-start; }
    .movie-poster { flex-shrink: 0; width: 200px; }
    .movie-poster img { width: 100%; border-radius: 14px; display: block; box-shadow: 0 10px 40px rgba(0,0,0,0.7); }
    .movie-poster-placeholder { width: 100%; aspect-ratio: 2/3; background: #1e1e1e; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 0.85rem; color: #555; text-align: center; padding: 1rem; line-height: 1.4; }

    .movie-info { flex: 1; min-width: 0; }
    .movie-title { font-size: 2rem; font-weight: 800; color: #fff; line-height: 1.2; margin-bottom: 1rem; }

    .info-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 0.65rem; margin-bottom: 1.25rem; }
    .tile { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 0.85rem 0.9rem; display: flex; flex-direction: column; gap: 0.3rem; }
    .tile-label { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #555; }
    .tile-value { font-size: 1rem; font-weight: 600; color: #f0f0f0; line-height: 1.25; }
    .tile-sub { font-size: 0.72rem; color: #555; font-weight: 400; }
    .tile-rating .tile-value { color: #f5c518; }
    .tile-cert .tile-value { display: inline-flex; align-items: center; justify-content: center; border: 1.5px solid #555; border-radius: 5px; padding: 0.1rem 0.45rem; font-size: 0.82rem; letter-spacing: 0.04em; color: #ccc; width: fit-content; }

    .movie-genres { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
    .genre-tag { background: rgba(15,52,96,0.8); color: #90caf9; border: 1px solid rgba(144,202,249,0.12); border-radius: 20px; padding: 0.28rem 0.8rem; font-size: 0.78rem; font-weight: 500; }
    .movie-crew { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.875rem; color: #aaa; margin-bottom: 1rem; }
    .movie-crew strong { color: #ddd; }
    .movie-overview { font-size: 0.975rem; color: #bbb; line-height: 1.75; }

    .wl-btn { display: inline-flex; align-items: center; gap: 0.5rem; margin-top: 1.25rem; padding: 0.6rem 1.3rem; background: transparent; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; color: #aaa; font-size: 0.88rem; cursor: pointer; transition: background 0.15s, border-color 0.15s, color 0.15s; }
    .wl-btn:hover { border-color: #e94560; color: #e94560; background: rgba(233,69,96,0.07); }
    .wl-btn.wl-active { background: #e94560; border-color: #e94560; color: #fff; }

    .trailer-section { margin-top: 2.5rem; }
    .trailer-wrap { position: relative; width: 100%; aspect-ratio: 16/9; border-radius: 14px; overflow: hidden; background: #111; }
    .trailer-wrap iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
    .releases-section { margin-top: 2.5rem; }
    .section-heading { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #555; margin-bottom: 0.9rem; padding-bottom: 0.5rem; border-bottom: 1px solid #1e1e1e; }
    .releases-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.65rem; }
    .release-item { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 13px; padding: 0.85rem 1rem; display: flex; flex-direction: column; gap: 0.25rem; }
    .release-country { color: #e0e0e0; font-weight: 600; font-size: 0.85rem; }
    .release-date { color: #666; font-size: 0.78rem; font-weight: 500; }

    footer { border-top: 1px solid #1e1e1e; margin-top: 3rem; padding: 1.4rem 2rem; }
    .footer-inner { max-width: 1300px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .footer-brand { font-size: 0.78rem; font-weight: 700; color: #333; letter-spacing: 0.1em; text-transform: uppercase; }
    .footer-attr { font-size: 0.75rem; color: #888; }
    footer a { color: #e94560; text-decoration: none; }
    footer a:hover { text-decoration: underline; }

    @media (max-width: 640px) {
      .movie-page { padding: 1rem; }
      .movie-main { flex-direction: column; }
      .movie-poster { width: 140px; }
      .movie-title { font-size: 1.5rem; }
      .movie-hero img { height: 200px; }
      .info-tiles { grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 0.5rem; }
    }
  </style>
</head>
<body>
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-T3BJFZSV" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>

<header>
  <div class="header-inner">
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
    <nav class="header-nav">
      <a href="/" class="nav-link">Calendar</a>
      <a href="/top-movies/" class="nav-link">Top Movies</a>
    </nav>
  </div>
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
      <div class="info-tiles">
        ${movie.release_date ? `<div class="tile"><div class="tile-label">Release Date</div><div class="tile-value">${releaseDate}</div></div>` : ''}
        ${movie.vote_count > 0 && movie.vote_average >= 1 ? `<div class="tile tile-rating"><div class="tile-label">Score</div><div class="tile-value">${movie.vote_average.toFixed(1)} <span class="tile-sub">/ 10</span></div></div>` : ''}
        ${runtime ? `<div class="tile"><div class="tile-label">Length</div><div class="tile-value">${runtime}</div></div>` : ''}
        ${movie.original_language ? `<div class="tile"><div class="tile-label">Language</div><div class="tile-value">${escHtml(movie.original_language.toUpperCase())}</div></div>` : ''}
        ${movie.certification ? `<div class="tile tile-cert"><div class="tile-label">US Rating</div><div class="tile-value">${escHtml(movie.certification)}</div></div>` : ''}
      </div>
      ${genreTagsHtml ? `<div class="movie-genres">${genreTagsHtml}</div>` : ''}
      <div class="movie-crew">
        ${directors ? `<span>&#127916; Directed by <strong>${directors}</strong></span>` : ''}
        ${cast      ? `<span>&#127775; ${cast}</span>`                                   : ''}
      </div>
      <p class="movie-overview">${overview}</p>
      <button class="wl-btn" id="wl-btn" data-id="${movie.id}">&#9825; Add to Watchlist</button>
    </div>
  </div>
  <script>
    (function(){
      var btn = document.getElementById('wl-btn');
      var id = ${movie.id};
      var KEY = 'watchlist';
      function getWl(){ try{ return JSON.parse(localStorage.getItem(KEY)||'[]'); }catch(e){ return []; } }
      function setWl(a){ try{ localStorage.setItem(KEY, JSON.stringify(a)); }catch(e){} }
      function render(){
        var inWl = getWl().indexOf(id) !== -1;
        btn.innerHTML = inWl ? '&#9829; In Watchlist' : '&#9825; Add to Watchlist';
        btn.classList.toggle('wl-active', inWl);
      }
      btn.addEventListener('click', function(){
        var wl = getWl();
        var idx = wl.indexOf(id);
        if(idx === -1){ wl.push(id); } else { wl.splice(idx,1); }
        setWl(wl);
        render();
      });
      render();
    })();
  </script>

  ${movie.trailerKey ? `
  <section class="trailer-section">
    <div class="section-heading">Trailer</div>
    <div class="trailer-wrap">
      <iframe src="https://www.youtube.com/embed/${movie.trailerKey}?rel=0" allowfullscreen loading="lazy" title="${title} trailer"></iframe>
    </div>
  </section>` : ''}

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
      This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.&nbsp;<a href="https://www.themoviedb.org/" target="_blank" rel="noopener"><img src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg" alt="The Movie Database (TMDB)" style="height:1.2rem;vertical-align:middle;" /></a>
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

// ── Top Movies pages ──────────────────────────────────────────────────────────

const RADAR_SVG = `<svg class="brand-icon" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
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
    </svg>`;

const GTM_CONSENT_JS = `window.dataLayer = window.dataLayer || [];
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

const GTM_TAG = `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-T3BJFZSV');<\/script>`;

const TOP_SHARED_CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0d0d0d; color: #e0e0e0; min-height: 100vh; }
    header { background: #0d0d0d; padding: 1.4rem 2rem; border-bottom: 1px solid #1e1e1e; }
    .header-inner { max-width: 1300px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; }
    .site-brand { display: flex; align-items: center; gap: 0.85rem; text-decoration: none; }
    .brand-icon { width: 38px; height: 38px; flex-shrink: 0; }
    .brand-icon .sweep-group { transform-origin: 22px 22px; animation: radar-spin 3s linear infinite; }
    @keyframes radar-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .brand-name { font-size: 1.45rem; font-weight: 800; color: #fff; letter-spacing: 0.1em; text-transform: uppercase; }
    .brand-name span { color: #e94560; }
    .header-nav { display: flex; align-items: center; gap: 1.5rem; }
    .nav-link { color: #666; text-decoration: none; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; transition: color 0.15s; }
    .nav-link:hover { color: #fff; }
    .nav-link.active { color: #fff; }
    .back-link { display: inline-flex; align-items: center; gap: 0.4rem; color: #e94560; text-decoration: none; font-size: 0.875rem; margin-bottom: 1.5rem; }
    .back-link:hover { text-decoration: underline; }
    .genre-tag { background: rgba(15,52,96,0.8); color: #90caf9; border: 1px solid rgba(144,202,249,0.12); border-radius: 20px; padding: 0.28rem 0.8rem; font-size: 0.78rem; font-weight: 500; }
    footer { border-top: 1px solid #1e1e1e; margin-top: 3rem; padding: 1.4rem 2rem; }
    .footer-inner { max-width: 1300px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .footer-brand { font-size: 0.78rem; font-weight: 700; color: #333; letter-spacing: 0.1em; text-transform: uppercase; }
    .footer-attr { font-size: 0.75rem; color: #888; }
    footer a { color: #e94560; text-decoration: none; }
    footer a:hover { text-decoration: underline; }
    @media (max-width: 600px) {
      header { padding: 1rem; }
      .header-inner { flex-direction: column; align-items: flex-start; gap: 0.75rem; }
    }`;

const TOP_PAGE_HEADER = `
<header>
  <div class="header-inner">
    <a href="/" class="site-brand">
      ${RADAR_SVG}
      <span class="brand-name">Movie Release <span>Radar</span></span>
    </a>
    <nav class="header-nav">
      <a href="/" class="nav-link">Calendar</a>
      <a href="/top-movies/" class="nav-link active">Top Movies</a>
    </nav>
  </div>
</header>`;

const TOP_PAGE_FOOTER = `
<footer>
  <div class="footer-inner">
    <div class="footer-brand">&#127916; Movie Release Radar</div>
    <div class="footer-attr">
      Created by <a href="https://serhiiomelchenko.com/" target="_blank" rel="noopener">Serhii Omelchenko</a>
      &nbsp;&middot;&nbsp;
      This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.&nbsp;<a href="https://www.themoviedb.org/" target="_blank" rel="noopener"><img src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg" alt="The Movie Database (TMDB)" style="height:1.2rem;vertical-align:middle;" /></a>
    </div>
  </div>
</footer>`;

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function addMonths(ym, n) {
  const pad = x => String(x).padStart(2, '0');
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function buildTopMoviesPage(ym, topMovies) {
  const label        = monthLabel(ym);
  const canonicalUrl = `${SITE_BASE}/top-movies/${ym}/`;
  const pageTitle    = `Top 10 Movies in ${label}`;
  const today        = new Date().toISOString().slice(0, 10);
  const previewTitles = topMovies.slice(0, 3).map(m => m.title).join(', ');
  const metaDesc = escHtml(
    `The 10 most anticipated movies releasing in ${label}: ${previewTitles}` +
    (topMovies.length > 3 ? ', and more.' : '.')
  );
  const ogImage = topMovies[0]?.poster_path ? escHtml(`${IMG_BASE}w500${topMovies[0].poster_path}`) : '';

  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ItemList',
        name: pageTitle,
        url: canonicalUrl,
        numberOfItems: topMovies.length,
        itemListElement: topMovies.map((m, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'Movie',
            name: m.title,
            url: `${SITE_BASE}/movie/${m.slug}/`,
            ...(m.poster_path  ? { image: `${IMG_BASE}w500${m.poster_path}` } : {}),
            ...(m.release_date ? { datePublished: m.release_date }            : {}),
            ...(m.genres?.length ? { genre: m.genres }                        : {}),
          },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home',                 item: `${SITE_BASE}/`            },
          { '@type': 'ListItem', position: 2, name: 'Top Movies by Month',  item: `${SITE_BASE}/top-movies/` },
          { '@type': 'ListItem', position: 3, name: pageTitle,              item: canonicalUrl               },
        ],
      },
    ],
  });

  const moviesHtml = topMovies.map((m, i) => {
    const poster    = m.poster_path ? `${IMG_BASE}w342${m.poster_path}` : '';
    const t         = escHtml(m.title);
    const overview  = escHtml((m.overview || '').slice(0, 200));
    const truncated = (m.overview || '').length > 200;
    const genresHtml = (m.genres || []).map(g => `<span class="genre-tag">${escHtml(g)}</span>`).join('');
    const directors  = (m.directors || []).map(d => escHtml(d)).join(', ');
    const relDate    = m.release_date
      ? new Date(m.release_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : 'TBA';
    const ratingHtml = m.vote_count > 0 && m.vote_average >= 1
      ? `<span class="score">&#9733; ${m.vote_average.toFixed(1)}<span class="score-denom">&thinsp;/ 10</span></span>`
      : '';
    return `
    <article class="top-item">
      <div class="rank">${i + 1}</div>
      <div class="poster-wrap">
        ${poster
          ? `<a href="/movie/${m.slug}/"><img src="${poster}" alt="${t} poster" loading="lazy" width="100" height="150" /></a>`
          : `<div class="poster-placeholder"><span>${t}</span></div>`}
      </div>
      <div class="movie-info">
        <h2><a href="/movie/${m.slug}/">${t}</a></h2>
        <div class="meta-row">
          <span class="rel-date">&#128197; ${escHtml(relDate)}</span>
          ${ratingHtml}
        </div>
        ${genresHtml ? `<div class="genres">${genresHtml}</div>` : ''}
        ${directors  ? `<div class="crew">&#127916; <strong>${directors}</strong></div>` : ''}
        ${overview   ? `<p class="overview">${overview}${truncated ? '&hellip;' : ''}</p>` : ''}
      </div>
    </article>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <script>${GTM_CONSENT_JS}</script>
  ${GTM_TAG}
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(pageTitle)} | Movie Release Radar</title>
  <meta name="description" content="${metaDesc}" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="${canonicalUrl}" />
  <link rel="icon" href="/favicon.ico" sizes="96x96" />
  <link rel="icon" type="image/png" href="/favicon.png" sizes="96x96" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="apple-touch-icon" href="/favicon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta property="og:type"        content="website" />
  <meta property="og:url"         content="${canonicalUrl}" />
  <meta property="og:title"       content="${escHtml(pageTitle)}" />
  <meta property="og:description" content="${metaDesc}" />
  ${ogImage ? `<meta property="og:image" content="${ogImage}" />` : ''}
  <script type="application/ld+json">${schema}</script>
  <style>${TOP_SHARED_CSS}
    .top-page { max-width: 860px; margin: 0 auto; padding: 2rem; }
    .page-header { margin-bottom: 2rem; }
    .page-header h1 { font-size: 2rem; font-weight: 800; color: #fff; line-height: 1.2; }
    .page-header .subtitle { margin-top: 0.5rem; font-size: 0.85rem; color: #555; }
    .page-header .subtitle a { color: #e94560; text-decoration: none; }
    .page-header .subtitle a:hover { text-decoration: underline; }
    .top-list { display: flex; flex-direction: column; gap: 1.25rem; }
    .top-item { display: flex; gap: 1.25rem; align-items: flex-start; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; padding: 1.25rem; position: relative; transition: border-color 0.15s; }
    .top-item:hover { border-color: rgba(233,69,96,0.3); }
    .rank { position: absolute; top: -10px; left: -10px; width: 32px; height: 32px; background: #e94560; color: #fff; font-weight: 800; font-size: 0.9rem; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(233,69,96,0.5); }
    .top-item:first-child .rank { width: 36px; height: 36px; font-size: 1rem; top: -12px; left: -12px; }
    .poster-wrap { flex-shrink: 0; width: 100px; }
    .poster-wrap img { width: 100%; border-radius: 10px; display: block; box-shadow: 0 6px 24px rgba(0,0,0,0.6); }
    .poster-wrap a { display: block; }
    .poster-placeholder { width: 100%; aspect-ratio: 2/3; background: #1a1a1a; border-radius: 10px; display: flex; align-items: center; justify-content: center; padding: 0.5rem; }
    .poster-placeholder span { font-size: 0.7rem; color: #444; text-align: center; line-height: 1.3; }
    .movie-info { flex: 1; min-width: 0; }
    .movie-info h2 { font-size: 1.2rem; font-weight: 700; color: #fff; margin-bottom: 0.5rem; line-height: 1.3; }
    .movie-info h2 a { color: inherit; text-decoration: none; }
    .movie-info h2 a:hover { color: #e94560; }
    .meta-row { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; flex-wrap: wrap; }
    .rel-date { font-size: 0.8rem; color: #666; }
    .score { font-size: 0.88rem; font-weight: 600; color: #f5c518; }
    .score-denom { font-weight: 400; color: #555; }
    .genres { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.5rem; }
    .crew { font-size: 0.82rem; color: #888; margin-bottom: 0.5rem; }
    .crew strong { color: #bbb; }
    .overview { font-size: 0.875rem; color: #888; line-height: 1.65; }
    .updated-note { margin-top: 2rem; font-size: 0.78rem; color: #444; text-align: center; }
    @media (max-width: 600px) {
      .top-page { padding: 1rem; }
      .page-header h1 { font-size: 1.5rem; }
      .top-item { padding: 0.875rem; gap: 0.875rem; }
      .poster-wrap { width: 110px; }
      .movie-info h2 { font-size: 1rem; }
    }
  </style>
</head>
<body>
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-T3BJFZSV" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
${TOP_PAGE_HEADER}
<main class="top-page">
  <a href="/top-movies/" class="back-link">&#8592; Top Movies by Month</a>
  <div class="page-header">
    <h1>${escHtml(pageTitle)}</h1>
    <p class="subtitle">Ranked by TMDB popularity &middot; <a href="/?m=${ym}">View full ${label} calendar</a></p>
  </div>
  <div class="top-list">
    ${moviesHtml}
  </div>
  <p class="updated-note">Last updated: ${today} &middot; Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a></p>
</main>
${TOP_PAGE_FOOTER}
</body>
</html>`;
}

function buildTopMoviesIndexPage(allMonths, detailedMovies) {
  const canonicalUrl = `${SITE_BASE}/top-movies/`;
  const pageTitle    = 'Top Movies by Month';
  const metaDesc     = escHtml('Browse the top 10 most anticipated movies for each month, ranked by popularity. Updated daily.');
  const today        = new Date().toISOString().slice(0, 10);

  const moviesByMonth = {};
  for (const m of detailedMovies) {
    if (!m.release_date || !m.slug) continue;
    const ym = m.release_date.slice(0, 7);
    if (!moviesByMonth[ym]) moviesByMonth[ym] = [];
    moviesByMonth[ym].push(m);
  }

  const cardsHtml = [...allMonths].reverse().map(ym => {
    const label    = monthLabel(ym);
    const topThree = (moviesByMonth[ym] || [])
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
      .slice(0, 3);
    const thumbsHtml = topThree
      .filter(m => m.poster_path)
      .map(m => `<img src="${escHtml(`${IMG_BASE}w154${m.poster_path}`)}" alt="${escHtml(m.title)} poster" loading="lazy" width="60" height="90" />`)
      .join('');
    return `
    <a href="/top-movies/${ym}/" class="month-card">
      <div class="month-name">${escHtml(label)}</div>
      ${thumbsHtml ? `<div class="month-thumbs">${thumbsHtml}</div>` : ''}
      <div class="view-label">View Top 10 &#8594;</div>
    </a>`;
  }).join('\n');

  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ItemList',
        name: pageTitle,
        url: canonicalUrl,
        description: 'Monthly top 10 movie rankings by popularity.',
        itemListElement: allMonths.map((ym, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: `Top 10 Movies in ${monthLabel(ym)}`,
          url: `${SITE_BASE}/top-movies/${ym}/`,
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home',                item: `${SITE_BASE}/`            },
          { '@type': 'ListItem', position: 2, name: 'Top Movies by Month', item: canonicalUrl               },
        ],
      },
    ],
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <script>${GTM_CONSENT_JS}</script>
  ${GTM_TAG}
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(pageTitle)} | Movie Release Radar</title>
  <meta name="description" content="${metaDesc}" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="${canonicalUrl}" />
  <link rel="icon" href="/favicon.ico" sizes="96x96" />
  <link rel="icon" type="image/png" href="/favicon.png" sizes="96x96" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="apple-touch-icon" href="/favicon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta property="og:type"        content="website" />
  <meta property="og:url"         content="${canonicalUrl}" />
  <meta property="og:title"       content="${escHtml(pageTitle)}" />
  <meta property="og:description" content="${metaDesc}" />
  <script type="application/ld+json">${schema}</script>
  <style>${TOP_SHARED_CSS}
    .index-page { max-width: 960px; margin: 0 auto; padding: 2rem; }
    .page-header { margin-bottom: 2.5rem; text-align: center; }
    .page-header h1 { font-size: 2.2rem; font-weight: 800; color: #fff; }
    .page-header p { margin-top: 0.6rem; font-size: 0.9rem; color: #666; }
    .months-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
    .month-card { display: flex; flex-direction: column; gap: 0.75rem; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; padding: 1.25rem 1rem; text-decoration: none; color: inherit; transition: border-color 0.15s, background 0.15s; }
    .month-card:hover { border-color: rgba(233,69,96,0.4); background: rgba(233,69,96,0.05); }
    .month-name { font-size: 1.05rem; font-weight: 700; color: #fff; }
    .month-thumbs { display: flex; gap: 0.35rem; }
    .month-thumbs img { width: 54px; height: 81px; object-fit: cover; border-radius: 6px; }
    .view-label { font-size: 0.8rem; color: #e94560; font-weight: 600; }
    .updated-note { margin-top: 2.5rem; font-size: 0.78rem; color: #444; text-align: center; }
    .updated-note a { color: #e94560; }
    @media (max-width: 600px) {
      .index-page { padding: 1rem; }
      .page-header h1 { font-size: 1.6rem; }
      .months-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
    }
  </style>
</head>
<body>
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-T3BJFZSV" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
${TOP_PAGE_HEADER}
<main class="index-page">
  <div class="page-header">
    <h1>${escHtml(pageTitle)}</h1>
    <p>The most anticipated movies for each month, ranked by popularity. Updated daily.</p>
  </div>
  <div class="months-grid">
    ${cardsHtml}
  </div>
  <p class="updated-note">Last updated: ${today} &middot; Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a></p>
</main>
${TOP_PAGE_FOOTER}
</body>
</html>`;
}

function generateTopMoviesPages(detailedMovies) {
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const nextYm    = addMonths(currentYm, 1);

  const allMonths = [];
  let cursor = TOP_MOVIES_START;
  while (cursor <= nextYm) {
    allMonths.push(cursor);
    cursor = addMonths(cursor, 1);
  }

  fs.mkdirSync(TOP_MOVIES_DIR, { recursive: true });

  let written = 0, skipped = 0;
  for (const ym of allMonths) {
    const outPath = path.join(TOP_MOVIES_DIR, ym, 'index.html');
    // Past months: generate once, then freeze
    if (ym < currentYm && fs.existsSync(outPath)) { skipped++; continue; }

    const topMovies = detailedMovies
      .filter(m => m.release_date && m.release_date.startsWith(ym) && m.slug)
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
      .slice(0, 10);

    if (topMovies.length === 0) continue;
    fs.mkdirSync(path.join(TOP_MOVIES_DIR, ym), { recursive: true });
    fs.writeFileSync(outPath, buildTopMoviesPage(ym, topMovies));
    written++;
  }

  fs.writeFileSync(path.join(TOP_MOVIES_DIR, 'index.html'), buildTopMoviesIndexPage(allMonths, detailedMovies));
  console.log(`Top movies pages: ${written} written, ${skipped} past-month(s) frozen`);
  return allMonths;
}

// ── Sitemap ───────────────────────────────────────────────────────────────────

function generateSitemap(movies, topMonths = []) {
  const today = new Date().toISOString().slice(0, 10);

  const movieUrls = movies.map(m => {
    const lastmod = m.dataUpdatedAt || today;
    return `  <url>\n    <loc>${SITE_BASE}/movie/${m.slug}/</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`;
  }).join('\n');

  const topIndexUrl = `  <url>\n    <loc>${SITE_BASE}/top-movies/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>`;

  const topMonthUrls = topMonths.map(ym =>
    `  <url>\n    <loc>${SITE_BASE}/top-movies/${ym}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.85</priority>\n  </url>`
  ).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_BASE}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
${movieUrls}
${topIndexUrl}
${topMonthUrls}
</urlset>`;

  fs.writeFileSync(path.join(__dirname, '..', 'sitemap.xml'), xml);
  const totalUrls = movies.length + 1 + 1 + topMonths.length;
  console.log(`sitemap.xml written (${totalUrls} URLs)`);
}

// ── Calendar file builder ─────────────────────────────────────────────────────

function buildCalendarFiles(calendarData, detailsMap) {
  let written = 0;
  for (const [ym, byCountry] of Object.entries(calendarData)) {
    const monthDir = path.join(CALENDAR_DIR, ym);
    fs.mkdirSync(monthDir, { recursive: true });

    for (const [country, rawMovies] of Object.entries(byCountry)) {
      const slim = rawMovies
        .filter(m => detailsMap[m.id])
        .map(m => {
          const d = detailsMap[m.id];
          return {
            id:                m.id,
            title:             d.title,
            release_date:      m.release_date,   // country-specific date from discover
            poster_path:       d.poster_path,
            backdrop_path:     d.backdrop_path,
            vote_average:      d.vote_average,
            vote_count:        d.vote_count,
            popularity:        d.popularity,
            genre_ids:         d.genre_ids,
            overview:          d.overview,
            original_language: d.original_language,
            directors:         d.directors,
            cast:              d.cast,
            slug:              d.slug,
          };
        })
        .sort((a, b) => a.release_date.localeCompare(b.release_date));

      // Atomic write: write to temp file then rename
      const outPath  = path.join(monthDir, `${country}.json`);
      const tmpPath  = `${outPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(slim));
      fs.renameSync(tmpPath, outPath);
      written++;
    }
  }
  console.log(`Calendar files written: ${written}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DATA_DIR,     { recursive: true });
  fs.mkdirSync(CALENDAR_DIR, { recursive: true });

  const manifest = loadJSON(MANIFEST_PATH, {});

  let detailedMovies;

  if (process.env.REGEN_ONLY === '1') {
    detailedMovies = loadJSON(MOVIES_PATH, []);
    const filterFrom = process.env.DATE_FROM || null;
    const filterTo   = process.env.DATE_TO   || null;
    if (filterFrom || filterTo) {
      const before = detailedMovies.length;
      detailedMovies = detailedMovies.filter(m => {
        const d = m.release_date || '';
        return (!filterFrom || d >= filterFrom) && (!filterTo || d <= filterTo);
      });
      console.log(`Filtered to ${detailedMovies.length} / ${before} movies (${filterFrom} → ${filterTo})`);
    }
    console.log(`Loaded ${detailedMovies.length} movies from existing data — skipping API fetch`);
    // Bootstrap dataUpdatedAt for any movie that doesn't have it yet
    const todayBoot = new Date().toISOString().slice(0, 10);
    for (const m of detailedMovies) { if (!m.dataUpdatedAt) m.dataUpdatedAt = todayBoot; }
  } else {
    // Build month range: 1 month back → 12 months forward
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');

    const months = [];
    for (let offset = -1; offset <= 12; offset++) {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      months.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
    }

    // calendarData[ym][country|'WW'] = array of raw discover results for that month+region
    // movieCountryReleases[id][country] = release_date string (country-specific)
    const calendarData          = {};
    const movieCountryReleases  = {};
    const allMovieIds           = new Set();

    // Fetch for each supported country + 'WW' (worldwide / All Regions)
    const fetchTargets = [...SUPPORTED_COUNTRIES, 'WW'];
    const totalFetches = fetchTargets.length * months.length;
    let   doneFetches  = 0;
    const monthsSet    = new Set(months);

    for (const country of fetchTargets) {
      for (const ym of months) {
        const [yr, mo] = ym.split('-').map(Number);
        const daysInMonth = new Date(yr, mo, 0).getDate();
        const fromDate    = `${ym}-01`;
        const toDate      = `${ym}-${pad(daysInMonth)}`;

        doneFetches++;
        process.stdout.write(`  [${doneFetches}/${totalFetches}] discover ${country} ${ym}\r`);

        const movies = country === 'WW'
          ? await fetchAllMoviesGlobal(fromDate, toDate)
          : await fetchMoviesForRegion(country, fromDate, toDate);

        for (const m of movies) {
          // File each movie under its actual release month (country-specific date from discover).
          // If that month isn't in our query window, fall back to the query month so the movie
          // isn't silently dropped.
          const movieYm = (m.release_date && monthsSet.has(m.release_date.slice(0, 7)))
            ? m.release_date.slice(0, 7)
            : ym;
          if (!calendarData[movieYm])          calendarData[movieYm] = {};
          if (!calendarData[movieYm][country]) calendarData[movieYm][country] = [];
          // Deduplicate: a movie can appear in multiple month queries (e.g. primary date in
          // March but country-specific date in April, so it shows up in both fetches).
          if (!calendarData[movieYm][country].some(x => x.id === m.id)) {
            calendarData[movieYm][country].push(m);
          }

          allMovieIds.add(m.id);
          if (country !== 'WW') {
            if (!movieCountryReleases[m.id]) movieCountryReleases[m.id] = {};
            movieCountryReleases[m.id][country] = m.release_date;
          }
        }
      }
    }

    console.log(`\nFound ${allMovieIds.size} unique movies — fetching details...`);

    // Fetch details for every unique movie (no /release_dates — dates come from discover)
    const movieIdArr = [...allMovieIds];
    const detailsMap = {};
    const BATCH = 10;

    for (let i = 0; i < movieIdArr.length; i += BATCH) {
      const batch = movieIdArr.slice(i, i + BATCH);
      process.stdout.write(`  details ${i + 1}–${Math.min(i + BATCH, movieIdArr.length)} / ${movieIdArr.length}\r`);

      const results = await Promise.allSettled(batch.map(id => fetchMovieDetails(id)));
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          const movie = r.value;
          movie.countryReleases = movieCountryReleases[movie.id] || {};
          detailsMap[movie.id] = movie;
        } else {
          console.error(`\n  Failed movie ${batch[idx]}: ${r.reason.message}`);
        }
      });

      if (i + BATCH < movieIdArr.length) await sleep(300);
    }

    console.log(`\nFetched details for ${Object.keys(detailsMap).length} movies`);

    detailedMovies = Object.values(detailsMap);

    // Stamp dataUpdatedAt — only advance when page-relevant data actually changed
    const today = new Date().toISOString().slice(0, 10);
    const existingMovieMap = {};
    for (const m of loadJSON(MOVIES_PATH, [])) existingMovieMap[m.id] = m;
    for (const movie of detailedMovies) {
      const prev = existingMovieMap[movie.id];
      if (!prev || movieFingerprint(movie) !== movieFingerprint(prev)) {
        movie.dataUpdatedAt = today;
      } else {
        movie.dataUpdatedAt = prev.dataUpdatedAt || today;
      }
    }

    // Assign slugs first so buildCalendarFiles can embed them
    assignSlugs(detailedMovies, manifest);

    // Write per-country per-month calendar JSON files
    buildCalendarFiles(calendarData, detailsMap);

    // Persist manifest and full movie data
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log('manifest.json saved');

    fs.writeFileSync(MOVIES_PATH, JSON.stringify(detailedMovies, null, 2));
    console.log(`movies.json saved (${detailedMovies.length} movies)`);
  }

  generatePages(detailedMovies, manifest);
  const allMovies = process.env.REGEN_ONLY === '1' ? loadJSON(MOVIES_PATH, []) : detailedMovies;
  const topMonths = generateTopMoviesPages(allMovies);
  generateSitemap(allMovies, topMonths);
}

main().catch(err => { console.error(err); process.exit(1); });
