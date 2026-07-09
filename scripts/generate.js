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
const HITS_PATH      = path.join(DATA_DIR, 'hits.json');
const PUBLIC_MANIFEST_PATH = path.join(DATA_DIR, 'manifest-public.json');
const DATE_HISTORY_PATH    = path.join(DATA_DIR, 'date-history.json');
const CALENDAR_PAGES_DIR   = path.join(__dirname, '..', 'calendar');
const RELEASES_DIR         = path.join(__dirname, '..', 'releases');
const INDEX_HTML_PATH      = path.join(__dirname, '..', 'index.html');

// First month tracked by the Top Movies series. The site keeps full history
// from this date forward — calendar data, hit pages, and top-movies landing
// pages are all preserved permanently for months >= this constant.
const TOP_MOVIES_START = '2026-01';
const HISTORY_START    = '2026-01';

// Hit-selection thresholds
const HIT_TOP_N_PER_COUNTRY = 15;
const HIT_RATING_MIN        = 7;
const HIT_VOTE_COUNT_MIN    = 50;

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
  const [details, credits, videos, releaseDates] = await Promise.all([
    fetchJSON(`${BASE_URL}/movie/${id}?api_key=${API_KEY}&language=en-US`),
    fetchJSON(`${BASE_URL}/movie/${id}/credits?api_key=${API_KEY}&language=en-US`),
    fetchJSON(`${BASE_URL}/movie/${id}/videos?api_key=${API_KEY}&language=en-US`),
    fetchJSON(`${BASE_URL}/movie/${id}/release_dates?api_key=${API_KEY}`).catch(() => ({ results: [] })),
  ]);

  // Earliest digital (streaming/VOD) release across all countries — TMDB
  // release type 4. Heavily searched ("when is X streaming") and not shown
  // by the discover endpoint the calendar dates come from.
  let digitalReleaseDate = null, digitalReleaseCountry = null;
  for (const entry of (releaseDates.results || [])) {
    for (const rd of (entry.release_dates || [])) {
      if (rd.type !== 4 || !rd.release_date) continue;
      const day = rd.release_date.slice(0, 10);
      if (!digitalReleaseDate || day < digitalReleaseDate) {
        digitalReleaseDate    = day;
        digitalReleaseCountry = entry.iso_3166_1 || null;
      }
    }
  }

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
    digitalReleaseDate,
    digitalReleaseCountry,
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

function countrySlug(cc) {
  return slugify(COUNTRY_NAMES[cc] || cc);
}

