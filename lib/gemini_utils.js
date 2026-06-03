// Gemini API integration for the memo-driven bulk-import flow.
// See prompt-web-app-with-llm.md for the three-call architecture
// (A: parse memo line, B: TMDB candidate match, C: Korean director name).
//
// The Gemini API key is inlined into the bundle at BUILD TIME via esbuild's
// --define flag (see package.json):
//   - `npm run build`      → defines __GEMINI_KEY__ as "" (empty). The
//                            production bundle has no key. The memo
//                            bulk-import UI is hidden at runtime by
//                            lib/app.js when getGeminiKey() returns null.
//                            Safe to deploy to GitHub Pages.
//   - `npm run build:dev`  → defines __GEMINI_KEY__ as the value of
//                            GEMINI_API_KEY from .env (or process.env).
//                            The memo bulk-import UI works. DO NOT DEPLOY
//                            this bundle.
// The `typeof` guard makes the source loadable under `node --test` (no
// esbuild replacement), where __GEMINI_KEY__ is simply undefined → null.

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent";

// -- Key access --------------------------------------------------------------

export function getGeminiKey() {
  // eslint-disable-next-line no-undef -- replaced by esbuild --define at build time
  return typeof __GEMINI_KEY__ === "string" && __GEMINI_KEY__ ? __GEMINI_KEY__ : null;
}

// -- Prompt formatting helper -----------------------------------------------

// Build a multi-paragraph prompt from template literals that can wrap across
// source lines for readability. Within each paragraph, runs of whitespace are
// collapsed to a single space; paragraphs are joined with a blank line.
// Output is byte-identical to the equivalent single-line form, so wrapping
// the source for editor readability never changes what the LLM sees.
function paragraphs(parts) {
  return parts.map((s) => s.trim().replace(/\s+/g, " ")).join("\n\n");
}

// -- Low-level call ----------------------------------------------------------

async function callGemini({ systemPrompt, userPrompt, schema, apiKey }) {
  if (!apiKey) throw new Error("Missing Gemini API key");
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0,
    },
  };
  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = "";
    try {
      const j = await r.json();
      detail = j?.error?.message || "";
    } catch {
      /* response body wasn't JSON — fall back to statusText */
    }
    throw new Error(
      `Gemini ${r.status}${detail ? `: ${detail}` : `: ${r.statusText}`}`
    );
  }
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("Gemini response had no text content");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned non-JSON: ${text.slice(0, 200)}`);
  }
}

// -- Call A: parse one memo line --------------------------------------------

export const CALL_A_SYSTEM = paragraphs([
  `You receive a single line from an unstructured memo of movie titles. Decide
   whether it names a movie. If it does not (e.g. a note like "watched with J",
   a date, a comment), return {"is_movie": false}. Otherwise return a
   TMDB-searchable query.`,
  `A very common case is that a non-Korean movie is written in Korean phonetic
   transliteration (e.g. "보헤미안 랩소디" = "Bohemian Rhapsody",
   "플라워킬링문" = "Killers of the Flower Moon", "에밀리아 페레스" =
   "Emilia Pérez"). For these, return the original English title in "title".
   Do NOT put the Korean phonetic form in "title_korean_overlay".`,
  `For a Korean original-language movie (e.g. "어쩔수가없다", "기생충"),
   return the canonical Korean title in "title". Light normalization is fine
   — fix obvious typos, adjust whitespace, expand common abbreviations — but
   keep the result in Korean script. TMDB search handles Korean originals
   natively.`,
  `"title_korean_overlay" is ONLY for the explicit "English Title (한국어)"
   parenthetical pattern, e.g. "Adolescence (소년의 시간)" →
   title_korean_overlay: "소년의 시간".`,
  `Do not invent year or director unless they are explicit in the line.`,
]);

const CALL_A_SCHEMA = {
  type: "object",
  properties: {
    is_movie: { type: "boolean" },
    title: { type: "string", nullable: true },
    year: { type: "integer", nullable: true },
    director: { type: "string", nullable: true },
    title_korean_overlay: { type: "string", nullable: true },
  },
  required: ["is_movie"],
};

export async function parseMemoLine(line, apiKey) {
  return callGemini({
    systemPrompt: CALL_A_SYSTEM,
    userPrompt: line,
    schema: CALL_A_SCHEMA,
    apiKey,
  });
}

// -- Call B: TMDB candidate match -------------------------------------------

export const CALL_B_SYSTEM = paragraphs([
  `You are matching one user memo line to one TMDB movie. The app provides the
   raw memo line, a parsed search query, and a list of TMDB candidates with
   selected fields including title, year, director, popularity, and IMDB-ID
   presence.`,
  `Pick which candidate (if any) matches the memo line. Matching cues:`,
  `(1) Title likeness across romanization, transliteration, or translation
   (e.g. "보헤미안 랩소디" matches "Bohemian Rhapsody"). A foreign film whose
   English "title" matches the query but whose "original_title" is in another
   language (a translation — e.g. title "I'm Still Here" / original_title
   "Ainda Estou Aqui") is a FULL title match. Do NOT prefer a candidate that
   matches both title and original_title exactly over such a translated-title
   candidate; a translated original_title does not make a match weaker.`,
  `(2) Year (when the memo specifies one) — but TMDB release dates can be off
   by ±1 year from what the user remembers, so don't reject solely on year.`,
  `(3) Director (when the memo specifies one).`,
  `(4) Popularity — the user logs films that became culturally popular, so
   popularity is the primary disambiguator among same-titled films. Common
   titles get reused across many films and decades; when several candidates
   share essentially the same title, pick the markedly more popular one — a
   candidate whose popularity is clearly higher (several times the others') is
   almost always the film the user means, even if a less-popular candidate
   matches the title or original_title more exactly. (Popularity above 1.0
   usually means a real released film; below 0.1 is usually a short film,
   festival piece, or unreleased entry.)`,
  `(5) has_imdb — "yes" means TMDB has an IMDB ID for the film (catalogued,
   almost always a released film). "no" means it lacks an IMDB ID (often
   unreleased or obscure). "unknown" means full details weren't fetched for
   this candidate. Strongly prefer has_imdb=yes candidates; reject has_imdb=no
   unless the title is a near-exact match AND no "yes" candidate fits.
   has_imdb=unknown is neutral — judge by the other cues.`,
  `If no candidate is a confident match, return matched_tmdb_id: null. Be
   willing to reject all candidates — a wrong match is worse than no match.`,
  `The "reasoning" field should be one short sentence explaining the pick.`,
]);

