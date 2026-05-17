// End-to-end tests for lib/memo_pipeline.js's processMemoLine.
//
// Architecture (see tests/_helpers/pipeline_mocks.js for the helper):
//   - TMDB calls (/search/movie, /movie/{id}) are routed to real captured
//     fixtures committed under tests/fixtures/ and tests/fixtures/memo/.
//     The capture script is scripts/capture-fixtures.mjs; re-run via
//     `npm run capture:fixtures` if TMDB responses drift.
//   - Gemini calls (Call A: parseMemoLine, Call B: matchTmdbCandidate) are
//     mocked by passing PLAIN JS OBJECTS to installPipelineMocks; the helper
//     wraps them in the proper response envelope.
//
// Production code (lib/memo_pipeline.js) is NOT modified for testability —
// the URL-dispatching globalThis.fetch lets the orchestration run unchanged.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { processMemoLine } from "../lib/memo_pipeline.js";
import { installPipelineMocks } from "./_helpers/pipeline_mocks.js";

beforeEach(() => {
  globalThis.fetch = undefined;
});

// ---------------------------------------------------------------------------
// Scenario 1 — Korean phonetic transliteration → English happy path.
// "보헤미안 랩소디 2018" → Bohemian Rhapsody (2018, dir. Bryan Singer).
// ---------------------------------------------------------------------------

