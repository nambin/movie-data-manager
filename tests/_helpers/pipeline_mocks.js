// Test helpers for end-to-end testing of lib/memo_pipeline.js.
//
// The pipeline issues fetches against TWO different APIs (Gemini + TMDB)
// inside one orchestration. installPipelineMocks installs a single
// URL-dispatching globalThis.fetch that:
//   1) routes Gemini POSTs to canned responses (Call A first, then Call B
//      by call order), and
//   2) routes TMDB GETs to fixture files based on URL pattern.
//
// Tests pass PLAIN JS OBJECTS for the LLM responses; this helper wraps them
// in the proper Gemini response envelope (candidates[0].content.parts[0].text).
// No test should have to construct that shape directly — that's the "clean
// LLM mock interface" we want.

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Fixture loading (matches the pattern in tests/tmdb_utils.test.js:9-11)
// ---------------------------------------------------------------------------

export function loadFixture(name) {
  // `name` is a path relative to tests/fixtures/, with or without .json.
  // E.g. "tmdb-parasite" or "memo/search-bohemian-rhapsody-2018".
  const path = new URL(
    `../fixtures/${name.endsWith(".json") ? name : name + ".json"}`,
    import.meta.url
  );
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ---------------------------------------------------------------------------
// Gemini envelope wrapper (same shape as gemini_utils.test.js)
// ---------------------------------------------------------------------------

function geminiResponseFor(payload) {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
  };
}

// ---------------------------------------------------------------------------
// installPipelineMocks
// ---------------------------------------------------------------------------
//
// Options:
//   geminiParseResult    Plain object — what Call A returns. Wrapped into
//                        the Gemini envelope automatically.
//   geminiMatchResult    Plain object — what Call B returns. May be omitted
//                        if the test expects no Call B (e.g. not_movie path).
//   tmdbSearchFixtures   Map keyed by "query|year" → fixture name to load
//                        and serve when the pipeline issues a search.
//                        Examples:
//                          "Bohemian Rhapsody|2018" → "memo/search-bohemian-rhapsody-2018"
//                          "기생충|2020"            → "memo/search-parasite-2020"
//   tmdbDetailsFixtures  Map keyed by tmdb_id (number) → fixture name for
//                        /movie/{id}?append_to_response=credits requests.
//
// Returns the `calls` array (each entry: { url, opts }) so tests can assert
// on which endpoints fired and in what order.
export function installPipelineMocks({
  geminiParseResult,
  geminiMatchResult,
  tmdbSearchFixtures = {},
  tmdbDetailsFixtures = {},
} = {}) {
  const calls = [];
  let geminiCallCount = 0;

  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });

    // -- Gemini ---------------------------------------------------------------
    if (url.includes("generativelanguage.googleapis.com")) {
      geminiCallCount += 1;
      let payload;
      if (geminiCallCount === 1) {
        if (!geminiParseResult) {
          throw new Error(
            "installPipelineMocks: Call A fired but no geminiParseResult was provided"
          );
        }
        payload = geminiParseResult;
      } else if (geminiCallCount === 2) {
        if (!geminiMatchResult) {
          throw new Error(
            "installPipelineMocks: Call B fired but no geminiMatchResult was provided"
          );
        }
        payload = geminiMatchResult;
      } else {
        throw new Error(
          `installPipelineMocks: unexpected Gemini call #${geminiCallCount}`
        );
      }
      return makeResponse(geminiResponseFor(payload));
    }

    // -- TMDB search ----------------------------------------------------------
    // `/search/movie?query=...&primary_release_year=YYYY` (year optional)
    const searchMatch = url.match(/\/search\/movie\?/);
    if (searchMatch) {
      const parsed = new URL(url);
      const query = parsed.searchParams.get("query") ?? "";
      const year = parsed.searchParams.get("primary_release_year") ?? "";
      const key = `${query}|${year}`;
      const fixtureName = tmdbSearchFixtures[key];
      if (!fixtureName) {
        throw new Error(
          `installPipelineMocks: no TMDB search fixture registered for key "${key}". ` +
            `Did you forget to add it to tmdbSearchFixtures?`
        );
      }
      return makeResponse(loadFixture(fixtureName));
    }

    // -- TMDB details ---------------------------------------------------------
    // `/movie/{id}?api_key=...&append_to_response=credits`
    const detailsMatch = url.match(/\/movie\/(\d+)\?/);
    if (detailsMatch) {
      const tmdbId = Number(detailsMatch[1]);
      const fixtureName = tmdbDetailsFixtures[tmdbId];
      if (!fixtureName) {
        throw new Error(
          `installPipelineMocks: no TMDB details fixture registered for tmdb_id=${tmdbId}. ` +
            `Did you forget to add it to tmdbDetailsFixtures?`
        );
      }
      return makeResponse(loadFixture(fixtureName));
    }

    throw new Error(
      `installPipelineMocks: unmocked URL ${url} — tests should stub every endpoint`
    );
  };

  return calls;
}

// Tiny Response shim — same shape callGemini and the TMDB helpers rely on.
function makeResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  };
}
