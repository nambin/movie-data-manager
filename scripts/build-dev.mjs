// Dev build — inlines both the Gemini and TMDB API keys from .env into the
// bundle so local testing of the memo bulk-import flow doesn't require any
// manual key entry. The resulting bundle MUST NOT be deployed to GitHub
// Pages; the Gemini key will be visible to anyone who reads the JS source.
//
// Run: `npm run build:dev` (from the repo root).
//
// Reads keys from, in order of precedence:
//   1. process.env.{GEMINI_API_KEY,TMDB_API_KEY}
//   2. The .env file at the repo root (KEY=VALUE format)
//
// Both keys are required — exits with a clear error if either is missing.
// No API keys are stored anywhere in source.
//
// The production build (`npm run build` → scripts/build.mjs) inlines TMDB
// the same way and defines __GEMINI_KEY__='""' so the bulk-import UI hides
// itself on the deployed site. See lib/gemini_utils.js getGeminiKey() and
// lib/tmdb_utils.js getTmdbKey() for the consumer side.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

function readEnvVar(name) {
  if (process.env[name]) return process.env[name].trim();
  let envText;
  try {
    envText = readFileSync(".env", "utf8");
  } catch {
    return null;
  }
  const m = envText.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

function requireEnvVar(name) {
  const v = readEnvVar(name);
  if (!v) {
    console.error(
      `build-dev: ${name} not found. Set it in .env or as an environment variable.`
    );
    process.exit(1);
  }
  return v;
}

const geminiKey = requireEnvVar("GEMINI_API_KEY");
const tmdbKey = requireEnvVar("TMDB_API_KEY");

const banner = JSON.stringify(
  "/* DEV BUILD — Gemini API key inlined from .env. DO NOT DEPLOY. */"
);

const cmd =
  `npx esbuild lib/app.js --bundle --format=esm ` +
  `--define:__GEMINI_KEY__=${JSON.stringify(JSON.stringify(geminiKey))} ` +
  `--define:__TMDB_KEY__=${JSON.stringify(JSON.stringify(tmdbKey))} ` +
  `--banner:js=${banner} ` +
  `--outfile=assets/movies_editor.js`;

execSync(cmd, { stdio: "inherit" });
console.log(
  "✓ dev build written to assets/movies_editor.js (KEY INLINED — DO NOT DEPLOY)"
);
