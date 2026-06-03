# Award Curation CLI — Implementation Prompt (Draft)

> Companion to [prompt-web-app.md](prompt-web-app.md) (the single-movie-via-TMDB-URL editor) and [prompt-web-app-with-llm.md](prompt-web-app-with-llm.md) (the memo-driven bulk-import flow). The data model, YAML conventions, award taxonomy, and field semantics from those documents apply unchanged. This draft adds an **offline CLI** that curates festival/award winners into a separate lookup file — it does not change `data/movies.yml` or the editor's runtime behavior.

## Goal

Today, awards are set **by hand, one movie at a time**: the user ticks the award checkboxes in the editor, which writes `award_names` (and the derived `awards` badges) onto an entry. Figuring out *which* movies won is manual research.

Automate that research. A CLI collects the official winner lists for six top prizes, finds each winner's TMDB/IMDb entry, and writes a machine-readable **`data/awards.yml`** lookup keyed by IMDb ID. The web app can later read this file to **pre-fill `award_names` automatically** when a movie is added, so the user never again searches "did this win Cannes?" by hand.

Goal in one line: **official winner lists → resolved to IMDb/TMDB → `data/awards.yml`**, regenerated monthly by a GitHub Actions cron.

The six awards in scope (exact taxonomy names from [lib/utils.js](lib/utils.js) `AWARD_NAMES`):

- `Oscar Best Picture`
- `Oscar Best International Film`
- `Cannes Palme d'Or`
- `Venice Leone d’oro` &nbsp;*(note: curly apostrophe `’` U+2019 — must match byte-for-byte)*
- `Berlin Goldener Bär`
- `청룡영화제 최우수 작품상` &nbsp;*(Blue Dragon Film Award for Best Film — sourced from Wikipedia, not Wikidata; see §2.2)*

The first five share one source (Wikidata); the Korean Blue Dragon award needs a different one — the structural split is explained in §2.

## Non-goals

- **Nominees are out of scope.** Only winners of the single top prize per festival/year. The data source encodes "won" distinctly from "nominated" (see below), so this is enforced at the query, not by guessing. This honors the existing rule in [prompt-web-app-with-llm.md](prompt-web-app-with-llm.md) that nominee and winner must never be confused.
- **No awards outside the six.** The `AWARD_NAMES` taxonomy has more entries (César, Hong Kong, IIFA, Japan Academy); this CLI does not touch them.
- **`data/movies.yml` is never modified.** `awards.yml` is a standalone sidecar. Merging into the editor is a documented future phase (§6), not built in the first cut.
- **No new matching brain.** Reuse the existing TMDB/Gemini code in `lib/`. The deterministic IMDb path does ~99% of the work; the Gemini pipeline is a fallback only.
- **No server.** A Node CLI run locally or in CI; output committed as a static data file, same hosting story as today.

## Data sources

The five international awards come from **Wikidata** (§2.1, near-complete coverage). The Korean **Blue Dragon** award is barely present in Wikidata (only 3 of ~45 winners carry the `P166` statement), so it uses the **English Wikipedia** winners table instead (§2.2). Both tracks converge into the same `by_imdb` output.

### 2.1 Wikidata SPARQL — the five international awards

Winners come from **Wikidata** via its public SPARQL endpoint `https://query.wikidata.org/sparql`. Wikidata models "this film **won** award X" as the statement `film wdt:P166 <award>` ("award received"), which is distinct from `P1411` ("nominated for"). Querying `P166` therefore yields **winners only** — exactly the semantic we need.

Each winning film typically also carries:

- `wdt:P345` — **IMDb ID** (the `tt…` form). Present for ~99% of winners.
- the `pq:P585` ("point in time") **qualifier** on the `P166` statement — the **award year**.

#### Award entities (verified live)

| `award_names` value (taxonomy) | Wikidata Q-ID | Winners | With IMDb ID |
|---|---|---|---|
| `Oscar Best Picture` | `Q102427` | 228 | 228 (100%) |
| `Oscar Best International Film` | `Q105304` | 73 | 73 (100%) |
| `Cannes Palme d'Or` | `Q179808` | 157 | 155 |
| `Venice Leone d’oro` | `Q209459` | 136 | 131 |
| `Berlin Goldener Bär` | `Q154590` | 158 | 157 |

> Coverage measured against live Wikidata: **752 winners total, 744 carry an IMDb ID**. The ~8 without one fall through to the Gemini fallback (§3). Wikidata is current — it already lists 2025/2026 ceremony winners.

