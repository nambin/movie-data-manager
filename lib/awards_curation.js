// Award-curation logic for cli/curate-awards.mjs.
//
// Collects official winner lists for six top film prizes and resolves each to
// an IMDb/TMDB entry, producing the data/awards.yml lookup. See
// prompt-award-curation.md for the full design.
//
// Two data sources converge into one `by_imdb` map:
//   - Wikidata SPARQL  → the five international awards (P166 = "won"), ~99% of
//                        winners carry an IMDb ID (wdt:P345) directly.
//   - English Wikipedia → the Blue Dragon Best Film award (Wikidata covers only
//                        ~3 of ~45 winners), parsed from the winners table.
//
// Pure parsing / grouping / dumping functions are exported for unit testing;
// the network helpers use the global `fetch` (overridable in tests, matching
// lib/memo_pipeline.js). Keys are passed in explicitly — the esbuild build-time
// __TMDB_KEY__/__GEMINI_KEY__ inlining does not apply under plain Node.

import yaml from "js-yaml";

import { deriveAwardBadges, YAML_DUMP_OPTIONS } from "./utils.js";
import { processMemoLine } from "./memo_pipeline.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const TMDB_BASE = "https://api.themoviedb.org/3";
const USER_AGENT =
  "movie-data-manager-award-curation/1.0 (https://nambin.github.io)";

// Wikidata award Q-IDs → exact taxonomy name (lib/utils.js AWARD_NAMES). The
// Wikidata labels differ ("Academy Award for Best International Feature Film"
// vs our "Oscar Best International Film"), so map by Q-ID, never by label.
// Verified live against query.wikidata.org (see prompt-award-curation.md §2.1).
export const AWARD_QID_TO_NAME = Object.freeze({
  Q102427: "Oscar Best Picture",
  Q105304: "Oscar Best International Film",
  Q179808: "Cannes Palme d'Or",
  Q209459: "Venice Leone d’oro", // curly apostrophe (U+2019) — must match AWARD_NAMES
  Q154590: "Berlin Goldener Bär",
  Q777921: "European Film Award for Best Film",
  Q4722629: "Hong Kong Film Awards",
});

export const BLUE_DRAGON_AWARD_NAME = "청룡영화제 최우수 작품상";

// Hand-verified wins that the upstream sources miss. Wikidata/Wikipedia are
// incomplete for a handful of real wins (e.g. Joker's 2019 Golden Lion is not
// recorded as a P166 statement on its film item), so they are injected here and
// merged into the curated records on every run. Keep this list small and only
// for confirmed gaps — each entry must use an exact AWARD_NAMES string and a
// `tt…` IMDb id. groupByImdb dedupes by (award_name, year), so an override is
// harmless if a source later starts reporting the same win.
export const MANUAL_AWARD_OVERRIDES = [
  // Joker (2019) won the Venice Golden Lion; absent from Wikidata's film item.
  { imdb_id: "tt7286456", award_name: "Venice Leone d’oro", year: 2019, title: "Joker" },
  // Better Days won the 39th Hong Kong Film Awards Best Film (2020); absent
  // from Wikidata's film item (Q4722629).
  { imdb_id: "tt9586294", award_name: "Hong Kong Film Awards", year: 2020, title: "Better Days" },
];

// Awards sourced from English Wikipedia winners tables — Wikidata is too sparse
// for these (Blue Dragon ~3 of 45; César ~26 of 51; Japan ~9 of 49 via P166).
// Each: taxonomy name, Wikipedia page, a parser → [{ year, article, title, … }],
// and a floor on the parsed winner count (warn if a markup change drops below
// it). Parser functions are hoisted, so referencing them here is fine.
export const WIKIPEDIA_AWARDS = [
  {
    name: BLUE_DRAGON_AWARD_NAME,
    page: "Blue Dragon Film Award for Best Film",
    parse: parseBlueDragonWikitext,
    minWinners: 35,
  },
  {
    name: "César Award for Best Film",
    page: "César Award for Best Film",
    parse: parseWinnersByYearHeader,
    minWinners: 40,
  },
  {
    name: "Japan Academy Prize",
    page: "Japan Academy Film Prize for Picture of the Year",
    parse: parseWinnersByYearHeader,
    minWinners: 40,
  },
];

