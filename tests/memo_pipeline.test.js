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
import { installPipelineMocks, loadFixture } from "./_helpers/pipeline_mocks.js";

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
  assert.equal(result.rawLine, "보헤미안 랩소디 2018");

  assert.deepStrictEqual(result.parseResult, {
    is_movie: true,
    title: "Bohemian Rhapsody",
    year: 2018,
    director: null,
    title_korean_overlay: null,
  });

  // result.candidates is exactly what enrichCandidatesForMatch produces from
  // the year-offset merge. Primary year (2018) yields [424694]; year+1 (2019)
  // yields [769442, 643844]; year-1 (2017) is empty. Only 424694 has a
  // registered details fixture; the other two trigger the helper's "no
  // fixture" error, which enrichCandidatesForMatch's try/catch swallows and
  // produces `{...c, directors: []}` (no _details).
  const search2018Results = loadFixture("memo/search-bohemian-rhapsody-2018").results;
  const search2019Results = loadFixture("memo/search-bohemian-rhapsody-2019").results;
  const brDetails = loadFixture("tmdb-bohemian-rhapsody");
  assert.deepStrictEqual(result.candidates, [
    { ...search2018Results[0], directors: ["Bryan Singer"], _details: brDetails },
    { ...search2019Results[0], directors: [] },
    { ...search2019Results[1], directors: [] },
  ]);

  assert.deepStrictEqual(result.matchResult, {
    matched_tmdb_id: 424694,
    confidence: "high",
    reasoning: "title and year line up exactly",
  });

  assert.deepStrictEqual(result.entry, {
    title: "Bohemian Rhapsody",
    year: 2018,
    director: "Bryan Singer",
    is_korean_director: false,
    imdb_id: "tt1727824",
    imdb_url: "https://www.imdb.com/title/tt1727824",
    tmdb_url: "https://www.themoviedb.org/movie/424694",
    tmdb_title: null,
    tmdb_original_title: "Bohemian Rhapsody",
    tmdb_original_language: "English",
    tmdb_director_name_1: "Bryan Singer",
    tmdb_director_name_2: null,
    tmdb_num_directors: 1,
    tmdb_poster_url:
      "https://image.tmdb.org/t/p/w200/lHu1wtNaczFPGFDTrjCSzeLPTKN.jpg",
  });

  // 2 Gemini (A + B) + 3 TMDB searches (year ± 1) + 3 details-fetch attempts
  // (one per merged candidate; the two unregistered fixtures throw inside the
  // mock but their calls are still logged because `calls.push` runs before
  // URL routing).
  assert.equal(calls.length, 8);
  const tmdbSearches = calls.filter((c) => c.url.includes("/search/movie"));
  const tmdbDetails = calls.filter((c) => c.url.includes("/movie/424694"));
  const geminiCalls = calls.filter((c) =>
    c.url.includes("generativelanguage.googleapis.com")
  );
  assert.equal(tmdbSearches.length, 3);
  // Exactly one /movie/424694 fetch — the eager enrichment in
  // enrichCandidatesForMatch covers it (424694 is at index 0 of the merged
  // candidates, well within CANDIDATE_DETAILS_FETCH_LIMIT). No lazy fetch
  // fires later because the matched candidate already carries _details.
  assert.equal(tmdbDetails.length, 1, "exactly one /movie/424694 fetch");
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
  assert.equal(result.rawLine, "Bohemian Rhapsody");

  assert.deepStrictEqual(result.parseResult, {
    is_movie: true,
    title: "Bohemian Rhapsody",
    year: null,
    director: null,
    title_korean_overlay: null,
  });

  // Exact-match the candidates produced by the single no-year search (6
  // results from TMDB). All 6 are within CANDIDATE_DETAILS_FETCH_LIMIT (=10),
  // so all get enrichment attempts. Only id=424694 has a registered details
  // fixture; the other five enrichment attempts fail-and-swallow → all the
  // non-matched candidates end up with `directors: []` and no `_details`.
  const searchNoYearResults = loadFixture(
    "memo/search-bohemian-rhapsody-no-year"
  ).results;
  assert.deepStrictEqual(result.candidates, [
    { ...searchNoYearResults[0], directors: ["Bryan Singer"], _details: loadFixture("tmdb-bohemian-rhapsody") },
    { ...searchNoYearResults[1], directors: [] },
    { ...searchNoYearResults[2], directors: [] },
    { ...searchNoYearResults[3], directors: [] },
    { ...searchNoYearResults[4], directors: [] },
    { ...searchNoYearResults[5], directors: [] },
  ]);

  assert.deepStrictEqual(result.matchResult, {
    matched_tmdb_id: 424694,
    confidence: "high",
    reasoning: "title matches the most popular 'Bohemian Rhapsody' entry",
  });

  // Full entry shape. Identical to the year-bearing scenario — `year` is
  // derived from TMDB's release_date (2018-10-24), NOT from Call A's year
  // (which is null here). The two tests share the same expected entry by
  // design: regardless of whether the user gives a year, if Call B picks
  // 424694, the same entry comes out.
  assert.deepStrictEqual(result.entry, {
    title: "Bohemian Rhapsody",
    year: 2018,
    director: "Bryan Singer",
    is_korean_director: false,
    imdb_id: "tt1727824",
    imdb_url: "https://www.imdb.com/title/tt1727824",
    tmdb_url: "https://www.themoviedb.org/movie/424694",
    tmdb_title: null,
    tmdb_original_title: "Bohemian Rhapsody",
    tmdb_original_language: "English",
    tmdb_director_name_1: "Bryan Singer",
    tmdb_director_name_2: null,
    tmdb_num_directors: 1,
    tmdb_poster_url:
      "https://image.tmdb.org/t/p/w200/lHu1wtNaczFPGFDTrjCSzeLPTKN.jpg",
  });

  // 2 Gemini + 1 TMDB search (no offsets) + 6 details-fetch attempts (all 6
  // merged candidates are within CANDIDATE_DETAILS_FETCH_LIMIT=10).
  assert.equal(calls.length, 9);
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
});