function fmtLong(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtShort(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Human list: ["A","B","C"] → "A, B and C"; long lists get "and N more countries".
function nameList(arr) {
  if (arr.length <= 3) return arr.join(', ').replace(/, ([^,]*)$/, ' and $1');
  return `${arr.slice(0, 3).join(', ')} and ${arr.length - 3} more countries`;
}

// Unique per-movie prose derived from the per-country release matrix — the
// dataset no other site surfaces for these titles.
function buildReleaseNarrative(movie, historyEntries) {
  const entries = Object.entries(movie.countryReleases || {})
    .filter(([cc]) => COUNTRY_NAMES[cc])
    .sort(([, a], [, b]) => a.localeCompare(b));
  const today = new Date().toISOString().slice(0, 10);
  const sentences = [];

  if (entries.length >= 2) {
    const first = entries[0][1];
    const last  = entries[entries.length - 1][1];
    const firstCountries = entries.filter(([, d]) => d === first).map(([cc]) => COUNTRY_NAMES[cc]);
    const lastCountries  = entries.filter(([, d]) => d === last).map(([cc]) => COUNTRY_NAMES[cc]);
    if (first === last) {
      sentences.push(`${movie.title} ${first < today ? 'opened' : 'opens'} simultaneously in ${entries.length} countries on ${fmtLong(first)}.`);
    } else {
      sentences.push(`${movie.title} ${first < today ? 'opened' : 'opens'} first in ${nameList(firstCountries)} on ${fmtLong(first)}.`);
      sentences.push(`The rollout ${last < today ? 'continued' : 'continues'} across ${entries.length} countries, finishing in ${nameList(lastCountries)} on ${fmtLong(last)}.`);
      const us = (movie.countryReleases || {}).US;
      if (us && us !== first) sentences.push(`In the United States, it ${us < today ? 'arrived' : 'arrives'} in theaters on ${fmtLong(us)}.`);
    }
  }
  if (movie.digitalReleaseDate) {
    sentences.push(`A digital release ${movie.digitalReleaseDate < today ? 'followed on' : 'is scheduled for'} ${fmtLong(movie.digitalReleaseDate)}.`);
  }
  const primaryChanges = (historyEntries || []).filter(h => h.scope === 'primary');
  if (primaryChanges.length) {
    const lastCh = primaryChanges[primaryChanges.length - 1];
    sentences.push(`The release date has changed ${primaryChanges.length === 1 ? 'once' : `${primaryChanges.length} times`} — most recently from ${fmtLong(lastCh.from)} to ${fmtLong(lastCh.to)}.`);
  }
  return sentences.map(escHtml).join(' ');
}

// FAQ entries answering the exact long-tail phrasings searchers use.
const FAQ_COUNTRY_PRIORITY = ['US', 'GB', 'IN', 'DE', 'AU', 'CA'];

function buildFaqData(movie) {
  const today = new Date().toISOString().slice(0, 10);
  const name  = movie.title;
  const faqs  = [];
  if (movie.release_date) {
    faqs.push({
      q: `When does ${name} come out?`,
      a: `${name} ${movie.release_date < today ? 'was released' : 'is scheduled for release'} on ${fmtLong(movie.release_date)}.`,
    });
  }
  let added = 0;
  for (const cc of FAQ_COUNTRY_PRIORITY) {
    const d = (movie.countryReleases || {})[cc];
    if (!d) continue;
    if (added >= 4) break;
    faqs.push({
      q: `When does ${name} come out in ${COUNTRY_NAMES[cc]}?`,
      a: `${name} ${d < today ? 'was released' : 'releases'} in ${COUNTRY_NAMES[cc]} on ${fmtLong(d)}.`,
    });
    added++;
  }
  if (movie.digitalReleaseDate) {
    faqs.push({
      q: `When will ${name} be available on streaming or digital?`,
      a: `${name} ${movie.digitalReleaseDate < today ? 'became' : 'is expected to become'} available on digital platforms on ${fmtLong(movie.digitalReleaseDate)}.`,
    });
  }
  if (movie.directors?.length) {
    faqs.push({ q: `Who directed ${name}?`, a: `${name} was directed by ${movie.directors.join(', ')}.` });
  }
  if (movie.runtime) {
    const h = Math.floor(movie.runtime / 60), min = movie.runtime % 60;
    faqs.push({ q: `How long is ${name}?`, a: `${name} has a runtime of ${h > 0 ? `${h}h ${min}m` : `${min} minutes`}.` });
  }
  return faqs;
}

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
    JSON.stringify(m.countryReleases || {}), m.digitalReleaseDate || '',
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

  const ym = (movie.release_date || '').slice(0, 7);
  const crumbs = [{ '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_BASE}/` }];
  if (ym) {
    crumbs.push({ '@type': 'ListItem', position: 2, name: `${monthLabel(ym)} Movies`, item: `${SITE_BASE}/calendar/${ym}/` });
  }
  crumbs.push({ '@type': 'ListItem', position: crumbs.length + 1, name: `${movie.title}${year ? ` (${year})` : ''}`, item: canonicalUrl });
  const breadcrumbSchema = { '@type': 'BreadcrumbList', itemListElement: crumbs };

  const graph = [movieSchema, breadcrumbSchema];

  const faqs = buildFaqData(movie);
  if (faqs.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: faqs.map(f => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }

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

function buildMoviePage(movie, ctx = {}) {
  const year        = (movie.release_date || '').slice(0, 4);
  const ym          = (movie.release_date || '').slice(0, 7);
  const title       = escHtml(movie.title);
  const overview    = escHtml(movie.overview || 'No synopsis available.');
  const backdrop    = movie.backdrop_path ? `${IMG_BASE}w1280${movie.backdrop_path}` : '';
  const poster      = movie.poster_path   ? `${IMG_BASE}w500${movie.poster_path}`   : '';
  const canonicalUrl = `${SITE_BASE}/movie/${movie.slug}/`;
  const today       = new Date().toISOString().slice(0, 10);
  const isFuture    = !!movie.release_date && movie.release_date >= today;

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
    const rawName   = code === 'WW' ? 'Worldwide' : (COUNTRY_NAMES[code] || code);
    const formatted = fmtShort(date);
    // Supported countries link to their release-calendar hub page
    const nameHtml = SUPPORTED_COUNTRIES.includes(code)
      ? `<a class="release-country" href="/releases/${countrySlug(code)}/">${escHtml(rawName)}</a>`
      : `<span class="release-country">${escHtml(rawName)}</span>`;
    return `<div class="release-item">${nameHtml}<span class="release-date">${formatted}</span></div>`;
  }).join('');

  const historyEntries = (ctx.dateHistory || {})[String(movie.id)] || [];
  const narrative      = buildReleaseNarrative(movie, historyEntries);
  const faqs           = buildFaqData(movie);

  const faqHtml = faqs.length ? `
  <section class="releases-section">
    <div class="section-heading">Frequently Asked Questions</div>
    ${faqs.map(f => `<div class="faq-item"><h3 class="faq-q">${escHtml(f.q)}</h3><p class="faq-a">${escHtml(f.a)}</p></div>`).join('\n    ')}
  </section>` : '';

  const shownHistory = historyEntries.slice(-8).reverse();
  const historyHtml = shownHistory.length ? `
  <section class="releases-section">
    <div class="section-heading">Release Date History</div>
    <div class="history-list">
    ${shownHistory.map(h => {
      const scopeName = h.scope === 'primary' ? 'Worldwide release' : `${escHtml(COUNTRY_NAMES[h.scope] || h.scope)} release`;
      return `<div class="history-item"><span class="history-when">${fmtShort(h.on)}</span><span>${scopeName} moved from <s>${fmtShort(h.from)}</s> to <strong>${fmtShort(h.to)}</strong></span></div>`;
    }).join('\n    ')}
    </div>
  </section>` : '';

  const related = ctx.related || [];
  const relatedHtml = related.length ? `
  <section class="releases-section">
    <div class="section-heading">More ${ym ? escHtml(monthLabel(ym)) : ''} Releases</div>
    <div class="related-grid">
    ${related.map(r => {
      const rPoster = r.poster_path ? `${IMG_BASE}w185${r.poster_path}` : '';
      return `<a class="related-card" href="/movie/${r.slug}/">
        ${rPoster ? `<img src="${rPoster}" alt="${escHtml(r.title)} poster" loading="lazy" width="92" height="138" />` : `<div class="related-noposter"><span>${escHtml(r.title)}</span></div>`}
        <span class="related-title">${escHtml(r.title)}</span>
        ${r.release_date ? `<span class="related-date">${fmtShort(r.release_date)}</span>` : ''}
      </a>`;
    }).join('\n    ')}
    </div>
    ${ym ? `<p class="hub-cross-link"><a href="/calendar/${ym}/">See every movie coming out in ${escHtml(monthLabel(ym))} &#8594;</a></p>` : ''}
  </section>` : '';

  const metaDesc  = escHtml(
    `${movie.title} releases ${releaseDate}. See the release date in your country, cast, synopsis, trailers and more on Movie Release Radar!`
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
  <title>${title}${year ? ` (${year})` : ''} - Release Dates, Info &amp; Trailers</title>
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
  <meta property="og:title"       content="${title}${year ? ` (${year})` : ''} - Release Dates, Info &amp; Trailers" />
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
    .featured-banner {
      display: inline-flex; align-items: center; gap: 0.5rem;
      padding: 0.4rem 0.8rem; margin-bottom: 0.9rem;
      background: rgba(233, 69, 96, 0.1);
      border: 1px solid rgba(233, 69, 96, 0.35);
      border-radius: 999px;
      color: #f3a4b1; font-size: 0.78rem; line-height: 1.3;
    }
    .featured-banner .fb-tag {
      background: #e94560; color: #fff;
      font-size: 0.62rem; font-weight: 800; letter-spacing: 0.08em;
      padding: 2px 7px; border-radius: 999px; text-transform: uppercase;
    }
    .featured-banner .fb-text { color: #ddd; }

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

    .movie-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; margin-top: 1.25rem; }
    .wl-btn { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.6rem 1.3rem; background: transparent; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; color: #aaa; font-size: 0.88rem; cursor: pointer; transition: background 0.15s, border-color 0.15s, color 0.15s; }
    .wl-btn:hover { border-color: #e94560; color: #e94560; background: rgba(233,69,96,0.07); }
    .wl-btn.wl-active { background: #e94560; border-color: #e94560; color: #fff; }

    .cal-wrap { position: relative; display: inline-block; }
    .cal-btn { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.6rem 1.3rem; background: transparent; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; color: #aaa; font-size: 0.88rem; cursor: pointer; transition: background 0.15s, border-color 0.15s, color 0.15s; }
    .cal-btn:hover, .cal-btn.open { border-color: #4a9eff; color: #4a9eff; background: rgba(74,158,255,0.07); }
    .cal-menu { display: none; position: absolute; top: calc(100% + 6px); left: 0; min-width: 180px; background: #1a1a1a; border: 1px solid #2e2e2e; border-radius: 10px; overflow: hidden; z-index: 100; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    .cal-menu.open { display: block; }
    .cal-menu a { display: flex; align-items: center; gap: 0.6rem; padding: 0.65rem 1rem; color: #ccc; text-decoration: none; font-size: 0.85rem; transition: background 0.12s, color 0.12s; }
    .cal-menu a:hover { background: rgba(74,158,255,0.1); color: #4a9eff; }

    .trailer-section { margin-top: 2.5rem; }
    .trailer-wrap { position: relative; width: 100%; aspect-ratio: 16/9; border-radius: 14px; overflow: hidden; background: #111; }
    .trailer-wrap iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
    .releases-section { margin-top: 2.5rem; }
    .section-heading { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #555; margin-bottom: 0.9rem; padding-bottom: 0.5rem; border-bottom: 1px solid #1e1e1e; }
    .releases-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.65rem; }
    .release-item { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 13px; padding: 0.85rem 1rem; display: flex; flex-direction: column; gap: 0.25rem; }
    .release-country { color: #e0e0e0; font-weight: 600; font-size: 0.85rem; }
    a.release-country { text-decoration: none; }
    a.release-country:hover { color: #e94560; text-decoration: underline; }
    .release-date { color: #666; font-size: 0.78rem; font-weight: 500; }

    .rollout-text { font-size: 0.95rem; color: #bbb; line-height: 1.75; }
    .history-list { display: flex; flex-direction: column; gap: 0.5rem; }
    .history-item { display: flex; gap: 0.9rem; align-items: baseline; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; padding: 0.65rem 0.9rem; font-size: 0.85rem; color: #bbb; }
    .history-item s { color: #777; }
    .history-item strong { color: #f0f0f0; }
    .history-when { flex-shrink: 0; font-size: 0.72rem; color: #555; font-weight: 600; }
    .faq-item { padding: 0.9rem 0; border-bottom: 1px solid #1a1a1a; }
    .faq-item:last-child { border-bottom: 0; }
    .faq-q { font-size: 0.95rem; font-weight: 700; color: #eee; margin-bottom: 0.35rem; }
    .faq-a { font-size: 0.9rem; color: #999; line-height: 1.65; }
    .related-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 0.85rem; }
    .related-card { display: flex; flex-direction: column; gap: 0.35rem; text-decoration: none; }
    .related-card img { width: 100%; border-radius: 10px; display: block; aspect-ratio: 2/3; object-fit: cover; }
    .related-noposter { width: 100%; aspect-ratio: 2/3; background: #1a1a1a; border-radius: 10px; display: flex; align-items: center; justify-content: center; padding: 0.4rem; }
    .related-noposter span { font-size: 0.65rem; color: #555; text-align: center; line-height: 1.3; }
    .related-title { font-size: 0.75rem; font-weight: 600; color: #ccc; line-height: 1.3; }
    .related-card:hover .related-title { color: #e94560; }
    .related-date { font-size: 0.68rem; color: #555; }
    .hub-cross-link { margin-top: 1.1rem; font-size: 0.85rem; }
    .hub-cross-link a { color: #e94560; text-decoration: none; }
    .hub-cross-link a:hover { text-decoration: underline; }

    footer { border-top: 1px solid #1e1e1e; margin-top: 3rem; padding: 1.4rem 2rem; }
    .footer-inner { max-width: 1300px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .footer-brand { font-size: 0.78rem; font-weight: 700; color: #333; letter-spacing: 0.1em; text-transform: uppercase; }
    .footer-attr { font-size: 0.75rem; color: #888; }
    footer a { color: #e94560; text-decoration: none; }
    footer a:hover { text-decoration: underline; }

    @media (max-width: 640px) {
      header { padding: 1rem; }
      .header-inner { flex-direction: row; align-items: center; }
      .site-brand { flex: 0 0 50%; }
      .header-nav { flex: 0 0 50%; flex-direction: column; align-items: flex-end; gap: 0.5rem; }
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
      ${(() => {
        const highRated = (movie.vote_average || 0) >= 7 && (movie.vote_count || 0) >= 50;
        const ri = ctx.rankInfo?.[movie.id];
        const gr = ctx.globalMonthRanks?.[movie.id];
        let reasonText, tooltip, dataAttrs = '', personalize = '';
        if (ri) {
          const entries = Object.entries(ri.byCountry);      // [cc, {rank, ym}]
          const totalCountries = entries.length;
          // A movie's rank is tied to its LOCAL release month in each country.
          // For the static (country-neutral) text, only ranks from the primary
          // release month are coherent with the release date shown on the page;
          // otherwise the month would seem to contradict the date tile.
          const primaryEntries = ym ? entries.filter(([, e]) => e.ym === ym) : [];
          const pool = primaryEntries.length ? primaryEntries : entries;
          let bestCc = null, bestEntry = null;
          for (const [cc, e] of pool) {
            if (!bestEntry || e.rank < bestEntry.rank) { bestEntry = e; bestCc = cc; }
          }
          const monthTxt = monthLabel(bestEntry.ym);
          const countryTxt = COUNTRY_NAMES[bestCc] || bestCc;
          const suffix = totalCountries > 1 ? ` &middot; featured in ${totalCountries} countries` : '';
          if (primaryEntries.length && totalCountries > 1) {
            reasonText = `#${bestEntry.rank} most anticipated ${monthTxt} release${suffix}`;
            tooltip = `Best position across the countries featuring it, by audience interest (TMDB popularity) among ${monthTxt} releases. The rank varies by country.`;
          } else {
            // Rank comes from one country's local release month — always name
            // the country so the month has context.
            reasonText = `#${bestEntry.rank} most anticipated ${monthTxt} release in ${countryTxt}${suffix}`;
            tooltip = `Position by audience interest (TMDB popularity) among ${monthTxt} releases in ${countryTxt} (its local release month there).`;
          }
          if (totalCountries > 1) {
            const ranksJson = {};
            for (const [cc, e] of entries) {
              ranksJson[cc] = [e.rank, COUNTRY_NAMES[cc] || cc, monthLabel(e.ym)];
            }
            dataAttrs = ` data-count="${totalCountries}" data-ranks="${escHtml(JSON.stringify(ranksJson))}"`;
            personalize = `
      <script>
        (function(){
          var b = document.getElementById('featured-banner');
          if (!b || !b.dataset.ranks) return;
          var region = null; try { region = localStorage.getItem('region'); } catch(e) {}
          if (!region) return;
          var ranks; try { ranks = JSON.parse(b.dataset.ranks); } catch(e) { return; }
          var r = ranks[region];
          if (!r) return;
          var el = b.querySelector('.fb-text');
          if (!el) return;
          el.textContent = '#' + r[0] + ' most anticipated ' + r[2] + ' release in ' + r[1] + ' \\u00b7 featured in ' + b.dataset.count + ' countries';
          b.title = 'Anticipation rank = position by audience interest (TMDB popularity) among ' + r[2] + ' releases in ' + r[1] + ' (its local release month there).';
        })();
      </script>`;
          }
        } else if (gr) {
          reasonText = `#${gr.rank} most anticipated movie of ${monthLabel(gr.ym)} worldwide`;
          tooltip = `Rank = position by audience interest (TMDB popularity) among all ${monthLabel(gr.ym)} releases.`;
        } else if (highRated) {
          reasonText = `Rated ${movie.vote_average.toFixed(1)}/10 by ${movie.vote_count.toLocaleString()} viewers`;
          tooltip = 'Featured for its audience rating on TMDB (7.0+ from 50+ voters).';
        } else {
          reasonText = 'Featured release';
          tooltip = 'Previously ranked among the most anticipated releases for its month.';
        }
        return `<div class="featured-banner" id="featured-banner" title="${escHtml(tooltip)}"${dataAttrs}><span class="fb-tag">Featured</span><span class="fb-text">${reasonText}</span></div>${personalize}`;
      })()}
      <h1 class="movie-title">${title}</h1>
      <div class="info-tiles">
        ${movie.release_date ? `<div class="tile"><div class="tile-label">Release Date</div><div class="tile-value">${releaseDate}</div></div>` : ''}
        ${movie.digitalReleaseDate ? `<div class="tile"><div class="tile-label">Digital Release</div><div class="tile-value">${fmtLong(movie.digitalReleaseDate)}</div></div>` : ''}
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
      <div class="movie-actions">
        <button class="wl-btn" id="wl-btn" data-id="${movie.id}">&#9825; Add to Watchlist</button>
        ${isFuture ? `
        <div class="cal-wrap" id="cal-wrap">
          <button class="cal-btn" id="cal-btn">&#128197; Add to Calendar</button>
          <div class="cal-menu" id="cal-menu">
            <a href="#" target="_blank" rel="noopener" id="cal-google">Google Calendar</a>
            <a href="#" id="cal-ics">Apple Calendar (.ics)</a>
          </div>
        </div>` : ''}
      </div>
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

  ${isFuture ? `
  <script>
    (function(){
      var calBtn  = document.getElementById('cal-btn');
      var calMenu = document.getElementById('cal-menu');
      var calWrap = document.getElementById('cal-wrap');
      if (!calBtn) return;

      // Build-time data
      var countryDates = ${JSON.stringify(movie.countryReleases || {})};
      var globalDate   = ${JSON.stringify(movie.release_date)};
      var calTitle     = ${JSON.stringify(movie.title + (year ? ' (' + year + ')' : ''))};
      var calDesc      = ${JSON.stringify((movie.overview || '').slice(0, 500) + '\n\nMore info: ' + canonicalUrl)};
      var icsSummary   = ${JSON.stringify((movie.title + (year ? ' (' + year + ')' : '')).replace(/[,;\\]/g, function(c){ return '\\' + c; }))};
      var icsDescBody  = ${JSON.stringify(((movie.overview || '').slice(0, 500) + '\n\nMore info: ' + canonicalUrl).replace(/[\n,;\\]/g, function(c){ return c === '\n' ? '\\n' : '\\' + c; }))};
      var icsUid       = ${JSON.stringify('movie-' + movie.id + '@moviereleasecalendar.com')};
      var icsCanonical = ${JSON.stringify(canonicalUrl)};
      var icsFile      = ${JSON.stringify((movie.title + (year ? ' (' + year + ')' : '')).replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.ics')};

      // Pick release date for the user's chosen region, fall back to global
      var region = 'WW';
      try { region = localStorage.getItem('region') || 'WW'; } catch(e) {}
      var rd = countryDates[region] || globalDate;

      // Date helpers
      function pad(n){ return String(n).padStart(2, '0'); }
      var parts = rd.split('-');
      var dtEnd = new Date(Date.UTC(+parts[0], +parts[1]-1, +parts[2]));
      dtEnd.setUTCDate(dtEnd.getUTCDate() + 1);
      var startG = rd.replace(/-/g, '');
      var endG   = dtEnd.getUTCFullYear() + pad(dtEnd.getUTCMonth()+1) + pad(dtEnd.getUTCDate());
      var te = encodeURIComponent(calTitle);
      var de = encodeURIComponent(calDesc);

      // Set calendar links
      document.getElementById('cal-google').href =
        'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + te +
        '&dates=' + startG + '/' + endG + '&details=' + de;
      // ICS download
      document.getElementById('cal-ics').addEventListener('click', function(e){
        e.preventDefault();
        var icsBody = [
          'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Movie Release Radar//EN',
          'BEGIN:VEVENT',
          'UID:' + icsUid,
          'DTSTART;VALUE=DATE:' + startG,
          'DTEND;VALUE=DATE:' + endG,
          'SUMMARY:' + icsSummary,
          'DESCRIPTION:' + icsDescBody,
          'URL:' + icsCanonical,
          'END:VEVENT', 'END:VCALENDAR'
        ].join('\\r\\n');
        var blob = new Blob([icsBody], {type:'text/calendar;charset=utf-8'});
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = icsFile;
        document.body.appendChild(a); a.click();
        setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 1000);
        calMenu.classList.remove('open'); calBtn.classList.remove('open');
      });

      // Toggle dropdown
      calBtn.addEventListener('click', function(e){
        e.stopPropagation();
        var open = calMenu.classList.toggle('open');
        calBtn.classList.toggle('open', open);
      });
      document.addEventListener('click', function(e){
        if (!calWrap.contains(e.target)){
          calMenu.classList.remove('open'); calBtn.classList.remove('open');
        }
      });
    })();
  </script>` : ''}

  ${movie.trailerKey ? `
  <section class="trailer-section">
    <div class="section-heading">Trailer</div>
    <div class="trailer-wrap">
      <iframe src="https://www.youtube.com/embed/${movie.trailerKey}?rel=0" allowfullscreen loading="lazy" title="${title} trailer"></iframe>
    </div>
  </section>` : ''}

  ${narrative ? `
  <section class="releases-section">
    <div class="section-heading">Release Rollout</div>
    <p class="rollout-text">${narrative}</p>
  </section>` : ''}

  ${releasesHtml ? `
  <section class="releases-section">
    <div class="section-heading">Release Dates by Country</div>
    <div class="releases-grid">${releasesHtml}</div>
  </section>` : ''}

  ${historyHtml}

  ${faqHtml}

  ${relatedHtml}
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