The Wikidata award labels differ from our taxonomy (e.g. Wikidata says *"Academy Award for Best International Feature Film"*, we say `Oscar Best International Film`). The CLI maps **Q-ID → taxonomy name** explicitly via this table; never derive the name from the Wikidata label.

#### Gotcha: producers are co-recipients

For the Oscars, the statuette is awarded to the **producers** as well as the film, so a bare `P166` query returns *people* alongside films (their IDs are `nm…`, not `tt…`). Filter them out by **requiring the subject be a film** — `?film wdt:P31/wdt:P279* wd:Q11424` — and/or by keeping only `tt`-prefixed IMDb IDs.

#### The query

One combined query covers all five awards. `?award` is bound back so each row knows which prize it belongs to; the `P166` statement node (`p:P166` / `ps:P166`) is used so the `pq:P585` year qualifier is reachable.

```sparql
SELECT ?award ?film ?imdb ?year WHERE {
  VALUES ?award { wd:Q102427 wd:Q105304 wd:Q179808 wd:Q209459 wd:Q154590 }
  ?film p:P166 ?stmt .
  ?stmt ps:P166 ?award .
  ?film wdt:P31/wdt:P279* wd:Q11424 .          # subject is a film (drops producers)
  OPTIONAL { ?film wdt:P345 ?imdb . }          # IMDb ID, ~99% present
  OPTIONAL { ?stmt pq:P585 ?date . BIND(YEAR(?date) AS ?year) }   # award year
}
```

**Endpoint etiquette:** send a descriptive `User-Agent` header (Wikidata blocks generic agents) and `Accept: application/sparql-results+json`. The endpoint occasionally returns `upstream request timeout` — wrap the request in a small **retry with backoff** (e.g. 3 attempts). A film may appear in multiple rows (won more than one of the five, or has multiple `P585` values) — dedupe downstream by `(award, film)` and collect the year(s).

### 2.2 English Wikipedia — Blue Dragon (`청룡영화제 최우수 작품상`)

