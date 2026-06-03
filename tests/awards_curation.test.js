// Tests for lib/awards_curation.js — the award-curation pipeline behind
// cli/curate-awards.mjs (see prompt-award-curation.md).
//
// Fixtures (tests/fixtures/awards/) are frozen so tests run offline:
//   - sparql-awards-sample.json   synthetic Wikidata award rows (edge cases)
//   - sparql-articles-sample.json  synthetic article→IMDb resolution
//   - bluedragon-wikitext.json     REAL captured Wikipedia wikitext
//   - tmdb-find-tt28607951.json    REAL captured TMDB /find response
// Gemini/TMDB network is never hit: fallback is exercised via an injected
// runFallback, and tmdbFind via an overridden globalThis.fetch.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseSparqlAwardRows,
  parseArticleImdbRows,
  buildArticleImdbQuery,
  parseBlueDragonWikitext,
  groupByImdb,
  buildAwardsDocument,
  dumpAwardsYaml,
  diffAwards,
  formatChangeSummary,
  resolveRecordsToImdb,
  tmdbFind,
  curateAwards,
  AWARD_QID_TO_NAME,
  BLUE_DRAGON_AWARD_NAME,
  MANUAL_AWARD_OVERRIDES,
} from "../lib/awards_curation.js";
import { AWARD_NAMES } from "../lib/utils.js";

