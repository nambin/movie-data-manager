# Movie Collection Web Editor — Implementation Prompt

## Goal

Build a static web page that lets me maintain my personal movie collection without touching a Google Spreadsheet. The page should let me:

1. **Load** an existing YAML file to append more movies (Step 2) or edit existing movies' attributes (Step 3).
2. **Add** a movie by pasting its TMDB URL (e.g. `https://www.themoviedb.org/movie/496243`).
3. **Edit** a small set of fields per movie: `year`, `director`, `custom_korean_title`, personal rating (`masterpiece` xor `my_best`), `award_names`, `note`.
4. **Download** the resulting collection as a YAML file with the exact same schema and ordering my Jekyll site already consumes, so I can drop it into [nambin.github.io](https://github.com/nambin/nambin.github.io) and commit.

The page is for personal, single-user use. No authentication, no server, no database.

## Existing system this replaces

- Source of truth today is a Google Spreadsheet exported as [data/movies.csv](data/movies.csv).
- [data-manager.py](data-manager.py) reads that CSV, calls TMDB Search + Movie Details APIs, merges with the prior [data/movies.yml](data/movies.yml) (incremental), and rewrites the YML.
- The YML is consumed by [movies.html](../nambin.github.io/movies.html) via Jekyll's `site.data.movies`.

The web editor is the user-facing replacement for the CSV-editing step. It must produce a YML that is byte-equivalent in structure to what `data-manager.py` produces — same fields, same null handling, same sort order — so the rest of the pipeline keeps working unchanged.

## Data model

Each movie entry in `data/movies.yml` looks like this (see [data-manager.py:388-431](data-manager.py#L388-L431) for the canonical construction):

Field order below is the **exact** order data-manager.py emits and the web app must reproduce on download for round-trip equality. `note` precedes `award_names` and `awards`.

```yaml
- title: 어쩔수가없다 # auto-populated; not exposed in the web app's edit UI
  year: 2025 # default from TMDB release_date; user-editable (TMDB year is sometimes wrong)
  director: 박찬욱 # user-editable; can be Korean
  country: Korea # legacy field — preserved verbatim on load, NOT emitted for entries added via the web app
  is_korean_director: true # derived: true if `director` contains any char in U+AC00–U+D7A3
  imdb_id: tt1527793
  imdb_url: https://www.imdb.com/title/tt1527793
  tmdb_url: https://www.themoviedb.org/movie/639988
  tmdb_title: No Other Choice # ← TMDB JSON `title`; set to null when equal to `tmdb_original_title`
  tmdb_original_title: 어쩔수가없다 # ← TMDB JSON `original_title`
  tmdb_original_language: Korean # ← TMDB JSON `original_language` (ISO 639-1) converted to full name
  tmdb_director_name_1: Park Chan-wook # first crew member with job=="Director"; null if none
  tmdb_director_name_2: null # second such crew member; null if none
  tmdb_num_directors: 1 # total count of crew with job=="Director"
  tmdb_poster_url: https://image.tmdb.org/t/p/w200/i38zFYpbBnWbqcRayu9F1n71yVT.jpg
  custom_korean_title: ... # OPTIONAL
  masterpiece: true # OPTIONAL — mutually exclusive with my_best
  my_best: true # OPTIONAL — mutually exclusive with masterpiece
  note: Some free-form text. # OPTIONAL
  award_names: # OPTIONAL — full real names; block-style sequence
  - Cannes Palme d'Or
  - Oscar Best Picture
  awards: # OPTIONAL — derived from award_names; block-style sequence
  - cannes
  - oscar
```

`masterpiece` and `my_best` are mutually exclusive — at most one is `true`, both can be absent.

### Awards taxonomy

There are two distinct concepts:

**Real award names** — the human-readable names I actually track. The full set (extracted from columns 6–7 of [data/movies.csv](data/movies.csv)) is:

- `Berlin Goldener Bär`
- `Cannes Palme d'Or`
- `César Award for Best Film`
- `Hong Kong Film Awards`
- `IIFA Awards`
- `Japan Academy Prize`
- `Oscar Best International Film`
- `Oscar Best Picture`
- `Venice Leone d'oro`
- `청룡영화제 최우수 작품상`

The award picker UI must use these exact strings as the options. Treat this list as the authoritative source — bake it into a constant in the JS so it's easy to extend later.

**Badge keys** — the short identifiers used for icon lookup in [movies.html:239-261](../nambin.github.io/movies.html#L239-L261). Mapping (mirrors `_FILM_AWARDS` at [data-manager.py:497-504](data-manager.py#L497-L504)):

| Real name                       | Badge key       |
| ------------------------------- | --------------- |
| `청룡영화제 최우수 작품상`      | `blue_dragon`   |
| `Oscar Best Picture`            | `oscar`         |
| `Oscar Best International Film` | `oscar`         |
| `Cannes Palme d'Or`             | `cannes`        |
| `Venice Leone d'oro`            | `venice`        |
| `Berlin Goldener Bär`           | `berlin`        |
| (others)                        | none — no badge |

### YML award fields

Two fields must be written:

- `award_names`: list of full real-name strings, e.g. `["Cannes Palme d'Or", "Oscar Best Picture"]`.
- `awards`: list of badge keys derived from `award_names` via the mapping above, deduplicated, preserving insertion order. This is what [movies.html](../nambin.github.io/movies.html) reads, so it must keep being emitted unchanged. Real names that have no badge mapping contribute nothing to this list.

Both fields are omitted when empty.

### Korean directors

Korean directors are often stored under their Korean name in `director` (e.g. `박찬욱`), and TMDB's `tmdb_director_name_1` provides the romanized version (`Park Chan-wook`). Sometimes TMDB returns no Korean form for a Korean director, in which case I want to override `director` manually. This is why `director` must be editable in the UI even though the rest of the TMDB-derived fields are not.

### custom_korean_title

Set when the movie's original language is not Korean **and** the user-entered `title` contained a Korean supplemental title in parentheses, e.g. `Adolescence (소년의 시간)` → `custom_korean_title: 소년의 시간`. See [title_parser.py](title_parser.py) for the parsing rules. The web editor should expose this as an editable text field; populating it manually is fine.

*Gate relaxation:* [data-manager.py:425](data-manager.py#L425) only writes `custom_korean_title` when `tmdb_original_language != "ko"`. The web app may expose the input unconditionally — when the original language is Korean, [movies.html:193-197](../nambin.github.io/movies.html#L193-L197) ignores `custom_korean_title` for display anyway (it gates on `tmdb_title`, which is always `null` for Korean-original movies). Setting it for a Korean movie has no rendering effect, so the gate is purely cosmetic.

### Sort order (matters for diff churn)

[data-manager.py:531-541](data-manager.py#L531-L541) sorts the output list by, descending: `year`, `masterpiece`, `my_best`, `len(awards)`, `director`. The web editor must produce the same order on download to keep diffs minimal.

Boolean semantics: missing `masterpiece`/`my_best` keys are treated as `False`; `True` sorts before `False/missing`. In JS, coerce booleans before comparing (e.g., `Number(b.masterpiece ?? false) - Number(a.masterpiece ?? false)`) — JS `>` on bare booleans coerces but is fragile across engines.

### YAML formatting

`data-manager.py` writes via `yaml.dump(..., allow_unicode=True, sort_keys=False)`. Match that exact output style: keys in insertion order matching the dict above, unicode preserved, no anchors, **block-style sequences** (one item per line with leading `- `, no `[...]` flow style anywhere). With `js-yaml`, dump with `{ noRefs: true, lineWidth: -1, flowLevel: -1, sortKeys: false }`.

## Functional requirements

### 1. Load existing collection

- Allow importing the current YML via file picker (drag-and-drop is a nice-to-have).
- Parse and render as a list. Keep the loaded entries' fields verbatim — never silently re-fetch from TMDB on load, since some entries are hand-curated (hardcoded TMDB/IMDB IDs in [data-manager.py:196-205](data-manager.py#L196-L205) and [data-manager.py:308-310](data-manager.py#L308-L310)).

### 2. Add a movie via TMDB URL

- Input: paste a TMDB movie URL. Extract the ID with a regex on `/movie/(\d+)`.
- Call TMDB Movie Details API: `https://api.themoviedb.org/3/movie/{id}?api_key={KEY}&append_to_response=credits`.
- Build a new entry mirroring [data-manager.py:388-422](data-manager.py#L388-L422) exactly:
  - `title` composed from TMDB `title` + `original_title`:
    - if either is missing, use whichever is present
    - if both are present and identical, use one (no redundant duplication)
    - if both differ, combine as `"<tmdb title> (<original title>)"` (e.g. `Parasite (기생충)`)
    Not editable in the UI (the field is unused by [movies.html](../nambin.github.io/movies.html), kept only for YML consistency). *Deviation from data-manager.py:* the legacy CSV pipeline stored the user-typed CSV title verbatim — including parenthetical Korean overlays like `Adolescence (소년의 시간)`. The web app reconstructs that parenthetical pattern directly from TMDB; further Korean overlays beyond what TMDB provides go through `custom_korean_title`.
  - `year` defaults to the leading 4 chars of `release_date`. User-editable.
  - `director` defaults to `credits.crew[?job=Director][0].name`. User-editable.
  - `country` — **do not emit** for newly added entries. The field is unused by [movies.html](../nambin.github.io/movies.html) and `tmdb_original_language` covers the same intent better. Legacy entries loaded from YML keep their existing `country` verbatim.
  - `is_korean_director` — recompute from final `director` value: `true` iff any character is in U+AC00–U+D7A3, else `false`.
  - `imdb_id` / `imdb_url` from TMDB `imdb_id`.
  - `tmdb_url` from `id`.
  - `tmdb_title` — TMDB JSON `title`, with one optimization: emit `null` when the API's `title` equals its `original_title` (avoids storing the same string twice).
  - `tmdb_original_title` — TMDB JSON `original_title`, verbatim.
  - `tmdb_original_language` — TMDB JSON `original_language` (an ISO 639-1 code like `ko`), converted to the full English language name (e.g. `Korean`). Python uses `pycountry`; in JS, ship a small map for the languages that appear in the YML or use a library.
  - `tmdb_director_name_1` / `_2` — the first and second entries (in API order) of `credits.crew` filtered by `job == "Director"`. Emit `null` (not omitted) when absent — required for round-trip parity with the existing YML.
  - `tmdb_num_directors` — total count of crew entries with `job == "Director"`.
  - `tmdb_poster_url` = `https://image.tmdb.org/t/p/w200{poster_path}` if present, else `null`.
- Refuse duplicates and surface a clear error. Check by TMDB ID first (before fetching, so a re-paste of an already-added URL short-circuits without an API call), then by `imdb_id` after the fetch as defense in depth.
- Error states to surface to the user: TMDB URL has no `/movie/<id>` match; TMDB API returns 404 / network error; TMDB response has no `imdb_id`.

The TMDB API key is sourced from `.env` (`TMDB_API_KEY`) at build time and inlined into the bundle via esbuild's `--define` flag — see `scripts/build.mjs` and `lib/tmdb_utils.js`'s `getTmdbKey()`. Embedding it client-side is acceptable for this personal tool. TMDB's CORS policy permits browser requests.

### 3. Edit fields

For each entry, expose **only these fields** as editable controls:

| Field                 | Control                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `director`            | text input                                                                                                                                             |
| `year`                | number input restricted to a 4-digit integer                                                                                                           |
| `custom_korean_title` | text input (clear → omit from YML)                                                                                                                     |
| Personal rating       | dropdown with three mutually exclusive options: `(none)`, `My Best`, `Masterpiece`. Writes either `my_best: true`, `masterpiece: true`, or omits both. |
| `award_names`         | multi-select listing the full real names (see Awards taxonomy). On change, also recompute and write `awards` (badge keys) automatically.               |
| `note`                | textarea (omit when blank)                                                                                                                             |

All other fields are read-only display. Do **not** add UI for `title` or any `tmdb_*` field — they're either set at add time or sourced from TMDB.

When `director` is edited, recompute `is_korean_director` automatically.

When the personal-rating dropdown is set to `(none)`, or any optional list/string field becomes empty, **omit the key from the YAML entirely** rather than writing `false` / `[]` / `""`. This matches the existing YML's conditional-emit behavior in [data-manager.py:478-529](data-manager.py#L478-L529).

### 4. Delete a movie

A delete button per entry. Confirm before removing.

### 5. Download YML

- Sort the list per the rule above.
- Serialize to YAML with the field order shown in the data model section.
- Trigger a browser download as `movies.yml`.

### 6. Persistence between page reloads

Save the working list to `localStorage` after every edit so an accidental refresh doesn't wipe progress. Show an "unsaved changes since last download" indicator.

## Non-goals

- No server, no auth, no database.
- No editing of TMDB-sourced fields (titles, posters, language, IMDB ID).
- No re-running TMDB searches by title — adds happen only via TMDB URL.
- No CSV export. The CSV pipeline is being retired by this UI.
- No support for `data-manager.py`'s hardcoded overrides: `_HARDCODED_TMDB_IDS` ([196-205](data-manager.py#L196-L205)), `_HARDCODED_IMDB_IDS` ([308-310](data-manager.py#L308-L310)), the `tt0442268` `custom_korean_title` patch ([427-428](data-manager.py#L427-L428)), and `_HARDCODED_AWARD_NAMES` ([505-511](data-manager.py#L505-L511)). Their effects are already baked into the existing YML and survive round-trip — the web app does not need to know they exist.

## Suggested tech

- Plain HTML + vanilla JS or a minimal framework (Alpine, Preact, or Svelte if you prefer). Avoid anything that needs a build server I have to run.
- [js-yaml](https://github.com/nodeca/js-yaml) for parse + dump.
- A single `index.html` + `app.js` + `style.css` in this directory, openable via `file://` or any static server.

## Decisions already made

- **Country**: not emitted for entries added via the web app (unused by the site, redundant with `tmdb_original_language`). Legacy entries loaded from YML keep their existing `country` verbatim so the round-trip stays clean.
- **CSV pipeline**: deprecated. Load the current YML on first run; the CSV is no longer maintained.
- **`title` not editable**: `title` is unused by [movies.html](../nambin.github.io/movies.html), so the web app does not expose it. Use `custom_korean_title` for Korean overlays.
- **Hosting**: the web app lives inside this `movie-data-manager` repo (e.g. `index.html` at the repo root). Run by opening the file directly via `file://` or serving the directory with any static server (e.g. `python -m http.server`). No GitHub Pages, no build step.

## Acceptance test

Round-trip check: load the current [data/movies.yml](data/movies.yml), make no edits, click download.

**Primary assertion (structural):** parse the input and the downloaded output with the same parser; the resulting in-memory data structures must be deep-equal — same length, same per-entry key set in the same order, same scalar values including `null`s.

**Secondary assertion (byte-identity, best-effort):** aim for byte-identical output (modulo a trailing newline). If a diff appears, manually inspect — js-yaml and PyYAML can disagree on cosmetic quoting choices (single vs double quotes, when to quote a string containing `:` like `'서울의 봄 (12.12: The Day)'`). Cosmetic-only differences are acceptable; any structural diff (missing/added field, changed order, changed scalar) is a bug.