// Per-award Wikidata query (one award Q-ID per request). The combined query
// for all seven awards at once was timing out / 502-ing on the Wikidata
// endpoint, so we send one lighter request per award instead — slower, but far
// more reliable. The P166 statement node (p:/ps:) is used so the pq:P585 year
// qualifier is reachable; the film-type filter drops co-recipient producers
// (whose IMDb IDs are nm…, not tt…). The result shape is identical to the old
// combined query, so parseSparqlAwardRows handles each response unchanged.
export function buildSparqlAwardQuery(qid) {
  return `SELECT ?award ?film ?imdb ?year ?filmLabel WHERE {
  VALUES ?award { wd:${qid} }
  ?film p:P166 ?stmt .
  ?stmt ps:P166 ?award .
  ?film wdt:P31/wdt:P279* wd:Q11424 .
  OPTIONAL { ?film wdt:P345 ?imdb . }
  OPTIONAL { ?stmt pq:P585 ?date . BIND(YEAR(?date) AS ?year) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
}

// -----------------------------------------------------------------------------
// Wikidata SPARQL — parsing (pure)
// -----------------------------------------------------------------------------

// SPARQL JSON results → win records for the five international awards.
// One record per (award, film, year) binding. `imdb_id` is kept only when it
// is a `tt…` title id; anything else (a stray `nm…` person id) becomes null so
// the row falls through to the Gemini fallback rather than poisoning the data.
export function parseSparqlAwardRows(json) {
  const bindings = json?.results?.bindings ?? [];
  const records = [];
  const seen = new Set();
  for (const b of bindings) {
    const awardUri = b.award?.value ?? "";
    const qid = awardUri.slice(awardUri.lastIndexOf("/") + 1);
    const award_name = AWARD_QID_TO_NAME[qid];
    if (!award_name) continue; // defensive: ignore unexpected awards

    const filmUri = b.film?.value ?? "";
    const rawImdb = b.imdb?.value ?? null;
    const imdb_id = rawImdb && rawImdb.startsWith("tt") ? rawImdb : null;
    const year = b.year?.value ? Number(b.year.value) : null;
    // The label service echoes the Q-id when no English label exists; treat
    // that as "no title" so the fallback uses a real string instead.
    const label = b.filmLabel?.value ?? null;
    const title =
      label && !/^Q\d+$/.test(label) ? label : null;

    const dedupeKey = `${qid}|${filmUri}|${year ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    records.push({ award_name, imdb_id, year, title, filmUri });
  }
  return records;
}

// -----------------------------------------------------------------------------
// Wikidata SPARQL — article → IMDb resolution (pure helpers)
// -----------------------------------------------------------------------------

// Build the en.wikipedia sitelink IRI for an article title (spaces → "_").
export function articleToWikipediaIri(article) {
  return "https://en.wikipedia.org/wiki/" + article.replace(/ /g, "_");
}

// VALUES query mapping en.wikipedia article IRIs → IMDb ids.
export function buildArticleImdbQuery(articles) {
  const values = articles
    .map((a) => `<${articleToWikipediaIri(a)}>`)
    .join(" ");
  return `SELECT ?article ?imdb WHERE {
  VALUES ?article { ${values} }
  ?article schema:about ?film .
  ?film wdt:P345 ?imdb .
}`;
}

// SPARQL JSON results → Map(article title → imdb_id). Article titles are
// returned with spaces (decoded from the sitelink IRI's underscores).
export function parseArticleImdbRows(json) {
  const map = new Map();
  for (const b of json?.results?.bindings ?? []) {
    const iri = b.article?.value ?? "";
    const imdb = b.imdb?.value ?? "";
    if (!iri || !imdb.startsWith("tt")) continue;
    const slug = decodeURIComponent(iri.slice(iri.lastIndexOf("/wiki/") + 6));
    const article = slug.replace(/_/g, " ");
    if (!map.has(article)) map.set(article, imdb);
  }
  return map;
}

// -----------------------------------------------------------------------------
// English Wikipedia — Blue Dragon winners table (pure)
// -----------------------------------------------------------------------------