Wikidata is **not** a usable source here: a `P166 = wd:Q28758354` (*Blue Dragon Film Award for Best Film*) query returns only **3 of ~45 winners** (verified live), with no ceremony-edition modeling to recover the rest. The authoritative machine-readable list is the **English Wikipedia** winners table on the page **[Blue Dragon Film Award for Best Film](https://en.wikipedia.org/wiki/Blue_Dragon_Film_Award_for_Best_Film)** (one winner row per year since 1963, with a hiatus 1974–1989).

Fetch the table via the MediaWiki API — `https://en.wikipedia.org/w/api.php?action=parse&page=Blue Dragon Film Award for Best Film&prop=wikitext&format=json&redirects=1` — and parse each winner row. Each row cleanly provides:

- **Year** (e.g. `1963 (1st)` → `1963`).
- **Winner** — English title as a `[[wikilink]]` (e.g. `[[Parasite (2019 film)|Parasite]]`).
- **Original title** — Korean (e.g. `혈맥`, `기생충`) — ideal for the Gemini+TMDB Korean-matching pipeline.
- **Director(s)**.

Winner rows are the highlighted (`background:#FAEB86`) / `{{double dagger}}`-marked rows; the table is winner-only, one per year. **Resolution is two-track, mirroring §2.1's IMDb-first / Gemini-fallback split:**

1. **Deterministic:** batch-resolve the English-article wikilinks to IMDb IDs with one Wikidata query —
   `?article schema:about ?film . ?film wdt:P345 ?imdb .` over `VALUES ?article { <https://en.wikipedia.org/wiki/Parasite_(2019_film)> … }` (verified: `Parasite_(2019_film)` → `tt6751668`, `Mother_(2009_film)` → `tt1216496`). Then TMDB `/find` as in §2.1.
2. **Fallback:** for winners whose article lacks an IMDb ID (or has no article), run the **Korean original title + year** through `processMemoLine` — the pipeline is specifically tuned for Korean titles → TMDB.

Parsing wikitext is more fragile than SPARQL JSON, so **assert the parsed winner count is in the expected range (~40+)** and log it; a sudden drop means the table markup changed and the parser needs attention. The award maps to the taxonomy name `청룡영화제 최우수 작품상` (badge `blue_dragon`).

## Pipeline — `cli/curate-awards.mjs`

ESM, Node 20+, native `fetch` (matches `scripts/*.mjs`). Keys read from **`process.env`** — `TMDB_API_KEY` (required) and `GEMINI_API_KEY` (optional; only the fallback needs it). The esbuild build-time inlining (`getTmdbKey()` / `getGeminiKey()` reading `__TMDB_KEY__` / `__GEMINI_KEY__`) does **not** apply under plain Node, so pass keys explicitly into the lib functions, which already accept them as parameters.

1. **Fetch winners.** Two sources (§2):
   - **Wikidata (5 awards):** run the SPARQL query (with retry). Keep rows whose IMDb ID is `tt…` (or whose subject passed the film filter). Map each `?award` Q-ID → taxonomy `award_names` string. IMDb ID is known immediately for ~99%.
   - **Wikipedia (Blue Dragon):** fetch + parse the winners table → rows of `{ year, english_article, korean_title }`. Batch-resolve the article wikilinks to IMDb via one Wikidata `schema:about`/`P345` query; rows that don't resolve keep `korean_title` + `year` for the fallback (step 4).

2. **Group by IMDb ID.** Build `imdb_id → { title, award_names: Set, wins: [{ award_name, year }] }`. A film that won two of the five (e.g. Palme d'Or **and** Best Picture) gets both names and two `wins` rows.

3. **Resolve TMDB (deterministic, the 99% path).** For each IMDb ID, call TMDB once:
   `GET https://api.themoviedb.org/3/find/{imdb_id}?external_source=imdb_id&api_key={TMDB_API_KEY}` → `movie_results[0]` gives `id` (TMDB id) and `title`. That is all the lookup file needs — the editor builds full entries itself via `buildMovieEntryFromTmdb` when the movie is actually added. (Verified: `tt28607951` → TMDB `1064213`, "Anora".)

4. **Fallback (winners with no IMDb ID — the ~8 international + any unresolved Blue Dragon).** Reuse the existing Gemini pipeline:
   `processMemoLine({ rawLine, geminiKey, tmdbApiKey, koreanDirectorMap })` from [lib/memo_pipeline.js](lib/memo_pipeline.js), where `rawLine` is `"<title> <year>"` — use the **Korean original title** for Blue Dragon rows (the pipeline's strength) and the Wikidata label for international ones. Build `koreanDirectorMap` from the existing collection via `buildKoreanDirectorMap(load('data/movies.yml'))` ([lib/utils.js](lib/utils.js)). On `status: "ok"`, take `entry.imdb_id` and the TMDB id from `entry.tmdb_url`. If `GEMINI_API_KEY` is absent or the pipeline returns `no_match`, **log the unresolved winner and continue** (don't fail the run).

5. **Derive badges.** For each grouped entry, compute `awards` from `award_names` via `deriveAwardBadges(award_names)` ([lib/utils.js](lib/utils.js)). Because the `award_names` strings come from the table in §2 (matching `AWARD_NAMES` byte-for-byte, including the curly apostrophe), `BADGE_KEY_BY_NAME` resolves them correctly.

6. **Emit `data/awards.yml`.** Dump with `YAML_DUMP_OPTIONS` ([lib/utils.js](lib/utils.js)). Sort the `by_imdb` keys deterministically (e.g. lexicographically by IMDb ID) and the `award_names`/`wins` within each entry, so a month with no new winners produces a **byte-identical file → empty git diff**. The run is a full idempotent regenerate, not an incremental patch.

### Reused building blocks

- `buildMovieEntryFromTmdb(tmdb)` — [lib/tmdb_utils.js](lib/tmdb_utils.js) (used by the fallback's pipeline; takes raw TMDB JSON, no key needed).
- `processMemoLine(...)` — [lib/memo_pipeline.js](lib/memo_pipeline.js) (fallback resolver).
- `AWARD_NAMES`, `BADGE_KEY_BY_NAME`, `deriveAwardBadges`, `buildKoreanDirectorMap`, `YAML_DUMP_OPTIONS` — [lib/utils.js](lib/utils.js).
- `js-yaml` (existing dependency) for load/dump.

## `data/awards.yml` schema

Keyed by **`imdb_id`** — the same join key `data/movies.yml` already uses, so the editor can look up awards for an entry it just built from TMDB.

```yaml
# AUTO-GENERATED by cli/curate-awards.mjs — do not edit by hand.
# Source: Wikidata (5 intl awards, wdt:P166) + Wikipedia (Blue Dragon) + TMDB. Regenerated monthly.
generated_at: "2026-06-03"
by_imdb:
  tt28607951:
    tmdb_id: 1064213
    title: Anora
    imdb_url: https://www.imdb.com/title/tt28607951
    tmdb_url: https://www.themoviedb.org/movie/1064213
    award_names:
      - Cannes Palme d'Or
      - Oscar Best Picture
    awards:                      # derived via deriveAwardBadges(award_names)
      - cannes
      - oscar
    wins:
      - { award_name: Cannes Palme d'Or, year: 2024 }
      - { award_name: Oscar Best Picture, year: 2025 }
```

Notes:
- `title`, `tmdb_id`, and the two URLs are for human readability / verification; the editor re-derives canonical fields from TMDB itself. The load-bearing data for the web app is `imdb_id → award_names`.
- `imdb_url` is always present (derived from the `imdb_id` key, matching `movies.yml`'s form). `tmdb_id` / `tmdb_url` are `null` for the rare winner whose IMDb id resolves to no TMDB movie.
- `wins[].year` is the **award/ceremony year** (Wikidata `P585`), not the film's release year — they can differ (a film released in 2024 wins Best Picture at the 2025 ceremony).

## GitHub Action — `.github/workflows/curate-awards.yml`

Runs in `movie-data-manager`, commits `data/awards.yml` there. The user syncs it to `nambin.github.io` manually, exactly as `data/movies.yml` is deployed today.

```yaml
name: Curate awards
on:
  schedule:
    - cron: "0 22 * * 5"       # Fri 22:00, evaluated in the timezone below — weekly
      timezone: "Asia/Seoul"   # native cron timezone (GitHub Actions, Mar 2026+)
  workflow_dispatch: {}
permissions:
  contents: write
env:
  TZ: "Asia/Seoul"             # job clock = KST, so generated_at is stamped in Seoul time
jobs:
  curate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: node cli/curate-awards.mjs
        env:
          TMDB_API_KEY: ${{ secrets.TMDB_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
      - name: Commit if changed
        run: |
          if ! git diff --quiet -- data/awards.yml; then
            git config user.name  "github-actions[bot]"
            git config user.email "github-actions[bot]@users.noreply.github.com"
            git add data/awards.yml
            git commit -m "chore: refresh award curation"
            git push
          fi
```

Repo secrets required: `TMDB_API_KEY`, `GEMINI_API_KEY`. The weekly Friday-night (KST) run catches new ceremony winners and Wikidata/Wikipedia corrections promptly; because the run is an idempotent full regenerate, quiet weeks produce an empty diff and no commit.

**On timezone:** GitHub Actions added a per-schedule `timezone` field (IANA names) in [March 2026](https://github.blog/changelog/2026-03-19-github-actions-late-march-2026-updates/) — it sits **on the same list item as the `cron` entry**. With `timezone: "Asia/Seoul"`, the cron is read directly in Seoul local time, so `0 22 * * 5` is simply "Friday 22:00 KST" — no UTC conversion needed. KST observes no daylight saving, so this fires at a fixed wall-clock time year-round (the DST spring-forward skip rule GitHub documents never applies to Seoul). The separate `TZ` env var is unrelated to scheduling — it sets the *job's* clock so the CLI's `generated_at` stamp also reads in Seoul time.

## Web-app consumption (future phase — documented, not built here)

When wired up later, [lib/app.js](lib/app.js) loads `data/awards.yml` alongside `data/movies.yml` at startup. Whenever the editor builds an entry that has an `imdb_id` (URL-paste add bar or memo bulk-import), it looks up `by_imdb[imdb_id]` and **pre-fills `award_names`** (and the derived `awards`). The user still reviews before committing — this only removes the manual "did it win, and which prize" lookup. This keeps the existing rule that the LLM/import flow never *invents* awards: the awards come from a curated, official-source file, not a model.

## Testing — `node --test`

Follow the existing fixture pattern (`tests/fixtures/`, frozen JSON):

- Frozen fixtures so tests run offline: a **Wikidata SPARQL JSON** response, a **Wikipedia `action=parse` wikitext** response for the Blue Dragon table, and a **TMDB `/find`** response.
- Assert: grouping by IMDb ID (a film winning two awards collapses to one entry with two `award_names` + two `wins`); the **producer/`nm` filter** drops non-film rows; **Q-ID → taxonomy-name mapping** is exact (including `Venice Leone d’oro`'s curly apostrophe); `deriveAwardBadges` yields the right badges (incl. `청룡영화제 최우수 작품상` → `blue_dragon`); the dumped YAML matches the schema and is **stable across two runs** (idempotent).
- **Blue Dragon table parse:** assert the winner-row count from the fixture is in the expected range and that one representative row extracts `{ year, english_article, korean_title }` correctly.
- A small mocked-fetch test for the Gemini fallback branch (no-IMDb winner → `processMemoLine` resolves `imdb_id`), mirroring `tests/_helpers/pipeline_mocks.js`.
