import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildMovieEntryFromTmdb,
  extractTmdbIdFromUrl,
} from "../lib/tmdb_utils.js";

function loadFixture(name) {
  const path = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf-8"));
}

test("extractTmdbIdFromUrl: bare URL", () => {
  assert.equal(
    extractTmdbIdFromUrl("https://www.themoviedb.org/movie/496243"),
    496243
  );
});

test("extractTmdbIdFromUrl: URL with slug", () => {
  assert.equal(
    extractTmdbIdFromUrl("https://www.themoviedb.org/movie/496243-parasite"),
    496243
  );
});

test("extractTmdbIdFromUrl: URL with query string", () => {
  assert.equal(
    extractTmdbIdFromUrl(
      "https://www.themoviedb.org/movie/872585?language=en"
    ),
    872585
  );
});

test("extractTmdbIdFromUrl: invalid input → null", () => {
  assert.equal(extractTmdbIdFromUrl("https://example.com"), null);
  assert.equal(extractTmdbIdFromUrl("not a url"), null);
  assert.equal(extractTmdbIdFromUrl(""), null);
  assert.equal(extractTmdbIdFromUrl(null), null);
  assert.equal(extractTmdbIdFromUrl(undefined), null);
});

// ---------------------------------------------------------------------------
// Fixture-driven tests against real TMDB Movie Details responses.
// Fixtures fetched once from the URLs in README.md and stored under
// tests/fixtures/. Updating them is a manual operation — these JSON blobs
// represent a stable snapshot of the API at fetch time.
// ---------------------------------------------------------------------------

