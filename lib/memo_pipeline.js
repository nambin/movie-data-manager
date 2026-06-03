// Memo-driven bulk-import orchestration.
//
// One per-line pipeline runs end-to-end: Call A (parse) → TMDB search →
// Call B (match) → entry build. Korean director resolution falls back to
// the romanized→Korean map only — Call C (LLM translation) is currently
// disabled.
//
// See prompt-web-app-with-llm.md for the full design, which still describes
// the three-call architecture.

import { parseMemoLine, matchTmdbCandidate } from "./gemini_utils.js";
import { buildMovieEntryFromTmdb } from "./tmdb_utils.js";

const TMDB_BASE = "https://api.themoviedb.org/3";

// Upper bound on TMDB candidates handed to Call B. The year-offset merge
// (primary year + year±1) can produce up to ~60 raw results; this cap keeps
// Call B's prompt manageable while leaving enough room for the right match
// to survive when the primary year fills the top of the list with junk and
// the actual movie sits in year±1. Every surviving candidate has its details
// fetched (see enrichCandidatesForMatch), so this also bounds the per-line
// /movie/{id} call volume (1 search + up to this many details).
const CANDIDATE_SEARCH_LIMIT = 20;

// Search TMDB for movie candidates matching the parsed memo line.
//
// `parsed` is Call A's output (see gemini_utils.js → CALL_A_SCHEMA):
//   {
//     is_movie:             boolean,
//     title:                string  | null,  // TMDB-searchable title
//     year:                 integer | null,
//     director:             string  | null,  // as written in memo, if any
//     title_korean_overlay: string  | null,  // "English (한국어)" pattern only
//   }
//
// Only `title` (treated as required here — caller checks before calling) and
// `year` (optional filter) are used by this search. `director` is matched
// later by Call B; the other fields are orchestration concerns handled by
// the caller.
//   - Uses `primary_release_year` (NOT `year`) as the TMDB filter — more
//     restrictive, matches the original-country release rather than any
//     country's re-release.
//   - When a year is given, runs three searches in parallel — primary year,
//     year+1, year-1 — to absorb TMDB release-date discrepancies. Results
//     are merged in input order (primary year first, preserving TMDB's
//     per-query popularity ordering) and deduped by tmdb id.
//   - allSettled semantics: a transient error on one offset doesn't poison
//     the others. Throws only if ALL searches fail.
//   - When no year is given, a single search runs.
//
// Returns up to CANDIDATE_SEARCH_LIMIT raw TMDB /search/movie results (no
// /movie/{id} enrichment).
async function tmdbSearch(parsed, tmdbApiKey) {
  const q = parsed.title?.trim();
  if (!q) return [];

  const buildUrl = (year) => {
    const p = new URLSearchParams({ api_key: tmdbApiKey, query: q });
    if (year) p.set("primary_release_year", String(year));
    return `${TMDB_BASE}/search/movie?${p}`;
  };

  const years = parsed.year
    ? [parsed.year, parsed.year + 1, parsed.year - 1]
    : [null];

  const responses = await Promise.allSettled(
    years.map(async (year) => {
      const r = await fetch(buildUrl(year));
      if (!r.ok) throw new Error(`TMDB search ${r.status}: ${r.statusText}`);
      const data = await r.json();
      return data.results ?? [];
    })
  );

  // If EVERY search failed, surface the primary year's error so the caller
  // marks the line as error rather than silently producing zero results.
  if (responses.every((res) => res.status === "rejected")) {
    throw responses[0].reason;
  }

  // Merge in input order (primary year first); dedupe by tmdb id.
  const seen = new Set();
  const merged = [];
  for (const res of responses) {
    if (res.status !== "fulfilled") continue;
    for (const result of res.value) {
      if (seen.has(result.id)) continue;
      seen.add(result.id);
      merged.push(result);
    }
  }
  return merged.slice(0, CANDIDATE_SEARCH_LIMIT);
}

