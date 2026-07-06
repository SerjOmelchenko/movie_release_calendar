# Organic Traffic Analysis — July 2026

Based on GSC export (last 12 months, through 2026-07-06), the live index, and a code audit.

## TL;DR

The site is not "a site that never got traffic" — it's a site that **had traffic and lost it**.
It grew to ~300 clicks/day by April 2, then impressions collapsed **97% on April 10–11**,
coinciding with the end of Google's March 2026 core update (rolled out Mar 27 – Apr 8), which
explicitly targeted thin/programmatic content at scale. A month later, the May 16 cleanup
(PR #28) deleted the pages that had earned **74% of all historical clicks**, removing any
chance of those pages recovering.

## The numbers

| Month | Clicks | Impressions |
|---|---|---|
| 2026-03 (from Mar 23) | 831 | 23,331 |
| 2026-04 | 1,608 | 41,620 |
| 2026-05 | 90 | 1,130 |
| 2026-06 | 62 | 790 |
| 2026-07 (6 days) | 7 | 106 |

Peak day: April 2 — 304 clicks, 11,126 impressions. Cliff: April 10 → 11, impressions
fell from ~570 to ~40/day and never recovered.

## What was actually winning (and what wasn't)

Clicks by query type:

- **Title-only queries for obscure regional movies: 918 clicks.** Filipino/Vivamax titles
  (*stepdaddy*, *scorpio nights 4*, *sawsawan*, *ligo*), Punjabi (*rabb da radio 3*,
  *carry on jatta 4*), Malayalam (*vaazha ii*), Indonesian, Tamil (*tn 2026*). Top GSC
  countries: India, US, Philippines, Indonesia, Germany.
- **"[title] release date": 239 clicks** — mostly positions 9–12 (page 1 bottom / page 2),
  losing to knowledge panels and IMDb.
- **"[title] + country" (e.g. "rabb da radio 3 germany", "vaazha 2 netherlands"): only 15
  queries but positions 4–8** — the site's *best* rankings. Per-country release data is the
  unique asset, and it wins when the query includes a country.
- Generic calendar queries ("new movies July 2026", "movies coming out this week"):
  **~0 clicks — no pages target them at all.** The `/top-movies/` pages earned 4 clicks total.

The niche the site can win: **movies too small for IMDb/Fandango coverage, and
country-specific release queries.** The head queries (Marvel-scale titles) are unwinnable
against knowledge panels on a young domain.

## What went wrong

1. **March 2026 core update (Mar 27 – Apr 8) devalued the site.** ~880 near-identical
   templated pages (~300 words each, TMDB synopsis duplicated across hundreds of TMDB-mirror
   sites), no internal link graph, brand-new domain, no backlinks. Textbook "scaled content
   abuse / low differentiation" profile that this update targeted. New-site "honeymoon"
   ranking, then reassessment — the classic pattern.
2. **The May 16 cleanup deleted the winners.** 776 of the 996 pages that appear in GSC no
   longer exist — they earned 1,743 of 2,366 movie-page clicks. The hit-gate
   (top-15 popularity per country, or rating ≥ 7 with 50+ votes) kept the *head* titles
   (where the site can't rank) and 404'd the *tail* titles (where it was ranking). The gate
   optimizes for movie popularity, but traffic lived in the unpopular tail.
3. **Architecture starves every page of internal links.**
   - Homepage → **zero crawlable links**. The calendar is client-side JS and navigates via
     `window.location.href` click handlers — no `<a>` tags exist even after rendering.
   - Only ~160 movie pages get any internal link (top-20 lists on 8 `/top-movies/` month
     pages). The other ~720 are sitemap-only orphans.
   - Movie pages link out only to `/` and `/top-movies/` — no related movies, no hubs.
4. **No pages match recurring demand.** No month hubs ("movies coming out in July 2026"),
   no country hubs ("movie releases in Germany"), no this-week page, despite the data for
   all of these already sitting in `data/movies.json` (7,041 movies × ~30 countries).

## Recovery plan

Everything below fits the existing pipeline: TMDB nightly fetch → `scripts/generate.js` →
static pages → GitHub Pages. No new infrastructure.

### P0 — Reverse the self-inflicted damage (highest impact)

1. **Reinstate the tail, gated by content completeness instead of popularity.** Generate a
   page for any movie that has enough substance for a real page (e.g. synopsis ≥ 40 words
   + ≥ 3 country dates + at least cast *or* trailer *or* director), regardless of
   popularity. Keep 404s only for genuinely empty/junk records (`5gresabab1123`-type rows,
   typo slugs). The obscure titles are where the clicks were.
2. **Never delete a URL that has earned impressions.** Persist earned slugs (like
   `hits.json` accumulates hits) and exempt them from demotion.

### P1 — Make pages substantively unique (core-update recovery requirement)

3. **Release-date change tracking — the genuinely unique dataset.** The nightly run already
   re-fetches every movie; diff `countryReleases`/`release_date` against yesterday and
   accumulate a `data/date-history.json` (same pattern as `hits.json`). Surface it on each
   movie page: "Release date history: originally Mar 7 2026 → delayed to Jun 12 2026."
   Nobody else publishes delay history for tail titles; it also creates natural freshness
   signals and answers real queries ("was X delayed?").
4. **Data-driven prose per page** (generated from the country matrix, unique per movie):
   release-order narrative ("Opens first in France on Jan 14, two days before the US"),
   day-of-week/season context, days-until countdown, staggered-vs-day-and-date rollout.
5. **FAQ block + `FAQPage` schema** on movie pages: "When does X come out in the US / UK /
   India?" — matches the exact long-tail phrasing that already converts at positions 4–8.
6. **Digital/streaming dates.** TMDB's `release_dates` endpoint returns a `type` per date
   (theatrical / digital / physical / TV) — same API call family, one more field to store.
   "When is X streaming" queries are high-volume and far less knowledge-panel-dominated
   than theatrical dates.

### P2 — Build the link graph and demand-matching hubs

7. **Static, crawlable homepage content**: render a "Releasing this week/month" list with
   real `<a href="/movie/…">` links into `index.html` at generate time; keep the JS
   calendar as an enhancement. Use `<a>` tags inside the calendar/list rendering.
8. **Related movies** on every movie page (same month + genre, 6–10 links) — de-orphans
   the catalog in one change.
9. **Month hubs** (`/calendar/2026-07/`): full month release list, targeting
   "movies coming out in {month} {year}" — recurring demand every month, forever.
10. **Country hubs** (`/releases/germany/`, `/releases/india/`, …): "Movie releases in
    {Country} — {Month} {Year}", generated from `countryReleases`. This is the unique-data
    play at hub level, and GSC shows country-modified queries are where the site ranks best.
11. Cross-link: movie page → its month hub + country hubs; hubs → movie pages.

### P3 — Authority & expectations

12. A young domain devalued by a core update typically needs **the next core update** to be
    reassessed — expect months, not weeks, even with perfect execution. Interim traffic will
    come from *new* tail pages (fresh titles get a fair shot before sitewide signals fully
    apply).
13. Realistic link building for a solo static site: embeddable release-countdown/date-table
    widget, Reddit/regional film communities (Filipino/Punjabi film subreddits map exactly to
    the winning queries), directories. Even a handful of real links matters at this size.

## Suggested implementation order

| Step | Change | Where |
|---|---|---|
| 1 | Content-completeness gate + reinstate earned slugs | `generate.js` hit logic |
| 2 | Related-movies block + FAQ + country-hub links on movie pages | `generate.js` page template |
| 3 | Static this-month list w/ `<a>` links on homepage | `generate.js` + `index.html` |
| 4 | Month hubs + country hubs | `generate.js` |
| 5 | Date-change history (nightly diff) + on-page display | `generate.js` |
| 6 | Digital/streaming release types | `generate.js` fetch + template |