// ── Hit selection ─────────────────────────────────────────────────────────────

// A movie qualifies as a "hit" (gets a full standalone page) if EITHER:
//   A) it is in top-N by popularity for ANY supported country for its release month
//      (union of per-country lists; WW is excluded — it is a fallback bucket only)
//   B) it has vote_average >= HIT_RATING_MIN AND vote_count >= HIT_VOTE_COUNT_MIN
//      (retroactive: catches already-released films that turn out to be well-received)
// Content floor: popularity alone can promote garbage rows in thin months
// (a country with fewer than 15 releases makes everything "top 15"), so a
// movie must also have enough real data to justify a standalone page.
function isPageWorthy(d) {
  if (!d) return false;
  if (!/\p{L}/u.test(d.title || '')) return false;              // title contains letters
  if ((d.overview || '').trim().length < 100) return false;      // real synopsis
  return !!(d.poster_path || d.trailerKey ||
            (d.cast || []).length || (d.directors || []).length);
}

function computeHits(calendarData, detailsMap) {
  const hitsByCountry = {};   // hitsByCountry[country][ym] = Set<id>
  const globalHitIds  = new Set();

  for (const [ym, byCountry] of Object.entries(calendarData)) {
    for (const [country, rawMovies] of Object.entries(byCountry)) {
      if (country === 'WW') continue;
      const ranked = rawMovies
        .filter(m => detailsMap[m.id] && isPageWorthy(detailsMap[m.id]))
        .sort((a, b) => (detailsMap[b.id].popularity || 0) - (detailsMap[a.id].popularity || 0))
        .slice(0, HIT_TOP_N_PER_COUNTRY);
      if (!hitsByCountry[country]) hitsByCountry[country] = {};
      hitsByCountry[country][ym] = new Set(ranked.map(m => m.id));
      for (const m of ranked) globalHitIds.add(m.id);
    }
  }
  for (const d of Object.values(detailsMap)) {
    if ((d.vote_average || 0) >= HIT_RATING_MIN && (d.vote_count || 0) >= HIT_VOTE_COUNT_MIN && isPageWorthy(d)) {
      globalHitIds.add(d.id);
    }
  }
  console.log(`Hits: ${globalHitIds.size} unique movies promoted (out of ${Object.keys(detailsMap).length})`);
  return { hitsByCountry, globalHitIds };
}

