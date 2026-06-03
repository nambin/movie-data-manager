// Tests for lib/awards_reconcile.js — overwriting movies.yml award data from
// awards.yml, which is the COMPLETE source of truth. See cli/reconcile-awards.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcileAwardNames, reconcileMovies } from "../lib/awards_reconcile.js";

test("reconcileAwardNames: award_names become exactly the ground-truth list", () => {
  // Whatever awards.yml lists fully replaces the movie's awards.
  const r = reconcileAwardNames(
    ["Cannes Palme d'Or", "Some Old Tag"],
    ["Cannes Palme d'Or", "Oscar Best Picture"]
  );
  assert.deepEqual(r.award_names, ["Cannes Palme d'Or", "Oscar Best Picture"]);
  assert.deepEqual(r.added, ["Oscar Best Picture"]);
  assert.deepEqual(r.removed, ["Some Old Tag"]);
  assert.equal(r.changed, true);
});

test("reconcileAwardNames: a film absent from awards.yml loses ALL its awards", () => {
  const r = reconcileAwardNames(["Venice Leone d’oro", "Some Old Tag"], []);
  assert.deepEqual(r.award_names, []);
  assert.deepEqual(r.removed, ["Venice Leone d’oro", "Some Old Tag"]);
  assert.deepEqual(r.added, []);
  assert.equal(r.changed, true);
});

test("reconcileAwardNames: replaces a wrong award with the ground-truth one", () => {
  const r = reconcileAwardNames(["Oscar Best International Film"], ["Venice Leone d’oro"]);
  assert.deepEqual(r.removed, ["Oscar Best International Film"]);
  assert.deepEqual(r.added, ["Venice Leone d’oro"]);
  assert.deepEqual(r.award_names, ["Venice Leone d’oro"]);
});

test("reconcileAwardNames: no change when awards already match exactly", () => {
  const r = reconcileAwardNames(
    ["Cannes Palme d'Or", "Oscar Best Picture"],
    ["Cannes Palme d'Or", "Oscar Best Picture"]
  );
  assert.equal(r.changed, false);
  assert.deepEqual(r.award_names, ["Cannes Palme d'Or", "Oscar Best Picture"]);
});

test("reconcileMovies: overwrites award_names from awards.yml, drops stale awards field", () => {
  const movies = [
    {
      title: "Wrong + extra award",
      imdb_id: "tt1",
      award_names: ["Cannes Palme d'Or", "Some Old Tag"],
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
    { title: "No imdb", award_names: ["Berlin Goldener Bär"] },
  ];
  const byImdb = {
    tt1: { award_names: ["Oscar Best Picture"] }, // fully replaces tt1's awards
    tt3: { award_names: ["Oscar Best Picture"] }, // unchanged
    // tt2 absent → all its awards stripped
  };

  const { movies: out, changes, unmatched } = reconcileMovies(movies, byImdb);

  // tt1: award_names become exactly awards.yml's list (Cannes + "Some Old Tag" gone).
  assert.deepEqual(out[0].award_names, ["Oscar Best Picture"]);
  assert.ok(!("awards" in out[0]), "stale awards field dropped for re-derivation");

  // tt2: absent from awards.yml → award_names removed entirely.
  assert.ok(!("award_names" in out[1]));

  // tt3: unchanged object identity (not copied).
  assert.equal(out[2], movies[2]);

  // Changes + unmatched bookkeeping.
  assert.deepEqual(changes.map((c) => c.imdb_id).sort(), ["tt1", "tt2"]);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].title, "No imdb");
});
