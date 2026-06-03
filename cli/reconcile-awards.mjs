#!/usr/bin/env node
// Reconcile the curated award data in data/movies.yml against data/awards.yml,
// which is treated as the ground truth for the six curated awards (Oscar Best
// Picture, Oscar Best International Film, Cannes Palme d'Or, Venice Leone d'oro,
// Berlin Goldener Bär, 청룡영화제 최우수 작품상). Any of those awards on a movie
// that is NOT backed by awards.yml is removed; any present in awards.yml but
// missing on the movie is added. Awards outside that set are left untouched.
//
// movies.yml is rewritten in canonical (canonicalize + sort) form — identical
// to what the web editor produces on download. Run: `node cli/reconcile-awards.mjs`
// (writes immediately). Pass `--dry-run` to report the changes without writing.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import yaml from "js-yaml";

import { canonicalizeAll } from "../lib/canonicalize.js";
import { sortMovies, YAML_DUMP_OPTIONS } from "../lib/utils.js";
import { reconcileMovies } from "../lib/awards_reconcile.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The canonical data lives in the nambin.github.io repo. Default to the
// side-by-side checkout (../nambin.github.io/data); override with DATA_DIR.
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(root, "..", "nambin.github.io", "data");
const moviesPath = path.join(dataDir, "movies.yml");
const awardsPath = path.join(dataDir, "awards.yml");
const dryRun = process.argv.includes("--dry-run");

const movies = yaml.load(readFileSync(moviesPath, "utf-8"));
if (!Array.isArray(movies)) {
  console.error("data/movies.yml did not parse to a list.");
  process.exit(1);
}
let byImdb;
try {
  byImdb = yaml.load(readFileSync(awardsPath, "utf-8"))?.by_imdb ?? {};
} catch (e) {
  console.error(`Could not read data/awards.yml: ${e.message}`);
  process.exit(1);
}

const { movies: reconciled, changes, unmatched } = reconcileMovies(movies, byImdb);

const adds = changes.reduce((s, c) => s + c.added.length, 0);
const rems = changes.reduce((s, c) => s + c.removed.length, 0);
console.error(
  `${movies.length} movies, ${Object.keys(byImdb).length} curated films in awards.yml.`
);
console.error(
  `${changes.length} movie(s) reconciled — ${adds} award(s) added, ${rems} removed:`
);
for (const c of changes) {
  const parts = [];
  if (c.added.length) parts.push(`+ ${c.added.join(", ")}`);
  if (c.removed.length) parts.push(`− ${c.removed.join(", ")}`);
  console.error(`  • ${c.title} [${c.imdb_id}]   ${parts.join("   ")}`);
}
if (unmatched.length) {
  console.error(
    `\n${unmatched.length} movie(s) without imdb_id carry curated awards and ` +
      `can't be matched — left untouched:`
  );
  for (const u of unmatched) {
    console.error(`  • ${u.title}   ${u.award_names.join(", ")}`);
  }
}

// Canonical (canonicalize + sort) output — matches the editor's on-disk format
// and re-derives the `awards` badges from the new award_names.
const dumped = yaml.dump(sortMovies(canonicalizeAll(reconciled)), YAML_DUMP_OPTIONS);
const current = readFileSync(moviesPath, "utf-8");

if (dumped === current) {
  console.error("\nmovies.yml already matches awards.yml — no write needed.");
} else if (dryRun) {
  console.error("\nDRY RUN — data/movies.yml would be rewritten (no changes written).");
} else {
  writeFileSync(moviesPath, dumped, "utf-8");
  console.error("\nWrote data/movies.yml (canonical order).");
}
