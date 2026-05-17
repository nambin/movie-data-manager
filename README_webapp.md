## Movie Collection Web Editor

A static, single-user web page for maintaining the movie collection without touching the Google Spreadsheet. Replaces the CSV-editing step in the [data-manager.py](data-manager.py) pipeline; produces a YAML file structurally compatible with [data/movies.yml](data/movies.yml) for direct commit into [nambin.github.io](https://github.com/nambin/nambin.github.io)'s `data/movies.yml`.

The full specification lives in [web-app-prompt.md](web-app-prompt.md).

### Features

- **Load** an existing YML via file picker.
- **Add** a movie by pasting a TMDB movie URL (e.g. `https://www.themoviedb.org/movie/496243`).
- **Bulk-import** by pasting an unstructured memo (one title per line, including Korean phonetic transliterations like `보헤미안 랩소디`). The memo is parsed by Gemini, candidates are fetched from TMDB and disambiguated by Gemini, then a review pane lets you approve each entry before committing. Local dev build only — see [Gemini API key](#gemini-api-key-memo-bulk-import) below.
- **Edit** per-entry: `year`, `director`, `custom_korean_title`, personal rating (Masterpiece / My Best / none), award names (10-option multi-select), `note`.
- **Search** across title, director, language, year, awards, note.
- **Download** as a sorted, canonical YAML file. The on-disk schema and field order match what [data-manager.py](data-manager.py) emits, so the round-trip is structurally lossless.
- **Persistence**: every edit is auto-saved to `localStorage`; an unsaved-changes indicator warns before page unload.

### How to Run

`index.html` references the bundle at `assets/movies_editor.js`, so produce that once before serving:

```bash
npm install     # one-time, pulls in js-yaml + esbuild
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

### Gemini API key (memo bulk-import)

The bulk-import flow makes per-line LLM calls to Google's Gemini API. The key is **inlined into the bundle at build time** via esbuild's `--define` flag — there is no runtime UI for entering a key, no `localStorage`, no `.env`-reading at page load. Two build variants exist:

| Command | What it does | Key in bundle? | Safe to deploy? |
| --- | --- | --- | --- |
| `npm run build` | Production build. Passes `--define:__GEMINI_KEY__='""'` so the constant becomes an empty string literal (dead-code-eliminated by esbuild). | ❌ | ✅ |
| `npm run build:dev` | Dev build. Reads `GEMINI_API_KEY` from `.env` (or `process.env`) and inlines it via `--define`. Adds a `/* DEV BUILD — DO NOT DEPLOY. */` banner at the top of the output. | ✅ | ❌ **NEVER** |

Both write to the same `assets/movies_editor.js` path. **Habit: end every local session with `npm run build` so the working tree is always deployable.**

**Setup** — put your key in `.env` at the repo root:

```
GEMINI_API_KEY=AIzaSy...
```

`.env` is gitignored. The key is yours from [Google AI Studio](https://aistudio.google.com/app/apikey); the model used is `gemini-flash-lite-latest`.

**Local testing** of the bulk-import feature:

```bash
npm run build:dev
python -m http.server 8000
# open http://localhost:8000
# the memo textarea is visible and ready
```

**Production deployment** has the bulk-import section automatically hidden:

```bash
npm run build   # NOT build:dev
```

[lib/app.js](lib/app.js) calls `getGeminiKey()` at boot. If it returns `null` (the empty-string case from `npm run build`), the entire `<div class="memo-bar">` is hidden — the deployed editor on nambin.github.io shows only the existing toolbar and TMDB-URL add-bar.

**The footgun, mitigated**: if you accidentally copy a `build:dev` output to nambin.github.io, the key leaks. Two defenses:

1. The dev bundle starts with `/* DEV BUILD — Gemini API key inlined from .env. DO NOT DEPLOY. */` — visible in the first 80 bytes. A simple `grep -q "DEV BUILD" assets/movies_editor.js && exit 1` step before any deploy catches it.
2. The `build:dev` command's stdout ends with `KEY INLINED — DO NOT DEPLOY`.

**For additional safety**, restrict the AI Studio key by HTTP referrer (to `nambin.github.io` and your local dev origin) and set a daily quota cap — both are one-click options in the AI Studio console. That way even an accidental leak has a bounded blast radius.

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
npm run build   # ← MUST be `build`, never `build:dev` (see Gemini API key section)
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
| [lib/utils.js](lib/utils.js) | Hangul detection, ISO 639 → English name, awards (real names + badge mapping + derivation), sort comparator matching [data-manager.py:531-541](data-manager.py#L531-L541), js-yaml dump options |
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

The fixtures under [tests/fixtures/](tests/fixtures/) are a frozen snapshot of TMDB responses. To refresh:

```bash
cd tests/fixtures
KEY=f6d7fb04f4d4d6b07d2d750811e73a4c
for pair in 496243:parasite 872585:oppenheimer 505192:shoplifters 531219:the-witches 9056:police-story 10775:infernal-affairs; do
  id=${pair%:*}; name=${pair#*:}
  curl -s "https://api.themoviedb.org/3/movie/${id}?api_key=${KEY}&append_to_response=credits" \
    | python -m json.tool --no-ensure-ascii > "tmdb-${name}.json"
done
```

The pipe through `python -m json.tool` keeps the fixtures pretty-printed (indent=2, unicode preserved) so they're readable in diffs.

Test assertions reference specific values from these responses — if TMDB changes them, expect the fixture-driven tests to fail until the assertions are updated to match.
