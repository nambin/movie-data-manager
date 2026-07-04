// Round-trip test against the real data/movies.yml.
// Loads the file, runs each entry through canonicalize + sort, dumps with
// js-yaml using YAML_DUMP_OPTIONS, parses the dumped output, and asserts
// structural equality with the original.
//
// This is the acceptance test from web-app-prompt.md (primary assertion:
// structural deep-equal). Cosmetic byte-level differences are tolerated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";
import { canonicalizeAll } from "../lib/canonicalize.js";
import {
  sortMovies,
  YAML_DUMP_OPTIONS,
  YAML_LOAD_OPTIONS,
} from "../lib/utils.js";

// movies.yml now lives in the nambin.github.io repo. Resolve it the same way
// the CLIs do: DATA_DIR if set, else the side-by-side checkout. The file-backed
// tests skip when that checkout isn't present (e.g. CI without the sibling repo).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(root, "..", "nambin.github.io", "data");
const YML_PATH = path.join(dataDir, "movies.yml");
const haveMovies = existsSync(YML_PATH);

test("round-trip: load → canonicalize → sort → dump → parse → deep-equal", { skip: !haveMovies && `movies.yml not found at ${YML_PATH}` }, () => {
  const text = readFileSync(YML_PATH, "utf-8");
  const original = yaml.load(text, YAML_LOAD_OPTIONS);
  assert.ok(Array.isArray(original));
  assert.ok(original.length > 800, `expected hundreds of movies, got ${original.length}`);

  const processed = sortMovies(canonicalizeAll(original));
  const dumped = yaml.dump(processed, YAML_DUMP_OPTIONS);
  const reparsed = yaml.load(dumped, YAML_LOAD_OPTIONS);

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

test("round-trip: input was already in sorted order (no shuffling)", { skip: !haveMovies && `movies.yml not found at ${YML_PATH}` }, () => {
  // The web app sorts on every download (see lib/app.js's Download YML
  // handler), so the on-disk file should already be sorted by the time it's
  // committed. If sortMovies disagrees with that order on real data, it
  // indicates a sort-comparator bug.
  const text = readFileSync(YML_PATH, "utf-8");
  const original = yaml.load(text, YAML_LOAD_OPTIONS);
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

test("YAML_SCHEMA: plain YYYY-MM-DD scalars stay strings, not Date objects (date_committed regression)", () => {
  // DEFAULT_SCHEMA would parse an unquoted `2026-01-04` into a JS Date on
  // load, then dump it back as a full ISO string with a time component
  // (`2026-01-04T00:00:00.000Z`) — silently corrupting `date_committed` (and
  // `generated_at` in awards.yml) on the next load→dump round trip.
  const loaded = yaml.load("date_committed: 2026-01-04\ntitle: X\n", YAML_LOAD_OPTIONS);
  assert.equal(typeof loaded.date_committed, "string");
  assert.equal(loaded.date_committed, "2026-01-04");

  const dumped = yaml.dump(loaded, YAML_DUMP_OPTIONS);
  assert.ok(
    dumped.includes("date_committed: 2026-01-04\n"),
    `expected plain unquoted date, got: ${dumped}`
  );
  assert.ok(!dumped.includes("T00:00:00"), `date got timestamp-ified: ${dumped}`);
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