// Rank EVERY featured movie within its country+month set (including legacy
// hits accumulated on earlier nights that have since slipped out of the
// current top-15) by present-day popularity. One numbering system: the
// calendar must never show an unnumbered "featured" movie next to numbered
// ones. Run this AFTER accumulateHits so the merged set is ranked.
function computeFinalRanks(hitsByCountry, popularityById) {
  const finalRanks = {};
  for (const [country, byYm] of Object.entries(hitsByCountry)) {
    finalRanks[country] = {};
    for (const [ym, ids] of Object.entries(byYm)) {
      const sorted = [...ids].sort((a, b) => (popularityById[b] || 0) - (popularityById[a] || 0));
      finalRanks[country][ym] = {};
      sorted.forEach((id, i) => { finalRanks[country][ym][id] = i + 1; });
    }
  }
  return finalRanks;
}

// Merge persisted hit data from previous runs into the in-memory sets so
// historical hits (computed when their month was still in the fetch window)
// stay marked as hits forever. Mutates the inputs in place.
function accumulateHits(hitsByCountry, globalHitIds) {
  const existing = loadJSON(HITS_PATH, { globalHitIds: [], hitsByCountry: {} });
  let addedGlobal = 0;
  for (const id of existing.globalHitIds || []) {
    if (!globalHitIds.has(id)) { globalHitIds.add(id); addedGlobal++; }
  }
  for (const [country, byYm] of Object.entries(existing.hitsByCountry || {})) {
    if (!hitsByCountry[country]) hitsByCountry[country] = {};
    for (const [ym, ids] of Object.entries(byYm)) {
      if (!hitsByCountry[country][ym]) hitsByCountry[country][ym] = new Set();
      for (const id of ids) hitsByCountry[country][ym].add(id);
    }
  }
  if (addedGlobal > 0) console.log(`Accumulated hits: kept ${addedGlobal} historical hits (total: ${globalHitIds.size})`);
}

// Serialise hit data for REGEN_ONLY re-runs and historical accumulation.
function persistHits(hitsByCountry, globalHitIds, hitRanks) {
  const flat = {};
  for (const [country, byYm] of Object.entries(hitsByCountry)) {
    flat[country] = {};
    for (const [ym, set] of Object.entries(byYm)) {
      flat[country][ym] = [...set];
    }
  }
  fs.writeFileSync(HITS_PATH, JSON.stringify({
    globalHitIds: [...globalHitIds],
    hitsByCountry: flat,
    hitRanks,
  }));
}

// Condense hitRanks into per-movie placement info for page templates:
// id → { byCountry: { cc: { rank, ym } } }. Ranks are per country AND per
// local release month (a movie can open in June in one country and October
// in another), so the month must always be carried alongside the rank.
function buildRankInfo(hitRanks) {
  const out = {};
  for (const [country, byYm] of Object.entries(hitRanks || {})) {
    for (const [ym, ranks] of Object.entries(byYm)) {
      for (const [id, rank] of Object.entries(ranks)) {
        if (!out[id]) out[id] = { byCountry: {} };
        const cur = out[id].byCountry[country];
        if (!cur || rank < cur.rank) out[id].byCountry[country] = { rank, ym };
      }
    }
  }
  return out;
}

// Global top-10-per-month ranks (mirrors the /top-movies/ lists) as a fallback
// for movies promoted via the top-movies safety net: id → { rank, ym }.
function buildGlobalMonthRanks(detailedMovies) {
  const byYm = {};
  for (const m of detailedMovies) {
    if (!m.release_date || !m.slug) continue;
    const ym = m.release_date.slice(0, 7);
    (byYm[ym] = byYm[ym] || []).push(m);
  }
  const out = {};
  for (const [ym, list] of Object.entries(byYm)) {
    list.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
      .slice(0, 10)
      .forEach((m, i) => { out[m.id] = { rank: i + 1, ym }; });
  }
  return out;
}

// ── Page generation ───────────────────────────────────────────────────────────

function generatePages(movies, manifest, globalHitIds, pageCtx = {}) {
  fs.mkdirSync(MOVIE_DIR, { recursive: true });

  // Only HIT slugs count as "active" — every other slug must NOT exist on
  // disk so its URL returns the site's 404 page with HTTP 404 status.
  const activeSlugs = new Set(
    movies.filter(m => globalHitIds.has(m.id)).map(m => m.slug)
  );

  // Index hit movies by primary release month for the related-movies block.
  const hitsByYm = {};
  for (const m of movies) {
    if (!globalHitIds.has(m.id) || !m.slug) continue;
    const mym = (m.release_date || '').slice(0, 7);
    if (!mym) continue;
    (hitsByYm[mym] = hitsByYm[mym] || []).push(m);
  }
  for (const list of Object.values(hitsByYm)) {
    list.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  }

  function relatedFor(movie) {
    const mym = (movie.release_date || '').slice(0, 7);
    if (!mym) return [];
    const pool = [...(hitsByYm[mym] || [])];
    if (pool.length < 9) {
      pool.push(...(hitsByYm[addMonths(mym, 1)] || []), ...(hitsByYm[addMonths(mym, -1)] || []));
    }
    const gset = new Set(movie.genre_ids || []);
    return pool
      .filter(r => r.id !== movie.id)
      .map(r => ({ r, overlap: (r.genre_ids || []).filter(g => gset.has(g)).length }))
      .sort((a, b) => b.overlap - a.overlap || (b.r.popularity || 0) - (a.r.popularity || 0))
      .slice(0, 8)
      .map(x => x.r);
  }

  // (1) Write a full page for every hit; delete any pre-existing page for
  // a demoted movie so its URL 404s. We deliberately do not generate
  // noindex stubs anymore — 404 is a stronger signal that the URL is gone.
  let hits = 0, deleted = 0;
  for (const movie of movies) {
    const dir = path.join(MOVIE_DIR, movie.slug);
    if (globalHitIds.has(movie.id)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), buildMoviePage(movie, { ...pageCtx, related: relatedFor(movie) }));
      hits++;
    } else if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      deleted++;
    }
  }
  console.log(`Movie pages: ${hits} hit written, ${deleted} demoted removed (will 404)`);

  // Build oldSlug → currentSlug map for renamed HIT movies. Stubs for
  // renamed slugs whose current target is demoted are skipped (they'd be
  // redirects to a 404 — better to let the old slug 404 directly).
  const redirectTargets = new Map();
  for (const entry of Object.values(manifest)) {
    if (!activeSlugs.has(entry.slug)) continue;
    for (const oldSlug of (entry.previousSlugs || [])) redirectTargets.set(oldSlug, entry.slug);
  }

  // (2) Write redirect stubs for hit-target renamed slugs.
  let stubs = 0;
  for (const [oldSlug, target] of redirectTargets) {
    if (oldSlug === target)       continue;
    if (activeSlugs.has(oldSlug)) continue;
    const dir = path.join(MOVIE_DIR, oldSlug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'),
      `<!DOCTYPE html><html><head><meta charset="UTF-8" />`+
      `<link rel="canonical" href="${SITE_BASE}/movie/${target}/" />`+
      `<meta http-equiv="refresh" content="0;url=/movie/${target}/" />`+
      `<title>Redirecting...</title></head>`+
      `<body><a href="/movie/${target}/">Click here if not redirected.</a></body></html>`
    );
    stubs++;
  }

  // (3) Stale-page sweep: delete any leftover directory on disk that isn't
  // an active hit slug and isn't a live redirect-stub target. This catches
  // orphans from prior runs whose movies have rolled off, plus stubs that
  // used to point to a now-demoted target.
  let staleDeleted = 0;
  for (const slug of fs.readdirSync(MOVIE_DIR)) {
    const dir = path.join(MOVIE_DIR, slug);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (activeSlugs.has(slug))     continue;
    if (redirectTargets.has(slug)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    staleDeleted++;
  }
  if (stubs > 0)        console.log(`Renamed-slug redirect stubs: ${stubs}`);
  if (staleDeleted > 0) console.log(`Stale pages deleted: ${staleDeleted}`);
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
      .header-inner { flex-direction: row; align-items: center; }
      .site-brand { flex: 0 0 50%; }
      .header-nav { flex: 0 0 50%; flex-direction: column; align-items: flex-end; gap: 0.5rem; }
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
    <p class="subtitle">Ranked by TMDB popularity &middot; <a href="/calendar/${ym}/">All ${label} releases</a> &middot; <a href="/?m=${ym}">Interactive calendar</a></p>
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
    .month-thumbs { display: flex; gap: 0.35rem; overflow: hidden; }
    .month-thumbs img { flex: 1 1 0; min-width: 0; width: 0; height: 81px; object-fit: cover; border-radius: 6px; }
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

function generateTopMoviesPages(detailedMovies, globalHitIds = null) {
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

    // Safety net: every movie linked from a top-movies page must be a hit,
    // otherwise we'd be sending users to a noindexed dead page.
    if (globalHitIds) {
      for (const tm of topMovies) globalHitIds.add(tm.id);
    }

    fs.mkdirSync(path.join(TOP_MOVIES_DIR, ym), { recursive: true });
    fs.writeFileSync(outPath, buildTopMoviesPage(ym, topMovies));
    written++;
  }

  fs.writeFileSync(path.join(TOP_MOVIES_DIR, 'index.html'), buildTopMoviesIndexPage(allMonths, detailedMovies));
  console.log(`Top movies pages: ${written} written, ${skipped} past-month(s) frozen`);
  return allMonths;
}