function fx(name) {
  const url = new URL(`./fixtures/awards/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf-8"));
}

beforeEach(() => {
  globalThis.fetch = undefined;
});

// ---------------------------------------------------------------------------
// parseSparqlAwardRows — Q-ID→name mapping, tt-only IMDb filter, dedupe.
// ---------------------------------------------------------------------------

test("parseSparqlAwardRows: maps Q-IDs to exact taxonomy names, filters non-tt IMDb, dedupes", () => {
  const rows = parseSparqlAwardRows(fx("sparql-awards-sample.json"));

  // 8 bindings → drop 1 exact dup + 1 unknown-award row = 6 records.
  assert.equal(rows.length, 6);

  // Q-ID → taxonomy name, including the curly-apostrophe Venice name.
  const palme = rows.find((r) => r.imdb_id === "tt6751668" && r.year === 2019);
  assert.equal(palme.award_name, "Cannes Palme d'Or");
  const venice = rows.find((r) => r.imdb_id === "tt1111111");
  assert.equal(venice.award_name, "Venice Leone d’oro"); // U+2019

  // Producer row (imdb starts with "nm") → imdb_id null, falls to fallback.
  const producer = rows.find((r) => r.title === "A Producer Row");
  assert.equal(producer.imdb_id, null);

  // OPTIONAL imdb absent → imdb_id null.
  const noImdb = rows.find((r) => r.title === "An Old Film Without IMDb");
  assert.equal(noImdb.imdb_id, null);
  assert.equal(noImdb.award_name, "Berlin Goldener Bär");

  // Label that echoes the Q-id → title null (so the fallback uses a real string).
  const qEcho = rows.find((r) => r.imdb_id === "tt2222222");
  assert.equal(qEcho.title, null);

  // The unknown award (Q999999) is dropped entirely.
  assert.ok(!rows.some((r) => r.imdb_id === "tt3333333"));
});

test("AWARD_QID_TO_NAME covers exactly the five international awards", () => {
  assert.deepEqual(Object.keys(AWARD_QID_TO_NAME).sort(), [
    "Q102427",
    "Q105304",
    "Q154590",
    "Q179808",
    "Q209459",
  ]);
});

// ---------------------------------------------------------------------------
// parseArticleImdbRows + buildArticleImdbQuery
// ---------------------------------------------------------------------------

test("parseArticleImdbRows: maps en.wikipedia article titles (spaces) to IMDb ids", () => {
  const map = parseArticleImdbRows(fx("sparql-articles-sample.json"));
  assert.equal(map.get("Parasite (2019 film)"), "tt6751668");
  assert.equal(map.get("Mother (2009 film)"), "tt1216496");
});

test("buildArticleImdbQuery: turns titles into en.wikipedia sitelink IRIs", () => {
  const q = buildArticleImdbQuery(["Parasite (2019 film)", "Mother (2009 film)"]);
  assert.match(q, /<https:\/\/en\.wikipedia\.org\/wiki\/Parasite_\(2019_film\)>/);
  assert.match(q, /schema:about \?film/);
});

// ---------------------------------------------------------------------------
// parseBlueDragonWikitext — real fixture.
// ---------------------------------------------------------------------------

test("parseBlueDragonWikitext: parses winners-only across both table formats", () => {
  const wikitext = fx("bluedragon-wikitext.json").parse.wikitext["*"];
  const rows = parseBlueDragonWikitext(wikitext);

  // ~45 winners since 1963 (hiatus 1974-1989); guard against parser drift.
  assert.ok(rows.length >= 40, `expected >=40 winners, got ${rows.length}`);

  // Every winner has a year and a non-empty title; one per year.
  assert.ok(rows.every((r) => Number.isInteger(r.year) && r.title));
  assert.equal(new Set(rows.map((r) => r.year)).size, rows.length);

  // Oldest row (single-`|`-per-line format) extracts article + Korean original.
  assert.deepEqual(rows[0], {
    year: 1963,
    article: "Blood Relation (film)",
    title: "Kinship",
    korean: "혈맥", // 혈맥
  });

  // A modern row (inline `||` format) extracts all three fields.
  const y2019 = rows.find((r) => r.year === 2019);
  assert.deepEqual(y2019, {
    year: 2019,
    article: "Parasite (2019 film)",
    title: "Parasite",
    korean: "기생충", // 기생충
  });

  // Nominees must NOT appear — "Voice of Silence" is a 2020 nominee, not winner.
  assert.ok(!rows.some((r) => r.title.includes("Voice of Silence")));

  // The "Table key" legend row (also carries {{double dagger}}) is excluded.
  assert.ok(!rows.some((r) => /Indicates the winner|name =/.test(r.title)));
});

// ---------------------------------------------------------------------------
// groupByImdb — merge multiple awards onto one film, dedupe wins.
// ---------------------------------------------------------------------------

test("groupByImdb: collapses a multi-award film and dedupes award_names + wins", () => {
  const records = [
    { award_name: "Cannes Palme d'Or", imdb_id: "tt1", year: 2019, title: "Film One" },
    { award_name: "Oscar Best Picture", imdb_id: "tt1", year: 2020, title: "Film One" },
    { award_name: "Oscar Best Picture", imdb_id: "tt1", year: 2020, title: "Film One" }, // dup
    { award_name: BLUE_DRAGON_AWARD_NAME, imdb_id: "tt2", year: 2021, title: "Film Two" },
    { award_name: "Berlin Goldener Bär", imdb_id: null, year: 1950, title: "No IMDb" },
  ];
  const byImdb = groupByImdb(records);

  assert.deepEqual([...byImdb.keys()], ["tt1", "tt2"]); // null imdb dropped
  assert.deepEqual(byImdb.get("tt1").award_names, [
    "Cannes Palme d'Or",
    "Oscar Best Picture",
  ]);
  assert.deepEqual(byImdb.get("tt1").wins, [
    { award_name: "Cannes Palme d'Or", year: 2019 },
    { award_name: "Oscar Best Picture", year: 2020 },
  ]);
});

// ---------------------------------------------------------------------------
// buildAwardsDocument + dumpAwardsYaml — sorting, badges, idempotency.
// ---------------------------------------------------------------------------

test("buildAwardsDocument: sorts deterministically and derives badges (incl. blue_dragon)", () => {
  const byImdb = groupByImdb([
    { award_name: "Oscar Best Picture", imdb_id: "tt_b", year: 2020, title: "B" },
    { award_name: "Cannes Palme d'Or", imdb_id: "tt_b", year: 2019, title: "B" },
    { award_name: BLUE_DRAGON_AWARD_NAME, imdb_id: "tt_a", year: 2019, title: "A src" },
    { award_name: "Venice Leone d’oro", imdb_id: "tt_a", year: 2018, title: "A src" },
  ]);

  const doc = buildAwardsDocument(byImdb, {
    generatedAt: "2026-06-03",
    tmdbInfo: new Map([["tt_a", { tmdb_id: 99, title: "A (TMDB title)" }]]),
  });

  // Keys sorted; tmdbInfo title overrides the source title.
  assert.deepEqual(Object.keys(doc.by_imdb), ["tt_a", "tt_b"]);
  assert.equal(doc.by_imdb.tt_a.title, "A (TMDB title)");
  assert.equal(doc.by_imdb.tt_a.tmdb_id, 99);
  assert.equal(doc.by_imdb.tt_b.title, "B"); // no tmdbInfo → source title

  // imdb_url is always derivable from the key; tmdb_url only when tmdb_id is known.
  assert.equal(doc.by_imdb.tt_a.imdb_url, "https://www.imdb.com/title/tt_a");
  assert.equal(doc.by_imdb.tt_a.tmdb_url, "https://www.themoviedb.org/movie/99");
  assert.equal(doc.by_imdb.tt_b.tmdb_id, null); // no tmdbInfo for tt_b
  assert.equal(doc.by_imdb.tt_b.tmdb_url, null); // → tmdb_url null

  // award_names sorted; badges derived (blue_dragon + venice, order-preserving).
  assert.deepEqual(doc.by_imdb.tt_a.award_names, [
    "Venice Leone d’oro",
    BLUE_DRAGON_AWARD_NAME,
  ]);
  assert.deepEqual(doc.by_imdb.tt_a.awards, ["venice", "blue_dragon"]);
  assert.deepEqual(doc.by_imdb.tt_b.awards, ["cannes", "oscar"]);

  // wins sorted by (award_name, year).
  assert.deepEqual(doc.by_imdb.tt_b.wins, [
    { award_name: "Cannes Palme d'Or", year: 2019 },
    { award_name: "Oscar Best Picture", year: 2020 },
  ]);
});

test("dumpAwardsYaml: stable across runs (idempotent) and carries the header", () => {
  const byImdb = groupByImdb([
    { award_name: "Cannes Palme d'Or", imdb_id: "tt9", year: 2024, title: "Nine" },
  ]);
  const doc = buildAwardsDocument(byImdb, { generatedAt: "2026-06-03" });

  const a = dumpAwardsYaml(doc);
  const b = dumpAwardsYaml(buildAwardsDocument(groupByImdb([
    { award_name: "Cannes Palme d'Or", imdb_id: "tt9", year: 2024, title: "Nine" },
  ]), { generatedAt: "2026-06-03" }));

  assert.equal(a, b); // byte-identical for identical input
  assert.match(a, /^# AUTO-GENERATED by cli\/curate-awards\.mjs/);
  assert.match(a, /by_imdb:/);
});

// ---------------------------------------------------------------------------
// diffAwards + formatChangeSummary — the change report behind the email.
// ---------------------------------------------------------------------------

test("diffAwards: classifies added films, award-additions, and removals", () => {
  const prev = {
    tt_keep: { title: "Keep", award_names: ["Cannes Palme d'Or"], wins: [] },
    tt_grow: { title: "Grow", award_names: ["Cannes Palme d'Or"], wins: [] },
    tt_gone: { title: "Gone", award_names: ["Berlin Goldener Bär"], wins: [] },
  };
  const next = {
    tt_keep: { title: "Keep", award_names: ["Cannes Palme d'Or"], wins: [] },
    tt_grow: {
      title: "Grow",
      award_names: ["Cannes Palme d'Or", "Oscar Best Picture"],
      wins: [
        { award_name: "Cannes Palme d'Or", year: 2018 },
        { award_name: "Oscar Best Picture", year: 2019 },
      ],
    },
    tt_new: {
      title: "New",
      award_names: ["Venice Leone d’oro"],
      wins: [{ award_name: "Venice Leone d’oro", year: 2020 }],
      tmdb_url: "https://www.themoviedb.org/movie/1",
    },
  };

  const diff = diffAwards(prev, next);
  assert.deepEqual(diff.added.map((f) => f.imdb_id), ["tt_new"]);
  assert.deepEqual(diff.removed.map((f) => f.imdb_id), ["tt_gone"]);
  assert.deepEqual(diff.updated.map((f) => f.imdb_id), ["tt_grow"]);
  // updated film reports the *newly added* award name (none dropped here).
  assert.deepEqual(diff.updated[0].newNames, ["Oscar Best Picture"]);
  assert.deepEqual(diff.updated[0].droppedNames, []);
  // tt_keep (unchanged) appears in none of the buckets.
});

test("diffAwards: a surviving film that LOSES an award is an update, not a removal", () => {
  const prev = {
    tt_x: {
      title: "Corrected Film",
      award_names: ["Cannes Palme d'Or", "Oscar Best Picture"],
      wins: [
        { award_name: "Cannes Palme d'Or", year: 2018 },
        { award_name: "Oscar Best Picture", year: 2019 },
      ],
    },
  };
  const next = {
    tt_x: {
      title: "Corrected Film",
      award_names: ["Cannes Palme d'Or"], // Oscar removed by a correction
      wins: [{ award_name: "Cannes Palme d'Or", year: 2018 }],
      imdb_url: "https://www.imdb.com/title/tt_x",
      tmdb_url: "https://www.themoviedb.org/movie/42",
    },
  };

  const diff = diffAwards(prev, next);
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0); // film still present → NOT a removal
  assert.deepEqual(diff.updated.map((f) => f.imdb_id), ["tt_x"]);
  assert.deepEqual(diff.updated[0].newNames, []);
  assert.deepEqual(diff.updated[0].droppedNames, ["Oscar Best Picture"]);

  // The summary renders the dropped award (with its old year from prevWins).
  const text = formatChangeSummary(diff, { generatedAt: "2026-06-03" });
  assert.match(text, /0 new film\(s\), 1 updated, 0 removed/);
  assert.match(
    text,
    /Corrected Film \[tt_x\] — removed: Oscar Best Picture \(2019\)/
  );
});

test("formatChangeSummary: renders counts and per-film detail lines", () => {
  const diff = diffAwards(
    {},
    {
      tt_new: {
        title: "Anora",
        award_names: ["Cannes Palme d'Or"],
        wins: [{ award_name: "Cannes Palme d'Or", year: 2024 }],
        imdb_url: "https://www.imdb.com/title/tt_new",
        tmdb_url: "https://www.themoviedb.org/movie/1064213",
      },
    }
  );
  const text = formatChangeSummary(diff, { generatedAt: "2026-06-03" });
  assert.match(text, /1 new film\(s\), 0 updated, 0 removed/);
  assert.match(text, /Anora \[tt_new\] — Cannes Palme d'Or \(2024\)/);
  assert.match(text, /themoviedb\.org\/movie\/1064213/);
});

test("formatChangeSummary: truncates long lists with an overflow line", () => {
  const next = {};
  for (let i = 0; i < 5; i++) {
    next[`tt${i}`] = { title: `F${i}`, award_names: ["Cannes Palme d'Or"], wins: [] };
  }
  const text = formatChangeSummary(diffAwards({}, next), {
    generatedAt: "2026-06-03",
    maxList: 2,
  });
  assert.match(text, /5 new film\(s\)/);
  assert.match(text, /… and 3 more/);
});

// ---------------------------------------------------------------------------
// resolveRecordsToImdb — passthrough, fallback, unresolved-drop.
// ---------------------------------------------------------------------------

test("resolveRecordsToImdb: keeps IMDb rows, runs fallback for the rest, drops unresolved", async () => {
  const records = [
    { award_name: "Oscar Best Picture", imdb_id: "tt_known", year: 2020, title: "Known" },
    { award_name: BLUE_DRAGON_AWARD_NAME, imdb_id: null, year: 2019, korean: "기생충" },
    { award_name: "Cannes Palme d'Or", imdb_id: null, year: 1950, title: "Lost Film" },
  ];

  const logged = [];
  const runFallback = async (rec) =>
    rec.korean === "기생충"
      ? { imdb_id: "tt_fb", title: "Resolved", tmdb_id: 5 }
      : null; // the 1950 film stays unresolved

  const { resolved, fallbackUsed, unresolved } = await resolveRecordsToImdb(records, {
    runFallback,
    log: (m) => logged.push(m),
  });

  assert.equal(fallbackUsed, 1);
  assert.equal(unresolved, 1);
  assert.deepEqual(resolved.map((r) => r.imdb_id), ["tt_known", "tt_fb"]);
  assert.equal(resolved[1].title, "Resolved");
  assert.ok(logged.some((m) => m.includes("Lost Film")));
});

// ---------------------------------------------------------------------------
// tmdbFind — parses /find movie_results (real fixture); null when empty.
// ---------------------------------------------------------------------------

test("tmdbFind: resolves an IMDb id to { tmdb_id, title } from /find", async () => {
  const findFixture = fx("tmdb-find-tt28607951.json");
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, statusText: "OK", json: async () => findFixture };
  };

  const info = await tmdbFind("tt28607951", "TEST_KEY");
  assert.deepEqual(info, { tmdb_id: 1064213, title: "Anora" });
  assert.match(calls[0], /\/find\/tt28607951\?api_key=TEST_KEY&external_source=imdb_id/);
});

test("tmdbFind: returns null when /find has no movie_results", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ movie_results: [], tv_results: [] }),
  });
  assert.equal(await tmdbFind("tt0000000", "TEST_KEY"), null);
});

// ---------------------------------------------------------------------------
// curateAwards — full orchestration with injected collaborators.
// ---------------------------------------------------------------------------

test("curateAwards: combines Wikidata + Blue Dragon, runs fallback, looks up TMDB", async () => {
  const doc = await curateAwards({
    tmdbApiKey: "TEST_TMDB",
    geminiKey: "TEST_GEMINI",
    generatedAt: "2026-06-03",
    deps: {
      // Two international winners: one with IMDb, one without (→ fallback).
      fetchInternational: async () => [
        { award_name: "Cannes Palme d'Or", imdb_id: "tt_intl", year: 2024, title: "Intl Film" },
        { award_name: "Berlin Goldener Bär", imdb_id: null, year: 1950, title: "Old Berlin" },
      ],
      // One Blue Dragon winner with a resolvable article.
      fetchBlueDragon: async () => [
        { year: 2019, article: "Parasite (2019 film)", title: "Parasite", korean: "기생충" },
      ],
      resolveArticles: async () => new Map([["Parasite (2019 film)", "tt6751668"]]),
      runFallback: async (rec) =>
        rec.title === "Old Berlin" ? { imdb_id: "tt_fb", title: "Old Berlin", tmdb_id: 7 } : null,
      findOnTmdb: async (imdb) => ({ tmdb_id: `tmdb_${imdb}`, title: `Title ${imdb}` }),
      overrides: [], // isolate from the built-in MANUAL_AWARD_OVERRIDES
    },
  });

  assert.equal(doc.generated_at, "2026-06-03");
  assert.deepEqual(Object.keys(doc.by_imdb).sort(), [
    "tt6751668",
    "tt_fb",
    "tt_intl",
  ]);
  assert.deepEqual(doc.by_imdb.tt6751668.award_names, [BLUE_DRAGON_AWARD_NAME]);
  assert.deepEqual(doc.by_imdb.tt6751668.awards, ["blue_dragon"]);
  assert.equal(doc.by_imdb.tt_intl.tmdb_id, "tmdb_tt_intl");
  assert.deepEqual(doc.by_imdb.tt_fb.award_names, ["Berlin Goldener Bär"]);
});

test("curateAwards: injects manual overrides for upstream gaps, deduped against sources", async () => {
  const doc = await curateAwards({
    tmdbApiKey: "T",
    geminiKey: "G",
    generatedAt: "2026-06-03",
    deps: {
      // A source that already reports the same win the override carries.
      fetchInternational: async () => [
        { award_name: "Cannes Palme d'Or", imdb_id: "tt_dup", year: 2020, title: "Dup" },
      ],
      fetchBlueDragon: async () => [],
      resolveArticles: async () => new Map(),
      runFallback: async () => null,
      findOnTmdb: async (imdb) => ({ tmdb_id: `x_${imdb}`, title: imdb }),
      overrides: [
        { imdb_id: "tt_gap", award_name: "Venice Leone d’oro", year: 2019, title: "Gap" },
        { imdb_id: "tt_dup", award_name: "Cannes Palme d'Or", year: 2020 }, // dup of source
      ],
    },
  });

  // The gap film is now present with its award + derived badge.
  assert.deepEqual(doc.by_imdb.tt_gap.award_names, ["Venice Leone d’oro"]);
  assert.deepEqual(doc.by_imdb.tt_gap.awards, ["venice"]);
  // The override duplicating a source win does NOT create a second win.
  assert.equal(doc.by_imdb.tt_dup.wins.length, 1);
});

test("MANUAL_AWARD_OVERRIDES: every entry is a tt-imdb id + exact taxonomy award name", () => {
  for (const o of MANUAL_AWARD_OVERRIDES) {
    assert.match(o.imdb_id, /^tt\d+$/, `bad imdb_id: ${o.imdb_id}`);
    assert.ok(AWARD_NAMES.includes(o.award_name), `not a taxonomy award: ${o.award_name}`);
  }
});
