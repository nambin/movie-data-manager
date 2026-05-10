## Movie Collection Web Editor

A static, single-user web page for maintaining the movie collection without touching the Google Spreadsheet. Replaces the CSV-editing step in the [data-manager.py](data-manager.py) pipeline; produces a YAML file structurally compatible with [prod-output-movies.yml](prod-output-movies.yml) for direct commit into [nambin.github.io](https://github.com/nambin/nambin.github.io)'s `_data/movies.yml`.

The full specification lives in [web-app-prompt.md](web-app-prompt.md).

### Features

- **Load** an existing YML via file picker.
- **Add** a movie by pasting a TMDB movie URL (e.g. `https://www.themoviedb.org/movie/496243`).
- **Edit** per-entry: `year`, `director`, `custom_korean_title`, personal rating (Masterpiece / My Best / none), award names (10-option multi-select), `note`.
- **Search** across title, director, language, year, awards, note.
- **Download** as a sorted, canonical YAML file. The on-disk schema and field order match what [data-manager.py](data-manager.py) emits, so the round-trip is structurally lossless.
- **Persistence**: every edit is auto-saved to `localStorage`; an unsaved-changes indicator warns before page unload.

### How to Run

No build step. Either open `index.html` directly via `file://`, or serve the directory:

```bash
python -m http.server
# then open http://localhost:8000
```

CORS note: TMDB's API allows browser requests, so adding via TMDB URL works from both `file://` and a static server. If a particular browser blocks `file://` fetches, use the static-server option.

### How to Test

Tests cover every data-correctness module. Fixtures are real TMDB JSON responses fetched once from the example URLs in [README.md](README.md) (Parasite, Oppenheimer, Shoplifters, The Witches) and stored under [tests/fixtures/](tests/fixtures/).

```bash
npm install   # one-time, pulls in js-yaml
npm test
```

The acceptance test (round-trip parity) loads the real [prod-output-movies.yml](prod-output-movies.yml), runs every entry through the canonicalize → sort → dump → re-parse pipeline, and asserts deep equality with the original. See [tests/yaml-roundtrip.test.js](tests/yaml-roundtrip.test.js).

### Architecture

Pure data-correctness logic is isolated in [lib/](lib/) so it's testable in Node without DOM. The UI is hand-written vanilla JS using `<script type="module">` and an importmap for js-yaml — no framework, no bundler.

| Module | Purpose |
| --- | --- |
| [lib/utils.js](lib/utils.js) | Hangul detection, ISO 639 → English name, awards (real names + badge mapping + derivation), sort comparator matching [data-manager.py:531-541](data-manager.py#L531-L541), js-yaml dump options |
| [lib/tmdb_utils.js](lib/tmdb_utils.js) | TMDB Movie Details JSON → web-app entry |
| [lib/canonicalize.js](lib/canonicalize.js) | Field-order enforcement, omit-when-empty, awards derivation |
| [app.js](app.js) | DOM, file I/O, TMDB fetching, localStorage |
| [index.html](index.html) | Layout, card template, importmap |
| [style.css](style.css) | Styling |

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
for pair in 496243:parasite 872585:oppenheimer 505192:shoplifters 531219:the-witches; do
  id=${pair%:*}; name=${pair#*:}
  curl -s "https://api.themoviedb.org/3/movie/${id}?api_key=${KEY}&append_to_response=credits" \
    | python -m json.tool --no-ensure-ascii > "tmdb-${name}.json"
done
```

The pipe through `python -m json.tool` keeps the fixtures pretty-printed (indent=2, unicode preserved) so they're readable in diffs.

Test assertions reference specific values from these responses — if TMDB changes them, expect the fixture-driven tests to fail until the assertions are updated to match.