// ── Month hub pages (/calendar/YYYY-MM/) ─────────────────────────────────────

function hubHead(pageTitle, metaDesc, canonicalUrl, ogImage, schema) {
  return `<script>${GTM_CONSENT_JS}</script>
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
  ${ogImage ? `<meta property="og:image" content="${escHtml(ogImage)}" />` : ''}
  <script type="application/ld+json">${schema}</script>`;
}

const HUB_CSS = `
    .hub-page { max-width: 960px; margin: 0 auto; padding: 2rem; }
    .page-header { margin-bottom: 2rem; }
    .page-header h1 { font-size: 2rem; font-weight: 800; color: #fff; line-height: 1.2; }
    .page-header .intro { margin-top: 0.75rem; font-size: 0.92rem; color: #999; line-height: 1.7; max-width: 720px; }
    .page-header .intro a { color: #e94560; text-decoration: none; }
    .page-header .intro a:hover { text-decoration: underline; }
    .hub-nav { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1.25rem 0; font-size: 0.85rem; }
    .hub-nav a { color: #e94560; text-decoration: none; }
    .hub-nav a:hover { text-decoration: underline; }
    .section-heading { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #555; margin: 2rem 0 0.9rem; padding-bottom: 0.5rem; border-bottom: 1px solid #1e1e1e; }
    .featured-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(105px, 1fr)); gap: 0.9rem; }
    .fg-card { display: flex; flex-direction: column; gap: 0.35rem; text-decoration: none; position: relative; }
    .fg-card img { width: 100%; border-radius: 10px; display: block; aspect-ratio: 2/3; object-fit: cover; }
    .fg-noposter { width: 100%; aspect-ratio: 2/3; background: #1a1a1a; border-radius: 10px; display: flex; align-items: center; justify-content: center; padding: 0.4rem; }
    .fg-noposter span { font-size: 0.68rem; color: #555; text-align: center; line-height: 1.3; }
    .fg-title { font-size: 0.76rem; font-weight: 600; color: #ccc; line-height: 1.3; }
    .fg-card:hover .fg-title { color: #e94560; }
    .fg-date { font-size: 0.68rem; color: #555; }
    .day-group { margin-bottom: 1.4rem; }
    .day-group h3 { font-size: 0.95rem; font-weight: 700; color: #ddd; margin-bottom: 0.55rem; }
    .day-group ul { list-style: none; display: flex; flex-direction: column; gap: 0.35rem; }
    .day-group li { font-size: 0.88rem; color: #999; }
    .day-group li a { color: #e0e0e0; text-decoration: none; font-weight: 600; }
    .day-group li a:hover { color: #e94560; }
    .day-group .genre-note { color: #555; font-size: 0.78rem; }
    .updated-note { margin-top: 2.5rem; font-size: 0.78rem; color: #444; text-align: center; }
    .updated-note a { color: #e94560; }
    @media (max-width: 600px) {
      .hub-page { padding: 1rem; }
      .page-header h1 { font-size: 1.45rem; }
    }`;

