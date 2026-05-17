// One-shot TMDB fixture recorder. Hits the live TMDB API and writes each
// response to a JSON file under tests/fixtures/. Tests then load those
// fixtures via tests/_helpers/pipeline_mocks.js instead of issuing live
// HTTP requests, which makes them deterministic, fast, and offline-runnable.
//
// Run: `npm run capture:fixtures` (from the repo root).
// Uses Node's built-in fetch (Node 18+). No external deps.
//
// ----------------------------------------------------------------------
// What this script does NOT do
// ----------------------------------------------------------------------
//
// It does NOT update any test assertions. Tests have their own hardcoded
// values (imdb_id="tt1727824", director="Bryan Singer", etc.); this script
// only refreshes the JSON fixture files those tests read.
//
// If TMDB ever changes a response in a way that conflicts with a hardcoded
// assertion (rare — e.g. a director name correction, or a popularity shift
// that affects sort order), the next test run will fail with a diff that
// names exactly what changed. At that point YOU decide whether to update
// the assertion or whether the change indicates a real bug. Auto-updating
// the assertions would silently rubber-stamp drift, defeating the point.
//
// ----------------------------------------------------------------------
// When to re-run
// ----------------------------------------------------------------------
//
// - Adding a new test scenario: append to FIXTURES below, run the script,
//   then write the test that consumes the new fixture.
// - A test starts failing in a way that looks like data drift (rather than
//   a code regression): re-run capture and inspect the git diff on the
//   fixture file to confirm the change is TMDB-side.
// - Periodic refresh: not necessary; fixtures don't go stale on their own.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// Same hardcoded TMDB API key as lib/app.js:29. Already public in this repo.
const TMDB_API_KEY = "f6d7fb04f4d4d6b07d2d750811e73a4c";
const TMDB_BASE = "https://api.themoviedb.org/3";

// Build a search URL the same way lib/memo_pipeline.js's tmdbSearch does
// (URLSearchParams encoding), so the request matches what the production
// code will issue.
function searchUrl(query, year) {
  const p = new URLSearchParams({ api_key: TMDB_API_KEY, query });
  if (year != null) p.set("primary_release_year", String(year));
  return `${TMDB_BASE}/search/movie?${p}`;
}

function detailsUrl(tmdbId) {
  return `${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=credits`;
}

// [output path relative to repo root, full TMDB URL]
const FIXTURES = [
  // Scenario 1: Bohemian Rhapsody (Bryan Singer 2018) — search across year ± 1
  ["tests/fixtures/memo/search-bohemian-rhapsody-2017.json", searchUrl("Bohemian Rhapsody", 2017)],
  ["tests/fixtures/memo/search-bohemian-rhapsody-2018.json", searchUrl("Bohemian Rhapsody", 2018)],
  ["tests/fixtures/memo/search-bohemian-rhapsody-2019.json", searchUrl("Bohemian Rhapsody", 2019)],

  // Scenario 1b: same title, no year — TMDB query without primary_release_year.
  // Used by the "no year given → single TMDB search" test.
  ["tests/fixtures/memo/search-bohemian-rhapsody-no-year.json", searchUrl("Bohemian Rhapsody", null)],

  // Scenario 5: "I'm Still Here" (TMDB id 1000837, Brazilian film, real year
  // 2024). The user's memo says 2025, so we search 2024/2025/2026. The TMDB
  // details for 1000837 currently have no imdb_id, so buildMovieEntryFromTmdb
  // throws and processMemoLine returns status="error". Captures the failure
  // mode for regression coverage.
  ["tests/fixtures/memo/search-im-still-here-2024.json", searchUrl("I'm Still Here", 2024)],
  ["tests/fixtures/memo/search-im-still-here-2025.json", searchUrl("I'm Still Here", 2025)],
  ["tests/fixtures/memo/search-im-still-here-2026.json", searchUrl("I'm Still Here", 2026)],
  ["tests/fixtures/tmdb-ainda-estou-aqui.json", detailsUrl(1000837)],

  // Scenario 2: 기생충 (Parasite, Bong Joon-ho 2019) — search across year ± 1
  // The query is Korean script; URLSearchParams handles the UTF-8 encoding.
  ["tests/fixtures/memo/search-parasite-2018.json", searchUrl("기생충", 2018)],
  ["tests/fixtures/memo/search-parasite-2019.json", searchUrl("기생충", 2019)],
  ["tests/fixtures/memo/search-parasite-2020.json", searchUrl("기생충", 2020)],

  // Scenario 4: TMDB zero-results case — a deliberately nonsensical title
  // and far-future year. Real TMDB call so the envelope shape is authentic
  // (page/total_results/total_pages keys all present even when results=[]).
  ["tests/fixtures/memo/search-empty-2998.json", searchUrl("Xyzqqq Notarealmovie", 2998)],
  ["tests/fixtures/memo/search-empty-2999.json", searchUrl("Xyzqqq Notarealmovie", 2999)],
  ["tests/fixtures/memo/search-empty-3000.json", searchUrl("Xyzqqq Notarealmovie", 3000)],

  // Scenario 1 details: Bohemian Rhapsody = TMDB id 424694
  // (Confirmed by inspecting search results before capture; updateable here
  // if TMDB ever shifts the canonical ID.)
  ["tests/fixtures/tmdb-bohemian-rhapsody.json", detailsUrl(424694)],

  // Scenario 2 details are reused from the pre-existing tests/fixtures/tmdb-parasite.json
];

async function captureOne(path, url) {
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`${path} ← ${url} → HTTP ${r.status} ${r.statusText}`);
  }
  const body = await r.json();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(body, null, 2) + "\n", "utf8");
}

async function main() {
  console.log(`Capturing ${FIXTURES.length} fixture${FIXTURES.length === 1 ? "" : "s"} from TMDB...`);
  for (const [path, url] of FIXTURES) {
    await captureOne(path, url);
    console.log(`  ✓ ${path}`);
  }
  console.log("Done.");
}

await main();