async function fetchTmdbDetails(tmdbId, tmdbApiKey) {
  const url = `${TMDB_BASE}/movie/${tmdbId}?api_key=${tmdbApiKey}&append_to_response=credits`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TMDB details ${r.status}: ${r.statusText}`);
  return r.json();
}

// Fetch /movie/{id} details for every candidate (TMDB's /search/movie returns
// title/year/poster but NOT credits or imdb_id). Each candidate is annotated
// with director names and its full _details — giving Call B director context
// AND letting processMemoLine drop candidates that have no imdb_id (which can
// never become an entry). A candidate whose details fetch fails passes through
// with directors=[] and no _details (imdb_id unknown — kept; the picker can
// re-fetch lazily). Bounded by CANDIDATE_SEARCH_LIMIT.
async function enrichCandidatesForMatch(tmdbCandidates, tmdbApiKey) {
  const tasks = tmdbCandidates.map(async (c) => {
    try {
      const tmdbDetail = await fetchTmdbDetails(c.id, tmdbApiKey);
      const directors = (tmdbDetail.credits?.crew ?? [])
        .filter((cr) => cr.job === "Director")
        .map((cr) => cr.name);
      return { ...c, directors, _details: tmdbDetail };
    } catch {
      return { ...c, directors: [] };
    }
  });
  return Promise.all(tasks);
}

// Process one memo line end-to-end.
// Returns one of:
//   { status: "ok",        rawLine, parseResult, candidates, matchResult, entry }
//   { status: "not_movie", rawLine, parseResult }
//   { status: "no_match",  rawLine, parseResult, candidates?, matchResult? }
//   { status: "error",     rawLine, error, parseResult?, candidates?, matchResult? }
// (Call C — LLM translation of the director's romanized name — is disabled
// for now; the function still lives in gemini_utils.js and may be re-enabled
// later.)
export async function processMemoLine({
  rawLine,
  geminiKey,
  tmdbApiKey,
  koreanDirectorMap,
}) {
  const result = { rawLine };

  // -- Call A: parse ---------------------------------------------------------
  let parsed;
  try {
    parsed = await parseMemoLine(rawLine, geminiKey);
  } catch (e) {
    return { ...result, status: "error", error: `Call A failed: ${e.message}` };
  }
  result.parseResult = parsed;
  if (!parsed.is_movie) {
    return { ...result, status: "not_movie" };
  }
  if (!parsed.title || !parsed.title.trim()) {
    return {
      ...result,
      status: "error",
      error: "Call A returned is_movie=true but no title",
    };
  }

  // -- TMDB search -----------------------------------------------------------
  let tmdbCandidates;
  try {
    tmdbCandidates = await tmdbSearch(parsed, tmdbApiKey);
  } catch (e) {
    return { ...result, status: "error", error: e.message };
  }
  if (tmdbCandidates.length === 0) {
    return { ...result, status: "no_match" };
  }
  const enrichedTmdbCandidates = await enrichCandidatesForMatch(
    tmdbCandidates,
    tmdbApiKey
  );

  // A candidate whose TMDB details carry no imdb_id can never become an entry
  // (buildMovieEntryFromTmdb requires one), so drop those before handing the
  // list to Call B AND before they reach the review candidate-picker — no point
  // offering a film that can't be saved (it only errors on selection). Every
  // candidate now has its details fetched (enrichCandidatesForMatch), so this
  // catches the whole list, not just the top ones. A candidate whose fetch
  // failed transiently has no _details (imdb_id unknown) and is kept; the
  // picker re-fetches it lazily if selected.
  const matchableCandidates = enrichedTmdbCandidates.filter(
    (c) => !c._details || c._details.imdb_id
  );
  if (matchableCandidates.length === 0) {
    return { ...result, status: "no_match" };
  }
  result.candidates = matchableCandidates;

  // -- Call B: match ---------------------------------------------------------
  let match;
  try {
    match = await matchTmdbCandidate({
      rawLine,
      parsed,
      candidates: matchableCandidates,
      apiKey: geminiKey,
    });
  } catch (e) {
    return { ...result, status: "error", error: `Call B failed: ${e.message}` };
  }
  result.matchResult = match;
  if (match.matched_tmdb_id == null) {
    return { ...result, status: "no_match" };
  }

  // -- Entry build -----------------------------------------------------------
  // Reuse the details we already fetched if Call B picked a candidate within
  // the top CANDIDATE_DETAILS_FETCH_LIMIT (enriched at search time); otherwise
  // fetch on demand. Call B may pick from anywhere in the CANDIDATE_SEARCH_LIMIT
  // window, so the lazy-fetch path is real.
  let pickedTmdbDetails = matchableCandidates.find(
    (c) => c.id === match.matched_tmdb_id
  )?._details;
  if (!pickedTmdbDetails) {
    try {
      pickedTmdbDetails = await fetchTmdbDetails(
        match.matched_tmdb_id,
        tmdbApiKey
      );
    } catch (e) {
      return {
        ...result,
        status: "error",
        error: `TMDB details fetch failed: ${e.message}`,
      };
    }
  }
  let entry;
  try {
    entry = buildMovieEntryFromTmdb(pickedTmdbDetails);
  } catch (e) {
    return {
      ...result,
      status: "error",
      error: `Entry build failed: ${e.message}`,
    };
  }

  // title_korean_overlay → custom_korean_title.
  // The existing editor's gate-relaxation policy is to set it unconditionally
  // and let movies.html ignore it when display doesn't apply.
  if (parsed.title_korean_overlay && typeof parsed.title_korean_overlay === "string") {
    const v = parsed.title_korean_overlay.trim();
    if (v) entry.custom_korean_title = v;
  }

  // -- Korean director resolution -------------------------------------------
  // Priority: existing-YML map → TMDB romanization fallback.
  // Call C (LLM Korean-translation fallback) is currently disabled — if the
  // map doesn't have the director, leave the TMDB romanization and let the
  // user type the Korean form manually in the review card.
  const romanized = entry.tmdb_director_name_1;
  if (romanized && koreanDirectorMap.has(romanized)) {
    entry.director = koreanDirectorMap.get(romanized);
    entry.is_korean_director = true;
  }

  result.entry = entry;
  result.status = "ok";
  return result;
}
