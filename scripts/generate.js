'use strict';

const fs   = require('fs');
const path = require('path');
const RadarCore = require('../assets/radar-core.js');
const { buildCatalog } = require('./build-catalog.js');

const API_KEY  = process.env.TMDB_API_KEY || '';
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
const POP_HISTORY_PATH     = path.join(DATA_DIR, 'popularity-history.json');
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

// Anticipation-scoring knobs (see "Anticipation scoring" section)
const POP_HISTORY_MAX_DAYS       = 14; // nightly popularity snapshots kept per movie
const POP_SMOOTH_DAYS            = 7;  // trailing snapshots averaged for ranking
const LATE_IMPORT_HALF_LIFE_DAYS = 30; // days playing elsewhere that halve the score

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
    if (!res.ok) { const error = new Error(`HTTP ${res.status}`); error.status = res.status; throw error; }
    return res.json();
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err;
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
    `&release_date.gte=${fromDate}&release_date.lte=${toDate}` +
    `&region=${region}&with_release_type=2|3&sort_by=popularity.desc`;

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
  if (!API_KEY) throw new Error('Set TMDB_API_KEY before refreshing movie data');
  const details = await fetchJSON(`${BASE_URL}/movie/${id}?api_key=${API_KEY}&language=en-US&append_to_response=credits,videos,release_dates,watch/providers`);
  const credits = details.credits || {};
  const videos = details.videos || {};
  const releaseDates = details.release_dates;
  const regional = RadarCore.extractReleases(releaseDates);
  let watchProviders = null;
  try { watchProviders = RadarCore.extractProviders(details['watch/providers']); } catch (_) {}

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
    ...regional,
    original_title: details.original_title,
    watchProviders,
    providersUpdatedAt: watchProviders ? new Date().toISOString() : null,
    releaseDatesCheckedAt: new Date().toISOString(),
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
    JSON.stringify(m.countryDigitalReleases || {}), JSON.stringify(m.watchProviders || {}),
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
  const movieClientData = JSON.stringify({id:movie.id,title:movie.title,slug:movie.slug,release_date:movie.release_date,countryReleases:movie.countryReleases||{},countryDigitalReleases:movie.countryDigitalReleases||{},countryReleaseTypes:movie.countryReleaseTypes||{},releaseDataVersion:movie.releaseDataVersion||1,watchProviders:movie.watchProviders,providersUpdatedAt:movie.providersUpdatedAt,releaseDatesCheckedAt:movie.releaseDatesCheckedAt}).replace(/</g, '\\u003c');

  const releaseDate = movie.release_date
    ? new Date(movie.release_date + 'T00:00:00').toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
    : 'TBA';

  const runtime = movie.runtime
    ? `${Math.floor(movie.runtime / 60)}h ${movie.runtime % 60}m`
    : '';

  const genreTagsHtml = (movie.genres || [])
    .map(g => `<span class="genre-tag">${escHtml(g)}</span>`)
    .join('');

  const directors = (movie.directors || []).map(d => escHtml(d)).join(', ');
  const cast       = (movie.cast      || []).map(c => escHtml(c)).join(', ');
  const hasRating  = movie.vote_count > 0 && movie.vote_average >= 1;
  const kicker     = [...(movie.genres || []).slice(0, 3), runtime, year].filter(Boolean).map(escHtml).join(' &middot; ');

  let countryEntries = Object.entries(movie.countryReleases || {})
    .sort(([, a], [, b]) => a.localeCompare(b));

  // No per-country entries but we have a primary release date — show it as Worldwide
  if (countryEntries.length === 0 && movie.release_date) {
    countryEntries = [['WW', movie.release_date]];
  }

  const releaseRow = ([code, date]) => {
    const rawName   = code === 'WW' ? 'Worldwide' : (COUNTRY_NAMES[code] || code);
    // Supported countries link to their release-calendar hub page
    const nameHtml = SUPPORTED_COUNTRIES.includes(code)
      ? `<a class="release-country" href="/releases/${countrySlug(code)}/">${escHtml(rawName)}</a>`
      : `<span class="release-country">${escHtml(rawName)}</span>`;
    return `<div class="mv-date">${nameHtml}<span class="release-date">${fmtShort(date)}</span></div>`;
  };
  const DATES_SHOWN = 16;
  const releasesHtml = countryEntries.length ? `
    <div class="mv-dates">${countryEntries.slice(0, DATES_SHOWN).map(releaseRow).join('')}</div>
    ${countryEntries.length > DATES_SHOWN ? `<details class="ed-more"><summary>Show all ${countryEntries.length} countries</summary><div class="mv-dates">${countryEntries.slice(DATES_SHOWN).map(releaseRow).join('')}</div></details>` : ''}` : '';

  // Rollout timeline: first and last opening plus the busiest day in between.
  const named = countryEntries.filter(([cc]) => COUNTRY_NAMES[cc]);
  const byDate = {};
  for (const [cc, d] of named) (byDate[d] = byDate[d] || []).push(COUNTRY_NAMES[cc]);
  const dates = Object.keys(byDate).sort();
  let timelineHtml = '';
  if (dates.length >= 2) {
    const first = dates[0], last = dates[dates.length - 1];
    const span = (new Date(last) - new Date(first)) || 1;
    const label = d => byDate[d][0] + (byDate[d].length > 1 ? ` +${byDate[d].length - 1}` : '');
    const marks = [[first, 'end'], [last, 'end']];
    const busiest = dates.slice(1, -1).sort((a, b) => byDate[b].length - byDate[a].length)[0];
    if (busiest) {
      const at = (new Date(busiest) - new Date(first)) / span;
      if (at > 0.12 && at < 0.88) marks.splice(1, 0, [busiest, '']);
    }
    timelineHtml = `<div class="mv-timeline" aria-hidden="true">${marks.map(([d, cls], i) =>
      `<div class="mv-mark ${cls}" style="left:${(((new Date(d) - new Date(first)) / span) * 100).toFixed(1)}%;--i:${i}"><b>${escHtml(label(d))}</b><i></i><span>${fmtShort(d)}</span></div>`).join('')}</div>`;
  }

  const historyEntries = (ctx.dateHistory || {})[String(movie.id)] || [];
  const narrative      = buildReleaseNarrative(movie, historyEntries);
  const faqs           = buildFaqData(movie);

  const faqHtml = faqs.length ? `
  <section class="mv-section">
    <h2 class="ed-sec">Frequently asked questions</h2>
    <div class="mv-faq">
    ${faqs.map(f => `<div class="mv-faq-item"><h3 class="mv-faq-q">${escHtml(f.q)}</h3><p class="mv-faq-a">${escHtml(f.a)}</p></div>`).join('\n    ')}
    </div>
  </section>` : '';

  const shownHistory = historyEntries.slice(-8).reverse();
  const historyHtml = shownHistory.length ? `
  <section class="mv-section">
    <h2 class="ed-sec">Release date history</h2>
    <div class="mv-history">
    ${shownHistory.map(h => {
      const scopeName = h.scope === 'primary' ? 'Worldwide release' : `${escHtml(COUNTRY_NAMES[h.scope] || h.scope)} release`;
      return `<div class="mv-history-item"><span class="mv-history-when">${fmtShort(h.on)}</span><span>${scopeName} ${!h.from ? 'announced for <strong>'+fmtShort(h.to)+'</strong>' : !h.to ? 'date no longer announced (previously '+fmtShort(h.from)+')' : 'moved from <s>'+fmtShort(h.from)+'</s> to <strong>'+fmtShort(h.to)+'</strong>'}</span></div>`;
    }).join('\n    ')}
    </div>
  </section>` : '';

  const related = ctx.related || [];
  const relatedHtml = related.length ? `
  <section class="mv-section">
    <h2 class="ed-sec">More ${ym ? escHtml(monthLabel(ym)) : ''} releases</h2>
    <div class="ed-poster-grid mv-related">
    ${related.map(r => {
      const rPoster = r.poster_path ? `${IMG_BASE}w185${r.poster_path}` : '';
      return `<a class="ed-poster" href="/movie/${r.slug}/">
        ${rPoster ? `<img src="${rPoster}" alt="${escHtml(r.title)} poster" loading="lazy" width="118" height="177" />` : `<span class="ed-noposter">${escHtml(r.title)}</span>`}
        <span class="ed-poster-title">${escHtml(r.title)}</span>
        ${r.release_date ? `<span class="ed-poster-date">${fmtShort(r.release_date)}</span>` : ''}
      </a>`;
    }).join('\n    ')}
    </div>
    ${ym ? `<p class="ed-note"><a href="/calendar/${ym}/">See every movie coming out in ${escHtml(monthLabel(ym))} &#8594;</a></p>` : ''}
  </section>` : '';

  const metaDesc  = escHtml(
    `${movie.title} releases ${releaseDate}. See the release date in your country, cast, synopsis, trailers and more on Movie Release Radar!`
  );
  const ogImage = poster || (movie.backdrop_path ? `${IMG_BASE}w780${movie.backdrop_path}` : '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <script>${GTM_CONSENT_JS}</script>
  ${GTM_TAG}
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
  ${THEME_HEAD}
<script src="/assets/radar-core.js"></script>
<script src="/assets/radar-ui.js"></script>
</head>
<body class="ed">
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-T3BJFZSV" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
${siteHeader()}

<main>
  <section class="mv-hero">
    ${backdrop ? `<img class="mv-hero-img" src="${backdrop}" alt="${title} backdrop" />` : ''}
    <div class="mv-hero-shade"></div>
    <div class="mv-hero-inner ed-wrap">
      <a href="/" class="ed-back mv-back" id="back-link">&#8592; Back to calendar</a>
      <script>
        (function(){
          try {
            var full = sessionStorage.getItem('calendarView');
            if (full) { document.getElementById('back-link').href = '/' + full; return; }
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
      <div class="mv-hero-text">
        ${kicker ? `<span class="ed-kicker">${kicker}</span>` : ''}
        <h1 class="ed-hero-title">${title}</h1>
        <div class="mv-meta">
          ${hasRating ? `<span><span class="mv-star">&#9733; ${movie.vote_average.toFixed(1)}</span> / 10 &middot; ${movie.vote_count.toLocaleString()} votes</span>` : ''}
          ${movie.original_language ? `<span>${escHtml(movie.original_language.toUpperCase())}</span>` : ''}
          ${movie.certification ? `<span class="mv-cert">${escHtml(movie.certification)}</span>` : ''}
        </div>
      </div>
    </div>
  </section>

  <div class="ed-wrap">
    <div class="mv-main">
      <div class="mv-side">
        ${poster
          ? `<img class="mv-poster" src="${poster}" alt="${title} poster" />`
          : `<div class="mv-poster mv-poster-ph">${title}</div>`}
        <button class="wl-btn" id="wl-btn" data-id="${movie.id}">&#9825; Add to Watchlist</button>
        ${movie.trailerKey ? `<a href="#trailer" class="ed-btn">&#9654; Watch trailer</a>` : ''}
      </div>
      <div class="mv-body">
        <div class="mv-text">
          <p class="mv-overview">${overview}</p>
          ${directors || cast ? `<div class="mv-crew">
            ${directors ? `<span>Directed by <strong>${directors}</strong></span>` : ''}
            ${cast      ? `<span>Starring <span>${cast}</span></span>`           : ''}
          </div>` : ''}
          ${genreTagsHtml ? `<div class="mv-genres">${genreTagsHtml}</div>` : ''}
          <div class="mv-stats">
            ${movie.release_date ? `<div class="mv-stat tile-global-release"><span class="ed-kicker">First release</span><span class="mv-stat-v">${fmtShort(movie.release_date)}</span></div>` : ''}
            ${hasRating ? `<div class="mv-stat"><span class="ed-kicker">Score</span><span class="mv-stat-v mv-star">${movie.vote_average.toFixed(1)} <small>/ 10</small></span></div>` : ''}
            ${runtime ? `<div class="mv-stat"><span class="ed-kicker">Length</span><span class="mv-stat-v">${runtime}</span></div>` : ''}
            ${movie.original_language ? `<div class="mv-stat"><span class="ed-kicker">Language</span><span class="mv-stat-v">${escHtml(movie.original_language.toUpperCase())}</span></div>` : ''}
            ${movie.certification ? `<div class="mv-stat"><span class="ed-kicker">US Rating</span><span class="mv-stat-v">${escHtml(movie.certification)}</span></div>` : ''}
          </div>
        </div>
        <div id="radar-local-release"></div>
      </div>
    </div>

    <section class="mv-section"><div id="radar-watch-providers"></div></section>
    <script type="application/json" id="radar-movie-data">${movieClientData}</script>
    <script>RadarUI.mountMovie(JSON.parse(document.getElementById('radar-movie-data').textContent));</script>

    ${movie.trailerKey ? `
    <section class="mv-section" id="trailer">
      <h2 class="ed-sec">Trailer</h2>
      <div class="mv-trailer">
        <iframe src="https://www.youtube.com/embed/${movie.trailerKey}?rel=0" allowfullscreen loading="lazy" title="${title} trailer"></iframe>
      </div>
    </section>` : ''}

    ${narrative ? `
    <section class="mv-section">
      <h2 class="ed-sec">Release rollout</h2>
      <p class="mv-rollout">${narrative}</p>
      ${timelineHtml}
    </section>` : ''}

    ${releasesHtml ? `
    <section class="mv-section">
      <h2 class="ed-sec">Release dates by country</h2>
      ${releasesHtml}
    </section>` : ''}

    ${historyHtml}

    ${faqHtml}

    ${relatedHtml}
  </div>