// ---------------------------------------------------------------------------
// Scenario 2 — Korean original (Parasite) + Korean-director map hit.
// The map should override the TMDB romanization ("Bong Joon Ho" → "봉준호").
// ---------------------------------------------------------------------------

test("processMemoLine: Korean original (기생충) with Korean-director map hit", async () => {
  const calls = installPipelineMocks({
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
  assert.equal(result.rawLine, "기생충 2019");

  assert.deepStrictEqual(result.parseResult, {
    is_movie: true,
    title: "기생충",
    year: 2019,
    director: null,
    title_korean_overlay: null,
  });

  // Exact-match the candidates. Only the 2019 search returns a result
  // (Parasite, id=496243); 2018 and 2020 are empty. Single candidate;
  // enriched with _details since 496243 has a registered fixture.
  const searchParasite2019Results = loadFixture("memo/search-parasite-2019").results;
  assert.deepStrictEqual(result.candidates, [
    {
      ...searchParasite2019Results[0],
      directors: ["Bong Joon Ho"],
      _details: loadFixture("tmdb-parasite"),
    },
  ]);

  assert.deepStrictEqual(result.matchResult, {
    matched_tmdb_id: 496243,
    confidence: "high",
    reasoning: "exact Korean title match",
  });

  // Full entry shape. Key contracts pinned by this deep match:
  //   - Korean-director map override: `director` is "봉준호" (not TMDB's
  //     romanization), `is_korean_director` is recomputed to true.
  //   - TMDB-sourced fields are untouched: `tmdb_director_name_1` remains
  //     the Latin "Bong Joon Ho" — only `director` is overridden.
  //   - Parasite has a separate English title, so both `tmdb_title` and
  //     `tmdb_original_title` are populated (not the collapsed-to-null
  //     behavior of the Bohemian Rhapsody scenarios).
  assert.deepStrictEqual(result.entry, {
    title: "Parasite (기생충)",
    year: 2019,
    director: "봉준호",
    is_korean_director: true,
    imdb_id: "tt6751668",
    imdb_url: "https://www.imdb.com/title/tt6751668",
    tmdb_url: "https://www.themoviedb.org/movie/496243",
    tmdb_title: "Parasite",
    tmdb_original_title: "기생충",
    tmdb_original_language: "Korean",
    tmdb_director_name_1: "Bong Joon Ho",
    tmdb_director_name_2: null,
    tmdb_num_directors: 1,
    tmdb_poster_url:
      "https://image.tmdb.org/t/p/w200/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg",
  });

  // 2 Gemini (A + B) + 3 TMDB searches (year ± 1, only 2019 has results) +
  // 1 details fetch (1 merged candidate within CANDIDATE_DETAILS_FETCH_LIMIT).
  assert.equal(calls.length, 6);
});

// ---------------------------------------------------------------------------
// Scenario 2b — Korean phonetic transliteration of a Brazilian film with a
// year that's off by one. "아임 스틸 히어 2025" (the user's memo) should
// resolve to "Ainda Estou Aqui" / "I'm Still Here" (TMDB id 1000837, real
// release year 2024 — Call A's year=2025 is wrong, but the year-offset
// search catches it via the year-1 offset).
//
// This test was added in response to a real-world failure report: the user
// observed that the pipeline sometimes produces a final entry without an
// IMDB URL for this memo line. The most likely cause is Call B picking one
// of the year-2025 candidates (e.g. id=1551447 "Pretend I'm Still Here" or
// id=1632888 "I'm Still Here: A Dog's Purpose Forever") whose TMDB details
// happen to lack `imdb_id` — buildMovieEntryFromTmdb then throws. This test
// pins the CORRECT outcome: when Call B picks 1000837 (the actual movie),
// the pipeline produces a valid entry with imdb_id="tt14961016".
//
// If TMDB ever drops the imdb_id from id=1000837, this test fails with the
// "Entry build failed: TMDB response has no imdb_id" message, surfacing
// the regression. Reproducing the picked-wrong-candidate failure would
// require either fixture-capturing those candidates' details OR adding a
// filter step (drop enriched candidates with empty imdb_id) before Call B.
// ---------------------------------------------------------------------------

test("processMemoLine: Korean phonetic with off-by-one year (I'm Still Here / Ainda Estou Aqui)", async () => {
  const calls = installPipelineMocks({
    geminiParseResult: {
      is_movie: true,
      title: "I'm Still Here",
      year: 2025,
      director: null,
      title_korean_overlay: null,
    },
    geminiMatchResult: {
      matched_tmdb_id: 1000837,
      confidence: "high",
      reasoning:
        "the Brazilian film by Walter Salles released 2024-09-19; the memo's year is off by one but the title matches",
    },
    tmdbSearchFixtures: {
      "I'm Still Here|2024": "memo/search-im-still-here-2024",
      "I'm Still Here|2025": "memo/search-im-still-here-2025",
      "I'm Still Here|2026": "memo/search-im-still-here-2026",
    },
    tmdbDetailsFixtures: {
      // Only the matched candidate is registered. The other four candidates
      // within CANDIDATE_DETAILS_FETCH_LIMIT will hit the mock's "no fixture"
      // branch and their details fetches will throw — enrichCandidatesForMatch
      // swallows the throw and produces `{ ...c, directors: [] }`.
      1000837: "tmdb-ainda-estou-aqui",
    },
  });

  const result = await processMemoLine({
    rawLine: "아임 스틸 히어 2025",
    geminiKey: "TEST_GEMINI_KEY",
    tmdbApiKey: "TEST_TMDB_KEY",
    koreanDirectorMap: new Map(),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.rawLine, "아임 스틸 히어 2025");

  assert.deepStrictEqual(result.parseResult, {
    is_movie: true,
    title: "I'm Still Here",
    year: 2025,
    director: null,
    title_korean_overlay: null,
  });

  // Merged candidates in primary-year-first order. Primary (2025) returns 2
  // results; year+1 (2026) returns 1; year-1 (2024) returns 6 — 9 total, all
  // within CANDIDATE_DETAILS_FETCH_LIMIT (=10), so all get enrichment
  // attempts. Only id=1000837 has a registered details fixture; the other
  // 8 attempts fail-and-swallow → `directors: []` and no `_details`. The
  // matched candidate is the only one carrying `_details`.
  const search2025Results = loadFixture("memo/search-im-still-here-2025").results;
  const search2026Results = loadFixture("memo/search-im-still-here-2026").results;
  const search2024Results = loadFixture("memo/search-im-still-here-2024").results;
  const aindaDetails = loadFixture("tmdb-ainda-estou-aqui");
  assert.deepStrictEqual(result.candidates, [
    { ...search2025Results[0], directors: [] },
    { ...search2025Results[1], directors: [] },
    { ...search2026Results[0], directors: [] },
    { ...search2024Results[0], directors: ["Walter Salles"], _details: aindaDetails },
    { ...search2024Results[1], directors: [] },
    { ...search2024Results[2], directors: [] },
    { ...search2024Results[3], directors: [] },
    { ...search2024Results[4], directors: [] },
    { ...search2024Results[5], directors: [] },
  ]);

  assert.deepStrictEqual(result.matchResult, {
    matched_tmdb_id: 1000837,
    confidence: "high",
    reasoning:
      "the Brazilian film by Walter Salles released 2024-09-19; the memo's year is off by one but the title matches",
  });

  // Full entry shape. Note: `year` is 2024 (derived from TMDB's
  // release_date), NOT 2025 (Call A's year) — the year-offset search
  // catches the off-by-one and the matched candidate's TMDB year wins at
  // entry-build time. `title` is the parenthetical-combined form because
  // TMDB's title ("I'm Still Here") differs from original_title ("Ainda
  // Estou Aqui").
  assert.deepStrictEqual(result.entry, {
    title: "I'm Still Here (Ainda Estou Aqui)",
    year: 2024,
    director: "Walter Salles",
    is_korean_director: false,
    imdb_id: "tt14961016",
    imdb_url: "https://www.imdb.com/title/tt14961016",
    tmdb_url: "https://www.themoviedb.org/movie/1000837",
    tmdb_title: "I'm Still Here",
    tmdb_original_title: "Ainda Estou Aqui",
    tmdb_original_language: "Portuguese",
    tmdb_director_name_1: "Walter Salles",
    tmdb_director_name_2: null,
    tmdb_num_directors: 1,
    tmdb_poster_url:
      "https://image.tmdb.org/t/p/w200/gZnsMbhCvhzAQlKaVpeFRHYjGyb.jpg",
  });

  // 2 Gemini (A + B) + 3 TMDB searches (year ± 1) + 9 details-fetch attempts
  // (all 9 merged candidates within CANDIDATE_DETAILS_FETCH_LIMIT=10; only
  // the 1000837 fetch succeeds, the other 8 throw due to no registered
  // fixture).
  assert.equal(calls.length, 14);
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
  assert.equal(result.rawLine, "watched with J");
  assert.deepStrictEqual(result.parseResult, { is_movie: false });
  assert.equal(result.candidates, undefined);
  assert.equal(result.matchResult, undefined);
  assert.equal(result.entry, undefined);

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
  assert.equal(result.rawLine, "Xyzqqq Notarealmovie 2999");
  assert.deepStrictEqual(result.parseResult, {
    is_movie: true,
    title: "Xyzqqq Notarealmovie",
    year: 2999,
    director: null,
    title_korean_overlay: null,
  });
  assert.equal(result.candidates, undefined);
  assert.equal(result.matchResult, undefined);
  assert.equal(result.entry, undefined);

  // 1 Gemini (Call A only) + 3 TMDB searches (year ± 1) + 0 details fetches
  // (no candidates to enrich since every search returned empty).
  assert.equal(calls.length, 4);
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
