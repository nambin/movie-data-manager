// Build a movie YAML entry from a TMDB Movie Details JSON response.
//
// Two intentional behaviors worth knowing:
//   1. `country` is NOT emitted for newly added entries (the web app drops it;
//      legacy entries loaded from YML preserve theirs verbatim).
//   2. `title` is composed from TMDB's `title` and `original_title`:
//        - if either is missing, use whichever is present
//        - if both are present and identical, use one (no redundant duplication)
//        - if both differ, combine as "<tmdb title> (<original title>)"
//      This recreates the legacy parenthetical pattern (e.g. "Parasite (기생충)")
//      directly from TMDB.

import { isKoreanLanguage, getLanguageName } from "./utils.js";

// TMDB API key access — inlined at build time via esbuild's --define flag.
// See scripts/build.mjs (prod) and scripts/build-dev.mjs (dev). Both require
// TMDB_API_KEY in .env (or process.env); no fallback. The deployed editor
// needs TMDB for the URL-paste add bar, so the prod bundle carries the key.
// The `typeof` guard keeps the module loadable under `node --test`, where
// __TMDB_KEY__ is undefined → null.
export function getTmdbKey() {
  // eslint-disable-next-line no-undef -- replaced by esbuild --define at build time
  return typeof __TMDB_KEY__ === "string" && __TMDB_KEY__ ? __TMDB_KEY__ : null;
}

// Extract TMDB ID from a TMDB movie URL. Returns null on no match.
// Examples that should match:
//   https://www.themoviedb.org/movie/496243
//   https://www.themoviedb.org/movie/496243-parasite
//   https://www.themoviedb.org/movie/496243?language=en
export function extractTmdbIdFromUrl(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/\/movie\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// TMDB Movie Details JSON → web-app movie entry.
// Returns an object with keys in the canonical YAML field order.
export function buildMovieEntryFromTmdb(tmdb) {
  if (!tmdb || typeof tmdb !== "object") {
    throw new Error("buildMovieEntryFromTmdb: tmdb response missing");
  }
  if (!tmdb.imdb_id) {
    throw new Error(
      `buildMovieEntryFromTmdb: TMDB response has no imdb_id (TMDB id=${tmdb.id})`
    );
  }

  const directors = (tmdb.credits?.crew ?? []).filter(
    (c) => c.job === "Director"
  );
  const tmdbDirectorName1 = directors[0]?.name ?? null;
  const tmdbDirectorName2 = directors[1]?.name ?? null;
  // The user-typed `director` defaults to TMDB's English/romanized `name`
  // (not `original_name`). For Korean directors the user is expected to
  // edit this to the Korean form afterwards.
  const director = tmdbDirectorName1 ?? "";

  const releaseYear = (tmdb.release_date ?? "").slice(0, 4);
  const year = releaseYear ? Number(releaseYear) : null;

  const tmdbTitle = tmdb.title;
  const tmdbOriginalTitle = tmdb.original_title;
  const tmdbPosterPath = tmdb.poster_path;

  let title;
  if (!tmdbTitle) {
    title = tmdbOriginalTitle ?? null;
  } else if (!tmdbOriginalTitle || tmdbTitle === tmdbOriginalTitle) {
    title = tmdbTitle;
  } else {
    title = `${tmdbTitle} (${tmdbOriginalTitle})`;
  }

  // Field order below MUST match the canonical YAML schema documented in
  // prompt-web-app.md — round-trip tests assert deep-equality, but downstream
  // consumers of data/movies.yml (e.g. movies.html) read fields positionally
  // in some places, so the order is load-bearing. `country` is intentionally
  // omitted for new entries.
  return {
    title: title,
    year: year,
    director: director,
    is_korean_director: isKoreanLanguage(director),
    imdb_id: tmdb.imdb_id,
    imdb_url: `https://www.imdb.com/title/${tmdb.imdb_id}`,
    tmdb_url: `https://www.themoviedb.org/movie/${tmdb.id}`,
    tmdb_title: tmdbTitle !== tmdbOriginalTitle ? tmdbTitle : null,
    tmdb_original_title: tmdbOriginalTitle,
    tmdb_original_language: getLanguageName(tmdb.original_language),
    tmdb_director_name_1: tmdbDirectorName1,
    tmdb_director_name_2: tmdbDirectorName2,
    tmdb_num_directors: directors.length,
    tmdb_poster_url: tmdbPosterPath
      ? `https://image.tmdb.org/t/p/w200${tmdbPosterPath}`
      : null,
  };
}
