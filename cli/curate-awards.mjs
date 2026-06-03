#!/usr/bin/env node
// Award-curation CLI. Collects official winner lists for six top film prizes
// (5 international via Wikidata, Blue Dragon via Wikipedia), resolves each to an
// IMDb/TMDB entry, and writes data/awards.yml. See prompt-award-curation.md.
//
// Env: TMDB_API_KEY (required), GEMINI_API_KEY (optional — only the rare
// no-IMDb fallback needs it). Run: `node cli/curate-awards.mjs`.
//
// Idempotent: the run is a full regenerate. `generated_at` is only re-stamped
// when the substantive `by_imdb` content changed, so a quiet week leaves the
// file byte-identical and produces an empty git diff.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import yaml from "js-yaml";

import { buildKoreanDirectorMap, YAML_DUMP_OPTIONS } from "../lib/utils.js";
import {
  curateAwards,
  dumpAwardsYaml,
  diffAwards,
  formatChangeSummary,
} from "../lib/awards_curation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(root, "data", "awards.yml");

// Key lookup mirrors scripts/build.mjs: prefer the environment (CI secrets),
// fall back to the .env file at the repo root (local runs) so the same .env
// the builds use works here too without exporting anything.
function readEnvVar(name) {
  if (process.env[name]) return process.env[name].trim();
  let envText;
  try {
    envText = readFileSync(path.join(root, ".env"), "utf8");
  } catch {
    return null;
  }
  const m = envText.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

const tmdbApiKey = readEnvVar("TMDB_API_KEY");
const geminiKey = readEnvVar("GEMINI_API_KEY");
if (!tmdbApiKey) {
  console.error("TMDB_API_KEY is required (set it in the environment).");
  process.exit(1);
}
if (!geminiKey) {
  console.error(
    "(GEMINI_API_KEY not set — winners lacking an IMDb id will be logged and skipped.)"
  );
}

// Korean director map from the existing collection, so the Gemini fallback can
// recover curated Korean spellings (best-effort — fine if movies.yml is absent).
let koreanDirectorMap = new Map();
try {
  const movies = yaml.load(readFileSync(path.join(root, "data", "movies.yml"), "utf-8"));
  koreanDirectorMap = buildKoreanDirectorMap(Array.isArray(movies) ? movies : []);
} catch (e) {
  console.error(`(could not build Korean director map: ${e.message})`);
}

// Stamp in Seoul local time (the workflow also sets TZ=Asia/Seoul).
const generatedAt = new Date().toLocaleDateString("en-CA", {
  timeZone: "Asia/Seoul",
});

const doc = await curateAwards({
  tmdbApiKey,
  geminiKey,
  koreanDirectorMap,
  generatedAt,
  log: (m) => console.error(m),
});

// Load the existing file once — used both for the idempotency check and for
// the change summary (what's newly populated since last run).
let prevByImdb = {};
try {
  prevByImdb = yaml.load(readFileSync(outPath, "utf-8"))?.by_imdb ?? {};
} catch {
  /* no existing file — first run; everything is "added" */
}

// Idempotent write: compare only the substantive body (ignoring generated_at).
const newBody = yaml.dump({ by_imdb: doc.by_imdb }, YAML_DUMP_OPTIONS);
const existingBody = yaml.dump({ by_imdb: prevByImdb }, YAML_DUMP_OPTIONS);

const filmCount = Object.keys(doc.by_imdb).length;
if (existingBody === newBody) {
  console.error(`No changes — ${filmCount} films, ${outPath} left as-is.`);
} else {
  writeFileSync(outPath, dumpAwardsYaml(doc), "utf-8");

  // Write a human-readable change summary (consumed by the workflow's email).
  const diff = diffAwards(prevByImdb, doc.by_imdb);
  const summary = formatChangeSummary(diff, { generatedAt });
  console.error(summary);
  if (process.env.AWARDS_SUMMARY_FILE) {
    writeFileSync(process.env.AWARDS_SUMMARY_FILE, summary, "utf-8");
  }
  console.error(`Wrote ${outPath} — ${filmCount} films.`);
}
