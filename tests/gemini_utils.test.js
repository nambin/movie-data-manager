import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  getGeminiKey,
  parseMemoLine,
  matchTmdbCandidate,
  translateDirectorToKorean,
  CALL_A_SYSTEM,
  CALL_B_SYSTEM,
  CALL_C_SYSTEM,
} from "../lib/gemini_utils.js";

beforeEach(() => {
  globalThis.fetch = undefined;
});

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

// Install a fetch mock that returns the same response for every call.
// `responseBodyOrFn`: either a fixed body or a function (call) → body, async OK.
// Returns the captured `calls` array (each entry: { url, opts }).
function installFetchMock(
  responseBodyOrFn,
  { ok = true, status = 200, statusText = "OK" } = {}
) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const body =
      typeof responseBodyOrFn === "function"
        ? await responseBodyOrFn({ url, opts })
        : responseBodyOrFn;
    return {
      ok,
      status,
      statusText,
      json: async () => body,
    };
  };
  return calls;
}

// Wrap a JSON payload in the shape a real Gemini response uses
// (data.candidates[0].content.parts[0].text contains the JSON string).
function geminiResponseFor(payload) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify(payload) }],
        },
      },
    ],
  };
}

// Extract the request body that was POSTed to fetch.
function bodyOf(call) {
  return JSON.parse(call.opts.body);
}

// ---------------------------------------------------------------------------
// Key access
// ---------------------------------------------------------------------------
//
// getGeminiKey() returns whatever esbuild --define inlined as __GEMINI_KEY__
// at build time. Under `node --test`, esbuild doesn't run and the identifier
// is undefined → the `typeof` guard in getGeminiKey returns null. That's the
// only behavior we can verify without running a real build; the dev/prod
// build paths are covered by inspecting the bundle after `npm run build` /
// `npm run build:dev`.

test("getGeminiKey returns null when no key was inlined at build time", () => {
  assert.equal(getGeminiKey(), null);
});

// ---------------------------------------------------------------------------
// callGemini envelope (tested via parseMemoLine, which is the simplest path)
// ---------------------------------------------------------------------------

test("Gemini call: missing apiKey throws synchronously-rejected promise", async () => {
  await assert.rejects(
    () => parseMemoLine("Anora 2024", ""),
    /Missing Gemini API key/
  );
});

test("Gemini call: hits the gemini-flash-latest endpoint by default", async () => {
  const calls = installFetchMock(
    geminiResponseFor({ is_movie: true, title: "Anora" })
  );
  await parseMemoLine("Anora 2024", "AIzaSyKEY");
  assert.match(
    calls[0].url,
    /\/v1beta\/models\/gemini-flash-latest:generateContent\?/
  );
});

test("Gemini call: API key is passed as the ?key= query parameter", async () => {
  const calls = installFetchMock(
    geminiResponseFor({ is_movie: true, title: "x" })
  );
  await parseMemoLine("x", "AIzaSyMY_KEY_123");
  assert.match(calls[0].url, /[?&]key=AIzaSyMY_KEY_123(?:&|$)/);
});

test("Gemini call: special characters in the API key are URL-encoded", async () => {
  const calls = installFetchMock(
    geminiResponseFor({ is_movie: true, title: "x" })
  );
  // Wouldn't appear in a real AI Studio key, but the encodeURIComponent path
  // is worth pinning down — a `+` or `/` shouldn't be interpreted as URL syntax.
  await parseMemoLine("x", "abc+def/ghi");
  assert.match(calls[0].url, /[?&]key=abc%2Bdef%2Fghi(?:&|$)/);
});

