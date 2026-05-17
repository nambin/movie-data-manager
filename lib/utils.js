// -----------------------------------------------------------------------------
// Awards
// -----------------------------------------------------------------------------
export const AWARD_NAMES = [
  "Berlin Goldener Bär",
  "Cannes Palme d'Or",
  "César Award for Best Film",
  "Hong Kong Film Awards",
  "IIFA Awards",
  "Japan Academy Prize",
  "Oscar Best International Film",
  "Oscar Best Picture",
  "Venice Leone d’oro",
  "청룡영화제 최우수 작품상",
];

export const BADGE_KEY_BY_NAME = {
  "청룡영화제 최우수 작품상": "blue_dragon",
  "Oscar Best Picture": "oscar",
  "Oscar Best International Film": "oscar",
  "Cannes Palme d'Or": "cannes",
  "Venice Leone d’oro": "venice",
  "Berlin Goldener Bär": "berlin",
};

// Preserves input order, dedupes badge keys, drops names with no mapping.
export function deriveAwardBadges(awardNames) {
  const out = [];
  for (const name of awardNames) {
    const badge = BADGE_KEY_BY_NAME[name];
    if (badge && !out.includes(badge)) out.push(badge);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Korean detection
// -----------------------------------------------------------------------------

// Returns true iff `s` contains any character in U+AC00..U+D7A3.
export function isKoreanLanguage(s) {
  if (typeof s !== "string") return false;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) return true;
  }
  return false;
}

// Build a romanized → Korean director-name map from already-loaded entries.
// Only tmdb_director_name_1 → m.director is mapped: on a two-director film,
// m.director holds the Korean form of the *first* director only, so mapping
// the second director's romanization here would associate the wrong name.
// Used by the URL-paste and bulk-import flows to recover a curated Korean
// spelling without re-typing it or invoking the LLM.
export function buildKoreanDirectorMap(movies) {
  const map = new Map();
  for (const m of movies) {
    if (!m?.is_korean_director) continue;
    const director = m.director;
    if (!director || !isKoreanLanguage(director)) continue;
    const romanized = m.tmdb_director_name_1;
    if (typeof romanized === "string" && !map.has(romanized)) {
      map.set(romanized, director);
    }
  }
  return map;
}

// -----------------------------------------------------------------------------
// Language names
// -----------------------------------------------------------------------------

// Resolves an ISO 639 language code to its English name via the standard
// Intl.DisplayNames API. With { fallback: "code" }, unrecognized but
// structurally valid codes pass through unchanged.
const DISPLAY_NAMES = new Intl.DisplayNames(["en"], {
  type: "language",
  fallback: "code",
});

// TMDb returns a few language codes that aren't valid ISO 639-1 — Intl
// can't resolve them, so without this map they'd leak through as raw codes
// (e.g. "cn") into tmdb_original_language in the YAML. Override with the
// human-readable name TMDb intends.
const TMDB_LANGUAGE_OVERRIDES = {
  // TMDb tags Cantonese-language films (Hong Kong cinema) with "cn". ISO 639-1
  // has no Cantonese code; the BCP-47 form is "zh-yue".
  cn: "Cantonese",
};

export function getLanguageName(code) {
  if (!code) return null;
  if (Object.prototype.hasOwnProperty.call(TMDB_LANGUAGE_OVERRIDES, code)) {
    return TMDB_LANGUAGE_OVERRIDES[code];
  }
  try {
    return DISPLAY_NAMES.of(code);
  } catch {
    // Intl.DisplayNames throws RangeError for structurally invalid input.
    return code;
  }
}

// -----------------------------------------------------------------------------
// Sort
// -----------------------------------------------------------------------------

// Sort movies by the following criteria:
//   key = (year, masterpiece, my_best, len(awards), director), reverse=True
// Missing `masterpiece` / `my_best` are treated as false. `True > False` in
// Python; in JS we coerce booleans to 0/1 so comparisons are deterministic.

function bool(v) {
  return v === true ? 1 : 0;
}

function awardsLen(m) {
  return Array.isArray(m?.awards) ? m.awards.length : 0;
}

// Returns a new array — does not mutate the input.
export function sortMovies(movies) {
  return [...movies].sort((a, b) => {
    // year DESC
    const yearDiff = (b.year ?? 0) - (a.year ?? 0);
    if (yearDiff !== 0) return yearDiff;
    // masterpiece DESC (true first)
    const mpDiff = bool(b.masterpiece) - bool(a.masterpiece);
    if (mpDiff !== 0) return mpDiff;
    // my_best DESC
    const mbDiff = bool(b.my_best) - bool(a.my_best);
    if (mbDiff !== 0) return mbDiff;
    // len(awards) DESC
    const awDiff = awardsLen(b) - awardsLen(a);
    if (awDiff !== 0) return awDiff;
    // director DESC (lexicographic, descending — mirrors Python str compare with reverse=True)
    const da = a.director ?? "";
    const db = b.director ?? "";
    if (db > da) return 1;
    if (db < da) return -1;
    return 0;
  });
}

// -----------------------------------------------------------------------------
// YAML dump options
// -----------------------------------------------------------------------------

// js-yaml dump options for the on-disk data/movies.yml format: block-style
// sequences, unicode preserved, fields in insertion (= canonical) order.
//
// - lineWidth: -1   → never wrap long scalars onto extra lines
// - flowLevel: -1   → never use [flow] style; emit block sequences (with `- `)
// - sortKeys: false → preserve object insertion order
// - noRefs: true    → no anchors / aliases
// - noCompatMode: true → use modern YAML 1.2-ish output
export const YAML_DUMP_OPTIONS = Object.freeze({
  lineWidth: -1,
  flowLevel: -1,
  sortKeys: false,
  noRefs: true,
  noCompatMode: true,
});
