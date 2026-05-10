import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeEntry } from "../lib/canonicalize.js";

function legacyEntry(extra = {}) {
  // A minimal legacy entry mirroring the YML schema for an existing movie.
  return {
    title: "Sample",
    year: 2020,
    director: "Some Director",
    country: "US",
    is_korean_director: false,
    imdb_id: "tt0000001",
    imdb_url: "https://www.imdb.com/title/tt0000001",
    tmdb_url: "https://www.themoviedb.org/movie/1",
    tmdb_title: null,
    tmdb_original_title: "Sample",
    tmdb_original_language: "English",
    tmdb_director_name_1: "Some Director",
    tmdb_director_name_2: null,
    tmdb_num_directors: 1,
    tmdb_poster_url: null,
    ...extra,
  };
}

test("canonicalize: preserves legacy main field order including country", () => {
  const out = canonicalizeEntry(legacyEntry());
  assert.deepEqual(Object.keys(out), [
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
  ]);
});

test("canonicalize: omits country when not present (new web-app entry)", () => {
  const e = legacyEntry();
  delete e.country;
  const out = canonicalizeEntry(e);
  assert.equal("country" in out, false);
  // is_korean_director should still appear in its canonical position.
  const keys = Object.keys(out);
  assert.equal(keys[keys.indexOf("director") + 1], "is_korean_director");
});

test("canonicalize: recomputes is_korean_director from director", () => {
  const e = legacyEntry({ director: "박찬욱", is_korean_director: false });
  const out = canonicalizeEntry(e);
  assert.equal(out.is_korean_director, true);
});

test("canonicalize: trims whitespace on director", () => {
  const out = canonicalizeEntry(legacyEntry({ director: "  Park Chan-wook  " }));
  assert.equal(out.director, "Park Chan-wook");
});

test("canonicalize: optional fields appear in this order: custom_korean_title, masterpiece|my_best, note, award_names, awards", () => {
  const out = canonicalizeEntry(
    legacyEntry({
      custom_korean_title: "기생충",
      masterpiece: true,
      note: "great",
      award_names: ["Cannes Palme d'Or"],
    })
  );
  const keys = Object.keys(out);
  // Strip main keys to inspect the optional tail.
  const tail = keys.slice(15);
  assert.deepEqual(tail, [
    "custom_korean_title",
    "masterpiece",
    "note",
    "award_names",
    "awards",
  ]);
  assert.deepEqual(out.awards, ["cannes"]);
});

test("canonicalize: omits empty optional fields", () => {
  const out = canonicalizeEntry(
    legacyEntry({
      custom_korean_title: "",
      masterpiece: false,
      my_best: false,
      note: "   ",
      award_names: [],
    })
  );
  // None of the optional keys should appear.
  for (const k of [
    "custom_korean_title",
    "masterpiece",
    "my_best",
    "note",
    "award_names",
    "awards",
  ]) {
    assert.equal(k in out, false, `${k} should be omitted`);
  }
});

test("canonicalize: masterpiece wins over my_best if both somehow set", () => {
  const out = canonicalizeEntry(
    legacyEntry({ masterpiece: true, my_best: true })
  );
  assert.equal(out.masterpiece, true);
  assert.equal("my_best" in out, false);
});

test("canonicalize: derives awards from award_names; drops unmapped names from awards", () => {
  const out = canonicalizeEntry(
    legacyEntry({
      award_names: ["Hong Kong Film Awards", "Cannes Palme d'Or"],
    })
  );
  assert.deepEqual(out.award_names, [
    "Hong Kong Film Awards",
    "Cannes Palme d'Or",
  ]);
  assert.deepEqual(out.awards, ["cannes"]);
});

test("canonicalize: award_names with only badge-less names → award_names emitted, awards omitted", () => {
  const out = canonicalizeEntry(
    legacyEntry({ award_names: ["César Award for Best Film"] })
  );
  assert.deepEqual(out.award_names, ["César Award for Best Film"]);
  assert.equal("awards" in out, false);
});

test("canonicalize: dedupes award_names entries", () => {
  const out = canonicalizeEntry(
    legacyEntry({
      award_names: ["Cannes Palme d'Or", "Cannes Palme d'Or"],
    })
  );
  assert.deepEqual(out.award_names, ["Cannes Palme d'Or"]);
});

test("canonicalize: trims string note", () => {
  const out = canonicalizeEntry(legacyEntry({ note: "  hello  " }));
  assert.equal(out.note, "hello");
});

test("canonicalize: throws on non-object input", () => {
  assert.throws(() => canonicalizeEntry(null), /must be an object/);
  assert.throws(() => canonicalizeEntry("foo"), /must be an object/);
});