test("Gemini call: POSTs JSON with temperature=0 and a responseSchema", async () => {
  const calls = installFetchMock(
    geminiResponseFor({ is_movie: true, title: "x" })
  );
  await parseMemoLine("x", "AIzaSyKEY");

  // Exact match on opts after dropping `body` (a long JSON-stringified blob
  // whose contents are covered by other tests). Catches accidental extra
  // fields in the request meta.
  const { body: _body, ...opts } = calls[0].opts;
  assert.deepStrictEqual(opts, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  // Exact match on the two scalar generationConfig fields. responseSchema's
  // shape is pinned by the per-call schema tests below — we only check
  // presence here (deepStrictEqual can't express "exists, any value").
  const body = bodyOf(calls[0]);
  const { temperature, responseMimeType, responseSchema } =
    body.generationConfig;
  assert.deepStrictEqual(
    { temperature, responseMimeType },
    { temperature: 0, responseMimeType: "application/json" }
  );
  assert.ok(responseSchema);
});

test("Gemini call: throws on non-OK HTTP with the API-reported message", async () => {
  installFetchMock(
    { error: { message: "API key not valid. Please pass a valid API key." } },
    { ok: false, status: 400, statusText: "Bad Request" }
  );
  await assert.rejects(
    () => parseMemoLine("x", "BAD_KEY"),
    /Gemini 400.*API key not valid/
  );
});

test("Gemini call: throws on non-OK when the body isn't JSON-parseable", async () => {
  // Simulate a CDN/edge layer returning HTML by overriding json() to throw.
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    statusText: "Bad Gateway",
    json: async () => {
      throw new Error("not json");
    },
  });
  await assert.rejects(
    () => parseMemoLine("x", "KEY"),
    /Gemini 502.*Bad Gateway/
  );
});

test("Gemini call: throws when response has no candidate text", async () => {
  installFetchMock({ candidates: [] }); // valid envelope but no candidates
  await assert.rejects(
    () => parseMemoLine("x", "KEY"),
    /no text content/
  );
});

test("Gemini call: throws when the candidate text isn't JSON", async () => {
  installFetchMock({
    candidates: [
      { content: { parts: [{ text: "this is not json {" }] } },
    ],
  });
  await assert.rejects(
    () => parseMemoLine("x", "KEY"),
    /non-JSON/
  );
});

// ---------------------------------------------------------------------------
// Call A — parseMemoLine
// ---------------------------------------------------------------------------

test("parseMemoLine: forwards the raw memo line as the user content", async () => {
  const calls = installFetchMock(
    geminiResponseFor({ is_movie: true, title: "Bohemian Rhapsody" })
  );
  await parseMemoLine("보헤미안 랩소디", "KEY");
  // Exact match on the user-content subtree: catches accidental extra fields
  // on the user message. The rest of the body (system_instruction, generationConfig)
  // is covered by other tests.
  assert.deepStrictEqual(bodyOf(calls[0]).contents, [
    { role: "user", parts: [{ text: "보헤미안 랩소디" }] },
  ]);
});

test("parseMemoLine: sends the Call A system instruction verbatim", async () => {
  const calls = installFetchMock(
    geminiResponseFor({ is_movie: true, title: "x" })
  );
  await parseMemoLine("x", "KEY");
  const body = bodyOf(calls[0]);
  assert.deepStrictEqual(body.system_instruction, {
    parts: [{ text: CALL_A_SYSTEM }],
  });
});

test("parseMemoLine: schema declares all five expected fields", async () => {
  const calls = installFetchMock(
    geminiResponseFor({ is_movie: true, title: "x" })
  );
  await parseMemoLine("x", "KEY");
  const schema = bodyOf(calls[0]).generationConfig.responseSchema;
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "director",
    "is_movie",
    "title",
    "title_korean_overlay",
    "year",
  ]);
  assert.deepEqual(schema.required, ["is_movie"]);
});

test("parseMemoLine: returns the parsed JSON payload from the candidate text", async () => {
  installFetchMock(
    geminiResponseFor({
      is_movie: true,
      title: "Bohemian Rhapsody",
      year: 2018,
      director: null,
      title_korean_overlay: null,
    })
  );
  const result = await parseMemoLine("보헤미안 랩소디", "KEY");
  assert.deepEqual(result, {
    is_movie: true,
    title: "Bohemian Rhapsody",
    year: 2018,
    director: null,
    title_korean_overlay: null,
  });
});

test("parseMemoLine: handles is_movie=false (non-movie chatter)", async () => {
  installFetchMock(geminiResponseFor({ is_movie: false }));
  const result = await parseMemoLine("watched with J", "KEY");
  assert.deepEqual(result, { is_movie: false });
});

test("parseMemoLine: handles the parenthetical Korean-overlay pattern", async () => {
  installFetchMock(
    geminiResponseFor({
      is_movie: true,
      title: "Adolescence",
      year: null,
      director: null,
      title_korean_overlay: "소년의 시간",
    })
  );
  const result = await parseMemoLine("Adolescence (소년의 시간)", "KEY");
  assert.deepStrictEqual(result, {
    is_movie: true,
    title: "Adolescence",
    year: null,
    director: null,
    title_korean_overlay: "소년의 시간",
  });
});

