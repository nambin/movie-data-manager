// Build a movie YAML entry from a TMDB Movie Details JSON response.
// Mirrors the dict construction in data-manager.py with two
// intentional deviations documented in web-app-prompt.md:
//   1. `country` is NOT emitted (web app drops it; legacy entries preserve it on load).
//   2. `title` is composed from TMDB's `title` and `original_title`:
//        - if either is missing, use whichever is present
//        - if both are present and identical, use one (no redundant duplication)
//        - if both differ, combine as "<tmdb title> (<original title>)"
//      This recreates the parenthetical pattern of the legacy CSV titles
//      (e.g. "Parasite (기생충)") directly from TMDB without needing the CSV.

import { isKoreanLanguage, getLanguageName } from "./utils.js";

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

  // Field order below MUST match data-manager.py:388-422 (with `country` omitted).
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