</main>

${SITE_FOOTER}
</body>
</html>`;
}

// ── Anticipation scoring ──────────────────────────────────────────────────────
// TMDB `popularity` is a real-time activity metric: it spikes on a movie's
// release day and stays inflated for as long as the film is playing somewhere.
// Ranking a month's releases by the raw nightly snapshot therefore has two
// credibility failures:
//   a) a one-day spike (release day, viral news) reshuffles the whole list;
//   b) a film that premiered abroad weeks before its local opening arrives
//      carrying a full theatrical run's worth of buzz and buries genuinely
//      anticipated upcoming releases (and re-releases of old films rank as if
//      they were new).
// Two corrections:
//   1. Smoothing — rank on the average of the last POP_SMOOTH_DAYS nightly
//      snapshots (persisted in popularity-history.json) instead of today's.
//   2. Late-import discount (country+month ranks only) — halve the score for
//      every LATE_IMPORT_HALF_LIFE_DAYS the film has already been playing
//      elsewhere before its local opening; that buzz is an ongoing box-office
//      run, not local anticipation.

let _popHistory = null;
function loadPopHistory() {
  if (!_popHistory) _popHistory = loadJSON(POP_HISTORY_PATH, {});
  return _popHistory;
}

// Record tonight's popularity for every freshly-fetched movie. Runs before any
// ranking so tonight's value participates in the smoothed average.
function recordPopularitySnapshots(movies) {
  const hist  = loadPopHistory();
  const today = new Date().toISOString().slice(0, 10);
  for (const m of movies) {
    if (!m || typeof m.popularity !== 'number') continue;
    const rows = (hist[m.id] || []).filter(([d]) => d !== today);
    rows.push([today, m.popularity]);
    rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    hist[m.id] = rows.slice(-POP_HISTORY_MAX_DAYS);
  }
  fs.writeFileSync(POP_HISTORY_PATH, JSON.stringify(hist));
  console.log(`popularity-history.json updated (${movies.length} snapshot(s))`);
}

const _smoothPopCache = new Map();
function smoothPop(m) {
  if (!m) return 0;
  let v = _smoothPopCache.get(m.id);
  if (v === undefined) {
    v = RadarCore.recentPopularity(m, loadPopHistory()[m.id] || [], new Date().toISOString().slice(0, 10), POP_SMOOTH_DAYS);
    _smoothPopCache.set(m.id, v);
  }
  return v;
}

// When the film's run effectively started. A lone early date in one country
// is usually a festival premiere, not the start of the theatrical run, so
// take the 3rd-earliest country date — but never later than the primary
// release date, which is what keeps re-releases of old films buried.
function effectiveFirstRelease(m) {
  const cdates = Object.values(m.countryReleases || {}).filter(Boolean).sort();
  const robust = cdates.length ? cdates[Math.min(2, cdates.length - 1)] : null;
  const primary = m.release_date || null;
  if (primary && (!robust || primary < robust)) return primary;
  return robust;
}

// 0..1 multiplier for a country's ranking: 1 when the local opening is the
// film's earliest anywhere, halving per LATE_IMPORT_HALF_LIFE_DAYS of lag.
// Re-releases (years of lag) end up effectively at zero.
function lateImportFactor(m, country) {
  const earliest = effectiveFirstRelease(m);
  const local    = (m.countryReleases || {})[country] || m.release_date;
  if (!earliest || !local || local <= earliest) return 1;
  const lagDays = (new Date(local) - new Date(earliest)) / 86400000;
  return Math.pow(0.5, lagDays / LATE_IMPORT_HALF_LIFE_DAYS);
}

function anticipationScore(m, country) {
  if (!m) return 0;
  return smoothPop(m) * lateImportFactor(m, country);
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
        .sort((a, b) => anticipationScore(detailsMap[b.id], country) - anticipationScore(detailsMap[a.id], country))
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
// current top-15) by anticipation score (smoothed popularity × late-import
// discount). One numbering system: the calendar must never show an
// unnumbered "featured" movie next to numbered ones. Run this AFTER
// accumulateHits so the merged set is ranked.
function computeFinalRanks(hitsByCountry, moviesById) {
  const finalRanks = {};
  for (const [country, byYm] of Object.entries(hitsByCountry)) {
    finalRanks[country] = {};
    for (const [ym, ids] of Object.entries(byYm)) {
      for (const id of ids) {
        if (RadarCore.localDate(moviesById[id], country)?.slice(0, 7) !== ym) ids.delete(id);
      }
      const sorted = [...ids].sort((a, b) => anticipationScore(moviesById[b], country) - anticipationScore(moviesById[a], country) || a - b);
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
    list.sort((a, b) => smoothPop(b) - smoothPop(a))
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

// Shared stylesheet links: the component styles first, the site theme over them.
const THEME_HEAD = `<link rel="preload" href="/assets/fonts/archivo-latin.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="/assets/radar.css" />
  <link rel="stylesheet" href="/assets/theme.css" />`;

const SUPPORT_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M7 2v2M11 2v2M15 2v2"/></svg>`;