test("Parasite (id=496243) — Korean original, English tmdb_title", () => {
  const tmdb = loadFixture("tmdb-parasite");
  const entry = buildMovieEntryFromTmdb(tmdb);

  // title combines TMDB title + original_title because they differ.
  assert.deepEqual(entry, {
    title: "Parasite (기생충)",
    year: 2019,
    director: "Bong Joon Ho",
    is_korean_director: false,
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

  // deepEqual above ignores key insertion order; emission order matters for YAML.
  assert.deepEqual(Object.keys(entry), [
    "title",
    "year",
    "director",
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
  ]);
});

test("Oppenheimer (id=872585) — English original, tmdb_title is null", () => {
  const tmdb = loadFixture("tmdb-oppenheimer");
  const entry = buildMovieEntryFromTmdb(tmdb);

  // TMDB's `title` equals `original_title` → tmdb_title MUST be null
  // and the composed `title` is just the single form (no duplication).
  assert.deepEqual(entry, {
    title: "Oppenheimer",
    year: 2023,
    director: "Christopher Nolan",
    is_korean_director: false,
    imdb_id: "tt15398776",
    imdb_url: "https://www.imdb.com/title/tt15398776",
    tmdb_url: "https://www.themoviedb.org/movie/872585",
    tmdb_title: null,
    tmdb_original_title: "Oppenheimer",
    tmdb_original_language: "English",
    tmdb_director_name_1: "Christopher Nolan",
    tmdb_director_name_2: null,
    tmdb_num_directors: 1,
    tmdb_poster_url:
      "https://image.tmdb.org/t/p/w200/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg",
  });
});

test("Shoplifters (id=505192) — Japanese original, English tmdb_title", () => {
  const tmdb = loadFixture("tmdb-shoplifters");
  const entry = buildMovieEntryFromTmdb(tmdb);

  // Director: TMDB returns name="Hirokazu Kore-eda" / original_name="是枝裕和".
  // We use `name` (the English/romanized form) for tmdb_director_name_1, not
  // `original_name`, so the YAML's tmdb_director_name_* fields stay English-
  // readable. The user-facing `director` field can be edited to the native
  // form when the user prefers it (see processMemoLine's Korean-director
  // map for the Korean case).
  // title combines TMDB title + original_title because they differ.
  assert.deepEqual(entry, {
    title: "Shoplifters (万引き家族)",
    year: 2018,
    director: "Hirokazu Kore-eda",
    is_korean_director: false,
    imdb_id: "tt8075192",
    imdb_url: "https://www.imdb.com/title/tt8075192",
    tmdb_url: "https://www.themoviedb.org/movie/505192",
    tmdb_title: "Shoplifters",
    tmdb_original_title: "万引き家族",
    tmdb_original_language: "Japanese",
    tmdb_director_name_1: "Hirokazu Kore-eda",
    tmdb_director_name_2: null,
    tmdb_num_directors: 1,
    tmdb_poster_url:
      "https://image.tmdb.org/t/p/w200/4nfRUOv3LX5zLn98WS1WqVBk9E9.jpg",
  });
});

test("The Witches (id=531219) — apostrophe in original_title; tmdb_title is null", () => {
  const tmdb = loadFixture("tmdb-the-witches");
  const entry = buildMovieEntryFromTmdb(tmdb);

  // title === original_title here, so tmdb_title is null and the composed
  // `title` is just the single form (no duplication).
  // The apostrophe in the title is a regular U+0027.
  assert.deepEqual(entry, {
    title: "Roald Dahl's The Witches",
    year: 2020,
    director: "Robert Zemeckis",
    is_korean_director: false,
    imdb_id: "tt0805647",
    imdb_url: "https://www.imdb.com/title/tt0805647",
    tmdb_url: "https://www.themoviedb.org/movie/531219",
    tmdb_title: null,
    tmdb_original_title: "Roald Dahl's The Witches",
    tmdb_original_language: "English",
    tmdb_director_name_1: "Robert Zemeckis",
    tmdb_director_name_2: null,
    tmdb_num_directors: 1,
    tmdb_poster_url:
      "https://image.tmdb.org/t/p/w200/ht6EfsM5hrsUPSR4ReJQFDVU71F.jpg",
  });
});

test("Police Story (id=9056) — Cantonese original; TMDb language code 'cn'", () => {
  const tmdb = loadFixture("tmdb-police-story");
  const entry = buildMovieEntryFromTmdb(tmdb);

  // tmdb_original_language is "Cantonese" via the TMDb-specific override —
  // not a raw "cn" passthrough, which is what TMDb returns and Intl.DisplayNames
  // can't resolve.
  assert.deepEqual(entry, {
    title: "Police Story (警察故事)",
    year: 1985,
    director: "Jackie Chan",
    is_korean_director: false,
    imdb_id: "tt0089374",
    imdb_url: "https://www.imdb.com/title/tt0089374",
    tmdb_url: "https://www.themoviedb.org/movie/9056",
    tmdb_title: "Police Story",
    tmdb_original_title: "警察故事",
    tmdb_original_language: "Cantonese",
    tmdb_director_name_1: "Jackie Chan",
    tmdb_director_name_2: null,
    tmdb_num_directors: 1,
    tmdb_poster_url:
      "https://image.tmdb.org/t/p/w200/1eFB0Iy1TMU4VO5hMcoCE064JAT.jpg",
  });
});

test("Infernal Affairs (id=10775) — Cantonese original, two directors", () => {
  const tmdb = loadFixture("tmdb-infernal-affairs");
  const entry = buildMovieEntryFromTmdb(tmdb);

  // Same "cn" → Cantonese override case as Police Story; also exercises the
  // two-director path (tmdb_director_name_2 non-null, tmdb_num_directors=2).
  assert.deepEqual(entry, {
    title: "Infernal Affairs (無間道)",
    year: 2002,
    director: "Alan Mak Siu-Fai",
    is_korean_director: false,
    imdb_id: "tt0338564",
    imdb_url: "https://www.imdb.com/title/tt0338564",
    tmdb_url: "https://www.themoviedb.org/movie/10775",
    tmdb_title: "Infernal Affairs",
    tmdb_original_title: "無間道",
    tmdb_original_language: "Cantonese",
    tmdb_director_name_1: "Alan Mak Siu-Fai",
    tmdb_director_name_2: "Andrew Lau Wai-Keung",
    tmdb_num_directors: 2,
    tmdb_poster_url:
      "https://image.tmdb.org/t/p/w200/gix9thDBXfjJ8M7rYbihqbQGBcP.jpg",
  });
});

test("missing imdb_id throws", () => {
  // Construct a minimal fake response with imdb_id missing.
  const fake = {
    id: 999999,
    title: "X",
    original_title: "X",
    original_language: "en",
    release_date: "2020-01-01",
    poster_path: null,
    credits: { crew: [] },
    imdb_id: "", // empty string is treated as missing — buildMovieEntryFromTmdb throws
  };
  assert.throws(() => buildMovieEntryFromTmdb(fake), /no imdb_id/);
});

test("missing release_date → year is null (caller must require user entry)", () => {
  const tmdb = loadFixture("tmdb-oppenheimer");
  const fake = { ...tmdb, release_date: "" };
  const entry = buildMovieEntryFromTmdb(fake);
  assert.equal(entry.year, null);
});

test("missing poster_path → tmdb_poster_url is null", () => {
  const tmdb = loadFixture("tmdb-oppenheimer");
  const fake = { ...tmdb, poster_path: null };
  const entry = buildMovieEntryFromTmdb(fake);
  assert.equal(entry.tmdb_poster_url, null);
});

test("no Director crew → director defaults to empty, names are null", () => {
  const tmdb = loadFixture("tmdb-oppenheimer");
  const fake = {
    ...tmdb,
    credits: { crew: tmdb.credits.crew.filter((c) => c.job !== "Director") },
  };
  const entry = buildMovieEntryFromTmdb(fake);
  assert.equal(entry.director, "");
  assert.equal(entry.is_korean_director, false);
  assert.equal(entry.tmdb_director_name_1, null);
  assert.equal(entry.tmdb_director_name_2, null);
  assert.equal(entry.tmdb_num_directors, 0);
});
