## Movie Collection Web Editor

A static, single-user web page for maintaining the movie collection. Produces a YAML file at [data/movies.yml](data/movies.yml) for direct commit into [nambin.github.io](https://github.com/nambin/nambin.github.io)'s `data/movies.yml`.

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
- `GEMINI_API_KEY` — optional, for `build:dev` only (it inlines the key so the memo flow works without typing one). The bulk-import (memo) flow makes per-line LLM calls to `gemini-flash-lite-latest`. Get one from [Google AI Studio](https://aistudio.google.com/app/apikey). On the deployed `build`, users instead paste their own key into the memo bar's key input at runtime.

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

Tests cover every data-correctness module. Fixtures are real TMDB JSON responses fetched once from the example URLs in [README.md](README.md) (Parasite, Oppenheimer, Shoplifters, The Witches) and stored under [tests/fixtures/](tests/fixtures/).

```bash
npm install   # one-time, pulls in js-yaml
npm test
```

The acceptance test (round-trip parity) loads the real [data/movies.yml](data/movies.yml), runs every entry through the canonicalize → sort → dump → re-parse pipeline, and asserts deep equality with the original. See [tests/yaml-roundtrip.test.js](tests/yaml-roundtrip.test.js).

### Deploying to nambin.github.io

```bash
npm run build   # ← MUST be `build`, never `build:dev` (see API keys section)
```

That's it on this side. The deploy is a plain copy of two files — no edits required:

| Source (this repo) | Destination (nambin.github.io) |
| --- | --- |
| `index.html` | `movies_editor.html` |
| `assets/movies_editor.js` | `assets/movies_editor.js` |

`index.html` already references `assets/movies_editor.js` and has CSS inlined, so the file works as-is once placed at the deploy location. js-yaml is inlined in the bundle — no CDN dependency, no importmap.

Commit and push both files in `nambin.github.io`. URL: `https://nambin.github.io/movies_editor.html`.

**Auto-load of `data/movies.yml`:** on page load, the editor fetches `data/movies.yml` from the same origin. On github.io that's `nambin.github.io/data/movies.yml`; locally, `python -m http.server` in this repo serves `data/movies.yml` at the same relative path. If localStorage has unsaved local edits (`dirty=true`), the auto-load is skipped and a status message offers the file picker for explicit override. Pushing a new `data/movies.yml` to nambin.github.io is effectively a deploy of the latest movie list.

### Architecture

Pure data-correctness logic is isolated in [lib/](lib/) so it's testable in Node without DOM. The UI is hand-written vanilla JS, bundled by esbuild for both local serve and deploy — no framework, single bundle output.

| Module | Purpose |
| --- | --- |
| [lib/utils.js](lib/utils.js) | Hangul detection, ISO 639 → English name, awards (real names + badge mapping + derivation), sort comparator, js-yaml dump options |
| [lib/tmdb_utils.js](lib/tmdb_utils.js) | TMDB Movie Details JSON → web-app entry |
| [lib/canonicalize.js](lib/canonicalize.js) | Field-order enforcement, omit-when-empty, awards derivation |
| [lib/app.js](lib/app.js) | Entry point: DOM, file I/O, TMDB fetching, localStorage. Bundled into `assets/movies_editor.js`. |
| [index.html](index.html) | Layout, card template, inline CSS. References the bundled JS. |

### Notable design decisions

- **`country` is dropped for newly-added movies.** Unused by the site, redundant with `tmdb_original_language`. Legacy entries loaded from YML keep theirs verbatim.
- **`title` is auto-composed from TMDB `title` + `original_title` and not editable.** When the two differ, the title is `"<tmdb title> (<original title>)"` (e.g. `Parasite (기생충)`); when they're equal or one is missing, the single form is used. This recreates the parenthetical pattern of the legacy CSV titles directly from TMDB. Korean overlays beyond what TMDB provides go through `custom_korean_title`.
- **`award_names` is the source of truth; `awards` is derived.** The 10-option picker writes the full real names (e.g. `Cannes Palme d'Or`); the badge-key list is recomputed on save via the `_FILM_AWARDS`-equivalent mapping in [lib/awards.js](lib/awards.js).
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
