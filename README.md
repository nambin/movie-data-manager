## Movie Collection Web Editor

A static, single-user web page for maintaining the movie collection. Produces a `movies.yml` for direct commit into [nambin.github.io](https://github.com/nambin/nambin.github.io)'s `data/movies.yml`.

> **Where the data lives.** The canonical `movies.yml` and `awards.yml` live in the **nambin.github.io** repo (`data/`) — that is the single source of truth and what the live site serves. This repo holds no copies. The CLIs and tests read/write those files via `DATA_DIR`, which defaults to the side-by-side checkout `../nambin.github.io/data`. The deployed editor loads them from its own origin; the local-dev editor falls back to fetching them from `https://nambin.github.io`.

The full specification lives in [prompt-web-app.md](prompt-web-app.md); the memo bulk-import architecture in [prompt-web-app-with-llm.md](prompt-web-app-with-llm.md).

### Features

- **Load** an existing YML via file picker.
- **Add** a movie by pasting a TMDB movie URL (e.g. `https://www.themoviedb.org/movie/496243`).
- **Bulk-import** by pasting an unstructured memo (one title per line, including Korean phonetic transliterations like `보헤미안 랩소디`). The memo is parsed by Gemini, candidates are fetched from TMDB and disambiguated by Gemini, then a review pane lets you approve each entry before committing. Works on the deployed site too — supply your own Gemini key in the memo bar — or use a `build:dev` bundle with the key inlined. See [API keys](#api-keys-env) below.
- **Edit** per-entry: `year`, `director`, `custom_korean_title`, personal rating (Masterpiece / My Best / none), award names (10-option multi-select), `note`.
- **Search** across title, director, language, year, awards, note.
- **Download** as a sorted, canonical YAML file. Schema and field order match the format documented in [prompt-web-app.md](prompt-web-app.md#data-model); the round-trip test asserts structural deep-equality.
- **Persistence**: every edit is auto-saved to `localStorage`; an unsaved-changes indicator warns before page unload.

### How to Run

`index.html` references the bundle at `assets/movies_editor.js`, so produce that once before serving. Both builds require a `.env` file at the repo root (see the [API keys section](#api-keys-env) below):

```bash
npm install     # one-time, pulls in js-yaml + esbuild
# create .env with TMDB_API_KEY (and GEMINI_API_KEY for dev) — see below
npm run build   # produces assets/movies_editor.js
python -m http.server
# open http://localhost:8000
```

For active development, run the watcher in a separate terminal — it rebuilds on every save (no minification, faster):

```bash
npm run watch
```

Hard-refresh the browser (`Ctrl+F5`) after each save to bypass the cache.

To test the **memo bulk-import** feature locally, use `npm run build:dev` instead of `npm run build` — it inlines your Gemini API key from `.env`. The full setup is described in the next section.

CORS note: TMDB's API allows browser requests, so adding via TMDB URL works from any static server. The auto-load of `data/movies.yml` requires HTTP (not `file://`); use `python -m http.server` rather than opening the HTML directly.

### API keys (.env)

The TMDB key is **inlined into the bundle at build time** via esbuild's `--define` flag — there is no runtime UI for entering it, no `.env`-reading at page load. The Gemini key is also inlined at build time for `build:dev`, but the deployed `build` bundle ships with no Gemini key: instead the memo bar exposes a runtime key input where each user supplies their own Gemini key (kept only in that browser's `localStorage`). No key is stored in source; build-time keys are read from `.env` (or `process.env`).

**Setup** — create a `.env` file at the repo root:

```
TMDB_API_KEY=...
GEMINI_API_KEY=AIzaSy...
```

- `TMDB_API_KEY` — required for **both** builds. The deployed editor needs TMDB for the URL-paste add bar. Get one from [TMDB → Settings → API](https://www.themoviedb.org/settings/api).
- `GEMINI_API_KEY` — optional, for `build:dev` only (it inlines the key so the memo flow works without typing one). The bulk-import (memo) flow makes per-line LLM calls to Gemini (default model `gemini-flash-latest` — see `DEFAULT_GEMINI_MODEL` in [lib/gemini_utils.js](lib/gemini_utils.js)). Get one from [Google AI Studio](https://aistudio.google.com/app/apikey). On the deployed `build`, users instead paste their own key into the memo bar's key input at runtime.

`.env` is gitignored.

**Two build variants:**

| Command | TMDB key in bundle? | Gemini key in bundle? | Safe to deploy? |
| --- | --- | --- | --- |
| `npm run build` | ✅ (required from `.env`) | ❌ — defined as `""`; memo bar stays visible, user supplies their own key at runtime | ✅ |
| `npm run build:dev` | ✅ (required from `.env`) | ✅ (required from `.env`) — `/* DEV BUILD — DO NOT DEPLOY. */` banner prepended | ❌ **NEVER** |

Both write to the same `assets/movies_editor.js` path. **Habit: end every local session with `npm run build` so the working tree is always deployable.**

**Local testing** of the bulk-import feature:

```bash
npm run build:dev
python -m http.server 8000
# open http://localhost:8000
# the memo textarea is visible and ready
```

**Production deployment** ships the memo bar with a runtime key input:

```bash
npm run build   # NOT build:dev
```

[lib/app.js](lib/app.js) calls `getGeminiKey()` at boot. If it returns `null` (the empty-string case from `npm run build`), the `<div class="memo-bar">` stays visible, the runtime Gemini key input (`#gemini-key-input`) is revealed, and the **Process memo** button stays disabled until the user types a key (and a non-empty memo). The user's key is persisted to that browser's `localStorage` so it survives reloads, and is never sent anywhere except Google's Gemini API. When a key *is* inlined (`build:dev`), the runtime input stays hidden since it isn't needed.

**The footgun, mitigated**: if you accidentally copy a `build:dev` output to nambin.github.io, the Gemini key leaks. Two defenses:

1. The dev bundle starts with `/* DEV BUILD — Gemini API key inlined from .env. DO NOT DEPLOY. */` — visible in the first 80 bytes. A simple `grep -q "DEV BUILD" assets/movies_editor.js && exit 1` step before any deploy catches it.
2. The `build:dev` command's stdout ends with `KEY INLINED — DO NOT DEPLOY`.

**For additional safety**, restrict the AI Studio key by HTTP referrer (to `nambin.github.io` and your local dev origin) and set a daily quota cap — both are one-click options in the AI Studio console. That way even an accidental leak has a bounded blast radius. The TMDB key is less sensitive (rate-limited free tier) but the same referrer restriction can be applied.

See [prompt-web-app-with-llm.md](prompt-web-app-with-llm.md) for the full design of the memo bulk-import architecture (the three-call LLM pipeline, year-offset TMDB search, review pane).

### How to Test

Tests cover every data-correctness module. Fixtures are real TMDB JSON responses fetched once and stored under [tests/fixtures/](tests/fixtures/) (Parasite, Oppenheimer, Shoplifters, The Witches, Police Story, Infernal Affairs, Bohemian Rhapsody, I'm Still Here — plus memo-pipeline search responses and awards fixtures under `memo/` and `awards/`).

```bash
npm install   # one-time, pulls in js-yaml
npm test
```

The acceptance test (round-trip parity) loads the real `movies.yml` (from `DATA_DIR`, default `../nambin.github.io/data`), runs every entry through the canonicalize → sort → dump → re-parse pipeline, and asserts deep equality with the original. The file-backed tests skip when that checkout isn't present. See [tests/yaml-roundtrip.test.js](tests/yaml-roundtrip.test.js).

### Generating `data/awards.yml`

`data/awards.yml` is an auto-generated award lookup. A CLI collects the official winner lists for ten top prizes (Oscar Best Picture, Oscar Best International Film, Cannes Palme d'Or, Venice Leone d'oro, Berlin Goldener Bär, European Film Award for Best Film, Hong Kong Film Awards, 청룡영화제 최우수 작품상, César Award for Best Film, and Japan Academy Prize), resolves each winner to an IMDb/TMDB entry, and writes a lookup keyed by `imdb_id` → `award_names`. The web app can later read it to pre-fill awards when a movie is added, so they never have to be searched and matched by hand. The full design is in [prompt-award-curation.md](prompt-award-curation.md).

Sources: **seven** awards come from **Wikidata** (SPARQL, `P166` "award received" = winner-only, mostly carrying an IMDb ID directly); **three** (Blue Dragon, César, Japan Academy) are too sparse in Wikidata and are parsed from their **English Wikipedia** winners tables. For the rare winner with no IMDb ID, the existing Gemini + TMDB memo pipeline ([lib/memo_pipeline.js](lib/memo_pipeline.js)) is used as a fallback. These ten are the entire award taxonomy, so `awards.yml` is the complete source of truth for awards.

To generate it from scratch:

```bash
npm install
# .env at the repo root needs TMDB_API_KEY (required) and GEMINI_API_KEY (optional) — see API keys section
npm run curate:awards   # writes awards.yml into $DATA_DIR (default ../nambin.github.io/data)
```

- `TMDB_API_KEY` — **required**. Used to resolve each IMDb ID to a TMDB entry (`/find?external_source=imdb_id`).
- `GEMINI_API_KEY` — **optional**. Only the no-IMDb fallback uses it. If it is absent, those few winners are logged and skipped (the run still succeeds); set it to resolve them too.

The keys are read from `process.env` (the same `.env` the builds use — the CLI runs under plain Node, so the esbuild build-time inlining does not apply). The run is a full **idempotent** regenerate: `generated_at` is only re-stamped when the substantive `by_imdb` content actually changed, so a run with no new winners leaves the file byte-identical (empty `git diff`). It makes a few hundred TMDB lookups, so expect it to take a couple of minutes.

### Reconciling `data/movies.yml` against `data/awards.yml`

`data/awards.yml` is the **complete source of truth for awards**. A second CLI overwrites each movie's `award_names` (matched by `imdb_id`) with exactly what `awards.yml` lists for that film — and **removes every award** from a movie that `awards.yml` doesn't list (including films absent from it entirely). It doesn't preserve any award on a movie that isn't in `awards.yml`. No network or API keys needed.

```bash
npm run reconcile:awards              # writes movies.yml in $DATA_DIR (default ../nambin.github.io/data)
npm run reconcile:awards -- --dry-run # report the changes without writing
```

### Deploying to nambin.github.io

```bash
npm run build   # ← MUST be `build`, never `build:dev` (see API keys section)
```

That's it on this side. The deploy is a plain copy of two editor files — no edits required:

| Source (this repo) | Destination (nambin.github.io) |
| --- | --- |
| `index.html` | `movies_editor.html` |
| `assets/movies_editor.js` | `assets/movies_editor.js` |

`index.html` already references `assets/movies_editor.js` and has CSS inlined, so the file works as-is once placed at the deploy location. js-yaml is inlined in the bundle — no CDN dependency, no importmap.

Commit and push both files in `nambin.github.io`. URL: `https://nambin.github.io/movies_editor.html`.

**The data files are NOT copied** — `data/movies.yml` and `data/awards.yml` live in nambin.github.io and are the source of truth. To publish a new movie list, **commit the editor's downloaded `movies.yml` directly to `nambin.github.io/data/movies.yml`**. `awards.yml` is maintained automatically by the cron below.

**Auto-load of `data/movies.yml`:** on page load, the editor fetches `data/movies.yml` from the same origin. On github.io that's `nambin.github.io/data/movies.yml`; locally (`python -m http.server` in this repo, which no longer carries the file), the editor falls back to fetching from `https://nambin.github.io`. If localStorage has unsaved local edits (`dirty=true`), the auto-load is skipped and a status message offers the file picker for explicit override. Pushing a new `data/movies.yml` to nambin.github.io is effectively a deploy of the latest movie list.

### Public movie list (movies.html)

[lib/movies_page.js](lib/movies_page.js) renders the movie list on `nambin.github.io/movies.html` client-side: it fetches `data/movies.yml` straight from `raw.githubusercontent.com/nambin/nambin.github.io/main/data/movies.yml` (falling back to the same-origin `/data/movies.yml` if that's unreachable), parses it with js-yaml, and builds the movie cards in the DOM. This replaced the old Jekyll `{% for movie in site.data.movies %}` build-time loop, whose output only updates when a GitHub Pages build succeeds — raw.githubusercontent.com serves straight from the git blob and reflects a new commit instantly, regardless of Pages build/deploy health.

Unlike the editor bundle, this one needs **no API keys** — it only reads and renders YAML.

```bash
npm run build:movies-page         # produces assets/movies_page.js
npm run watch:movies-page         # rebuild on save, unminified, for active development
```

**Deploying:** copy the built file into nambin.github.io — no edits needed there unless the card markup/attributes themselves change (they must keep matching what [nambin.github.io's `includes/movies.js`](https://github.com/nambin/nambin.github.io/blob/main/includes/movies.js) filter/search logic expects):

| Source (this repo) | Destination (nambin.github.io) |
| --- | --- |
| `assets/movies_page.js` | `assets/movies_page.js` |

Commit and push the file in `nambin.github.io`. `movies.html` there already references it via `<script type="module" src="/assets/movies_page.js">`.

### Android app

A phone-native, curation-only client lives in [android/](android/) — same repo, its own Gradle project. It's a different front door onto the same `data/movies.yml` (memo-based add, search-based update, one-tap commit straight to GitHub) rather than a copy of this web app. Spec: [prompt-android-app.md](prompt-android-app.md). Build setup: [android/README.md](android/README.md).

### Award-curation cron

[.github/workflows/curate-awards.yml](.github/workflows/curate-awards.yml) runs `curate:awards` weekly (Wed 04:00 KST) and on manual `workflow_dispatch`. It checks out **nambin.github.io** into `./site`, regenerates `site/data/awards.yml`, and — only when it changed — commits and pushes that file **to nambin.github.io** (then emails a summary). This requires a repo secret **`NAMBIN_IO_TOKEN`**: a credential with write access to `nambin/nambin.github.io` (a fine-grained PAT with `Contents: read/write`, or a deploy key). The default `GITHUB_TOKEN` can't push cross-repo, so this secret is mandatory for the push to succeed.

### Architecture

Pure data-correctness logic is isolated in [lib/](lib/) so it's testable in Node without DOM. The UI is hand-written vanilla JS, bundled by esbuild for both local serve and deploy — no framework, single bundle output.

| Module | Purpose |
| --- | --- |
| [lib/utils.js](lib/utils.js) | Hangul detection, ISO 639 → English name, awards (real names + badge mapping + derivation), sort comparator, js-yaml dump options |
| [lib/tmdb_utils.js](lib/tmdb_utils.js) | TMDB Movie Details JSON → web-app entry |
| [lib/canonicalize.js](lib/canonicalize.js) | Field-order enforcement, omit-when-empty, awards derivation |
| [lib/app.js](lib/app.js) | Entry point: DOM, file I/O, TMDB fetching, localStorage. Bundled into `assets/movies_editor.js`. |
| [index.html](index.html) | Layout, card template, inline CSS. References the bundled JS. |
| [lib/movies_page.js](lib/movies_page.js) | Entry point for the public movie list: fetches + parses `movies.yml`, renders cards. Bundled into `assets/movies_page.js`, deployed to `nambin.github.io/movies.html`. |

### Notable design decisions

- **`country` is dropped for newly-added movies.** Unused by the site, redundant with `tmdb_original_language`. Legacy entries loaded from YML keep theirs verbatim.
- **`title` is auto-composed from TMDB `title` + `original_title` and not editable.** When the two differ, the title is `"<tmdb title> (<original title>)"` (e.g. `Parasite (기생충)`); when they're equal or one is missing, the single form is used. This recreates the parenthetical pattern of the legacy CSV titles directly from TMDB. Korean overlays beyond what TMDB provides go through `custom_korean_title`.
- **`award_names` is the source of truth; `awards` is derived.** The 10-option picker writes the full real names (e.g. `Cannes Palme d'Or`); the badge-key list is recomputed on save via the `_FILM_AWARDS`-equivalent mapping in [lib/utils.js](lib/utils.js).
- **Acceptance test is structural, not byte-identical.** PyYAML and js-yaml may disagree on cosmetic quoting (single vs double quotes, when to quote a string containing `:`), so the round-trip asserts deep-equal in-memory equivalence rather than file-byte equality.

### Updating fixtures

The fixtures under [tests/fixtures/](tests/fixtures/) are a frozen snapshot of TMDB responses (both `/movie/{id}?append_to_response=credits` details and `/search/movie?...` results). To refresh all of them:

```bash
npm run capture:fixtures
```

This runs [scripts/capture-fixtures.mjs](scripts/capture-fixtures.mjs), which holds the canonical list of `(output path, TMDB URL)` pairs and hits TMDB once per pair. The TMDB API key it uses is the same hardcoded one in `lib/app.js` — no extra setup. The fixtures it writes are pretty-printed with 2-space indent, unicode preserved, trailing newline.

To add a new fixture, append a `[path, url]` entry to the `FIXTURES` array in [scripts/capture-fixtures.mjs](scripts/capture-fixtures.mjs) and re-run the command.

Test assertions reference specific values from these responses — if TMDB changes them, expect the fixture-driven tests to fail until the assertions are updated to match.

**One-time normalization caveat:** the legacy `tmdb-*.json` fixtures (parasite, oppenheimer, shoplifters, the-witches, police-story, infernal-affairs) were originally produced by a `python -m json.tool` shell pipeline that wrote CRLF line endings. The capture script writes LF. The first time `npm run capture:fixtures` is run against those files, expect a one-time CRLF → LF normalization diff (~14k lines, no semantic change). After that, refreshes show only real TMDB content changes.
