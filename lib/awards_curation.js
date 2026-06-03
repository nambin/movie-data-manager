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
});

export const BLUE_DRAGON_AWARD_NAME = "청룡영화제 최우수 작품상";

const BLUE_DRAGON_WIKIPEDIA_PAGE = "Blue Dragon Film Award for Best Film";

// Combined query for all five international awards. The P166 statement node
// (p:/ps:) is used so the pq:P585 year qualifier is reachable; the film-type
// filter drops co-recipient producers (whose IMDb IDs are nm…, not tt…).
export const SPARQL_AWARDS_QUERY = `SELECT ?award ?film ?imdb ?year ?filmLabel WHERE {
  VALUES ?award { wd:Q102427 wd:Q105304 wd:Q179808 wd:Q209459 wd:Q154590 }
  ?film p:P166 ?stmt .
  ?stmt ps:P166 ?award .
  ?film wdt:P31/wdt:P279* wd:Q11424 .
  OPTIONAL { ?film wdt:P345 ?imdb . }
  OPTIONAL { ?stmt pq:P585 ?date . BIND(YEAR(?date) AS ?year) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

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

// -----------------------------------------------------------------------------
// Network helpers (use global fetch; overridable in tests)
// -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET/POST with small retry+backoff. Wikidata occasionally returns transient
// timeouts; a few retries smooth those over without masking real failures.
async function fetchWithRetry(url, opts = {}, { attempts = 3, backoffMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return r;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(backoffMs * (i + 1));
    }
  }
  throw lastErr;
}

async function sparql(query) {
  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}&format=json`;
  const r = await fetchWithRetry(url, {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": USER_AGENT,
    },
  });
  return r.json();
}

export async function fetchSparqlAwardRows() {
  return parseSparqlAwardRows(await sparql(SPARQL_AWARDS_QUERY));
}

export async function resolveArticlesToImdb(articles) {
  const unique = [...new Set(articles.filter(Boolean))];
  if (unique.length === 0) return new Map();
  return parseArticleImdbRows(await sparql(buildArticleImdbQuery(unique)));
}

export async function fetchBlueDragonRows() {
  const url =
    `${WIKIPEDIA_API}?action=parse&page=${encodeURIComponent(BLUE_DRAGON_WIKIPEDIA_PAGE)}` +
    `&prop=wikitext&format=json&redirects=1`;
  const r = await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT } });
  const json = await r.json();
  const wikitext = json?.parse?.wikitext?.["*"] ?? "";
  return parseBlueDragonWikitext(wikitext);
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
    fetchBlueDragon = fetchBlueDragonRows,
    resolveArticles = resolveArticlesToImdb,
    findOnTmdb = tmdbFind,
    runFallback = makeMemoFallback({ geminiKey, tmdbApiKey, koreanDirectorMap }),
  } = deps;

  // -- International (Wikidata) ----------------------------------------------
  log("Fetching Wikidata winners (5 international awards)…");
  const intlRecords = await fetchInternational();
  log(
    `  ${intlRecords.length} award rows; ` +
      `${intlRecords.filter((r) => r.imdb_id).length} carry an IMDb id`
  );

  // -- Blue Dragon (Wikipedia) ----------------------------------------------
  log("Fetching Blue Dragon winners (Wikipedia)…");
  const bdRows = await fetchBlueDragon();
  log(`  ${bdRows.length} winners parsed from the table`);
  if (bdRows.length < 35) {
    log(
      `  WARNING: only ${bdRows.length} Blue Dragon winners parsed — the table ` +
        `markup may have changed; check parseBlueDragonWikitext.`
    );
  }
  const articleImdb = await resolveArticles(bdRows.map((r) => r.article));
  const bdRecords = bdRows.map((r) => ({
    award_name: BLUE_DRAGON_AWARD_NAME,
    imdb_id: r.article ? articleImdb.get(r.article) ?? null : null,
    year: r.year,
    title: r.title,
    korean: r.korean,
    filmUri: null,
  }));
  log(
    `  ${bdRecords.filter((r) => r.imdb_id).length}/${bdRecords.length} ` +
      `resolved to IMDb via Wikidata sitelinks`
  );

  // -- Resolve the remainder via the Gemini fallback -------------------------
  const all = [...intlRecords, ...bdRecords];
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