function siteHeader(active = '') {
  const link = (href, label, key) =>
    `<a href="${href}" class="ed-nav-link${active === key ? ' active' : ''}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `
<header class="ed-header">
  <div class="ed-header-inner">
    <a href="/" class="ed-brand">
      ${RADAR_SVG}
      <span class="ed-wordmark">Movie Release <span>Radar</span></span>
    </a>
    <nav class="ed-nav" aria-label="Main">
      ${link('/', 'Calendar', 'calendar')}
      ${link('/top-movies/', 'Top Movies', 'top')}
      <a href="https://ko-fi.com/serhiiomelchenko" class="ed-support" target="_blank" rel="noopener noreferrer">${SUPPORT_ICON} Support Movie Release Radar</a>
    </nav>
  </div>
</header>`;
}

const SITE_FOOTER = `
<footer class="ed-footer">
  <div class="ed-footer-inner">
    <span class="ed-footer-brand">Movie Release Radar</span>
    <span class="ed-footer-attr">
      Created by <a href="https://serhiiomelchenko.com/" target="_blank" rel="noopener">Serhii Omelchenko</a>
      &nbsp;&middot;&nbsp;
      This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.&nbsp;<a href="https://www.themoviedb.org/" target="_blank" rel="noopener"><img src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg" alt="The Movie Database (TMDB)" /></a>
    </span>
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

function buildTopMoviesPage(ym, topMovies, updatedOn = null) {
  const label        = monthLabel(ym);
  const canonicalUrl = `${SITE_BASE}/top-movies/${ym}/`;
  const pageTitle    = `Top 10 Movies in ${label}`;
  const today        = updatedOn || new Date().toISOString().slice(0, 10);
  const previewTitles = topMovies.slice(0, 3).map(m => m.title).join(', ');
  const metaDesc = escHtml(
    `The 10 most popular movies releasing in ${label}: ${previewTitles}` +
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

  const MEDALS = ['gold', 'silver', 'bronze'];
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
      ? ` &middot; <span class="mv-star">&#9733; ${m.vote_average.toFixed(1)}</span> / 10`
      : '';
    const medal = MEDALS[i] || '';
    return `
    <article class="tp-row${medal ? ' ' + medal : ''}" style="--i:${i}">
      <div>
        <div class="tp-n">${String(i + 1).padStart(2, '0')}</div>
        ${medal ? `<div class="tp-medal"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13 2c1 5-3 6-3 9-1-1-2-2-2-4-4 4-5 7-4 10 1 4 5 6 8 6s7-2 8-6c1-5-2-10-7-15Z"/><path fill="#fff0dd" d="M12 13c1 2 3 3 3 5a3 3 0 0 1-6 0c0-2 2-3 3-5Z"/></svg>${medal}</div>` : ''}
      </div>
      ${poster
        ? `<a href="/movie/${m.slug}/"><img class="tp-poster" src="${poster}" alt="${t} poster" loading="lazy" width="132" height="198" /></a>`
        : `<div class="tp-poster ed-noposter">${t}</div>`}
      <div class="tp-info">
        <h2><a class="tp-title" href="/movie/${m.slug}/">${t}</a></h2>
        <div class="tp-meta">${escHtml(relDate)}${ratingHtml}</div>
        ${genresHtml ? `<div class="mv-genres">${genresHtml}</div>` : ''}
        ${directors  ? `<div class="tp-meta">Directed by <strong style="color:var(--soft)">${directors}</strong></div>` : ''}
        ${overview   ? `<p class="tp-overview">${overview}${truncated ? '&hellip;' : ''}</p>` : ''}
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
  ${THEME_HEAD}
</head>
<body class="ed" data-tpl="ed1">
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-T3BJFZSV" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
${siteHeader('top')}
<main class="ed-wrap" style="padding-top:30px">
  <a href="/top-movies/" class="ed-back">&#8592; Top Movies by month</a>
  <div class="ed-reveal" style="display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap;margin-top:18px">
    <h1 class="ed-display">Top 10 <span class="ed-light">${escHtml(label)}</span></h1>
    <div class="ed-links"><a class="ed-btn" href="/calendar/${ym}/">All ${escHtml(label)} releases</a><a class="ed-btn accent" href="/?m=${ym}">Interactive calendar</a></div>
  </div>
  <p class="ed-note" style="margin:14px 0 22px">Ranked by TMDB popularity</p>
  <div class="ed-rule"></div>
  <div class="tp-list">
    ${moviesHtml}
  </div>
  <p class="ed-note">Last updated: ${today} &middot; Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a></p>
</main>
${SITE_FOOTER}
</body>
</html>`;
}

function buildTopMoviesIndexPage(allMonths, detailedMovies) {
  const canonicalUrl = `${SITE_BASE}/top-movies/`;
  const pageTitle    = 'Top Movies by Month';
  const metaDesc     = escHtml('Browse the top 10 most popular movies for each month, ranked by popularity. Updated daily.');
  const today        = new Date().toISOString().slice(0, 10);

  const moviesByMonth = {};
  for (const m of detailedMovies) {
    if (!m.release_date || !m.slug) continue;
    const ym = m.release_date.slice(0, 7);
    if (!moviesByMonth[ym]) moviesByMonth[ym] = [];
    moviesByMonth[ym].push(m);
  }

  const recentFirst = [...allMonths].reverse();
  const FEATURED_MONTHS = 4;
  const cardsHtml = recentFirst.slice(0, FEATURED_MONTHS).map((ym, i) => {
    const [y] = ym.split('-');
    const name = new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long' });
    const topThree = (moviesByMonth[ym] || [])
      .sort((a, b) => smoothPop(b) - smoothPop(a))
      .slice(0, 3);
    const thumbsHtml = topThree
      .filter(m => m.poster_path)
      .map(m => `<img src="${escHtml(`${IMG_BASE}w185${m.poster_path}`)}" alt="${escHtml(m.title)} poster" loading="lazy" width="118" height="177" />`)
      .join('');
    return `
    <a href="/top-movies/${ym}/" class="tp-month ed-reveal" style="--i:${i}">
      <span class="tp-month-head"><span class="tp-month-name">${escHtml(name)}</span><span class="tp-month-year">${y}</span></span>
      ${thumbsHtml ? `<span class="tp-fan">${thumbsHtml}</span>` : ''}
      <span class="tp-month-cta">View Top 10 &#8594;</span>
    </a>`;
  }).join('\n');
  const archiveHtml = recentFirst.slice(FEATURED_MONTHS).map(ym =>
    `<a href="/top-movies/${ym}/"><span class="tp-archive-name">${escHtml(monthLabel(ym))}</span><span class="tp-archive-cta">Top 10 &#8594;</span></a>`).join('\n    ');

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
  ${THEME_HEAD}
</head>
<body class="ed">
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-T3BJFZSV" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
${siteHeader('top')}
<main class="ed-wrap" style="padding-top:34px">
  <span class="ed-kicker">Updated daily</span>
  <h1 class="ed-display ed-reveal" style="margin-top:8px">Top movies <span class="ed-light">by month</span></h1>
  <p class="ed-lede" style="margin:16px 0 22px;color:var(--muted);font-size:14px">The most popular movies for each month, ranked by popularity. Updated daily.</p>
  <div class="ed-rule"></div>
  <div class="tp-months">
    ${cardsHtml}
  </div>
  ${archiveHtml ? `<span class="ed-kicker" style="margin:40px 0 6px">Earlier months</span>
  <div class="tp-archive">
    ${archiveHtml}
  </div>` : ''}
  <p class="ed-note">Last updated: ${today} &middot; Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a></p>
</main>
${SITE_FOOTER}
</body>
</html>`;
}

// A movie listed in a frozen Top 10 archive: the current record (following
// renamed slugs), or, when the movie has left the catalog, the entry as the
// archive itself printed it.
function archivedTopMovie(block, bySlug, slugIds, byId) {
  const slug = (block.match(/<h2><a href="\/movie\/([^/"]+)\/"/) || [])[1];
  if (!slug) return null;
  const current = bySlug.get(slug) || byId.get(slugIds.get(slug));
  if (current) return current;
  const text = re => { const m = block.match(re); return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : ''; };
  const title = text(/<h2><a [^>]*>([\s\S]*?)<\/a><\/h2>/);
  if (!title) return null;
  const dateText = text(/&#128197; ([^<]+)</);
  const parsed = dateText ? new Date(dateText + ' 12:00:00 UTC') : null;
  const rating = parseFloat(text(/&#9733; ([\d.]+)/));
  return {
    slug,
    title,
    poster_path: text(/image\.tmdb\.org\/t\/p\/w\d+(\/[^"]+)"/) || null,
    release_date: parsed && !isNaN(parsed) ? parsed.toISOString().slice(0, 10) : null,
    vote_average: rating || 0,
    vote_count: rating ? 1 : 0,
    genres: [...block.matchAll(/<span class="genre-tag">([^<]+)<\/span>/g)].map(g => g[1].replace(/&amp;/g, '&')),
    directors: text(/<div class="crew">[\s\S]*?<strong>([\s\S]*?)<\/strong>/).split(', ').filter(Boolean),
    overview: text(/<p class="overview">([\s\S]*?)<\/p>/).replace(/&hellip;$/, '…'),
  };
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

  let written = 0, skipped = 0, reskinned = 0;
  const bySlug = new Map(detailedMovies.filter(m => m.slug).map(m => [m.slug, m]));
  const byId = new Map(detailedMovies.map(m => [String(m.id), m]));
  const slugIds = new Map();
  for (const [id, entry] of Object.entries(loadJSON(MANIFEST_PATH, {}))) {
    for (const sl of [entry.slug, ...(entry.previousSlugs || [])]) if (sl) slugIds.set(sl, id);
  }
  for (const ym of allMonths) {
    const outPath = path.join(TOP_MOVIES_DIR, ym, 'index.html');
    // Past months: generate once, then freeze. An archive written by an older
    // template is rebuilt in the current one with its frozen order and date.
    if (ym < currentYm && fs.existsSync(outPath)) {
      const frozen = fs.readFileSync(outPath, 'utf8');
      if (!frozen.includes('data-tpl="ed1"')) {
        const order = [...frozen.matchAll(/<article class="top-item">([\s\S]*?)<\/article>/g)].map(x => archivedTopMovie(x[1], bySlug, slugIds, byId));
        const updatedOn = (frozen.match(/Last updated: (\d{4}-\d{2}-\d{2})/) || [])[1];
        if (order.length && order.every(Boolean)) {
          fs.writeFileSync(outPath, buildTopMoviesPage(ym, order, updatedOn));
          reskinned++;
          continue;
        }
      }
      skipped++;
      continue;
    }

    const topMovies = detailedMovies
      .filter(m => m.release_date && m.release_date.startsWith(ym) && m.slug)
      .sort((a, b) => smoothPop(b) - smoothPop(a))
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
  console.log(`Top movies pages: ${written} written, ${skipped} past-month(s) frozen${reskinned ? `, ${reskinned} archive(s) restyled` : ''}`);
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

// One day of a hub schedule: big date, weekday, film count, the first dozen
// titles and the rest behind a no-JS <details> (still in the page for crawlers).
const HUB_DAY_SHOWN = 12;
function hubDayHtml(date, items, i) {
  const d = new Date(date + 'T00:00:00');
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
  const row = ({ movie: m, linked }) => {
    const genre = (m.genres || [])[0];
    const titleHtml = linked ? `<a href="/movie/${m.slug}/">${escHtml(m.title)}</a>` : escHtml(m.title);
    return `<li class="hub-item">${titleHtml}${genre ? ` <span class="genre-note">&middot; ${escHtml(genre)}</span>` : ''}</li>`;
  };
  return `<section class="hub-day ed-reveal" style="--i:${Math.min(i, 8)}">
      <h3 class="hub-day-head"><span class="hub-day-num">${d.getDate()}</span><span class="hub-day-sub"><span class="ed-kicker">${weekday}</span><span class="hub-day-count">${fmtLong(date)} &middot; ${items.length} ${items.length === 1 ? 'film' : 'films'}</span></span></h3>
      <ul>
        ${items.slice(0, HUB_DAY_SHOWN).map(row).join('\n        ')}
      </ul>
      ${items.length > HUB_DAY_SHOWN ? `<details class="ed-more"><summary>Show all ${items.length} films</summary><ul>${items.slice(HUB_DAY_SHOWN).map(row).join('')}</ul></details>` : ''}
    </section>`;
}

function hubPosterCard(m, date) {
  const poster = m.poster_path ? `${IMG_BASE}w185${m.poster_path}` : '';
  return `<a class="ed-poster" href="/movie/${m.slug}/">
      ${poster ? `<img src="${poster}" alt="${escHtml(m.title)} poster" loading="lazy" width="132" height="198" />` : `<span class="ed-noposter">${escHtml(m.title)}</span>`}
      <span class="ed-poster-title">${escHtml(m.title)}</span>
      ${date ? `<span class="ed-poster-date">${fmtShort(date)}</span>` : ''}
    </a>`;
}

function buildMonthHubPage(ym, monthMovies, globalHitIds, hubMonthsSet, topMonthsSet) {
  const label        = monthLabel(ym);
  const canonicalUrl = `${SITE_BASE}/calendar/${ym}/`;
  const today        = new Date().toISOString().slice(0, 10);
  const pageTitle    = `Movies Coming Out in ${label}`;

  const hits = monthMovies.filter(m => globalHitIds.has(m.id) && m.slug)
    .sort((a, b) => smoothPop(b) - smoothPop(a));
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

  const featuredHtml = hits.slice(0, 18).map(m => hubPosterCard(m, m.release_date)).join('\n    ');

  // Day-by-day schedule: every page-worthy movie of the month, links for hits
  const byDay = {};
  for (const m of monthMovies) {
    if (!m.release_date) continue;
    (byDay[m.release_date] = byDay[m.release_date] || []).push(m);
  }
  const scheduleHtml = Object.keys(byDay).sort().map((date, i) => hubDayHtml(date, byDay[date]
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    .map(m => ({ movie: m, linked: globalHitIds.has(m.id) && !!m.slug })), i)).join('\n    ');

  const prevYm = addMonths(ym, -1), nextMonthYm = addMonths(ym, 1);
  const navLinks = [
    hubMonthsSet.has(prevYm)      ? `<a class="ed-btn" href="/calendar/${prevYm}/">&#8592; ${escHtml(monthLabel(prevYm))}</a>` : '',
    `<a class="ed-btn accent" href="/?m=${ym}">Interactive ${escHtml(label)} calendar</a>`,
    topMonthsSet.has(ym)          ? `<a class="ed-btn" href="/top-movies/${ym}/">Top 10 of ${escHtml(label)}</a>` : '',
    hubMonthsSet.has(nextMonthYm) ? `<a class="ed-btn" href="/calendar/${nextMonthYm}/">${escHtml(monthLabel(nextMonthYm))} &#8594;</a>` : '',
  ].filter(Boolean).join('\n    ');

  const introTop = hits.slice(0, 3).map(m => `<a href="/movie/${m.slug}/">${escHtml(m.title)}</a>`).join(', ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${hubHead(pageTitle, metaDesc, canonicalUrl, ogImage, schema)}
  ${THEME_HEAD}
</head>
<body class="ed">
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-T3BJFZSV" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
${siteHeader()}
<main class="ed-wrap" style="padding-top:34px">
  <span class="ed-kicker">Release calendar</span>
  <h1 class="ed-display ed-reveal" style="margin-top:8px">Movies coming out <span class="ed-light">in ${escHtml(label)}</span></h1>
  <p class="ed-lede" style="margin-top:18px">${monthMovies.length} movies ${ym < today.slice(0, 7) ? 'were released' : 'are scheduled for release'} in ${escHtml(label)}${introTop ? `, led by ${introTop}` : ''}. Below is the full day-by-day theatrical release schedule, with release dates tracked across ${SUPPORTED_COUNTRIES.length} countries and updated every night.</p>
  <nav class="hub-nav" aria-label="Related calendars">
    ${navLinks}
  </nav>
  ${featuredHtml ? `
  <h2 class="ed-sec">Featured ${escHtml(label)} releases</h2>
  <div class="ed-poster-grid">
    ${featuredHtml}
  </div>` : ''}
  <h2 class="ed-sec" style="margin-top:56px">Day-by-day schedule</h2>
  <div class="hub-days">
    ${scheduleHtml}
  </div>
  <p class="ed-note">Updated nightly &middot; Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a></p>
</main>
${SITE_FOOTER}
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
    `Upcoming movie release dates in ${name}: ${upcoming.length} movies with reported local dates` +
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

  const featuredHtml = hits.slice(0, 12).map(x => hubPosterCard(x.movie, x.date)).join('\n    ');

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
    const days = Object.keys(byYm[ym]).sort().map((date, i) => hubDayHtml(date, byYm[ym][date]
      .sort((a, b) => (b.movie.popularity || 0) - (a.movie.popularity || 0))
      .map(x => ({ movie: x.movie, linked: globalHitIds.has(x.movie.id) && !!x.movie.slug })), i)).join('\n    ');
    return `<section class="hub-month"><h2 class="ed-sec">${monthHeading}</h2>\n  <div class="hub-days">\n    ${days}\n  </div></section>`;
  }).join('\n    ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${hubHead(pageTitle, metaDesc, canonicalUrl, ogImage, schema)}
  ${THEME_HEAD}
</head>
<body class="ed">
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-T3BJFZSV" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
${siteHeader()}
<main class="ed-wrap" style="padding-top:30px">
  <a href="/releases/" class="ed-back">&#8592; Releases by country</a>
  <span class="ed-kicker" style="margin-top:18px">Movie release dates in</span>
  <h1 class="ed-hero-title ed-reveal" style="margin-top:8px;font-size:clamp(56px,7vw,96px)">${escHtml(name)}</h1>
  <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;margin-top:18px">
    <p class="ed-lede">${upcoming.length} movies have reported local release dates in ${escHtml(name)} over the coming months. Dates below are the local ${escHtml(name)} release dates, which often differ from the US or worldwide premiere — checked and updated every night.</p>
    <a class="ed-btn accent" href="/?country=${cc}">Open in the calendar &#8594;</a>
  </div>
  <div class="ed-rule" style="margin-top:26px"></div>
  ${featuredHtml ? `
  <h2 class="ed-sec" style="border-top:0;padding-top:22px">Featured upcoming releases</h2>
  <div class="ed-poster-grid">
    ${featuredHtml}
  </div>` : ''}
  ${scheduleHtml}
  <p class="ed-note">Updated nightly &middot; Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a></p>
</main>
${SITE_FOOTER}
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

  const REGIONS = [
    ['Europe', cc => !['BR', 'CA', 'US', 'AU', 'CN', 'IN', 'JP', 'KR'].includes(cc)],
    ['Americas', cc => ['BR', 'CA', 'US'].includes(cc)],
    ['Asia-Pacific', cc => ['AU', 'CN', 'IN', 'JP', 'KR'].includes(cc)],
  ];
  const byName = [...SUPPORTED_COUNTRIES].sort((a, b) => (COUNTRY_NAMES[a] || a).localeCompare(COUNTRY_NAMES[b] || b));
  const regionsHtml = REGIONS.map(([region, test], i) => {
    const list = byName.filter(test);
    return `<section class="cty-region ed-reveal" style="--i:${i}">
    <div class="cty-region-head"><h2 class="ed-sec" style="border:0;padding:0">${region}</h2><span class="cty-count">${list.length} countries</span></div>
    <div class="cty-grid">
      ${list.map(cc => `<a href="/releases/${countrySlug(cc)}/" class="cty-link"><span class="cty-name">${escHtml(COUNTRY_NAMES[cc] || cc)}</span><span class="cty-count">${countryCounts[cc] || 0} upcoming &#8594;</span></a>`).join('\n      ')}
    </div>
  </section>`;
  }).join('\n  ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${hubHead(pageTitle, metaDesc, canonicalUrl, '', schema)}
  ${THEME_HEAD}
</head>
<body class="ed">
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-T3BJFZSV" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
${siteHeader()}
<main class="ed-wrap" style="padding-top:34px">
  <span class="ed-kicker">${SUPPORTED_COUNTRIES.length} countries</span>
  <h1 class="ed-display ed-reveal" style="margin-top:8px">Release dates <span class="ed-light">by country</span></h1>
  <p class="ed-lede" style="margin-top:18px">Movies rarely open everywhere on the same day. Pick a country to see its local theatrical release calendar — every date below is tracked per country and refreshed nightly.</p>
  ${regionsHtml}
  <p class="ed-note">Updated nightly &middot; Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a></p>
</main>
${SITE_FOOTER}
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
    .sort((a, b) => smoothPop(b) - smoothPop(a))
    .slice(0, 12);

  const cards = featured.map(m => {
    const poster = m.poster_path ? `${IMG_BASE}w185${m.poster_path}` : '';
    return `    <a class="ed-poster hf-card" href="/movie/${m.slug}/">
      ${poster ? `<img src="${poster}" alt="${escHtml(m.title)} poster" loading="lazy" width="132" height="198" />` : `<span class="ed-noposter">${escHtml(m.title)}</span>`}
      <span class="ed-poster-title">${escHtml(m.title)}</span>
      ${m.release_date ? `<span class="ed-poster-date">${fmtShort(m.release_date)}</span>` : ''}
    </a>`;
  }).join('\n');

  const featuredSection = featured.length ? `<section class="home-featured ed-wrap">
  <h2 class="ed-sec">Featured movies this month</h2>
  <p class="home-sec-sub">The most popular ${escHtml(label)} releases &mdash; <a href="/calendar/${currentYm}/">see the full ${escHtml(label)} release calendar</a>.</p>
  <div class="ed-poster-grid">
${cards}
  </div>
</section>` : '';

  const monthLinks = hubMonths.map(ym =>
    `<a class="ed-chip" href="/calendar/${ym}/">${escHtml(monthLabel(ym))}</a>`).join('\n      ');
  const countryLinks = [...SUPPORTED_COUNTRIES]
    .sort((a, b) => (COUNTRY_NAMES[a] || a).localeCompare(COUNTRY_NAMES[b] || b))
    .map(cc => `<a class="ed-chip" href="/releases/${countrySlug(cc)}/">${escHtml(COUNTRY_NAMES[cc] || cc)}</a>`).join('\n      ');

  const browseSection = `<section class="home-browse ed-wrap">
  <h2 class="ed-sec">Browse release calendars</h2>
  <div class="home-browse-group">
    <h3 class="ed-kicker">By month</h3>
    <div class="ed-links">
      ${monthLinks}
    </div>
  </div>
  <div class="home-browse-group">
    <h3 class="ed-kicker">By country</h3>
    <div class="ed-links">
      ${countryLinks}
      <a class="ed-chip ed-chip-accent" href="/releases/">All countries &#8594;</a>
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
          const local = country === 'WW' ? m.release_date : RadarCore.localDate(d, country);
          if (!local || !local.startsWith(ym)) return null;
          const entry = {
            id:                m.id,
            title:             d.title,
            release_date:      local,
            countryReleases:   country === 'WW' ? {} : { [country]: local },
            releaseDataVersion: d.releaseDataVersion || 1,
            countryReleaseTypes: country === 'WW' ? {} : { [country]: d.countryReleaseTypes?.[country] },
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
          // Exact position in this country's monthly popularity ranking —
          // lets the UI say "#3 most popular" instead of a vague "top 15".
          if (entry.isHit && countryRanks[m.id]) entry.featuredRank = countryRanks[m.id];
          // Only expose slug for HIT movies — otherwise the client would
          // navigate to a noindexed page instead of opening the modal.
          if (globalHitIds.has(m.id)) entry.slug = d.slug;
          return entry;
        })
        .filter(Boolean)
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
  if (process.env.REGEN_ONLY !== '1' && !API_KEY) throw new Error('Set TMDB_API_KEY before refreshing movie data');
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
    const calendarData = Object.fromEntries([...allowedMonths].map(ym => [ym, Object.fromEntries(SUPPORTED_COUNTRIES.map(cc => [cc, []]))]));
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
    const moviesById = {};
    for (const m of loadJSON(MOVIES_PATH, [])) moviesById[m.id] = m;
    hitRanks = computeFinalRanks(hitsByCountry, moviesById);
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
          if (r.reason.status === 401 || r.reason.status === 403) throw r.reason;
          console.error(`\n  Failed movie ${batch[idx]}: ${r.reason.message}`);
        }
      });

      if (i + BATCH < idsToFetch.length) await sleep(300);
    }

    // Explicit release records are authoritative. Never merge stale dates back
    // over a withdrawn local date. A failed fetch retains its previous snapshot.
    for (const id of idsToFetch) {
      if (!detailsMap[id] && existingMovieMap[id]) detailsMap[id] = existingMovieMap[id];
      const movie = detailsMap[id], previous = existingMovieMap[id];
      if (movie && !movie.watchProviders && previous?.watchProviders) {
        movie.watchProviders = previous.watchProviders;
        movie.providersUpdatedAt = previous.providersUpdatedAt;
      }
    }
    // Rebuild country membership from typed release records, including cases
    // where the local release is in a different month from the primary date.
    for (const ym of months) for (const cc of SUPPORTED_COUNTRIES) {
      calendarData[ym] ||= {};
      calendarData[ym][cc] = [];
    }
    for (const movie of Object.values(detailsMap)) for (const [cc, date] of Object.entries(movie.countryReleases || {})) {
      const ym = date.slice(0, 7);
      if (SUPPORTED_COUNTRIES.includes(cc) && monthsSet.has(ym)) calendarData[ym][cc].push({id:movie.id, release_date:date});
    }

    console.log(`\nFetched details for ${Object.keys(detailsMap).length} movies (${idsToFetch.length} hit TMDB, ${idsToReuse.length} reused)`);

    // Persist tonight's popularity for every movie that actually hit TMDB
    // (reused entries carry stale values and must not be re-dated as fresh).
    // Must happen before computeHits so ranking sees tonight's snapshot.
    recordPopularitySnapshots(idsToFetch.map(id => detailsMap[id]).filter(Boolean));

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
        // Schema migration changes are corrections, not new audience alerts.
        if (prev.releaseDataVersion === movie.releaseDataVersion) {
          entries.push(...RadarCore.diffReleases(prev, movie, today));
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
    const moviesById = {};
    for (const m of detailedMovies) moviesById[m.id] = m;
    hitRanks = computeFinalRanks(hitsByCountry, moviesById);
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
  buildCatalog(allMovies, manifest, globalHitIds, pageCtx.dateHistory, DATA_DIR);
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
      .sort((a, b) => smoothPop(b) - smoothPop(a))
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

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
module.exports = { fetchMovieDetails, fetchMoviesForRegion, buildMoviePage, buildCalendarFiles, computeFinalRanks, main };
