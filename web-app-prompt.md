# Movie Collection Web Editor — Implementation Prompt

## Goal

Build a static web page that lets me maintain my personal movie collection without touching a Google Spreadsheet. The page should let me:

1. **Load** an existing YAML file to append more movies (Step 2) or edit existing movies' attributes (Step 3).
2. **Add** a movie by pasting its TMDB URL (e.g. `https://www.themoviedb.org/movie/496243`).
3. **Edit** a small set of fields per movie: `year`, `director`, `custom_korean_title`, `masterpiece`, `my_best`, `awards`, `note`.
4. **Download** the resulting collection as a YAML file with the exact same schema and ordering my Jekyll site already consumes, so I can drop it into [nambin.github.io](https://github.com/nambin/nambin.github.io) and commit.

The page is for personal, single-user use. No authentication, no server, no database.

## Existing system this replaces

- Source of truth today is a Google Spreadsheet exported as [prod-input-movies.csv](prod-input-movies.csv).
- [data-manager.py](data-manager.py) reads that CSV, calls TMDB Search + Movie Details APIs, merges with the prior [prod-output-movies.yml](prod-output-movies.yml) (incremental), and rewrites the YML.
- The YML is consumed by [movies.html](../nambin.github.io/movies.html) via Jekyll's `site.data.movies`.

The web editor is the user-facing replacement for the CSV-editing step. It must produce a YML that is byte-equivalent in structure to what `data-manager.py` produces — same fields, same null handling, same sort order — so the rest of the pipeline keeps working unchanged.

## Data model

Each movie entry in `prod-output-movies.yml` looks like this (see [data-manager.py:388-431](data-manager.py#L388-L431) for the canonical construction):

```yaml
- title: 어쩔수가없다 # raw user-entered title (may include "(English)" suffix). Not needed for this web app.
  year: 2025 # user-entered year. It'd be help if the initial value is given by extracting it from TMDB metadata. Note that TMDB year is sometimes not correct.
  director: 박찬욱 # user-entered director, can be Korean
  country: Korea # raw user-entered country. Not needed for this web app.
  is_korean_director: true # derived: true if any Hangul in director
  imdb_id: tt1527793
  imdb_url: https://www.imdb.com/title/tt1527793
  tmdb_url: https://www.themoviedb.org/movie/639988
  tmdb_title: No Other Choice # null if same as tmdb_original_title
  tmdb_original_title: 어쩔수가없다
  tmdb_original_language: Korean # full name, not ISO code
  tmdb_director_name_1: Park Chan-wook
  tmdb_director_name_2: null
  tmdb_num_directors: 1
  tmdb_poster_url: https://image.tmdb.org/t/p/w200/i38zFYpbBnWbqcRayu9F1n71yVT.jpg
  custom_korean_title: ... # OPTIONAL
  masterpiece: true # OPTIONAL — mutually exclusive with my_best
  my_best: true # OPTIONAL — mutually exclusive with masterpiece
  award_names: [Cannes Palme d'Or, Oscar Best Picture] # OPTIONAL — NEW field, full real names
  awards: [oscar, cannes] # OPTIONAL — derived from award_names, badge keys
  note: Some free-form text. # OPTIONAL
```

`masterpiece` and `my_best` are mutually exclusive — at most one is `true`, both can be absent.

### Awards taxonomy

There are two distinct concepts:

**Real award names** — the human-readable names I actually track. The full set (extracted from columns 6–7 of [prod-input-movies.csv](prod-input-movies.csv)) is:

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

**Badge keys** — the short identifiers used for icon lookup in [movies.html:239-261](../nambin.github.io/movies.html#L239-L261). Mapping (mirrors [data-manager.py:493-500](data-manager.py#L493-L500)):

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

### Sort order (matters for diff churn)

[data-manager.py:517-527](data-manager.py#L517-L527) sorts the output list by, descending: `year`, `masterpiece`, `my_best`, `len(awards)`, `director`. The web editor must produce the same order on download to keep diffs minimal.

### YAML formatting

`data-manager.py` writes via `yaml.dump(..., allow_unicode=True, sort_keys=False)`. Match that exact output style: keys in insertion order matching the dict above, unicode preserved, no anchors. Use a JS YAML library (e.g. `js-yaml`) configured to match.

## Functional requirements

### 1. Load existing collection

- Allow importing the current YML via file picker (drag-and-drop is a nice-to-have).
- Parse and render as a list. Keep the loaded entries' fields verbatim — never silently re-fetch from TMDB on load, since some entries are hand-curated (hardcoded TMDB/IMDB IDs in [data-manager.py:196-205](data-manager.py#L196-L205) and [data-manager.py:308-310](data-manager.py#L308-L310)).

### 2. Add a movie via TMDB URL

- Input: paste a TMDB movie URL. Extract the ID with a regex on `/movie/(\d+)`.
- Call TMDB Movie Details API: `https://api.themoviedb.org/3/movie/{id}?api_key={KEY}&append_to_response=credits`.
- Build a new entry mirroring [data-manager.py:388-422](data-manager.py#L388-L422) exactly:
  - `title` defaults to `tmdb_original_title` (the user can edit before saving).
  - `year` from `release_date`'s leading 4 chars.
  - `director` defaults to `credits.crew[?job=Director][0].name` (user-editable).
  - `country` — default to the first `production_countries[].name` from TMDB; the user can edit if needed. (TMDB doesn't always match my hand-curated values like `Pixar`, but defaulting is fine — manual edit covers the exceptions.)
  - `is_korean_director` — recompute from final `director` value (any Hangul → true).
  - `imdb_id` / `imdb_url` from TMDB `imdb_id`.
  - `tmdb_url` from `id`.
  - `tmdb_title` — set only if `title` differs from `original_title`, else `null`.
  - `tmdb_original_title`, `tmdb_original_language` (convert ISO 639-1 → full name; the Python script uses `pycountry`. In JS, ship a small map for the languages that actually appear in the YML, or use a library).
  - `tmdb_director_name_1` / `_2` from credits.
  - `tmdb_num_directors` = count of crew with `job == "Director"`.
  - `tmdb_poster_url` = `https://image.tmdb.org/t/p/w200{poster_path}` if present, else `null`.
- Reject (or warn) if a movie with the same `imdb_id` already exists in the loaded list.

The TMDB API key is in [data-manager.py:35](data-manager.py#L35) (`f6d7fb04f4d4d6b07d2d750811e73a4c`). Embedding it client-side is acceptable for this personal tool, since it's already public in this repo and the README. TMDB's CORS policy permits browser requests.

### 3. Edit fields

For each entry, expose **only these fields** as editable controls:

| Field                 | Control                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `director`            | text input                                                                                                                                             |
| `year`                | text input                                                                                                                                             |
| `custom_korean_title` | text input (clear → omit from YML)                                                                                                                     |
| Personal rating       | dropdown with three mutually exclusive options: `(none)`, `My Best`, `Masterpiece`. Writes either `my_best: true`, `masterpiece: true`, or omits both. |
| `award_names`         | multi-select listing the full real names (see Awards taxonomy). On change, also recompute and write `awards` (badge keys) automatically.               |
| `note`                | textarea (omit when blank)                                                                                                                             |

All other fields are read-only display. Do **not** add UI for `title` or any `tmdb_*` field — they're either set at add time or sourced from TMDB.

When `director` is edited, recompute `is_korean_director` automatically.

When a checkbox is unchecked or a list/string field becomes empty, **omit the key from the YAML entirely** rather than writing `false` / `[]` / `""`. This matches the existing YML's conditional-emit behavior in [data-manager.py:478-515](data-manager.py#L478-L515).

### 4. Delete a movie

A delete button per entry. Confirm before removing.

### 5. Download YML

- Sort the list per the rule above.
- Serialize to YAML with the field order shown in the data model section.
- Trigger a browser download as `prod-output-movies.yml`.

### 6. Persistence between page reloads

Save the working list to `localStorage` after every edit so an accidental refresh doesn't wipe progress. Show an "unsaved changes since last download" indicator.

## Non-goals

- No server, no auth, no database.
- No editing of TMDB-sourced fields (titles, posters, language, IMDB ID).
- No re-running TMDB searches by title — adds happen only via TMDB URL.
- No CSV export. The CSV pipeline is being retired by this UI.
- No support for the hardcoded TMDB/IMDB ID overrides used in `data-manager.py` — those rare cases can stay in the YML manually after import, since the UI never refetches.

## Suggested tech

- Plain HTML + vanilla JS or a minimal framework (Alpine, Preact, or Svelte if you prefer). Avoid anything that needs a build server I have to run.
- [js-yaml](https://github.com/nodeca/js-yaml) for parse + dump.
- A single `index.html` + `app.js` + `style.css` in this directory, openable via `file://` or any static server.

## Decisions already made

- **Country**: default from TMDB's first `production_countries[].name`, user-editable.
- **CSV pipeline**: deprecated. Load the current YML on first run; the CSV is no longer maintained.
- **`title` not editable**: `title` is unused by [movies.html](../nambin.github.io/movies.html), so the web app does not expose it. Use `custom_korean_title` for Korean overlays.
- **Hosting**: the web app lives inside this `movie-data-manager` repo (e.g. `index.html` at the repo root or under a subdirectory), not inside `nambin.github.io`.

## Acceptance test

Round-trip check: load the current [prod-output-movies.yml](prod-output-movies.yml), make no edits, click download.

No other field should change. If it does, the YAML serialization, field-ordering, or sort-order is off.
