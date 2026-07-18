// Builds the public movie-list page bundle (lib/movies_page.js →
// assets/movies_page.js). Unlike movies_editor.js, this bundle needs no API
// keys — it only fetches and renders data/movies.yml.
//
// Run: `npm run build:movies-page` (from the repo root).

import { execSync } from "node:child_process";

const watch = process.argv.includes("--watch");

const cmd =
  `npx esbuild lib/movies_page.js --bundle --format=esm ` +
  (watch ? "" : "--minify ") +
  `--outfile=assets/movies_page.js` +
  (watch ? " --watch" : "");

execSync(cmd, { stdio: "inherit" });
if (!watch) console.log("✓ production build written to assets/movies_page.js");
