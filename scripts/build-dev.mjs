// Dev build — inlines the Gemini API key from .env (or process.env) into the
// bundle so local testing of the memo bulk-import flow doesn't require any
// manual key entry. The resulting bundle MUST NOT be deployed to GitHub
// Pages; the key will be visible to anyone who reads the JS source.
//
// Run: `npm run build:dev` (from the repo root).
//
// Reads GEMINI_API_KEY from, in order of precedence:
//   1. process.env.GEMINI_API_KEY (e.g. `GEMINI_API_KEY=... npm run build:dev`)
//   2. The .env file at the repo root (KEY=VALUE format)
// If neither is set, exits with a clear error rather than producing a broken
// bundle.
//
// The production build (`npm run build`) calls esbuild directly with
// --define:__GEMINI_KEY__='""' so __GEMINI_KEY__ is an empty string literal,
// which the gemini_utils.js code path treats as "no key, hide the UI".
// See package.json for the contrast between the two scripts.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  let envText;
  try {
    envText = readFileSync(".env", "utf8");
  } catch {
    return null;
  }
  const m = envText.match(/^GEMINI_API_KEY=(.+)$/m);
  return m ? m[1].trim() : null;
}

const key = loadKey();
if (!key) {
  console.error(
    "build-dev: GEMINI_API_KEY not found. Set it in .env or as an environment variable."
  );
  process.exit(1);
}

// esbuild's --define replaces `__GEMINI_KEY__` references in the source with
// the literal JSON value. We have to double-JSON-encode so that the value
// reaches esbuild as a JS string literal (with quotes), not a bare identifier.
const defineValue = JSON.stringify(JSON.stringify(key));

const banner = JSON.stringify(
  "/* DEV BUILD — Gemini API key inlined from .env. DO NOT DEPLOY. */"
);

const cmd =
  `npx esbuild lib/app.js --bundle --format=esm ` +
  `--define:__GEMINI_KEY__=${defineValue} ` +
  `--banner:js=${banner} ` +
  `--outfile=assets/movies_editor.js`;

execSync(cmd, { stdio: "inherit" });
console.log(
  "✓ dev build written to assets/movies_editor.js (KEY INLINED — DO NOT DEPLOY)"
);