// Strip a single wikitext cell down to plain text: drop {{templates}},
// <ref>…</ref>, <div…> wrappers, bold/italic quotes, and leftover brackets.
function stripCellMarkup(s) {
  return s
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/'''/g, "")
    .replace(/''/g, "")
    .trim();
}

// Split a table row's content into cells on the `||` inline separator,
// ignoring `||` that falls inside [[wikilinks]] or {{templates}}. Wikitext
// tables use either one `|`-prefixed cell per line OR several cells on one line
// joined by `||`; the Blue Dragon table mixes both across decades.
function splitTableCells(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if ((c === "[" && n === "[") || (c === "{" && n === "{")) {
      depth++;
      cur += c + n;
      i++;
    } else if ((c === "]" && n === "]") || (c === "}" && n === "}")) {
      if (depth > 0) depth--;
      cur += c + n;
      i++;
    } else if (c === "|" && n === "|" && depth === 0) {
      out.push(cur);
      cur = "";
      i++;
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Drop an HTML-attribute prefix (`style=… |`) from a cell's first segment, but
// only when the part before the first "|" looks like attributes (has "=", no
// "[" / "{") — never cut inside a piped [[link|display]].
function stripAttrPrefix(content) {
  const firstPipe = content.indexOf("|");
  if (firstPipe < 0) return content;
  const prefix = content.slice(0, firstPipe);
  return /^[^[{]*=[^[{]*$/.test(prefix) ? content.slice(firstPipe + 1) : content;
}

// Extract the first [[wikilink]] from a cell. Returns { article, display }.
// `[[A|B]]` → { article: "A", display: "B" }; `[[A]]` → { article: "A", display: "A" }.
function firstWikilink(cell) {
  const m = cell.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
  if (!m) return null;
  const article = m[1].trim();
  const display = stripCellMarkup(m[2] ?? m[1]);
  return { article, display };
}

// Parse the Blue Dragon "Best Film" winners table from the page wikitext.
// Returns one row per WINNER (not nominees), in source order:
//   { year, article, title, korean }
// `article` is the English Wikipedia article title (for deterministic
// IMDb resolution) or null; `korean` is the original-title cell.
//
// The table format varies by decade: older rows put the year `!`-header and the
// winner `|`-cells in one table row; newer rows put the year in its own
// rowspan header row, followed by the winner row and several nominee rows.
// Winners (and only winners) carry the {{double dagger}} marker, so we key on
// that and attach the most recently seen year. The "Table key" legend row also
// contains a double dagger but has no title cell, so it is skipped.
export function parseBlueDragonWikitext(wikitext) {
  const rows = wikitext.split(/\n\|-/); // table-row segments
  const winners = [];
  let currentYear = null;

  for (const row of rows) {
    // A header cell (`! …`) anywhere in this segment may carry the year. The
    // year can sit several lines below the "!" (rowspan `<div>` form), so scan
    // lazily from the first "!" to the first 4-digit year.
    const headerMatch = row.match(/(?:^|\n)\s*![\s\S]*?((?:19|20)\d{2})/);
    if (headerMatch) currentYear = Number(headerMatch[1]);

    // The legend ("Table key") and the infobox precede the first dated row;
    // skip any double-dagger match seen before a real year is in scope.
    if (currentYear == null) continue;
    if (!row.includes("{{double dagger")) continue;

    // Data cells: lines beginning with a single "|" (not |-, |+, |}), each of
    // which may itself hold several cells joined by "||". A line that starts
    // with neither "|" nor "!" is a continuation of the previous cell (e.g. a
    // director name wrapped onto its own line).
    const cells = [];
    for (const rawLine of row.split("\n")) {
      const line = rawLine.trimStart();
      if (line.startsWith("!")) continue; // year header cell
      if (/^\|[-+}]/.test(line)) continue; // row / caption / end marker
      if (line.startsWith("|")) {
        const pieces = splitTableCells(line.slice(1));
        pieces[0] = stripAttrPrefix(pieces[0]);
        for (const p of pieces) cells.push(p.trim());
      } else if (cells.length && line) {
        cells[cells.length - 1] = `${cells[cells.length - 1]} ${line}`.trim();
      }
    }
    if (cells.length === 0) continue;

    const winnerCell = cells[0];
    const link = firstWikilink(winnerCell);
    const title = link ? link.display : stripCellMarkup(winnerCell);
    if (!title) continue; // skips the "Table key" legend row

    const korean = cells[1] ? stripCellMarkup(cells[1]) : null;
    winners.push({
      year: currentYear,
      article: link ? link.article : null,
      title,
      korean: korean || null,
    });
  }
  return winners;
}

// Parse a Wikipedia winners table where each WINNER row carries a header cell
// (`! …`) holding the ceremony year, followed by the film cells. Returns one
// row per winner: { year, article, title } in source order.
//
// This covers two shapes with a single rule ("a row whose `!` header has a
// 4-digit year is a winner; its first wikilink is the film"):
//   - winners-only tables — every row is `!Nth (YYYY) | film | … ` (Japan
//     Academy "Picture of the Year").
//   - winner+nominees tables — only the winner row carries the `! rowspan`
//     year header; nominee rows are plain `| …` with no `!` (César Best Film,
//     across its older per-cell-highlight and newer per-row-highlight formats).
// Blue Dragon does NOT fit this rule (its modern format puts the year in a
// separate year-only row and marks the winner with {{double dagger}}), which
// is why it keeps a dedicated parser above.
export function parseWinnersByYearHeader(wikitext) {
  const winners = [];
  for (const row of wikitext.split(/\n\|-/)) {
    // The winner row is the one whose `!` header cell carries a 4-digit year
    // (on the same line as the "!"). Column-header rows ("!Year", "!English
    // title") and nominee rows have no year here and are skipped.
    const headerMatch = row.match(/(?:^|\n)\s*![^\n]*?((?:19|20)\d{2})/);
    if (!headerMatch) continue;
    const year = Number(headerMatch[1]);

    // Data cells: lines starting with a single "|" (each may hold several
    // cells joined by "||"). The "!" header line and row markers are skipped.
    const cells = [];
    for (const rawLine of row.split("\n")) {
      const line = rawLine.trimStart();
      if (line.startsWith("!")) continue;
      if (/^\|[-+}]/.test(line)) continue;
      if (!line.startsWith("|")) continue;
      const pieces = splitTableCells(line.slice(1));
      pieces[0] = stripAttrPrefix(pieces[0]);
      for (const p of pieces) cells.push(p.trim());
    }
    if (cells.length === 0) continue;

    const link = firstWikilink(cells[0]);
    const title = link ? link.display : stripCellMarkup(cells[0]);
    if (!title) continue;
    winners.push({ year, article: link ? link.article : null, title });
  }
  return winners;
}

// -----------------------------------------------------------------------------
// Network helpers (use global fetch; overridable in tests)
// -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mask the TMDB api_key before a URL is written to logs (the CI run log is
// visible to repo collaborators). Wikidata/Wikipedia URLs carry no secret.
function redactUrl(url) {
  return String(url).replace(/(api_key=)[^&]+/gi, "$1***");
}

// GET/POST with retry + exponential backoff. Wikidata in particular returns
// transient 5xx (e.g. 502 Bad Gateway) and timeouts that clear within seconds;
// retrying with growing backoff (1s, 2s, 4s, 8s) rides those out instead of
// failing the whole weekly run. Network errors and transient HTTP statuses
// (429 + any 5xx) are retried; a 4xx won't fix itself, so it fails fast.
// Every retry / give-up / fast-fail is logged to stderr so a CI run shows
// exactly what was slow or broken (status, reason, URL, attempt, backoff).
async function fetchWithRetry(url, opts = {}, { attempts = 5, backoffMs = 1000 } = {}) {
  const safeUrl = redactUrl(url);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    let r;
    try {
      r = await fetch(url, opts);
    } catch (e) {
      // Network/DNS error (no HTTP response) — always transient, retry.
      lastErr = e;
      const code = e.cause?.code ?? e.code ?? e.name ?? "network error";
      if (i < attempts - 1) {
        const wait = backoffMs * 2 ** i;
        console.error(
          `  fetch error [${code}] ${e.message} — ${safeUrl} — ` +
            `attempt ${i + 1}/${attempts}, retrying in ${wait}ms`
        );
        await sleep(wait);
      } else {
        console.error(
          `  fetch error [${code}] ${e.message} — ${safeUrl} — ` +
            `gave up after ${attempts} attempts`
        );
      }
      continue;
    }
    if (r.ok) return r;
    lastErr = new Error(`HTTP ${r.status} ${r.statusText}`);
    if (r.status !== 429 && r.status < 500) {
      // A 4xx won't fix itself — fail fast (no retry).
      console.error(
        `  HTTP ${r.status} ${r.statusText} — ${safeUrl} — non-transient, not retrying`
      );
      break;
    }
    if (i < attempts - 1) {
      const wait = backoffMs * 2 ** i;
      console.error(
        `  HTTP ${r.status} ${r.statusText} — ${safeUrl} — ` +
          `transient, attempt ${i + 1}/${attempts}, retrying in ${wait}ms`
      );
      await sleep(wait);
    } else {
      console.error(
        `  HTTP ${r.status} ${r.statusText} — ${safeUrl} — ` +
          `transient, gave up after ${attempts} attempts`
      );
    }
  }
  throw lastErr;
}

// POST (not GET) so a large article→IMDb query — ~150 sitelink IRIs across all
// Wikipedia awards — doesn't blow the URL length limit (HTTP 414).
async function sparql(query) {
  const r = await fetchWithRetry(WIKIDATA_SPARQL, {
    method: "POST",
    headers: {
      Accept: "application/sparql-results+json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: `query=${encodeURIComponent(query)}&format=json`,
  });
  return r.json();
}

// Query each Wikidata award separately and concatenate the winner rows.
// Sequential (not parallel) to stay gentle on the endpoint that was already
// erroring; each call has its own retry/backoff via fetchWithRetry. If any one
// award still fails after its retries we throw and fail the whole run — we must
// NOT silently drop an award, because awards.yml is the complete source of
// truth and the reconcile step strips any award it doesn't list. A failed run
// leaves the file untouched (safe); a partial regenerate would be data loss.
export async function fetchSparqlAwardRows() {
  const records = [];
  for (const qid of Object.keys(AWARD_QID_TO_NAME)) {
    const name = AWARD_QID_TO_NAME[qid];
    console.error(`  Wikidata: fetching ${name} (${qid})…`);
    try {
      const rows = parseSparqlAwardRows(await sparql(buildSparqlAwardQuery(qid)));
      console.error(`  Wikidata: ${name} (${qid}) — ${rows.length} winner row(s)`);
      records.push(...rows);
    } catch (e) {
      // Log which award failed (fetchWithRetry's per-attempt logs only show the
      // shared endpoint URL), then re-throw with that context to fail the run.
      console.error(`  Wikidata: ${name} (${qid}) FAILED — ${e.message}`);
      throw new Error(`Wikidata query for ${name} (${qid}) failed: ${e.message}`);
    }
  }
  return records;
}

export async function resolveArticlesToImdb(articles) {
  const unique = [...new Set(articles.filter(Boolean))];
  if (unique.length === 0) return new Map();
  return parseArticleImdbRows(await sparql(buildArticleImdbQuery(unique)));
}

// Fetch + parse one Wikipedia-sourced award (an entry of WIKIPEDIA_AWARDS).
export async function fetchWikipediaAwardRows(award) {
  const url =
    `${WIKIPEDIA_API}?action=parse&page=${encodeURIComponent(award.page)}` +
    `&prop=wikitext&format=json&redirects=1`;
  const r = await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT } });
  const json = await r.json();
  const wikitext = json?.parse?.wikitext?.["*"] ?? "";
  return award.parse(wikitext);
}

// TMDB find-by-IMDb → { tmdb_id, title } or null. One deterministic call.
export async function tmdbFind(imdbId, tmdbApiKey) {
  const url = `${TMDB_BASE}/find/${imdbId}?api_key=${tmdbApiKey}&external_source=imdb_id`;
  const r = await fetchWithRetry(url, {}, { attempts: 2, backoffMs: 500 });
  const json = await r.json();
  const movie = json?.movie_results?.[0];
  if (!movie) return null;
  return { tmdb_id: movie.id, title: movie.title ?? movie.original_title ?? null };
}

// -----------------------------------------------------------------------------
// Grouping + document building (pure)
// -----------------------------------------------------------------------------

// Collapse resolved win records (each carrying an imdb_id) into the per-film
// shape. award_names is order-preserving + deduped; wins dedupes (name, year).
export function groupByImdb(records) {
  const byImdb = new Map();
  for (const rec of records) {
    if (!rec.imdb_id) continue;
    let entry = byImdb.get(rec.imdb_id);
    if (!entry) {
      entry = { award_names: [], wins: [], title: rec.title ?? null };
      byImdb.set(rec.imdb_id, entry);
    }
    if (!entry.award_names.includes(rec.award_name)) {
      entry.award_names.push(rec.award_name);
    }
    const winKey = `${rec.award_name}|${rec.year ?? ""}`;
    if (!entry.wins.some((w) => `${w.award_name}|${w.year ?? ""}` === winKey)) {
      entry.wins.push({ award_name: rec.award_name, year: rec.year ?? null });
    }
    if (!entry.title && rec.title) entry.title = rec.title;
  }
  return byImdb;
}

// Build the final awards document. `tmdbInfo` maps imdb_id → { tmdb_id, title }
// (from tmdbFind); when present its title/tmdb_id win over the source title.
// Everything is sorted deterministically so an unchanged run is byte-identical.
export function buildAwardsDocument(byImdb, { generatedAt, tmdbInfo = new Map() }) {
  const byImdbOut = {};
  for (const imdb_id of [...byImdb.keys()].sort()) {
    const entry = byImdb.get(imdb_id);
    const info = tmdbInfo.get(imdb_id) ?? {};
    const award_names = [...entry.award_names].sort();
    const awards = deriveAwardBadges(award_names);
    const wins = [...entry.wins].sort((a, b) => {
      if (a.award_name !== b.award_name)
        return a.award_name < b.award_name ? -1 : 1;
      return (a.year ?? 0) - (b.year ?? 0);
    });
    const tmdb_id = info.tmdb_id ?? null;
    byImdbOut[imdb_id] = {
      tmdb_id,
      title: info.title ?? entry.title ?? null,
      imdb_url: `https://www.imdb.com/title/${imdb_id}`,
      tmdb_url:
        tmdb_id != null ? `https://www.themoviedb.org/movie/${tmdb_id}` : null,
      award_names,
      awards,
      wins,
    };
  }
  return { generated_at: generatedAt, by_imdb: byImdbOut };
}

const AWARDS_YAML_HEADER =
  "# AUTO-GENERATED by cli/curate-awards.mjs — do not edit by hand.\n" +
  "# Source: Wikidata (5 intl awards, wdt:P166) + Wikipedia (Blue Dragon) + TMDB.\n" +
  "# Regenerated on a schedule; see prompt-award-curation.md.\n";

export function dumpAwardsYaml(doc) {
  return AWARDS_YAML_HEADER + yaml.dump(doc, YAML_DUMP_OPTIONS);
}

// -----------------------------------------------------------------------------
// Change reporting (for the GitHub Action's notification email)
// -----------------------------------------------------------------------------

// Diff two `by_imdb` maps (plain objects, as loaded from awards.yml). Returns
//   added:   films present only in `next`
//   updated: films in both whose award set changed — `newNames` gained and/or
//            `droppedNames` lost (a correction can remove an award from a film
//            that still holds another). `prevWins` carries the old wins so the
//            dropped awards' years can be rendered.
//   removed: films present only in `prev`
// Each entry carries enough fields to render a human-readable summary line.
export function diffAwards(prev = {}, next = {}) {
  const added = [];
  const updated = [];
  const removed = [];

  for (const imdb_id of Object.keys(next)) {
    const n = next[imdb_id];
    const p = prev[imdb_id];
    if (!p) {
      added.push({ imdb_id, ...n });
      continue;
    }
    const prevNames = new Set(p.award_names ?? []);
    const nextNames = new Set(n.award_names ?? []);
    const newNames = (n.award_names ?? []).filter((nm) => !prevNames.has(nm));
    const droppedNames = (p.award_names ?? []).filter((nm) => !nextNames.has(nm));
    if (newNames.length || droppedNames.length) {
      updated.push({ imdb_id, ...n, newNames, droppedNames, prevWins: p.wins ?? [] });
    }
  }
  for (const imdb_id of Object.keys(prev)) {
    if (!next[imdb_id]) removed.push({ imdb_id, ...prev[imdb_id] });
  }
  return { added, updated, removed };
}

// "Award (year), Award (year)" from a film's wins list.
function winsLine(film, onlyNames = null) {
  const wins = (film.wins ?? []).filter(
    (w) => !onlyNames || onlyNames.includes(w.award_name)
  );
  return wins.map((w) => `${w.award_name} (${w.year ?? "?"})`).join(", ");
}

// Render a diff as plain-text suitable for an email body. Long lists are
// truncated to `maxList` with an "… and N more" line (matters mainly on the
// first run, when every film is "added").
export function formatChangeSummary(diff, { generatedAt, maxList = 100 } = {}) {
  const { added, updated, removed } = diff;
  const lines = [];
  lines.push(`Award curation — ${generatedAt}`);
  lines.push("");
  lines.push(
    `${added.length} new film(s), ${updated.length} updated, ` +
      `${removed.length} removed.`
  );

  if (added.length) {
    lines.push("");
    lines.push(`New films (${added.length}):`);
    for (const f of added.slice(0, maxList)) {
      lines.push(`  • ${f.title ?? "(untitled)"} [${f.imdb_id}] — ${winsLine(f)}`);
      lines.push(`      ${f.tmdb_url ?? f.imdb_url}`);
    }
    if (added.length > maxList) lines.push(`  … and ${added.length - maxList} more`);
  }

  if (updated.length) {
    lines.push("");
    lines.push(`Updated films (${updated.length}) — award changes:`);
    for (const f of updated.slice(0, maxList)) {
      const parts = [];
      if (f.newNames?.length) {
        parts.push(`added: ${winsLine(f, f.newNames) || f.newNames.join(", ")}`);
      }
      if (f.droppedNames?.length) {
        const dropped =
          winsLine({ wins: f.prevWins }, f.droppedNames) ||
          f.droppedNames.join(", ");
        parts.push(`removed: ${dropped}`);
      }
      lines.push(
        `  • ${f.title ?? "(untitled)"} [${f.imdb_id}] — ${parts.join("; ")}`
      );
      lines.push(`      ${f.tmdb_url ?? f.imdb_url}`);
    }
    if (updated.length > maxList)
      lines.push(`  … and ${updated.length - maxList} more`);
  }

  if (removed.length) {
    lines.push("");
    lines.push(`Removed films (${removed.length}):`);
    for (const f of removed.slice(0, maxList)) {
      lines.push(`  • ${f.title ?? "(untitled)"} [${f.imdb_id}]`);
    }
    if (removed.length > maxList)
      lines.push(`  … and ${removed.length - maxList} more`);
  }

  return lines.join("\n").trimEnd() + "\n";
}

// -----------------------------------------------------------------------------
// Resolution (records lacking an IMDb id → Gemini fallback)
// -----------------------------------------------------------------------------

// Split records into those already carrying an imdb_id and those needing the
// Gemini+TMDB fallback. `runFallback(record)` resolves one record to
// { imdb_id, title, tmdb_id } or null; injected for testability. Unresolved
// records are logged and dropped (never fail the whole run).
export async function resolveRecordsToImdb(records, { runFallback, log = () => {} }) {
  const resolved = [];
  let fallbackUsed = 0;
  let unresolved = 0;
  for (const rec of records) {
    if (rec.imdb_id) {
      resolved.push(rec);
      continue;
    }
    const got = await runFallback(rec);
    if (got?.imdb_id) {
      fallbackUsed++;
      resolved.push({ ...rec, imdb_id: got.imdb_id, title: got.title ?? rec.title });
    } else {
      unresolved++;
      log(
        `  unresolved: ${rec.award_name} ${rec.year ?? "?"} — ` +
          `"${rec.korean ?? rec.title ?? rec.filmUri ?? "?"}"`
      );
    }
  }
  return { resolved, fallbackUsed, unresolved };
}

// Default fallback: run the existing memo pipeline. Korean original title is
// preferred for Blue Dragon rows (the pipeline's strength); otherwise the
// English/Wikidata title. Returns { imdb_id, title, tmdb_id } or null.
export function makeMemoFallback({ geminiKey, tmdbApiKey, koreanDirectorMap }) {
  return async (rec) => {
    if (!geminiKey) return null;
    const titleForSearch = rec.korean || rec.title;
    if (!titleForSearch) return null;
    const rawLine = rec.year ? `${titleForSearch} ${rec.year}` : titleForSearch;
    let result;
    try {
      result = await processMemoLine({
        rawLine,
        geminiKey,
        tmdbApiKey,
        koreanDirectorMap,
      });
    } catch {
      return null;
    }
    if (result.status !== "ok" || !result.entry?.imdb_id) return null;
    const m = result.entry.tmdb_url?.match(/\/movie\/(\d+)/);
    return {
      imdb_id: result.entry.imdb_id,
      title: result.entry.title ?? titleForSearch,
      tmdb_id: m ? Number(m[1]) : null,
    };
  };
}

// Run `task` over `items` with a bounded number of concurrent workers,
// preserving input order in the result array.
async function mapPool(items, limit, task) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// -----------------------------------------------------------------------------
// Orchestration
// -----------------------------------------------------------------------------

// Full curation run: fetch both sources, resolve every winner to an IMDb id
// (deterministically where possible, Gemini fallback otherwise), look up TMDB,
// and build the awards document. Network-bound; collaborators default to the
// real helpers above but are injectable for testing.
export async function curateAwards({
  tmdbApiKey,
  geminiKey,
  koreanDirectorMap = new Map(),
  generatedAt,
  log = () => {},
  deps = {},
} = {}) {
  const {
    fetchInternational = fetchSparqlAwardRows,
    fetchWikipediaAward = fetchWikipediaAwardRows,
    wikipediaAwards = WIKIPEDIA_AWARDS,
    resolveArticles = resolveArticlesToImdb,
    findOnTmdb = tmdbFind,
    runFallback = makeMemoFallback({ geminiKey, tmdbApiKey, koreanDirectorMap }),
    overrides = MANUAL_AWARD_OVERRIDES,
  } = deps;

  // -- International (Wikidata) ----------------------------------------------
  log("Fetching Wikidata winners (7 awards)…");
  const intlRecords = await fetchInternational();
  log(
    `  ${intlRecords.length} award rows; ` +
      `${intlRecords.filter((r) => r.imdb_id).length} carry an IMDb id`
  );

  // -- Wikipedia-sourced awards (Blue Dragon, César, Japan Academy) ----------
  const wikiFetched = [];
  for (const award of wikipediaAwards) {
    log(`Fetching ${award.name} winners (Wikipedia)…`);
    const rows = await fetchWikipediaAward(award);
    log(`  ${rows.length} winners parsed from the table`);
    if (rows.length < (award.minWinners ?? 0)) {
      log(
        `  WARNING: only ${rows.length} ${award.name} winners parsed — the ` +
          `table markup may have changed; check its parser.`
      );
    }
    wikiFetched.push({ award, rows });
  }
  // One batch article→IMDb query across every Wikipedia award.
  const allArticles = wikiFetched.flatMap(({ rows }) => rows.map((r) => r.article));
  const articleImdb = await resolveArticles(allArticles);
  const wikiRecords = wikiFetched.flatMap(({ award, rows }) =>
    rows.map((r) => ({
      award_name: award.name,
      imdb_id: r.article ? articleImdb.get(r.article) ?? null : null,
      year: r.year,
      title: r.title,
      korean: r.korean ?? null, // Blue Dragon supplies a Korean original; others null
      filmUri: null,
    }))
  );
  log(
    `  ${wikiRecords.filter((r) => r.imdb_id).length}/${wikiRecords.length} ` +
      `Wikipedia winners resolved to IMDb via sitelinks`
  );

  // -- Manual overrides for confirmed upstream gaps -------------------------
  const overrideRecords = overrides.map((o) => ({
    award_name: o.award_name,
    imdb_id: o.imdb_id,
    year: o.year ?? null,
    title: o.title ?? null,
    korean: null,
    filmUri: null,
  }));
  if (overrideRecords.length) {
    log(`Applying ${overrideRecords.length} manual override(s) for known source gaps.`);
  }

  // -- Resolve the remainder via the Gemini fallback -------------------------
  const all = [...intlRecords, ...wikiRecords, ...overrideRecords];
  const { resolved, fallbackUsed, unresolved } = await resolveRecordsToImdb(all, {
    runFallback,
    log,
  });
  log(`Fallback: resolved ${fallbackUsed}, unresolved ${unresolved}`);

  // -- Group by film, then look up TMDB --------------------------------------
  const byImdb = groupByImdb(resolved);
  log(`${byImdb.size} unique films; looking up TMDB…`);
  const ids = [...byImdb.keys()];
  const tmdbInfo = new Map();
  const infos = await mapPool(ids, 8, async (imdb_id) => {
    try {
      return await findOnTmdb(imdb_id, tmdbApiKey);
    } catch (e) {
      log(`  TMDB find failed for ${imdb_id}: ${e.message}`);
      return null;
    }
  });
  ids.forEach((imdb_id, i) => {
    if (infos[i]) tmdbInfo.set(imdb_id, infos[i]);
  });

  return buildAwardsDocument(byImdb, { generatedAt, tmdbInfo });
}
