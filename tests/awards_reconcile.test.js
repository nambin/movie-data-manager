// Tests for lib/awards_reconcile.js — reconciling movies.yml award data against
// awards.yml (ground truth for the six curated awards). See cli/reconcile-awards.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  reconcileAwardNames,
  reconcileMovies,
  CURATED_AWARD_NAMES,
} from "../lib/awards_reconcile.js";

test("CURATED_AWARD_NAMES is exactly the ten awards.yml-curated names", () => {
  assert.equal(CURATED_AWARD_NAMES.size, 10);
  for (const n of [
    "Oscar Best Picture",
    "Oscar Best International Film",
    "Cannes Palme d'Or",
    "Venice Leone d’oro", // curly apostrophe
    "Berlin Goldener Bär",
    "European Film Award for Best Film",
    "Hong Kong Film Awards",
    "청룡영화제 최우수 작품상",
    "César Award for Best Film",
    "Japan Academy Prize",
  ]) {
    assert.ok(CURATED_AWARD_NAMES.has(n), `missing ${n}`);
  }
  // IIFA Awards is the only taxonomy award NOT curated.
  assert.ok(!CURATED_AWARD_NAMES.has("IIFA Awards"));
});

test("reconcileAwardNames: removes a curated award not backed by ground truth, keeps non-curated", () => {
  const r = reconcileAwardNames(
    ["Cannes Palme d'Or", "IIFA Awards"], // IIFA is the one award still uncurated
    [] // not in awards.yml
  );
  assert.deepEqual(r.award_names, ["IIFA Awards"]); // non-curated kept
  assert.deepEqual(r.removed, ["Cannes Palme d'Or"]);
  assert.deepEqual(r.added, []);
  assert.equal(r.changed, true);
});

test("reconcileAwardNames: adds a curated award present in ground truth", () => {
  const r = reconcileAwardNames(["IIFA Awards"], ["Oscar Best Picture"]);
  assert.deepEqual(r.award_names, ["IIFA Awards", "Oscar Best Picture"]);
  assert.deepEqual(r.added, ["Oscar Best Picture"]);
  assert.deepEqual(r.removed, []);
});

test("reconcileAwardNames: replaces a wrong curated award with the ground-truth one", () => {
  // movies.yml says Oscar Best International; awards.yml says Venice instead.
  const r = reconcileAwardNames(
    ["Oscar Best International Film"],
    ["Venice Leone d’oro"]
  );
  assert.deepEqual(r.removed, ["Oscar Best International Film"]);
  assert.deepEqual(r.added, ["Venice Leone d’oro"]);
  assert.deepEqual(r.award_names, ["Venice Leone d’oro"]);
});

test("reconcileAwardNames: no change when curated awards already match", () => {
  const r = reconcileAwardNames(
    ["Oscar Best Picture", "IIFA Awards"],
    ["Oscar Best Picture"]
  );
  assert.equal(r.changed, false);
  assert.deepEqual(r.award_names, ["Oscar Best Picture", "IIFA Awards"]);
});

test("reconcileMovies: matches by imdb_id, preserves non-curated, drops stale awards field", () => {
  const movies = [
    {
      title: "Has wrong curated award",
      imdb_id: "tt1",
      award_names: ["Cannes Palme d'Or", "IIFA Awards"],
      awards: ["cannes"], // stale derived field
    },
    {
      title: "Not in awards.yml",
      imdb_id: "tt2",
      award_names: ["Venice Leone d’oro"],
      awards: ["venice"],
    },
    {
      title: "Already correct",
      imdb_id: "tt3",
      award_names: ["Oscar Best Picture"],
      awards: ["oscar"],
    },
    { title: "No imdb but curated", award_names: ["Berlin Goldener Bär"] },
  ];
  const byImdb = {
    tt1: { award_names: ["Oscar Best Picture"] }, // Cannes wrong → swap
    tt3: { award_names: ["Oscar Best Picture"] }, // unchanged
    // tt2 absent → its Venice award is stripped
  };

  const { movies: out, changes, unmatched } = reconcileMovies(movies, byImdb);

  // tt1: Cannes removed, Oscar added, IIFA (non-curated) preserved.
  assert.deepEqual(out[0].award_names, ["IIFA Awards", "Oscar Best Picture"]);
  assert.ok(!("awards" in out[0]), "stale awards field dropped for re-derivation");

  // tt2: absent from awards.yml → curated Venice stripped → award_names removed entirely.
  assert.ok(!("award_names" in out[1]));

  // tt3: unchanged object identity (not copied).
  assert.equal(out[2], movies[2]);

  // Changes + unmatched bookkeeping.
  assert.deepEqual(changes.map((c) => c.imdb_id).sort(), ["tt1", "tt2"]);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].title, "No imdb but curated");
});
