// Production build. Inlines:
//   __TMDB_KEY__   — required. Read from process.env.TMDB_API_KEY or the
//                    .env file at the repo root. Exits with a clear error
//                    if missing. (TMDB is needed by URL-paste even on the
//                    deployed site, so the prod bundle must carry the key.)
//   __GEMINI_KEY__ — empty string. The bulk-import UI hides itself at runtime
//                    when getGeminiKey() returns null, so the deployed site
//                    has no memo feature — exactly what we want.
//
// Run: `npm run build` (from the repo root).
//
// No API keys are stored anywhere in source. Anyone cloning the repo must
// supply their own `.env` with at least `TMDB_API_KEY=...` to build.

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

const tmdbKey = readEnvVar("TMDB_API_KEY");
if (!tmdbKey) {
  console.error(
    "build: TMDB_API_KEY not found. Set it in .env or as an environment variable."
  );
  process.exit(1);
}

// --watch swaps minification off (faster rebuilds) and adds esbuild's
// continuous-watch mode. Used by `npm run watch` for active development.
const watch = process.argv.includes("--watch");

const cmd =
  `npx esbuild lib/app.js --bundle --format=esm ` +
  (watch ? "" : "--minify ") +
  `--define:__TMDB_KEY__=${JSON.stringify(JSON.stringify(tmdbKey))} ` +
  `--define:__GEMINI_KEY__=${JSON.stringify(JSON.stringify(""))} ` +
  `--outfile=assets/movies_editor.js` +
  (watch ? " --watch" : "");

execSync(cmd, { stdio: "inherit" });
if (!watch) console.log("✓ production build written to assets/movies_editor.js");