const CALL_B_SCHEMA = {
  type: "object",
  properties: {
    matched_tmdb_id: { type: "integer", nullable: true },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reasoning: { type: "string" },
  },
  required: ["matched_tmdb_id", "confidence"],
};

export async function matchTmdbCandidate({ rawLine, parsed, candidates, apiKey }) {
  const lines = [
    `User memo line: ${rawLine}`,
    `Parsed query: title="${parsed.title ?? ""}" year=${parsed.year ?? "-"} director="${parsed.director ?? ""}"`,
    "",
    "TMDB candidates:",
  ];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const year = c.release_date?.slice(0, 4) ?? "-";
    const dirs = (c.directors ?? []).join(", ") || "-";
    const pop =
      typeof c.popularity === "number" ? c.popularity.toFixed(1) : "-";
    // has_imdb is "yes" when we have full details with a non-empty imdb_id,
    // "no" when we have full details but imdb_id is missing/empty, "unknown"
    // when we didn't fetch full details for this candidate (rank beyond
    // CANDIDATE_DETAILS_FETCH_LIMIT in memo_pipeline.js).
    let hasImdb;
    if (c._details) {
      hasImdb = c._details.imdb_id ? "yes" : "no";
    } else {
      hasImdb = "unknown";
    }
    lines.push(
      `${i + 1}. tmdb_id=${c.id} title="${c.title ?? ""}" original_title="${c.original_title ?? ""}" year=${year} directors="${dirs}" popularity=${pop} has_imdb=${hasImdb}`
    );
  }
  return callGemini({
    systemPrompt: CALL_B_SYSTEM,
    userPrompt: lines.join("\n"),
    schema: CALL_B_SCHEMA,
    apiKey,
  });
}

// -- Call C: Korean director name -------------------------------------------

export const CALL_C_SYSTEM = paragraphs([
  `Return the director's name in Korean script (한글, U+AC00–U+D7A3) if and
   only if you are confident this person is Korean. Return null otherwise. Do
   not guess. Return only Hangul characters in korean_name (no romanization,
   no Latin letters).`,
]);

const CALL_C_SCHEMA = {
  type: "object",
  properties: {
    korean_name: { type: "string", nullable: true },
  },
  required: ["korean_name"],
};

export async function translateDirectorToKorean({
  romanizedName,
  movieTitle,
  apiKey,
}) {
  const result = await callGemini({
    systemPrompt: CALL_C_SYSTEM,
    userPrompt: `Romanized director name: ${romanizedName}\nFilm: ${movieTitle ?? "(unknown)"}`,
    schema: CALL_C_SCHEMA,
    apiKey,
  });
  return result?.korean_name ?? null;
}