// ---------------------------------------------------------------------------
// Call B — matchTmdbCandidate
// ---------------------------------------------------------------------------

test("matchTmdbCandidate: sends the Call B system instruction verbatim", async () => {
  const calls = installFetchMock(
    geminiResponseFor({
      matched_tmdb_id: 1,
      confidence: "high",
      reasoning: "ok",
    })
  );
  await matchTmdbCandidate({
    rawLine: "x",
    parsed: { title: "x", year: null, director: null },
    candidates: [],
    apiKey: "KEY",
  });
  assert.deepStrictEqual(bodyOf(calls[0]).system_instruction, {
    parts: [{ text: CALL_B_SYSTEM }],
  });
});

test("matchTmdbCandidate: builds the full user prompt verbatim", async () => {
  const calls = installFetchMock(
    geminiResponseFor({
      matched_tmdb_id: 424694,
      confidence: "high",
      reasoning: "title matches",
    })
  );
  await matchTmdbCandidate({
    rawLine: "보헤미안 랩소디",
    parsed: { title: "Bohemian Rhapsody", year: 2018, director: null },
    candidates: [
      {
        id: 424694,
        title: "Bohemian Rhapsody",
        original_title: "Bohemian Rhapsody",
        release_date: "2018-10-24",
        directors: ["Bryan Singer"],
        popularity: 89.234,
      },
    ],
    apiKey: "KEY",
  });
  const text = bodyOf(calls[0]).contents[0].parts[0].text;
  assert.deepStrictEqual(
    text,
    [
      `User memo line: 보헤미안 랩소디`,
      `Parsed query: title="Bohemian Rhapsody" year=2018 director=""`,
      ``,
      `TMDB candidates:`,
      `1. tmdb_id=424694 title="Bohemian Rhapsody" original_title="Bohemian Rhapsody" year=2018 directors="Bryan Singer" popularity=89.2 has_imdb=unknown`,
    ].join("\n")
  );
});

test("matchTmdbCandidate: builds the full user prompt with multiple candidates", async () => {
  const calls = installFetchMock(
    geminiResponseFor({
      matched_tmdb_id: 424694,
      confidence: "high",
      reasoning: "ok",
    })
  );
  await matchTmdbCandidate({
    rawLine: "Bohemian Rhapsody",
    parsed: { title: "Bohemian Rhapsody", year: null, director: null },
    candidates: [
      {
        id: 424694,
        title: "Bohemian Rhapsody",
        original_title: "Bohemian Rhapsody",
        release_date: "2018-10-24",
        directors: ["Bryan Singer"],
        popularity: 89.2,
      },
      {
        id: 999,
        title: "Other Movie",
        original_title: "他",
        release_date: "2010-01-01",
        directors: ["A", "B"],
        popularity: 5.31,
      },
    ],
    apiKey: "KEY",
  });
  const text = bodyOf(calls[0]).contents[0].parts[0].text;
  // Pins multi-candidate rendering. parsed.year=null renders as "-";
  // popularity=5.3 (not 5.31) verifies toFixed(1) rounding;
  // directors="A, B" verifies multi-director joining.
  assert.deepStrictEqual(
    text,
    [
      `User memo line: Bohemian Rhapsody`,
      `Parsed query: title="Bohemian Rhapsody" year=- director=""`,
      ``,
      `TMDB candidates:`,
      `1. tmdb_id=424694 title="Bohemian Rhapsody" original_title="Bohemian Rhapsody" year=2018 directors="Bryan Singer" popularity=89.2 has_imdb=unknown`,
      `2. tmdb_id=999 title="Other Movie" original_title="他" year=2010 directors="A, B" popularity=5.3 has_imdb=unknown`,
    ].join("\n")
  );
});

