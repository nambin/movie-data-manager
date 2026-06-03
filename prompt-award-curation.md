# Award Curation CLI — Implementation Prompt (Draft)

> Companion to [prompt-web-app.md](prompt-web-app.md) (the single-movie-via-TMDB-URL editor) and [prompt-web-app-with-llm.md](prompt-web-app-with-llm.md) (the memo-driven bulk-import flow). The data model, YAML conventions, award taxonomy, and field semantics from those documents apply unchanged. This draft adds an **offline CLI** that curates festival/award winners into a separate lookup file — it does not change `data/movies.yml` or the editor's runtime behavior.

## Goal

Today, awards are set **by hand, one movie at a time**: the user ticks the award checkboxes in the editor, which writes `award_names` (and the derived `awards` badges) onto an entry. Figuring out *which* movies won is manual research.

Automate that research. A CLI collects the official winner lists for ten top prizes, finds each winner's TMDB/IMDb entry, and writes a machine-readable **`data/awards.yml`** lookup keyed by IMDb ID. The web app can later read this file to **pre-fill `award_names` automatically** when a movie is added, so the user never again searches "did this win Cannes?" by hand.

Goal in one line: **official winner lists → resolved to IMDb/TMDB → `data/awards.yml`**, regenerated monthly by a GitHub Actions cron.

The ten awards in scope (exact taxonomy names from [lib/utils.js](lib/utils.js) `AWARD_NAMES`):

- `Oscar Best Picture`
- `Oscar Best International Film`
- `Cannes Palme d'Or`
- `Venice Leone d’oro` &nbsp;*(note: curly apostrophe `’` U+2019 — must match byte-for-byte)*
- `Berlin Goldener Bär`
- `European Film Award for Best Film`
- `Hong Kong Film Awards` &nbsp;*(mapped from the Wikidata "Best Film" category — see §2.1)*
- `청룡영화제 최우수 작품상` &nbsp;*(Blue Dragon Film Award for Best Film — Wikipedia, see §2.2)*
- `César Award for Best Film` &nbsp;*(Wikipedia, see §2.2)*
- `Japan Academy Prize` &nbsp;*(Picture of the Year — Wikipedia, see §2.2)*

The first **seven** share one source (Wikidata, §2.1); the last **three** (Blue Dragon, César, Japan Academy) are too sparse in Wikidata and come from **English Wikipedia** winners tables (§2.2). These ten are the entire `AWARD_NAMES` taxonomy — every award the editor knows about is curated here, so `data/awards.yml` is the complete source of truth for awards.

## Non-goals

- **Nominees are out of scope.** Only winners of the single top prize per festival/year. The data source encodes "won" distinctly from "nominated" (see below), so this is enforced at the query, not by guessing. This honors the existing rule in [prompt-web-app-with-llm.md](prompt-web-app-with-llm.md) that nominee and winner must never be confused.
- **The ten awards are the whole taxonomy.** Every `AWARD_NAMES` entry is curated, so `awards.yml` is the *complete* source of truth — the reconcile CLI / editor overwrite a movie's awards from it entirely, leaving nothing behind. (`IIFA Awards` was previously in the taxonomy but is dropped: no Wikidata "Best Film" entity and a ~25-table Wikipedia page, for films rarely in this collection.)
- **`data/movies.yml` is never modified.** `awards.yml` is a standalone sidecar. Merging into the editor is a documented future phase (§6), not built in the first cut.
- **No new matching brain.** Reuse the existing TMDB/Gemini code in `lib/`. The deterministic IMDb path does ~99% of the work; the Gemini pipeline is a fallback only.
- **No server.** A Node CLI run locally or in CI; output committed as a static data file, same hosting story as today.

## Data sources

Seven awards come from **Wikidata** (§2.1, near-complete coverage). Three more — **Blue Dragon**, **César**, **Japan Academy** — are barely present in Wikidata (Blue Dragon ~3 of 45 via `P166`; César ~26 of 51; Japan ~9 of 49), so they come from **English Wikipedia** winners tables instead (§2.2). All tracks converge into the same `by_imdb` output.

### 2.1 Wikidata SPARQL — the seven Wikidata-sourced awards

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
| `European Film Award for Best Film` | `Q777921` | 37 | 37 (100%) |
| `Hong Kong Film Awards` | `Q4722629` | 37 | 37 (100%) |

> Coverage measured against live Wikidata. The handful of winners without an IMDb ID fall through to the Gemini fallback (§3). Wikidata is current — it already lists recent (2024–2026) ceremony winners. `Hong Kong Film Awards` is mapped from the Wikidata **Best Film** category (`Q4722629`); the taxonomy name is generic but represents that top prize. `European Film Award for Best Film` is a new `AWARD_NAMES` entry; the other six already existed.

The Wikidata award labels differ from our taxonomy (e.g. Wikidata says *"Academy Award for Best International Feature Film"*, we say `Oscar Best International Film`). The CLI maps **Q-ID → taxonomy name** explicitly via this table; never derive the name from the Wikidata label.