function buildMonthHubPage(ym, monthMovies, globalHitIds, hubMonthsSet, topMonthsSet) {
  const label        = monthLabel(ym);
  const canonicalUrl = `${SITE_BASE}/calendar/${ym}/`;
  const today        = new Date().toISOString().slice(0, 10);
  const pageTitle    = `Movies Coming Out in ${label}`;

  const hits = monthMovies.filter(m => globalHitIds.has(m.id) && m.slug)
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  const top3 = hits.slice(0, 3).map(m => m.title).join(', ');
  const metaDesc = escHtml(
    `Full ${label} movie release calendar: ${monthMovies.length} movies day by day` +
    (top3 ? `, including ${top3}` : '') + '. Theatrical release dates, updated daily.'
  );
  const ogImage = hits[0]?.poster_path ? `${IMG_BASE}w500${hits[0].poster_path}` : '';

  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ItemList',
        name: pageTitle,
        url: canonicalUrl,
        numberOfItems: hits.length,
        itemListElement: hits.slice(0, 25).map((m, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'Movie',
            name: m.title,
            url: `${SITE_BASE}/movie/${m.slug}/`,
            ...(m.release_date ? { datePublished: m.release_date } : {}),
          },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home',     item: `${SITE_BASE}/` },
          { '@type': 'ListItem', position: 2, name: pageTitle,  item: canonicalUrl },
        ],
      },
    ],
  });

  const featuredHtml = hits.slice(0, 18).map(m => {
    const poster = m.poster_path ? `${IMG_BASE}w185${m.poster_path}` : '';
    return `<a class="fg-card" href="/movie/${m.slug}/">
      ${poster ? `<img src="${poster}" alt="${escHtml(m.title)} poster" loading="lazy" width="105" height="158" />` : `<div class="fg-noposter"><span>${escHtml(m.title)}</span></div>`}
      <span class="fg-title">${escHtml(m.title)}</span>
      ${m.release_date ? `<span class="fg-date">${fmtShort(m.release_date)}</span>` : ''}
    </a>`;
  }).join('\n    ');

  // Day-by-day schedule: every page-worthy movie of the month, links for hits
  const byDay = {};
  for (const m of monthMovies) {
    if (!m.release_date) continue;
    (byDay[m.release_date] = byDay[m.release_date] || []).push(m);
  }
  const scheduleHtml = Object.keys(byDay).sort().map(date => {
    const items = byDay[date]
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
      .map(m => {
        const genre = (m.genres || [])[0];
        const titleHtml = (globalHitIds.has(m.id) && m.slug)
          ? `<a href="/movie/${m.slug}/">${escHtml(m.title)}</a>`
          : escHtml(m.title);
        return `<li>${titleHtml}${genre ? ` <span class="genre-note">&middot; ${escHtml(genre)}</span>` : ''}</li>`;
      }).join('\n        ');
    return `<div class="day-group">
      <h3>${fmtLong(date)}</h3>
      <ul>
        ${items}
      </ul>
    </div>`;
  }).join('\n    ');

  const prevYm = addMonths(ym, -1), nextMonthYm = addMonths(ym, 1);
  const navLinks = [
    hubMonthsSet.has(prevYm)      ? `<a href="/calendar/${prevYm}/">&#8592; ${escHtml(monthLabel(prevYm))}</a>` : '',
    `<a href="/?m=${ym}">Interactive ${escHtml(label)} calendar</a>`,
    topMonthsSet.has(ym)          ? `<a href="/top-movies/${ym}/">Top 10 of ${escHtml(label)}</a>` : '',
    hubMonthsSet.has(nextMonthYm) ? `<a href="/calendar/${nextMonthYm}/">${escHtml(monthLabel(nextMonthYm))} &#8594;</a>` : '',
  ].filter(Boolean).join('\n    ');

  const introTop = hits.slice(0, 3).map(m => `<a href="/movie/${m.slug}/">${escHtml(m.title)}</a>`).join(', ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${hubHead(pageTitle, metaDesc, canonicalUrl, ogImage, schema)}
  <style>${TOP_SHARED_CSS}${HUB_CSS}</style>
</head>
<body>
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-T3BJFZSV" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
${TOP_PAGE_HEADER}
<main class="hub-page">
  <div class="page-header">
    <h1>${escHtml(pageTitle)}</h1>
    <p class="intro">${monthMovies.length} movies ${ym < today.slice(0, 7) ? 'were released' : 'are scheduled for release'} in ${escHtml(label)}${introTop ? `, led by ${introTop}` : ''}. Below is the full day-by-day theatrical release schedule, with release dates tracked across ${SUPPORTED_COUNTRIES.length} countries and updated every night.</p>
  </div>
  <nav class="hub-nav">
    ${navLinks}
  </nav>
  ${featuredHtml ? `
  <div class="section-heading">Featured ${escHtml(label)} Releases</div>
  <div class="featured-grid">
    ${featuredHtml}
  </div>` : ''}
  <div class="section-heading">Day-by-Day Schedule</div>
  ${scheduleHtml}
  <p class="updated-note">Updated nightly &middot; Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a></p>
</main>
${TOP_PAGE_FOOTER}
</body>
</html>`;
}

function generateMonthHubs(allMovies, globalHitIds) {
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const lastYm    = addMonths(currentYm, 12);

  const months = [];
  let cursor = HISTORY_START;
  while (cursor <= lastYm) { months.push(cursor); cursor = addMonths(cursor, 1); }

  // Bucket page-worthy movies by primary release month
  const byYm = {};
  for (const m of allMovies) {
    if (!m.release_date) continue;
    if (!globalHitIds.has(m.id) && !isPageWorthy(m)) continue;
    const ym = m.release_date.slice(0, 7);
    (byYm[ym] = byYm[ym] || []).push(m);
  }

  const hubMonths = months.filter(ym => (byYm[ym] || []).length > 0);
  const hubMonthsSet = new Set(hubMonths);

  // Months that have a /top-movies/ page (mirrors generateTopMoviesPages range)
  const topMonthsSet = new Set();
  let tCursor = TOP_MOVIES_START;
  const topEnd = addMonths(currentYm, 1);
  while (tCursor <= topEnd) { topMonthsSet.add(tCursor); tCursor = addMonths(tCursor, 1); }

  fs.mkdirSync(CALENDAR_PAGES_DIR, { recursive: true });
  for (const ym of hubMonths) {
    const dir = path.join(CALENDAR_PAGES_DIR, ym);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'),
      buildMonthHubPage(ym, byYm[ym], globalHitIds, hubMonthsSet, topMonthsSet));
  }
  console.log(`Month hub pages: ${hubMonths.length} written`);
  return hubMonths;
}

// ── Country hub pages (/releases/<country>/) ─────────────────────────────────

function buildCountryHubPage(cc, movies, globalHitIds, hubMonthsSet) {
  const name         = COUNTRY_NAMES[cc] || cc;
  const slug         = countrySlug(cc);
  const canonicalUrl = `${SITE_BASE}/releases/${slug}/`;
  const today        = new Date().toISOString().slice(0, 10);
  const pageTitle    = `Movie Release Dates in ${name}`;

  // movies: [{ movie, date }] sorted by country-specific date ascending
  const upcoming = movies.filter(x => x.date >= today);
  const hits = upcoming.filter(x => globalHitIds.has(x.movie.id) && x.movie.slug);
  const top3 = hits.slice(0, 3).map(x => x.movie.title).join(', ');
  const metaDesc = escHtml(
    `Upcoming movie release dates in ${name}: ${upcoming.length} movies with confirmed local dates` +
    (top3 ? `, next up ${top3}` : '') + '. Updated daily.'
  );
  const ogImage = hits[0]?.movie.poster_path ? `${IMG_BASE}w500${hits[0].movie.poster_path}` : '';

  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ItemList',
        name: pageTitle,
        url: canonicalUrl,
        numberOfItems: hits.length,
        itemListElement: hits.slice(0, 25).map((x, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'Movie',
            name: x.movie.title,
            url: `${SITE_BASE}/movie/${x.movie.slug}/`,
            datePublished: x.date,
          },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home',                item: `${SITE_BASE}/` },
          { '@type': 'ListItem', position: 2, name: 'Releases by Country', item: `${SITE_BASE}/releases/` },
          { '@type': 'ListItem', position: 3, name: pageTitle,             item: canonicalUrl },
        ],
      },
    ],
  });

  const featuredHtml = hits.slice(0, 12).map(x => {
    const m = x.movie;
    const poster = m.poster_path ? `${IMG_BASE}w185${m.poster_path}` : '';
    return `<a class="fg-card" href="/movie/${m.slug}/">
      ${poster ? `<img src="${poster}" alt="${escHtml(m.title)} poster" loading="lazy" width="105" height="158" />` : `<div class="fg-noposter"><span>${escHtml(m.title)}</span></div>`}
      <span class="fg-title">${escHtml(m.title)}</span>
      <span class="fg-date">${fmtShort(x.date)}</span>
    </a>`;
  }).join('\n    ');

  // Schedule grouped by month, then by day (local dates)
  const byYm = {};
  for (const x of upcoming) {
    const ym = x.date.slice(0, 7);
    (byYm[ym] = byYm[ym] || {});
    (byYm[ym][x.date] = byYm[ym][x.date] || []).push(x);
  }
  const scheduleHtml = Object.keys(byYm).sort().map(ym => {
    const monthHeading = hubMonthsSet.has(ym)
      ? `<a href="/calendar/${ym}/">${escHtml(monthLabel(ym))}</a>`
      : escHtml(monthLabel(ym));
    const days = Object.keys(byYm[ym]).sort().map(date => {
      const items = byYm[ym][date]
        .sort((a, b) => (b.movie.popularity || 0) - (a.movie.popularity || 0))
        .map(x => {
          const m = x.movie;
          const genre = (m.genres || [])[0];
          const titleHtml = (globalHitIds.has(m.id) && m.slug)
            ? `<a href="/movie/${m.slug}/">${escHtml(m.title)}</a>`
            : escHtml(m.title);
          return `<li>${titleHtml}${genre ? ` <span class="genre-note">&middot; ${escHtml(genre)}</span>` : ''}</li>`;
        }).join('\n        ');
      return `<div class="day-group">
      <h3>${fmtLong(date)}</h3>
      <ul>
        ${items}
      </ul>
    </div>`;
    }).join('\n    ');
    return `<div class="section-heading">${monthHeading}</div>\n    ${days}`;
  }).join('\n    ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${hubHead(pageTitle, metaDesc, canonicalUrl, ogImage, schema)}
  <style>${TOP_SHARED_CSS}${HUB_CSS}</style>
</head>
<body>
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-T3BJFZSV" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
${TOP_PAGE_HEADER}
<main class="hub-page">
  <a href="/releases/" class="back-link">&#8592; Releases by country</a>
  <div class="page-header">
    <h1>${escHtml(pageTitle)}</h1>
    <p class="intro">${upcoming.length} movies have confirmed theatrical release dates in ${escHtml(name)} over the coming months. Dates below are the local ${escHtml(name)} release dates, which often differ from the US or worldwide premiere — checked and updated every night.</p>
  </div>
  ${featuredHtml ? `
  <div class="section-heading">Featured Upcoming Releases</div>
  <div class="featured-grid">
    ${featuredHtml}
  </div>` : ''}
  ${scheduleHtml}
  <p class="updated-note">Updated nightly &middot; Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a></p>
</main>
${TOP_PAGE_FOOTER}
</body>
</html>`;
}

function buildReleasesIndexPage(countryCounts) {
  const canonicalUrl = `${SITE_BASE}/releases/`;
  const pageTitle    = 'Movie Release Dates by Country';
  const metaDesc     = escHtml('Country-by-country movie release calendars: local theatrical release dates for upcoming movies in ' + SUPPORTED_COUNTRIES.length + ' countries, updated daily.');

  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ItemList',
        name: pageTitle,
        url: canonicalUrl,
        itemListElement: SUPPORTED_COUNTRIES.map((cc, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: `Movie Release Dates in ${COUNTRY_NAMES[cc]}`,
          url: `${SITE_BASE}/releases/${countrySlug(cc)}/`,
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home',      item: `${SITE_BASE}/` },
          { '@type': 'ListItem', position: 2, name: pageTitle,   item: canonicalUrl },
        ],
      },
    ],
  });

  const cardsHtml = [...SUPPORTED_COUNTRIES]
    .sort((a, b) => (COUNTRY_NAMES[a] || a).localeCompare(COUNTRY_NAMES[b] || b))
    .map(cc => `
    <a href="/releases/${countrySlug(cc)}/" class="country-card">
      <span class="cc-name">${escHtml(COUNTRY_NAMES[cc] || cc)}</span>
      <span class="cc-count">${countryCounts[cc] || 0} upcoming</span>
    </a>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${hubHead(pageTitle, metaDesc, canonicalUrl, '', schema)}
  <style>${TOP_SHARED_CSS}${HUB_CSS}
    .countries-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 0.9rem; }
    .country-card { display: flex; flex-direction: column; gap: 0.3rem; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 14px; padding: 1rem; text-decoration: none; transition: border-color 0.15s, background 0.15s; }
    .country-card:hover { border-color: rgba(233,69,96,0.4); background: rgba(233,69,96,0.05); }
    .cc-name { font-size: 0.95rem; font-weight: 700; color: #fff; }
    .cc-count { font-size: 0.75rem; color: #666; }
  </style>
</head>
<body>
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-T3BJFZSV" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
${TOP_PAGE_HEADER}
<main class="hub-page">
  <div class="page-header">
    <h1>${escHtml(pageTitle)}</h1>
    <p class="intro">Movies rarely open everywhere on the same day. Pick a country to see its local theatrical release calendar — every date below is tracked per country and refreshed nightly.</p>
  </div>
  <div class="countries-grid">
    ${cardsHtml}
  </div>
  <p class="updated-note">Updated nightly &middot; Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a></p>
</main>
${TOP_PAGE_FOOTER}
</body>
</html>`;
}

function generateCountryHubs(allMovies, globalHitIds, hubMonths) {
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 365);
  const maxDate = horizon.toISOString().slice(0, 10);
  const hubMonthsSet = new Set(hubMonths);

  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  const countryCounts = {};

  for (const cc of SUPPORTED_COUNTRIES) {
    const entries = [];
    for (const m of allMovies) {
      const date = (m.countryReleases || {})[cc];
      if (!date || date > maxDate) continue;
      if (date < today) continue;
      if (!globalHitIds.has(m.id) && !isPageWorthy(m)) continue;
      entries.push({ movie: m, date });
    }
    entries.sort((a, b) => a.date.localeCompare(b.date));
    const capped = entries.slice(0, 250);
    countryCounts[cc] = entries.length;

    const dir = path.join(RELEASES_DIR, countrySlug(cc));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'),
      buildCountryHubPage(cc, capped, globalHitIds, hubMonthsSet));
  }

  fs.writeFileSync(path.join(RELEASES_DIR, 'index.html'), buildReleasesIndexPage(countryCounts));
  console.log(`Country hub pages: ${SUPPORTED_COUNTRIES.length} + index written`);
}

