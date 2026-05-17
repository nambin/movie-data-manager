import { test } from "node:test";
import assert from "node:assert/strict";
import { isKoreanLanguage, buildKoreanDirectorMap } from "../lib/utils.js";

test("isKoreanLanguage: pure Korean", () => {
  assert.equal(isKoreanLanguage("박찬욱"), true);
  assert.equal(isKoreanLanguage("봉준호"), true);
});

test("isKoreanLanguage: pure English", () => {
  assert.equal(isKoreanLanguage("Christopher Nolan"), false);
  assert.equal(isKoreanLanguage("Park Chan-wook"), false);
});

test("isKoreanLanguage: mixed (Korean + English)", () => {
  assert.equal(isKoreanLanguage("박찬욱 (Park Chan-wook)"), true);
});

test("isKoreanLanguage: Japanese kanji is NOT Korean", () => {
  assert.equal(isKoreanLanguage("是枝裕和"), false);
});

test("isKoreanLanguage: Chinese is NOT Korean", () => {
  assert.equal(isKoreanLanguage("李安"), false);
});

test("isKoreanLanguage: empty / non-string", () => {
  assert.equal(isKoreanLanguage(""), false);
  assert.equal(isKoreanLanguage(null), false);
  assert.equal(isKoreanLanguage(undefined), false);
  assert.equal(isKoreanLanguage(123), false);
});

test("isKoreanLanguage: U+AC00..U+D7A3 boundary", () => {
  // 가 = U+AC00, 힣 = U+D7A3
  assert.equal(isKoreanLanguage("가"), true);
  assert.equal(isKoreanLanguage("힣"), true);
  // U+ABFF (just below) and U+D7A4 (just above) should NOT match.
  assert.equal(isKoreanLanguage(String.fromCodePoint(0xabff)), false);
  assert.equal(isKoreanLanguage(String.fromCodePoint(0xd7a4)), false);
});

// ---------------------------------------------------------------------------
// buildKoreanDirectorMap
// ---------------------------------------------------------------------------

// Compact factory for test entries — keeps each test focused on the field
// under test instead of repeating the same boilerplate.
function entry(overrides) {
  return {
    is_korean_director: true,
    director: "박찬욱",
    tmdb_director_name_1: "Park Chan-wook",
    tmdb_director_name_2: null,
    ...overrides,
  };
}

test("buildKoreanDirectorMap: empty input → empty Map", () => {
  const map = buildKoreanDirectorMap([]);
  assert.ok(map instanceof Map);
  assert.equal(map.size, 0);
});

test("buildKoreanDirectorMap: maps tmdb_director_name_1 → director for a Korean director", () => {
  const map = buildKoreanDirectorMap([
    entry({ director: "봉준호", tmdb_director_name_1: "Bong Joon Ho" }),
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get("Bong Joon Ho"), "봉준호");
});

test("buildKoreanDirectorMap: collects multiple distinct directors", () => {
  const map = buildKoreanDirectorMap([
    entry({ director: "박찬욱", tmdb_director_name_1: "Park Chan-wook" }),
    entry({ director: "봉준호", tmdb_director_name_1: "Bong Joon Ho" }),
    entry({ director: "윤가은", tmdb_director_name_1: "Yoon Ga-eun" }),
  ]);
  assert.equal(map.size, 3);
  assert.deepStrictEqual(
    Object.fromEntries(map),
    {
      "Park Chan-wook": "박찬욱",
      "Bong Joon Ho": "봉준호",
      "Yoon Ga-eun": "윤가은",
    }
  );
});

test("buildKoreanDirectorMap: skips entries with is_korean_director=false", () => {
  const map = buildKoreanDirectorMap([
    entry({
      is_korean_director: false,
      director: "Christopher Nolan",
      tmdb_director_name_1: "Christopher Nolan",
    }),
  ]);
  assert.equal(map.size, 0);
});

test("buildKoreanDirectorMap: skips entries where tmdb_director_name_1 is null", () => {
  const map = buildKoreanDirectorMap([
    entry({ tmdb_director_name_1: null }),
  ]);
  assert.equal(map.size, 0);
});

test("buildKoreanDirectorMap: skips entries where director field has no Hangul", () => {
  // Defensive: if is_korean_director=true but director has no Hangul, the
  // data is inconsistent — don't pollute the map with a Latin-on-Latin entry.
  const map = buildKoreanDirectorMap([
    entry({ director: "Park Chan-wook" }),
  ]);
  assert.equal(map.size, 0);
});

test("buildKoreanDirectorMap: ignores tmdb_director_name_2 (co-director not mapped)", () => {
  // On a two-director film, m.director holds only the first director's
  // Korean form. Mapping the second director's romanization here would
  // associate the wrong name.
  const map = buildKoreanDirectorMap([
    entry({
      director: "봉준호",
      tmdb_director_name_1: "Bong Joon Ho",
      tmdb_director_name_2: "Andrew Lau Wai-Keung",
    }),
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get("Bong Joon Ho"), "봉준호");
  assert.equal(map.has("Andrew Lau Wai-Keung"), false);
});

test("buildKoreanDirectorMap: first-write-wins when same director appears in multiple entries", () => {
  // Park Chan-wook appears as tmdb_director_name_1 in two different films.
  // The map should not grow per occurrence; the first Korean form sticks.
  const map = buildKoreanDirectorMap([
    entry({ director: "박찬욱", tmdb_director_name_1: "Park Chan-wook" }),
    entry({ director: "박찬욱", tmdb_director_name_1: "Park Chan-wook" }),
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get("Park Chan-wook"), "박찬욱");
});

test("buildKoreanDirectorMap: handles null/undefined entries in the array", () => {
  // Defensive — shouldn't happen with well-formed YAML, but the function
  // uses `m?.is_korean_director` to guard against it.
  const map = buildKoreanDirectorMap([
    null,
    undefined,
    entry({ director: "박찬욱", tmdb_director_name_1: "Park Chan-wook" }),
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get("Park Chan-wook"), "박찬욱");
});

test("buildKoreanDirectorMap: mixed collection — only the qualifying entries appear", () => {
  const map = buildKoreanDirectorMap([
    entry({ director: "박찬욱", tmdb_director_name_1: "Park Chan-wook" }),
    entry({
      is_korean_director: false,
      director: "Christopher Nolan",
      tmdb_director_name_1: "Christopher Nolan",
    }),
    entry({ director: "봉준호", tmdb_director_name_1: "Bong Joon Ho" }),
    entry({ director: "윤가은", tmdb_director_name_1: null }), // no romanized name
  ]);
  assert.equal(map.size, 2);
  assert.deepStrictEqual(Object.fromEntries(map), {
    "Park Chan-wook": "박찬욱",
    "Bong Joon Ho": "봉준호",
  });
});
