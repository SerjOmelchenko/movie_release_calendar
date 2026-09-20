# Movie Release Radar experience improvements

The existing static site now supports five additions. Date shortcuts and email digests are excluded.

- **Local release dates:** Movie pages and detail dialogs use the selected country's date for the headline, status, Google Calendar and ICS export. An unknown local date never falls back to a worldwide date. Cinema and digital/rental dates remain separate. Existing untyped records are labeled “Reported local release” until refreshed.
- **Global search:** A generated search index covers every stored movie, including films outside the selected month and films without standalone pages. Search combines title, genre and rating filters, handles accents, and exposes non-featured matches. Detail shards avoid fetching the entire movie database for each watchlist.
- **Personal release radar:** Existing locally saved movie IDs are preserved. The watchlist shows local announcements, date moves, withdrawals and releases within seven days. It sorts upcoming and released entries by the selected country's date. Whole-watchlist ICS export omits movies whose local dates are unknown and uses stable per-movie/per-country event identifiers. Downloads are snapshots, not subscription feeds.
- **Where to watch:** Movie pages and dialogs display subscription/free or rental/purchase availability for the selected country. Provider information comes from TMDB's JustWatch-backed endpoint, links to the returned TMDB watch page, and includes attribution and the actual check date. Missing availability is explicit.
- **First visit and sharing:** An inline country confirmation replaces the automatic tour. Share links preserve country, month, calendar/list mode, genre, rating and search. Valid URL selections take precedence over saved browser preferences. Existing `?m=YYYY-MM` links still work.

## Local development

Requires Node 22 or later.

```sh
npm ci
npm test
npm run generate:cached
npm run dev
```

The site runs at `http://127.0.0.1:5174/`. Generated files and all assets remain compatible with GitHub Pages.

## Data updates

Set `TMDB_API_KEY` in the process environment for API-backed generation. In GitHub Actions use the existing repository secret of that name. Do not commit credentials.

```sh
# One-time migration of already published movie pages; accepts optional movie IDs.
npm run enrich
# Refresh provider availability for every saved movie, including the archive.
npm run providers
# Regenerate pages and catalog files from the saved data without API requests.
npm run generate:cached
# Full refresh: existing nightly pipeline, including typed dates and providers.
npm run generate
```

The generator obtains credits, videos, release records and provider data in one appended movie-details request. Regional discovery uses theatrical release types and regional date bounds. Explicit release records are authoritative; withdrawn dates are not merged back from stale cache. On an individual network failure the previous movie snapshot is retained. Authentication errors stop API generation without replacing the existing dataset.

`data/search-index.json` supplies cross-month discovery. `data/catalog/00.json` through `63.json` supply details and release histories, selected by movie ID modulo 64. The nightly and backfill workflows commit these alongside existing generated files.

Both dates and providers depend on source coverage. No service availability is inferred from a digital-release date. If the first enrichment has not run, provider sections show an honest unavailable state. Cached regeneration alone cannot fetch new provider data.

The nightly workflow also refreshes missing provider data and checks records older than seven days across the entire saved catalog, including historical movies outside the release discovery window. It then rebuilds the pages and detail shards. To populate viewing options without repeating release discovery, run **Nightly Generate** on the desired branch with **providers_only** enabled. GitHub Pages publishes from `main`; a run on a feature branch only updates that branch. No API credentials are written into site files.

Provider requests use the [TMDB watch-provider endpoint](https://developer.themoviedb.org/reference/movie-watch-providers), at most 20 initial requests per second with retry backoff and `Retry-After` handling ([rate-limit guidance](https://developer.themoviedb.org/docs/rate-limiting)). Authentication errors abort before cached data is modified; individual failures preserve the previous listings and check dates. A refresh yielding no listings fails instead of silently publishing an empty feature. The provider panel initially opens rental/purchase options when subscription/free options are absent.

## Validation

`npm test` checks typed release extraction, unknown local dates, date changes, safe provider URLs, shared-view validation, Unicode-safe ICS folding, cross-month search, page/dialog integration, watchlist migration/export and excluded UI controls. DOM integration tests run the real homepage script and generated movie template against isolated fixtures without analytics or live requests.

## Popularity ranks

Monthly country ranks use global TMDB popularity adjusted for release timing. They do not measure anticipation among that country's viewers. The average uses only samples dated within the last seven calendar days, includes the current snapshot once, and uses available samples when fewer than seven days have been collected. Movies moved to another month or without a local date are excluded from the old month's ranks; their standalone pages remain available.

Poster badges show the exact rank. Number 1 has the largest red flame and a double-weight accent border; ranks 2–3 have a smaller flame and emphasis; 4–10 have a compact red flame; 11–25 use a light outline; 26 onward use muted gray. All tiers have a dark background for readability over posters. Mobile badges shrink to fit the calendar. Single-film days, grouped posters, list cards and dialogs use the same tiers. Redundant featured-count and anticipation labels are removed, including the movie-page featured banner.