#### Gotcha: producers are co-recipients

For the Oscars, the statuette is awarded to the **producers** as well as the film, so a bare `P166` query returns *people* alongside films (their IDs are `nm…`, not `tt…`). Filter them out by **requiring the subject be a film** — `?film wdt:P31/wdt:P279* wd:Q11424` — and/or by keeping only `tt`-prefixed IMDb IDs.

#### The query

One combined query covers all seven awards. `?award` is bound back so each row knows which prize it belongs to; the `P166` statement node (`p:P166` / `ps:P166`) is used so the `pq:P585` year qualifier is reachable.

```sparql
SELECT ?award ?film ?imdb ?year WHERE {
  VALUES ?award { wd:Q102427 wd:Q105304 wd:Q179808 wd:Q209459 wd:Q154590 wd:Q777921 wd:Q4722629 }
  ?film p:P166 ?stmt .
  ?stmt ps:P166 ?award .
  ?film wdt:P31/wdt:P279* wd:Q11424 .          # subject is a film (drops producers)
  OPTIONAL { ?film wdt:P345 ?imdb . }          # IMDb ID, ~99% present
  OPTIONAL { ?stmt pq:P585 ?date . BIND(YEAR(?date) AS ?year) }   # award year
}
```

**Endpoint etiquette:** send a descriptive `User-Agent` header (Wikidata blocks generic agents) and `Accept: application/sparql-results+json`. The endpoint occasionally returns `upstream request timeout` — wrap the request in a small **retry with backoff** (e.g. 3 attempts). A film may appear in multiple rows (won more than one of these awards, or has multiple `P585` values) — dedupe downstream by `(award, film)` and collect the year(s).

### 2.2 English Wikipedia — Blue Dragon, César, Japan Academy

Wikidata is too sparse for these three (Blue Dragon **3 of ~45** via `P166`; César **~26 of 51**, with scattered gaps including recent years; Japan Academy **~9 of 49**), so winners come from the **English Wikipedia** winners tables. Each award is a `WIKIPEDIA_AWARDS` entry (`{ name, page, parse, minWinners }`) in [lib/awards_curation.js](lib/awards_curation.js); the page is fetched via the MediaWiki API (`action=parse&prop=wikitext`).

| Award | Page | Parser | Winners |
|---|---|---|---|
| `청룡영화제 최우수 작품상` | *Blue Dragon Film Award for Best Film* | `parseBlueDragonWikitext` | ~46 (1963–, hiatus 1974–89) |
| `César Award for Best Film` | *César Award for Best Film* | `parseWinnersByYearHeader` | ~51 (1976–) |
| `Japan Academy Prize` | *Japan Academy Film Prize for Picture of the Year* | `parseWinnersByYearHeader` | ~49 (1978–) |

**Two parser strategies** (each returns `[{ year, article, title, … }]`, one per winner):

- **`parseBlueDragonWikitext`** — Blue Dragon's table marks the winner with `{{double dagger}}` / `background:#FAEB86`, mixes a winner-only old format with a winner+nominees new format, and uses both newline-`|` and inline-`||` cells. It needs the dedicated parser; it also yields the **Korean original title** for the fallback.
- **`parseWinnersByYearHeader`** (César + Japan) — one rule covers both: *a row whose `!` header cell carries a 4-digit year is a winner; its first `[[wikilink]]` is the film.* Works for Japan's winners-only table and for César's winner+nominees tables (only the winner row carries the `! rowspan` year header; nominee rows have no `!`) across César's older per-cell-highlight and newer per-row-highlight formats.

**Resolution is two-track, mirroring §2.1's IMDb-first / Gemini-fallback split** (shared across all three awards):

1. **Deterministic:** batch-resolve every winner's English-article wikilink to an IMDb ID with **one** Wikidata query — `?article schema:about ?film . ?film wdt:P345 ?imdb .` over a `VALUES { <…sitelink IRI…> … }` set. Because the combined set is ~150 articles, the SPARQL request is sent via **POST** (a GET URL would exceed the length limit → HTTP 414). Then TMDB `/find` as in §2.1.
2. **Fallback:** for winners whose article lacks an IMDb ID (or has no article), run the title + year through `processMemoLine` (Korean original for Blue Dragon; English title otherwise).

Parsing wikitext is more fragile than SPARQL JSON, so each `WIKIPEDIA_AWARDS` entry declares a `minWinners` floor and the CLI **logs a warning** when a parse falls below it — a sudden drop means the table markup changed and the parser needs attention. None of these three has a badge in `BADGE_KEY_BY_NAME`, so `deriveAwardBadges` emits no badge key for them (only Blue Dragon maps, to `blue_dragon`); they appear in `award_names` and the editor's read-only Awards row regardless.

## Pipeline — `cli/curate-awards.mjs`

