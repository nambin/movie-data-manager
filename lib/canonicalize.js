// Canonicalize a movie entry: enforce field order, omit-when-empty rules, and
// derive `awards` from `award_names`.

import { isKoreanLanguage, deriveAwardBadges } from "./utils.js";

// Canonical field order for a movie entry.
// `country` is preserved verbatim when present on legacy entries; new entries
// from the web app omit it.
const MAIN_KEY_ORDER = [
  "title",
  "year",
  "director",
  "country",
  "is_korean_director",
  "imdb_id",
  "imdb_url",
  "tmdb_url",
  "tmdb_title",
  "tmdb_original_title",
  "tmdb_original_language",
  "tmdb_director_name_1",
  "tmdb_director_name_2",
  "tmdb_num_directors",
  "tmdb_poster_url",
];

// Optional keys.
// `note` precedes `award_names` and `awards` — see verified actual emit order.
const OPTIONAL_KEY_ORDER = [
  "custom_korean_title",
  "masterpiece",
  "my_best",
  "note",
  "award_names",
  "awards",
];

const ALL_KNOWN_KEYS = new Set([...MAIN_KEY_ORDER, ...OPTIONAL_KEY_ORDER]);

function trimOrEmpty(v) {
  return typeof v === "string" ? v.trim() : "";
}

// Canonicalize one entry. Pure: returns a new object.
//   - Recomputes `is_korean_director` from `director`.
//   - Trims string values for the user-edited text fields.
//   - Omits empty optional fields entirely (no `false`/`""`/`[]` placeholders).
//   - Derives `awards` from `award_names`.
//   - Enforces mutual exclusion of `masterpiece` and `my_best` (masterpiece wins).
//   - Preserves any unknown keys at the end (defensive — shouldn't happen, but
//     prevents data loss if a future field is added to the YML).
export function canonicalizeEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("canonicalizeEntry: entry must be an object");
  }

  const out = {};

  for (const k of MAIN_KEY_ORDER) {
    if (!(k in entry)) continue;
    if (k === "director") {
      out[k] = trimOrEmpty(entry[k]);
    } else if (k === "is_korean_director") {
      out[k] = isKoreanLanguage(trimOrEmpty(entry.director));
    } else {
      out[k] = entry[k];
    }
  }

  // custom_korean_title — string, trim, omit when empty.
  const ckt = trimOrEmpty(entry.custom_korean_title);
  if (ckt) out.custom_korean_title = ckt;

  // masterpiece XOR my_best. If both somehow set, masterpiece wins. The
  // two are mutually exclusive by design (the UI's personal-rating dropdown
  // exposes them as a single select), but be defensive in case of malformed
  // YAML.
  if (entry.masterpiece === true) {
    out.masterpiece = true;
  } else if (entry.my_best === true) {
    out.my_best = true;
  }

  // note — string, trim, omit when empty.
  const note = trimOrEmpty(entry.note);
  if (note) out.note = note;

  // award_names + awards (derived).
  if (Array.isArray(entry.award_names) && entry.award_names.length > 0) {
    const names = [];
    for (const n of entry.award_names) {
      const t = typeof n === "string" ? n.trim() : "";
      if (t && !names.includes(t)) names.push(t);
    }
    if (names.length > 0) {
      out.award_names = names;
      const badges = deriveAwardBadges(names);
      if (badges.length > 0) out.awards = badges;
    }
  }

  // Defensive passthrough for any future/unknown keys, appended at the end.
  for (const k of Object.keys(entry)) {
    if (!ALL_KNOWN_KEYS.has(k)) out[k] = entry[k];
  }

  return out;
}

// Canonicalize a whole list. Returns a new array.
export function canonicalizeAll(movies) {
  return movies.map(canonicalizeEntry);
}