// ── Homepage injection ────────────────────────────────────────────────────────

function replaceBetween(html, startMark, endMark, content) {
  const s = html.indexOf(startMark);
  const e = html.indexOf(endMark);
  if (s === -1 || e === -1) {
    console.warn(`  WARNING: homepage markers not found: ${startMark}`);
    return html;
  }
  return html.slice(0, s + startMark.length) + '\n' + content + '\n' + html.slice(e);
}

// Renders crawlable content into index.html between build markers: a featured
// this-month grid with real <a> links, and month/country hub link blocks.
function injectHomepage(allMovies, globalHitIds, hubMonths) {
  let html;
  try { html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'); }
  catch { console.warn('  WARNING: index.html not found — skipping homepage injection'); return; }

  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const label = monthLabel(currentYm);

  const featured = allMovies
    .filter(m => globalHitIds.has(m.id) && m.slug && (m.release_date || '').startsWith(currentYm))
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    .slice(0, 12);

  const cards = featured.map(m => {
    const poster = m.poster_path ? `${IMG_BASE}w185${m.poster_path}` : '';
    return `    <a class="hf-card" href="/movie/${m.slug}/">
      ${poster ? `<img src="${poster}" alt="${escHtml(m.title)} poster" loading="lazy" width="105" height="158" />` : `<div class="hf-noposter"><span>${escHtml(m.title)}</span></div>`}
      <span class="hf-title">${escHtml(m.title)}</span>
      ${m.release_date ? `<span class="hf-date">${fmtShort(m.release_date)}</span>` : ''}
    </a>`;
  }).join('\n');

  const featuredSection = featured.length ? `<section class="home-featured">
  <h2 class="home-sec-title">Featured Movies This Month</h2>
  <p class="home-sec-sub">The most anticipated ${escHtml(label)} releases &mdash; <a href="/calendar/${currentYm}/">see the full ${escHtml(label)} release calendar</a>.</p>
  <div class="home-featured-grid">
${cards}
  </div>
</section>` : '';

  const monthLinks = hubMonths.map(ym =>
    `<a href="/calendar/${ym}/">${escHtml(monthLabel(ym))}</a>`).join('\n      ');
  const countryLinks = [...SUPPORTED_COUNTRIES]
    .sort((a, b) => (COUNTRY_NAMES[a] || a).localeCompare(COUNTRY_NAMES[b] || b))
    .map(cc => `<a href="/releases/${countrySlug(cc)}/">${escHtml(COUNTRY_NAMES[cc] || cc)}</a>`).join('\n      ');

  const browseSection = `<section class="home-browse">
  <h2 class="home-sec-title">Browse Release Calendars</h2>
  <div class="home-browse-group">
    <h3>By month</h3>
    <div class="home-links">
      ${monthLinks}
    </div>
  </div>
  <div class="home-browse-group">
    <h3>By country</h3>
    <div class="home-links">
      ${countryLinks}
      <a href="/releases/">All countries &#8594;</a>
    </div>
  </div>
</section>`;

  html = replaceBetween(html, '<!-- BUILD:FEATURED_MONTH:START -->', '<!-- BUILD:FEATURED_MONTH:END -->', featuredSection);
  html = replaceBetween(html, '<!-- BUILD:BROWSE_LINKS:START -->',   '<!-- BUILD:BROWSE_LINKS:END -->',   browseSection);
  fs.writeFileSync(INDEX_HTML_PATH, html);
  console.log('index.html: static featured + browse sections injected');
}

// ── Sitemap ───────────────────────────────────────────────────────────────────

function generateSitemap(movies, topMonths = [], globalHitIds = null, hubMonths = []) {
  const today = new Date().toISOString().slice(0, 10);

  // Only include HIT movies in the sitemap. Demoted pages are noindex and
  // should not be advertised to Google.
  const sitemapMovies = globalHitIds
    ? movies.filter(m => globalHitIds.has(m.id))
    : movies;

  const movieUrls = sitemapMovies.map(m => {
    const lastmod = m.dataUpdatedAt || today;
    return `  <url>\n    <loc>${SITE_BASE}/movie/${m.slug}/</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`;
  }).join('\n');

  const topIndexUrl = `  <url>\n    <loc>${SITE_BASE}/top-movies/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>`;

  const topMonthUrls = topMonths.map(ym =>
    `  <url>\n    <loc>${SITE_BASE}/top-movies/${ym}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.85</priority>\n  </url>`
  ).join('\n');

  const monthHubUrls = hubMonths.map(ym =>
    `  <url>\n    <loc>${SITE_BASE}/calendar/${ym}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>`
  ).join('\n');

  const countryHubUrls = [
    `  <url>\n    <loc>${SITE_BASE}/releases/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>`,
    ...SUPPORTED_COUNTRIES.map(cc =>
      `  <url>\n    <loc>${SITE_BASE}/releases/${countrySlug(cc)}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>`),
  ].join('\n');

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
${monthHubUrls}
${countryHubUrls}
</urlset>`;

  fs.writeFileSync(path.join(__dirname, '..', 'sitemap.xml'), xml);
  const totalUrls = sitemapMovies.length + 2 + topMonths.length + hubMonths.length + 1 + SUPPORTED_COUNTRIES.length;
  console.log(`sitemap.xml written (${totalUrls} URLs)`);
}

// ── Calendar file builder ─────────────────────────────────────────────────────

function buildCalendarFiles(calendarData, detailsMap, hitsByCountry, globalHitIds, hitRanks) {
  let written = 0;
  for (const [ym, byCountry] of Object.entries(calendarData)) {
    const monthDir = path.join(CALENDAR_DIR, ym);
    fs.mkdirSync(monthDir, { recursive: true });

    for (const [country, rawMovies] of Object.entries(byCountry)) {
      const countryHits = hitsByCountry[country]?.[ym]; // undefined for 'WW'
      const countryRanks = hitRanks?.[country]?.[ym] || {};
      const slim = rawMovies
        .filter(m => detailsMap[m.id])
        .map(m => {
          const d = detailsMap[m.id];
          const entry = {
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
            isHit:             countryHits ? countryHits.has(m.id) : false,
          };
          // Exact position in this country's monthly anticipation ranking —
          // lets the UI say "#3 most anticipated" instead of a vague "top 15".
          if (entry.isHit && countryRanks[m.id]) entry.featuredRank = countryRanks[m.id];
          // Only expose slug for HIT movies — otherwise the client would
          // navigate to a noindexed page instead of opening the modal.
          if (globalHitIds.has(m.id)) entry.slug = d.slug;
          return entry;
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
  let hitsByCountry, hitRanks, globalHitIds;

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

    // Reconstruct calendarData + detailsMap from existing movies.json so we can
    // (re-)compute hits and (re-)build the per-country calendar JSON files.
    // Limit the months to the same -1 → +12 window the full-fetch branch uses,
    // otherwise stale countryReleases entries pull in long-ago / far-future
    // months and generate phantom calendar files.
    const detailsMap = {};
    for (const m of detailedMovies) detailsMap[m.id] = m;
    const padYm = n => String(n).padStart(2, '0');
    const nowReg = new Date();
    const currentYmReg = `${nowReg.getFullYear()}-${padYm(nowReg.getMonth() + 1)}`;
    // Rebuild every month the site keeps history for (so historical files
    // pick up featuredRank etc.), up to 12 months ahead. Anything outside
    // this range is a phantom month from stale countryReleases entries.
    const allowedMonths = new Set();
    let ymCursor = HISTORY_START;
    const lastAllowedYm = addMonths(currentYmReg, 12);
    while (ymCursor <= lastAllowedYm) {
      allowedMonths.add(ymCursor);
      ymCursor = addMonths(ymCursor, 1);
    }
    const calendarData = {};
    for (const m of detailedMovies) {
      for (const [country, releaseDate] of Object.entries(m.countryReleases || {})) {
        const ym = (releaseDate || '').slice(0, 7);
        if (!ym || !allowedMonths.has(ym)) continue;
        if (!calendarData[ym])          calendarData[ym] = {};
        if (!calendarData[ym][country]) calendarData[ym][country] = [];
        if (!calendarData[ym][country].some(x => x.id === m.id)) {
          calendarData[ym][country].push({ id: m.id, release_date: releaseDate });
        }
      }
    }

    ({ hitsByCountry, globalHitIds } = computeHits(calendarData, detailsMap));
    accumulateHits(hitsByCountry, globalHitIds);
    promoteTopMoviesToHits(detailedMovies, globalHitIds);
    const popularityById = {};
    for (const m of loadJSON(MOVIES_PATH, [])) popularityById[m.id] = m.popularity || 0;
    hitRanks = computeFinalRanks(hitsByCountry, popularityById);
    persistHits(hitsByCountry, globalHitIds, hitRanks);
    buildCalendarFiles(calendarData, detailsMap, hitsByCountry, globalHitIds, hitRanks);
  } else {
    // Build month range. Default: 1 month back → 12 months forward (nightly
    // refresh). Override via BACKFILL_FROM=YYYY-MM to extend the window
    // backward for a one-time historical fetch.
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');

    let startOffset = -1;
    if (process.env.BACKFILL_FROM) {
      const [bfY, bfM] = process.env.BACKFILL_FROM.split('-').map(Number);
      if (Number.isFinite(bfY) && Number.isFinite(bfM)) {
        const monthsBack = (now.getFullYear() - bfY) * 12 + (now.getMonth() + 1 - bfM);
        if (monthsBack > Math.abs(startOffset)) startOffset = -monthsBack;
        console.log(`Backfill mode: fetching from ${process.env.BACKFILL_FROM} (offset ${startOffset})`);
      }
    }

    const months = [];
    for (let offset = startOffset; offset <= 12; offset++) {
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

    // Backfill optimisation: when running with BACKFILL_FROM, skip the 3-call
    // detail fetch for any historical movie we already have cached in
    // movies.json AND whose release falls outside the standard -1 → +12
    // refresh window. The standard window's movies still get fresh details
    // every run so popularity / ratings stay current.
    const isBackfill = !!process.env.BACKFILL_FROM;
    const existingMovieMap = {};
    for (const m of loadJSON(MOVIES_PATH, [])) existingMovieMap[m.id] = m;

    const freshWindowMonths = new Set();
    for (let offset = -1; offset <= 12; offset++) {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      freshWindowMonths.add(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
    }

    // Fetch details for every unique movie (no /release_dates — dates come from discover)
    const movieIdArr = [...allMovieIds];
    const detailsMap = {};
    const BATCH = 10;

    const idsToFetch = movieIdArr.filter(id => {
      const cached = existingMovieMap[id];
      if (!cached) return true;                       // new movie — always fetch
      if (!isBackfill) return true;                   // nightly run — refresh everything
      const ymd = cached.release_date || '';
      return freshWindowMonths.has(ymd.slice(0, 7));  // backfill but in fresh window
    });
    const idsToReuse = movieIdArr.filter(id => !idsToFetch.includes(id));
    for (const id of idsToReuse) detailsMap[id] = existingMovieMap[id];
    if (isBackfill) console.log(`Backfill detail-fetch plan: ${idsToFetch.length} fresh + ${idsToReuse.length} reused from movies.json`);

    for (let i = 0; i < idsToFetch.length; i += BATCH) {
      const batch = idsToFetch.slice(i, i + BATCH);
      process.stdout.write(`  details ${i + 1}–${Math.min(i + BATCH, idsToFetch.length)} / ${idsToFetch.length}\r`);

      const results = await Promise.allSettled(batch.map(id => fetchMovieDetails(id)));
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          detailsMap[r.value.id] = r.value;
        } else {
          console.error(`\n  Failed movie ${batch[idx]}: ${r.reason.message}`);
        }
      });

      if (i + BATCH < idsToFetch.length) await sleep(300);
    }

    // Stamp the per-country release dates discovered in this run onto every
    // movie (fresh or reused), merging with whatever countryReleases the
    // cached entry already had so older country dates aren't lost.
    for (const movie of Object.values(detailsMap)) {
      movie.countryReleases = {
        ...(movie.countryReleases || {}),
        ...(movieCountryReleases[movie.id] || {}),
      };
    }

    console.log(`\nFetched details for ${Object.keys(detailsMap).length} movies (${idsToFetch.length} hit TMDB, ${idsToReuse.length} reused)`);

    detailedMovies = Object.values(detailsMap);

    // Stamp dataUpdatedAt — only advance when page-relevant data actually changed
    const today = new Date().toISOString().slice(0, 10);
    for (const movie of detailedMovies) {
      const prev = existingMovieMap[movie.id];
      if (!prev || movieFingerprint(movie) !== movieFingerprint(prev)) {
        movie.dataUpdatedAt = today;
      } else {
        movie.dataUpdatedAt = prev.dataUpdatedAt || today;
      }
    }

    // Release-date change tracking: diff tonight's dates against yesterday's
    // and accumulate the changes forever. Reused (non-refetched) movies are
    // the same object as their cached entry, so they never produce a diff.
    {
      const dateHistory = loadJSON(DATE_HISTORY_PATH, {});
      let changeCount = 0;
      for (const movie of detailedMovies) {
        const prev = existingMovieMap[movie.id];
        if (!prev || prev === movie) continue;
        const entries = [];
        if (prev.release_date && movie.release_date && prev.release_date !== movie.release_date) {
          entries.push({ on: today, scope: 'primary', from: prev.release_date, to: movie.release_date });
        }
        for (const [cc, date] of Object.entries(movie.countryReleases || {})) {
          const old = (prev.countryReleases || {})[cc];
          if (old && date && old !== date) {
            entries.push({ on: today, scope: cc, from: old, to: date });
          }
        }
        if (entries.length) {
          const key = String(movie.id);
          dateHistory[key] = [...(dateHistory[key] || []), ...entries].slice(-50);
          changeCount += entries.length;
        }
      }
      fs.writeFileSync(DATE_HISTORY_PATH, JSON.stringify(dateHistory));
      console.log(`date-history.json updated (${changeCount} change(s) recorded tonight)`);
    }

    // Accumulate movies.json: merge freshly-fetched details over the existing
    // dataset so historical movies that rolled out of the fetch window keep
    // their last-known data instead of disappearing. This is what lets us
    // keep all hit pages alive forever even though we only re-fetch the
    // rolling -1 → +12 window each night.
    const accumulatedMap = {};
    for (const m of Object.values(existingMovieMap)) accumulatedMap[m.id] = m;
    for (const m of detailedMovies)                  accumulatedMap[m.id] = m;
    const freshCount = detailedMovies.length;
    detailedMovies = Object.values(accumulatedMap);
    console.log(`Accumulated movies.json: ${freshCount} fresh + ${detailedMovies.length - freshCount} historical = ${detailedMovies.length} total`);

    // Assign slugs first so buildCalendarFiles can embed them
    assignSlugs(detailedMovies, manifest);

    // Compute which movies qualify as "hits" (get a full standalone page)
    ({ hitsByCountry, globalHitIds } = computeHits(calendarData, detailsMap));
    // Union with previously-persisted hits so historical month rankings —
    // computed when those months were inside the fetch window — stay alive.
    accumulateHits(hitsByCountry, globalHitIds);
    // Promote /top-movies/ targets BEFORE writing calendar JSON, otherwise
    // safety-net-promoted movies would be missing their slug in the calendar.
    promoteTopMoviesToHits(detailedMovies, globalHitIds);
    const popularityById = {};
    for (const m of detailedMovies) popularityById[m.id] = m.popularity || 0;
    hitRanks = computeFinalRanks(hitsByCountry, popularityById);
    persistHits(hitsByCountry, globalHitIds, hitRanks);

    // Write per-country per-month calendar JSON files (carries isHit + slug-for-hits)
    buildCalendarFiles(calendarData, detailsMap, hitsByCountry, globalHitIds, hitRanks);

    // Persist manifest and full movie data
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log('manifest.json saved');

    fs.writeFileSync(MOVIES_PATH, JSON.stringify(detailedMovies, null, 2));
    console.log(`movies.json saved (${detailedMovies.length} movies)`);
  }

  // Write the slim public manifest the browser uses for slug lookups + certifications.
  writePublicManifest(manifest, globalHitIds);

  const allMovies = process.env.REGEN_ONLY === '1' ? loadJSON(MOVIES_PATH, []) : detailedMovies;
  const pageCtx = {
    rankInfo:         buildRankInfo(hitRanks),
    globalMonthRanks: buildGlobalMonthRanks(allMovies),
    dateHistory:      loadJSON(DATE_HISTORY_PATH, {}),
  };
  generatePages(detailedMovies, manifest, globalHitIds, pageCtx);
  const topMonths = generateTopMoviesPages(allMovies, globalHitIds);
  const hubMonths = generateMonthHubs(allMovies, globalHitIds);
  generateCountryHubs(allMovies, globalHitIds, hubMonths);
  injectHomepage(allMovies, globalHitIds, hubMonths);
  generateSitemap(allMovies, topMonths, globalHitIds, hubMonths);
}

// Pick the same top-10-by-popularity-per-month list that generateTopMoviesPages
// will produce, and promote those IDs into the hit set so their /movie/ pages
// get the full template (not the noindex stub).
function promoteTopMoviesToHits(detailedMovies, globalHitIds) {
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const nextYm    = addMonths(currentYm, 1);
  const months    = [];
  let cursor = TOP_MOVIES_START;
  while (cursor <= nextYm) { months.push(cursor); cursor = addMonths(cursor, 1); }

  let promoted = 0;
  for (const ym of months) {
    const top = detailedMovies
      .filter(m => m.release_date && m.release_date.startsWith(ym) && m.slug)
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
      .slice(0, 10);
    for (const m of top) {
      if (!globalHitIds.has(m.id)) { globalHitIds.add(m.id); promoted++; }
    }
  }
  if (promoted > 0) console.log(`Top-movies safety net: promoted ${promoted} extra movie(s) to hit status`);
}

// Slim manifest exposed to the browser. Contains slug ONLY for hit movies
// (so the client can't navigate to a noindexed page) but keeps certification
// for every movie (still used by the in-page modal + filter).
function writePublicManifest(manifest, globalHitIds) {
  const out = {};
  for (const [id, entry] of Object.entries(manifest)) {
    const numId = Number(id);
    const isHit = globalHitIds.has(numId);
    const obj = {};
    if (isHit && entry.slug) obj.slug = entry.slug;
    if (entry.certification) obj.certification = entry.certification;
    if (Object.keys(obj).length > 0) out[id] = obj;
  }
  fs.writeFileSync(PUBLIC_MANIFEST_PATH, JSON.stringify(out));
  console.log(`manifest-public.json saved (${Object.keys(out).length} entries)`);
}

main().catch(err => { console.error(err); process.exit(1); });