test("matchTmdbCandidate: builds the full user prompt with missing candidate fields", async () => {
  const calls = installFetchMock(
    geminiResponseFor({
      matched_tmdb_id: null,
      confidence: "low",
      reasoning: "no match",
    })
  );
  await matchTmdbCandidate({
    rawLine: "Mystery",
    parsed: { title: "Mystery", year: null, director: null },
    candidates: [
      {
        id: 42,
        title: "Mystery",
        original_title: "Mystery",
        release_date: "",
        // directors and popularity intentionally omitted
      },
    ],
    apiKey: "KEY",
  });
  const text = bodyOf(calls[0]).contents[0].parts[0].text;
  // Pins fallback rendering for absent/empty candidate fields:
  //   directors=undefined  → directors="-"  (via `||` fallback)
  //   popularity=undefined → popularity=-   (via typeof check)
  //   release_date=""      → year=          (empty, NOT "-"; the `??`
  //                                          fallback only triggers for
  //                                          null/undefined, not "")
  //   _details=undefined   → has_imdb=unknown (no details fetched for this
  //                                            candidate)
  // The "year=-" in the Parsed query line comes from parsed.year=null,
  // not the candidate row.
  assert.deepStrictEqual(
    text,
    [
      `User memo line: Mystery`,
      `Parsed query: title="Mystery" year=- director=""`,
      ``,
      `TMDB candidates:`,
      `1. tmdb_id=42 title="Mystery" original_title="Mystery" year= directors="-" popularity=- has_imdb=unknown`,
    ].join("\n")
  );
});

test("matchTmdbCandidate: has_imdb=yes/no/unknown branches by _details + imdb_id presence", async () => {
  // Exercises all three branches of the has_imdb computation:
  //   - candidate with _details.imdb_id truthy   → has_imdb=yes
  //   - candidate with _details but no imdb_id   → has_imdb=no
  //   - candidate without _details (its details fetch failed in production)
  //     → has_imdb=unknown
  // This is a defensive cue in Call B's prompt. In practice processMemoLine
  // now drops the has_imdb=no candidates before Call B (they would crash
  // buildMovieEntryFromTmdb downstream), so Call B mainly sees yes/unknown.
  const calls = installFetchMock(
    geminiResponseFor({ matched_tmdb_id: 1, confidence: "high", reasoning: "ok" })
  );
  await matchTmdbCandidate({
    rawLine: "Anora",
    parsed: { title: "Anora", year: 2024, director: null },
    candidates: [
      {
        id: 1,
        title: "Anora",
        original_title: "Anora",
        release_date: "2024-10-18",
        directors: ["Sean Baker"],
        popularity: 50,
        _details: { imdb_id: "tt28607951" }, // truthy → yes
      },
      {
        id: 2,
        title: "Anora (Unreleased Cut)",
        original_title: "Anora (Unreleased Cut)",
        release_date: "2026-01-01",
        directors: [],
        popularity: 0.05,
        _details: { imdb_id: "" }, // empty → no
      },
      {
        id: 3,
        title: "Anora Behind the Scenes",
        original_title: "Anora Behind the Scenes",
        release_date: "2024-12-01",
        directors: [],
        popularity: 0.1,
        // no _details → unknown
      },
    ],
    apiKey: "KEY",
  });
  const text = bodyOf(calls[0]).contents[0].parts[0].text;
  assert.deepStrictEqual(
    text,
    [
      `User memo line: Anora`,
      `Parsed query: title="Anora" year=2024 director=""`,
      ``,
      `TMDB candidates:`,
      `1. tmdb_id=1 title="Anora" original_title="Anora" year=2024 directors="Sean Baker" popularity=50.0 has_imdb=yes`,
      `2. tmdb_id=2 title="Anora (Unreleased Cut)" original_title="Anora (Unreleased Cut)" year=2026 directors="-" popularity=0.1 has_imdb=no`,
      `3. tmdb_id=3 title="Anora Behind the Scenes" original_title="Anora Behind the Scenes" year=2024 directors="-" popularity=0.1 has_imdb=unknown`,
    ].join("\n")
  );
});

test("matchTmdbCandidate: schema returns matched_tmdb_id + confidence + reasoning", async () => {
  const calls = installFetchMock(
    geminiResponseFor({
      matched_tmdb_id: 1,
      confidence: "high",
      reasoning: "ok",
    })
  );
  await matchTmdbCandidate({
    rawLine: "x",
    parsed: { title: "x", year: null, director: null },
    candidates: [],
    apiKey: "KEY",
  });
  const schema = bodyOf(calls[0]).generationConfig.responseSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "confidence",
    "matched_tmdb_id",
    "reasoning",
  ]);
  assert.deepEqual(schema.required, ["matched_tmdb_id", "confidence"]);
  assert.deepEqual(schema.properties.confidence.enum, ["high", "medium", "low"]);
});

