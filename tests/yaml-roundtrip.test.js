// Round-trip test against the real data/movies.yml.
// Loads the file, runs each entry through canonicalize + sort, dumps with
// js-yaml using YAML_DUMP_OPTIONS, parses the dumped output, and asserts
// structural equality with the original.
//
// This is the acceptance test from web-app-prompt.md (primary assertion:
// structural deep-equal). Cosmetic byte-level differences are tolerated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { canonicalizeAll } from "../lib/canonicalize.js";
import { sortMovies, YAML_DUMP_OPTIONS } from "../lib/utils.js";

const YML_PATH = new URL("../data/movies.yml", import.meta.url);

test("round-trip: load → canonicalize → sort → dump → parse → deep-equal", () => {
  const text = readFileSync(YML_PATH, "utf-8");
  const original = yaml.load(text);
  assert.ok(Array.isArray(original));
  assert.ok(original.length > 800, `expected hundreds of movies, got ${original.length}`);

  const processed = sortMovies(canonicalizeAll(original));
  const dumped = yaml.dump(processed, YAML_DUMP_OPTIONS);
  const reparsed = yaml.load(dumped);

  assert.equal(reparsed.length, original.length);

  // Per-entry deep equality. We use deepStrictEqual to catch null vs undefined.
  for (let i = 0; i < original.length; i++) {
    const o = original[i];
    const r = reparsed[i];
    assert.deepStrictEqual(
      r,
      o,
      `entry ${i} (${o.title} / ${o.imdb_id}) differs after round-trip`
    );
    // Also verify key order matches per entry (canonical field order is part
    // of the contract — js-yaml preserves object insertion order on parse).
    assert.deepEqual(
      Object.keys(r),
      Object.keys(o),
      `entry ${i} (${o.title}) field order changed`
    );
  }
});

test("round-trip: input was already in sorted order (no shuffling)", () => {
  // data-manager.py sorts on every write, so the on-disk file should
  // already be sorted. If sortMovies disagrees with that order on real data,
  // it indicates a sort-comparator bug.
  const text = readFileSync(YML_PATH, "utf-8");
  const original = yaml.load(text);
  const sorted = sortMovies(original);
  for (let i = 0; i < original.length; i++) {
    assert.equal(
      sorted[i].imdb_id,
      original[i].imdb_id,
      `entry ${i}: sortMovies disagrees with on-disk order ` +
        `(disk: ${original[i].title} ${original[i].year} / ` +
        `sort: ${sorted[i].title} ${sorted[i].year})`
    );
  }
});

test("yaml dump options: produces block-style sequences (no [flow] form)", () => {
  const sample = [
    {
      title: "X",
      awards: ["a", "b"],
      tags: ["x", "y", "z"],
    },
  ];
  const dumped = yaml.dump(sample, YAML_DUMP_OPTIONS);
  // Block-style sequences use leading "- " indented under the key, not "[a, b]".
  assert.ok(!dumped.includes("[a, b]"), `flow style leaked: ${dumped}`);
  assert.ok(dumped.includes("- a"), `expected block style: ${dumped}`);
  assert.ok(dumped.includes("- b"), `expected block style: ${dumped}`);
});