test("processMemoLine: Korean phonetic → English (Bohemian Rhapsody) happy path", async () => {
  const calls = installPipelineMocks({
    geminiParseResult: {
      is_movie: true,
      title: "Bohemian Rhapsody",
      year: 2018,
      director: null,
      title_korean_overlay: null,
    },
    geminiMatchResult: {
      matched_tmdb_id: 424694,
      confidence: "high",
      reasoning: "title and year line up exactly",
    },
    tmdbSearchFixtures: {
      "Bohemian Rhapsody|2017": "memo/search-bohemian-rhapsody-2017",
      "Bohemian Rhapsody|2018": "memo/search-bohemian-rhapsody-2018",
      "Bohemian Rhapsody|2019": "memo/search-bohemian-rhapsody-2019",
    },
    tmdbDetailsFixtures: {
      424694: "tmdb-bohemian-rhapsody",
    },
  });

  const result = await processMemoLine({
    rawLine: "보헤미안 랩소디 2018",
    geminiKey: "TEST_GEMINI_KEY",
    tmdbApiKey: "TEST_TMDB_KEY",
    koreanDirectorMap: new Map(),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.entry.year, 2018);
  assert.equal(result.entry.director, "Bryan Singer");
  assert.equal(result.entry.is_korean_director, false);
  assert.equal(result.entry.imdb_id, "tt1727824");
  assert.equal(result.entry.tmdb_url, "https://www.themoviedb.org/movie/424694");
  // Bohemian Rhapsody is an English-original film, so tmdb_title and
  // tmdb_original_title coincide → tmdb_title is null per buildMovieEntryFromTmdb.
  assert.equal(result.entry.tmdb_title, null);
  assert.equal(result.entry.tmdb_original_title, "Bohemian Rhapsody");
  assert.equal(result.entry.tmdb_director_name_1, "Bryan Singer");

  // result.candidates is the array the review-card UI binds to. The matched
  // candidate should be present AND carry _details (it was within the
  // CANDIDATE_DETAILS_FETCH_LIMIT, so enrichCandidatesForMatch fetched its
  // /movie/{id} response and stashed it for the picker change handler).
  assert.ok(
    Array.isArray(result.candidates) && result.candidates.length > 0,
    "result.candidates must be a non-empty array for the review-card dropdown"
  );
  const matchedBohemian = result.candidates.find((c) => c.id === 424694);
  assert.ok(matchedBohemian, "matched candidate (id=424694) must appear in result.candidates");
  assert.ok(matchedBohemian._details, "matched candidate should carry enriched _details");

  // 3 TMDB searches (year ± 1) + 1 TMDB details fetch + 2 Gemini calls (A + B).
  // Details fetch happens during enrichCandidatesForMatch (top-5 enrichment).
  const tmdbSearches = calls.filter((c) => c.url.includes("/search/movie"));
  const tmdbDetails = calls.filter((c) => c.url.includes("/movie/424694"));
  const geminiCalls = calls.filter((c) =>
    c.url.includes("generativelanguage.googleapis.com")
  );
  assert.equal(tmdbSearches.length, 3);
  assert.ok(tmdbDetails.length >= 1, "expected at least one details fetch for the matched movie");
  assert.equal(geminiCalls.length, 2);
});

// ---------------------------------------------------------------------------
// Scenario 1b — Same Bohemian Rhapsody match but NO year in the memo.
// Verifies that when Call A returns year=null, tmdbSearch fires exactly ONE
// search (no year-offset expansion) and Call B still finds the right movie
// among the many "Bohemian Rhapsody"-titled entries the unfiltered search
// returns (making-of docs, etc.).
// ---------------------------------------------------------------------------

test("processMemoLine: Bohemian Rhapsody with NO year — only one TMDB search fires", async () => {
  const calls = installPipelineMocks({
    geminiParseResult: {
      is_movie: true,
      title: "Bohemian Rhapsody",
      year: null,
      director: null,
      title_korean_overlay: null,
    },
    geminiMatchResult: {
      matched_tmdb_id: 424694,
      confidence: "high",
      reasoning: "title matches the most popular 'Bohemian Rhapsody' entry",
    },
    tmdbSearchFixtures: {
      // Key uses empty year because primary_release_year is omitted when null.
      "Bohemian Rhapsody|": "memo/search-bohemian-rhapsody-no-year",
    },
    tmdbDetailsFixtures: {
      424694: "tmdb-bohemian-rhapsody",
    },
  });

  const result = await processMemoLine({
    rawLine: "Bohemian Rhapsody",
    geminiKey: "TEST_GEMINI_KEY",
    tmdbApiKey: "TEST_TMDB_KEY",
    koreanDirectorMap: new Map(),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.entry.imdb_id, "tt1727824");
  assert.equal(result.entry.director, "Bryan Singer");

  // Key assertion: ONE search call, not three.
  // (The year-offset expansion only runs when parsed.year is truthy.)
  const tmdbSearches = calls.filter((c) => c.url.includes("/search/movie"));
  assert.equal(tmdbSearches.length, 1, "no-year path must fire exactly one TMDB search");
  // The single search must NOT carry a primary_release_year param.
  assert.equal(
    new URL(tmdbSearches[0].url).searchParams.has("primary_release_year"),
    false,
    "no-year search should omit primary_release_year"
  );

  // Same review-card contract as the year-bearing scenario.
  const matched = result.candidates.find((c) => c.id === 424694);
  assert.ok(matched, "matched candidate (id=424694) must appear in result.candidates");
  assert.ok(matched._details, "matched candidate should carry enriched _details");
});

// ---------------------------------------------------------------------------
// Scenario 2 — Korean original (Parasite) + Korean-director map hit.
// The map should override the TMDB romanization ("Bong Joon Ho" → "봉준호").
// ---------------------------------------------------------------------------

test("processMemoLine: Korean original (기생충) with Korean-director map hit", async () => {
  installPipelineMocks({
    geminiParseResult: {
      is_movie: true,
      title: "기생충",
      year: 2019,
      director: null,
      title_korean_overlay: null,
    },
    geminiMatchResult: {
      matched_tmdb_id: 496243,
      confidence: "high",
      reasoning: "exact Korean title match",
    },
    tmdbSearchFixtures: {
      "기생충|2018": "memo/search-parasite-2018",
      "기생충|2019": "memo/search-parasite-2019",
      "기생충|2020": "memo/search-parasite-2020",
    },
    tmdbDetailsFixtures: {
      496243: "tmdb-parasite", // reuses pre-existing fixture
    },
  });

  const koreanDirectorMap = new Map([["Bong Joon Ho", "봉준호"]]);

  const result = await processMemoLine({
    rawLine: "기생충 2019",
    geminiKey: "TEST_GEMINI_KEY",
    tmdbApiKey: "TEST_TMDB_KEY",
    koreanDirectorMap,
  });

  assert.equal(result.status, "ok");
  // Map override: director is the Korean form, NOT the TMDB romanization.
  assert.equal(result.entry.director, "봉준호");
  assert.equal(result.entry.is_korean_director, true);
  // The TMDB-sourced fields are untouched — only `director` gets the override.
  assert.equal(result.entry.tmdb_director_name_1, "Bong Joon Ho");
  assert.equal(result.entry.imdb_id, "tt6751668");
  assert.equal(result.entry.tmdb_original_language, "Korean");
  // Parasite has a separate English title — both `tmdb_title` and
  // `tmdb_original_title` should be present.
  assert.equal(result.entry.tmdb_title, "Parasite");
  assert.equal(result.entry.tmdb_original_title, "기생충");

  // result.candidates is the array the review-card UI binds to. Same checks
  // as the Bohemian Rhapsody scenario: matched candidate present + enriched.
  assert.ok(
    Array.isArray(result.candidates) && result.candidates.length > 0,
    "result.candidates must be a non-empty array for the review-card dropdown"
  );
  const matchedParasite = result.candidates.find((c) => c.id === 496243);
  assert.ok(matchedParasite, "matched candidate (id=496243) must appear in result.candidates");
  assert.ok(matchedParasite._details, "matched candidate should carry enriched _details");
});

// ---------------------------------------------------------------------------
// Scenario 3 — `is_movie: false` short-circuits the pipeline.
// No TMDB calls, no Call B. Only Call A fires.
// ---------------------------------------------------------------------------

test("processMemoLine: is_movie=false short-circuits before any TMDB or Call B activity", async () => {
  const calls = installPipelineMocks({
    geminiParseResult: { is_movie: false },
    // geminiMatchResult intentionally omitted — Call B should never fire.
    // tmdbSearchFixtures + tmdbDetailsFixtures intentionally empty.
  });

  const result = await processMemoLine({
    rawLine: "watched with J",
    geminiKey: "TEST_GEMINI_KEY",
    tmdbApiKey: "TEST_TMDB_KEY",
    koreanDirectorMap: new Map(),
  });

  assert.equal(result.status, "not_movie");
  assert.deepStrictEqual(result.parseResult, { is_movie: false });
  assert.equal(result.entry, undefined);
  assert.equal(result.candidates, undefined);

  // Only ONE fetch happened — Call A. No TMDB, no Call B.
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("generativelanguage.googleapis.com"));
});

// ---------------------------------------------------------------------------
// Scenario 4 — TMDB returns zero results across all year offsets → no_match.
// Call B should NOT fire (pipeline short-circuits when candidates is empty).
// ---------------------------------------------------------------------------

test("processMemoLine: TMDB zero results across year ± 1 → status=no_match, Call B skipped", async () => {
  const calls = installPipelineMocks({
    geminiParseResult: {
      is_movie: true,
      title: "Xyzqqq Notarealmovie",
      year: 2999,
      director: null,
      title_korean_overlay: null,
    },
    // geminiMatchResult intentionally omitted — Call B should never fire.
    tmdbSearchFixtures: {
      "Xyzqqq Notarealmovie|2998": "memo/search-empty-2998",
      "Xyzqqq Notarealmovie|2999": "memo/search-empty-2999",
      "Xyzqqq Notarealmovie|3000": "memo/search-empty-3000",
    },
    // tmdbDetailsFixtures intentionally empty — no movie picked, no details.
  });

  const result = await processMemoLine({
    rawLine: "Xyzqqq Notarealmovie 2999",
    geminiKey: "TEST_GEMINI_KEY",
    tmdbApiKey: "TEST_TMDB_KEY",
    koreanDirectorMap: new Map(),
  });

  assert.equal(result.status, "no_match");
  assert.equal(result.entry, undefined);
  assert.equal(result.candidates, undefined);
  assert.equal(result.matchResult, undefined);

  // Call A + 3 TMDB searches. NO Call B, NO details fetch.
  const geminiCalls = calls.filter((c) =>
    c.url.includes("generativelanguage.googleapis.com")
  );
  const tmdbSearches = calls.filter((c) => c.url.includes("/search/movie"));
  const tmdbDetails = calls.filter((c) =>
    /\/movie\/\d+\?/.test(c.url) && !c.url.includes("/search/movie")
  );
  assert.equal(geminiCalls.length, 1, "only Call A should have fired");
  assert.equal(tmdbSearches.length, 3, "all three year offsets should be searched");
  assert.equal(tmdbDetails.length, 0, "no details fetch when no candidates");
});