test("matchTmdbCandidate: returns the parsed match result", async () => {
  installFetchMock(
    geminiResponseFor({
      matched_tmdb_id: 496243,
      confidence: "high",
      reasoning: "title and year line up exactly",
    })
  );
  const r = await matchTmdbCandidate({
    rawLine: "Parasite 2019",
    parsed: { title: "Parasite", year: 2019, director: null },
    candidates: [
      {
        id: 496243,
        title: "Parasite",
        original_title: "기생충",
        release_date: "2019-05-30",
        directors: ["Bong Joon Ho"],
        popularity: 50,
      },
    ],
    apiKey: "KEY",
  });
  assert.deepEqual(r, {
    matched_tmdb_id: 496243,
    confidence: "high",
    reasoning: "title and year line up exactly",
  });
});

test("matchTmdbCandidate: returns matched_tmdb_id=null when the LLM rejects all candidates", async () => {
  installFetchMock(
    geminiResponseFor({
      matched_tmdb_id: null,
      confidence: "low",
      reasoning: "none of the candidates resemble the memo line",
    })
  );
  const r = await matchTmdbCandidate({
    rawLine: "totally obscure thing",
    parsed: { title: "totally obscure thing", year: null, director: null },
    candidates: [
      {
        id: 1,
        title: "Something Else",
        original_title: "Something Else",
        release_date: "2020-01-01",
        directors: [],
        popularity: 0,
      },
    ],
    apiKey: "KEY",
  });
  assert.deepStrictEqual(r, {
    matched_tmdb_id: null,
    confidence: "low",
    reasoning: "none of the candidates resemble the memo line",
  });
});

// ---------------------------------------------------------------------------
// Call C — translateDirectorToKorean
// ---------------------------------------------------------------------------

test("translateDirectorToKorean: sends the Call C system instruction verbatim", async () => {
  const calls = installFetchMock(geminiResponseFor({ korean_name: null }));
  await translateDirectorToKorean({
    romanizedName: "Someone",
    movieTitle: "Something",
    apiKey: "KEY",
  });
  assert.deepStrictEqual(bodyOf(calls[0]).system_instruction, {
    parts: [{ text: CALL_C_SYSTEM }],
  });
});

test("translateDirectorToKorean: builds the full user prompt verbatim", async () => {
  const calls = installFetchMock(
    geminiResponseFor({ korean_name: "박찬욱" })
  );
  await translateDirectorToKorean({
    romanizedName: "Park Chan-wook",
    movieTitle: "Decision to Leave",
    apiKey: "KEY",
  });
  const text = bodyOf(calls[0]).contents[0].parts[0].text;
  assert.deepStrictEqual(
    text,
    [
      `Romanized director name: Park Chan-wook`,
      `Film: Decision to Leave`,
    ].join("\n")
  );
});

test("translateDirectorToKorean: builds the full user prompt with missing movieTitle", async () => {
  const calls = installFetchMock(
    geminiResponseFor({ korean_name: null })
  );
  await translateDirectorToKorean({
    romanizedName: "Someone",
    movieTitle: undefined,
    apiKey: "KEY",
  });
  const text = bodyOf(calls[0]).contents[0].parts[0].text;
  // movieTitle=undefined → "(unknown)" via the `?? "(unknown)"` fallback.
  assert.deepStrictEqual(
    text,
    [`Romanized director name: Someone`, `Film: (unknown)`].join("\n")
  );
});

test("translateDirectorToKorean: extracts korean_name from the structured response", async () => {
  installFetchMock(geminiResponseFor({ korean_name: "봉준호" }));
  const result = await translateDirectorToKorean({
    romanizedName: "Bong Joon Ho",
    movieTitle: "Mickey 17",
    apiKey: "KEY",
  });
  assert.equal(result, "봉준호");
});

test("translateDirectorToKorean: returns null when LLM declines (non-Korean director)", async () => {
  installFetchMock(geminiResponseFor({ korean_name: null }));
  const result = await translateDirectorToKorean({
    romanizedName: "Christopher Nolan",
    movieTitle: "Oppenheimer",
    apiKey: "KEY",
  });
  assert.equal(result, null);
});

test("translateDirectorToKorean: defensive — returns null when the field is missing", async () => {
  installFetchMock(geminiResponseFor({})); // schema-violating response
  const result = await translateDirectorToKorean({
    romanizedName: "Someone",
    movieTitle: "Something",
    apiKey: "KEY",
  });
  assert.equal(result, null);
});