ESM, Node 20+, native `fetch` (matches `scripts/*.mjs`). Keys read from **`process.env`** — `TMDB_API_KEY` (required) and `GEMINI_API_KEY` (optional; only the fallback needs it). The esbuild build-time inlining (`getTmdbKey()` / `getGeminiKey()` reading `__TMDB_KEY__` / `__GEMINI_KEY__`) does **not** apply under plain Node, so pass keys explicitly into the lib functions, which already accept them as parameters.

1. **Fetch winners.** Sources (§2):
   - **Wikidata (7 awards):** run the SPARQL query (with retry). Keep rows whose IMDb ID is `tt…` (or whose subject passed the film filter). Map each `?award` Q-ID → taxonomy `award_names` string. IMDb ID is known immediately for ~99%.
   - **Wikipedia (Blue Dragon, César, Japan Academy):** for each `WIKIPEDIA_AWARDS` entry, fetch + parse its winners table → rows of `{ year, article, title }` (Blue Dragon also yields `korean`). Batch-resolve **all** article wikilinks across the three awards in **one** Wikidata `schema:about`/`P345` query (sent via POST — see §2.2); rows that don't resolve keep `title` + `year` for the fallback (step 4).

2. **Group by IMDb ID.** Build `imdb_id → { title, award_names: Set, wins: [{ award_name, year }] }`. A film that won two awards (e.g. Palme d'Or **and** Best Picture) gets both names and two `wins` rows.

3. **Resolve TMDB (deterministic, the 99% path).** For each IMDb ID, call TMDB once:
   `GET https://api.themoviedb.org/3/find/{imdb_id}?external_source=imdb_id&api_key={TMDB_API_KEY}` → `movie_results[0]` gives `id` (TMDB id) and `title`. That is all the lookup file needs — the editor builds full entries itself via `buildMovieEntryFromTmdb` when the movie is actually added. (Verified: `tt28607951` → TMDB `1064213`, "Anora".)

4. **Fallback (winners with no IMDb ID — a few international + any unresolved Wikipedia winners).** Reuse the existing Gemini pipeline:
   `processMemoLine({ rawLine, geminiKey, tmdbApiKey, koreanDirectorMap })` from [lib/memo_pipeline.js](lib/memo_pipeline.js), where `rawLine` is `"<title> <year>"` — use the **Korean original title** for Blue Dragon rows (the pipeline's strength) and the English/Wikidata title otherwise. Build `koreanDirectorMap` from the existing collection via `buildKoreanDirectorMap(load('data/movies.yml'))` ([lib/utils.js](lib/utils.js)). On `status: "ok"`, take `entry.imdb_id` and the TMDB id from `entry.tmdb_url`. If `GEMINI_API_KEY` is absent or the pipeline returns `no_match`, **log the unresolved winner and continue** (don't fail the run).

5. **Derive badges.** For each grouped entry, compute `awards` from `award_names` via `deriveAwardBadges(award_names)` ([lib/utils.js](lib/utils.js)). Because the `award_names` strings come from the table in §2 (matching `AWARD_NAMES` byte-for-byte, including the curly apostrophe), `BADGE_KEY_BY_NAME` resolves them correctly. Four awards have **no badge mapping** — `European Film Award for Best Film`, `Hong Kong Film Awards`, `César Award for Best Film`, and `Japan Academy Prize` — so `deriveAwardBadges` skips them: they appear in `award_names` (and the editor's read-only Awards row) but contribute no badge key, so `awards:` can be empty for a film whose only wins are these.

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

## Testing — `node --test`

Follow the existing fixture pattern (`tests/fixtures/`, frozen JSON):

- Frozen fixtures so tests run offline: a **Wikidata SPARQL JSON** response, a **Wikipedia `action=parse` wikitext** response per Wikipedia award (`bluedragon-`, `cesar-`, `japan-academy-wikitext.json`), and a **TMDB `/find`** response.
- Assert: grouping by IMDb ID (a film winning two awards collapses to one entry with two `award_names` + two `wins`); the **producer/`nm` filter** drops non-film rows; **Q-ID → taxonomy-name mapping** is exact (including `Venice Leone d’oro`'s curly apostrophe); `deriveAwardBadges` yields the right badges (incl. `청룡영화제 최우수 작품상` → `blue_dragon`, and **no** badge for César/Japan/EFA/HK); the dumped YAML matches the schema and is **stable across two runs** (idempotent).
- **Wikipedia table parsers:** for each fixture, assert the winner-row count is in range (one per year) and a representative row extracts `{ year, article, title }` correctly — `parseBlueDragonWikitext` (double-dagger / `||` formats, Korean original) and `parseWinnersByYearHeader` (César winner+nominees with the `!`-year-header rule; Japan winners-only).
- A small mocked-fetch test for the Gemini fallback branch (no-IMDb winner → `processMemoLine` resolves `imdb_id`), mirroring `tests/_helpers/pipeline_mocks.js`.
