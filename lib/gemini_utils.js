// Gemini API integration for the memo-driven bulk-import flow.
// See prompt-web-app-with-llm.md for the three-call architecture
// (A: parse memo line, B: TMDB candidate match, C: Korean director name).
//
// The Gemini API key is stored in this browser's localStorage only.
// It is NEVER read from a bundled source file or .env — that would leak
// it into the public GitHub Pages deploy (see the threat-model section
// of prompt-web-app-with-llm.md).

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent";

export const GEMINI_KEY_STORAGE_KEY = "gemini-api-key-v1";

// -- Key management ----------------------------------------------------------

export function getStoredGeminiKey() {
  try {
    return localStorage.getItem(GEMINI_KEY_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function setStoredGeminiKey(key) {
  try {
    if (key) localStorage.setItem(GEMINI_KEY_STORAGE_KEY, key);
    else localStorage.removeItem(GEMINI_KEY_STORAGE_KEY);
  } catch (e) {
    console.warn("Gemini key persistence failed:", e);
  }
}

export function clearStoredGeminiKey() {
  try {
    localStorage.removeItem(GEMINI_KEY_STORAGE_KEY);
  } catch {
    /* swallow */
  }
}

// Display-friendly masked form, e.g. "AIzaSy…wXyZ".
export function maskGeminiKey(key) {
  if (!key || key.length < 12) return key ? "•••" : "";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
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
   Do NOT put the Korean phonetic form in "korean_overlay".`,
  `For a Korean original-language movie (e.g. "어쩔수가없다", "기생충"),
   return the canonical Korean title in "title". Light normalization is fine
   — fix obvious typos, adjust whitespace, expand common abbreviations — but
   keep the result in Korean script. TMDB search handles Korean originals
   natively.`,
  `"korean_overlay" is ONLY for the explicit "English Title (한국어)"
   parenthetical pattern, e.g. "Adolescence (소년의 시간)" →
   korean_overlay: "소년의 시간".`,
  `Do not invent year or director unless they are explicit in the line.`,
]);

const CALL_A_SCHEMA = {
  type: "object",
  properties: {
    is_movie: { type: "boolean" },
    title: { type: "string", nullable: true },
    year: { type: "integer", nullable: true },
    director: { type: "string", nullable: true },
    korean_overlay: { type: "string", nullable: true },
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
   selected fields.`,
  `Pick which candidate (if any) matches the memo line. Matching cues include
   title likeness across romanization, transliteration, or translation
   (e.g. "보헤미안 랩소디" matches "Bohemian Rhapsody"); year (when the memo
   specifies one); director (when the memo specifies one).`,
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
    lines.push(
      `${i + 1}. tmdb_id=${c.id} title="${c.title ?? ""}" original_title="${c.original_title ?? ""}" year=${year} directors="${dirs}" popularity=${pop}`
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
