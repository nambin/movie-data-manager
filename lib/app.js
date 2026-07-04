// UI glue + entry point. The pure data-correctness logic lives in the
// sibling lib/* modules (tested). This file handles DOM, file I/O, TMDB
// fetching, and localStorage persistence.

import yaml from "js-yaml";

import {
  buildMovieEntryFromTmdb,
  extractTmdbIdFromUrl,
  getTmdbKey,
} from "./tmdb_utils.js";
import { canonicalizeAll } from "./canonicalize.js";
import {
  sortMovies,
  YAML_DUMP_OPTIONS,
  YAML_LOAD_OPTIONS,
  isKoreanLanguage,
  buildKoreanDirectorMap,
} from "./utils.js";
import { getGeminiKey, DEFAULT_GEMINI_MODEL } from "./gemini_utils.js";
import { processMemoLine } from "./memo_pipeline.js";
import { reconcileAwardNames } from "./awards_reconcile.js";

// TMDB API key — inlined at build time from .env (or process.env), with a
// public default fallback. See lib/tmdb_utils.js getTmdbKey() and the
// scripts/build*.mjs wrappers.
const TMDB_API_KEY = getTmdbKey();

function todayDateString() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

// Full movies array (JSON-serialized). Survives page reloads so accidental
// refreshes don't wipe in-progress edits.
const LOCAL_STORAGE_KEY = "movie-collection-v1";
// imdb_ids of entries added via TMDB URL since the last YML load or download.
// Drives the "All / New" toolbar toggle across reloads.
const NEW_IDS_STORAGE_KEY = "movie-collection-new-ids-v1";
// "1" when localStorage holds unsaved edits. Lets the boot-time auto-load of
// data/movies.yml know whether it's safe to clobber localStorage with the
// server copy ("0") or must preserve in-progress work ("1").
const DIRTY_STORAGE_KEY = "movie-collection-dirty-v1";
// User-supplied Gemini API key, entered at runtime via the memo bar input.
// Only used when no key was inlined at build time (i.e. production builds).
// Stored in this browser's localStorage so the user doesn't have to retype
// it every visit — it's their own key, in their own browser.
const GEMINI_KEY_STORAGE_KEY = "movie-collection-gemini-key-v1";
// User's chosen Gemini model tier for the memo bulk-import flow's debug model
// picker (#gemini-model-select) — lets the user A/B test flash-lite/flash/pro
// on a failing memo line without rebuilding. Persisted so the choice survives
// reloads; always available regardless of build type (unlike the key input,
// this isn't a secret).
const GEMINI_MODEL_STORAGE_KEY = "movie-collection-gemini-model-v1";

// Default location of the published collection. Resolves relative to the
// page URL, so it works both in local dev (python -m http.server in this
// repo serves data/movies.yml at /data/movies.yml) and on GitHub Pages
// (nambin.github.io/movies_editor.html → /data/movies.yml).
const DEFAULT_DATA_URL = "data/movies.yml";

// data/awards.yml is the COMPLETE source of truth for awards. It is loaded at
// boot alongside movies.yml; every movie's award_names are overwritten from it
// (on load and whenever a movie is added) — set to exactly what awards.yml
// lists for the film, and emptied if the film isn't in awards.yml.
const AWARDS_DATA_URL = "data/awards.yml";
let awardsByImdb = null; // imdb_id → { award_names, … }; null until loaded

// The canonical data files live in the nambin.github.io repo, which serves this
// editor at the same origin — so on the live site the relative fetches above
// resolve to /data/*.yml directly. In local dev the editor is served from this
// (movie-data-manager) repo, which no longer carries the data files, so the
// same-origin fetch 404s; we then fall back to the live site so local dev still
// auto-loads. On nambin.github.io that fallback never runs.
const LIVE_DATA_ORIGIN = "https://nambin.github.io";

// Cap on how many movie cards are built into the DOM at once. Rendering all
// 800+ entries up front is the main cause of slow initial load, so we render
// only the top RENDER_LIMIT of the current filter result (plus any pinned
// "new" entries — see renderAll()). The rest are reachable by searching, which
// re-renders the top matches. Bumping this trades load speed for how many
// cards are visible without searching.
const RENDER_LIMIT = 10;

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
let movies = []; // array of entry objects
// True when there are edits in `movies` that haven't been written to disk via
// "Download YML". Drives the unsaved-changes indicator, the beforeunload
// prompt, and the auto-load guard (don't clobber unsaved work with the
// server copy of data/movies.yml). Mirrored to localStorage via
// DIRTY_STORAGE_KEY so a page reload remembers the unsaved state.
let dirty = false;
// imdb_ids of entries added via TMDB URL since the last YML load or download.
// Powers the "All / New" toolbar toggle so the user can focus on editing
// fresh entries without scrolling through hundreds of unchanged ones.
let newImdbIds = new Set();
// Toggle state: true → only show entries in newImdbIds; false → show all.
let newOnly = false;

// -----------------------------------------------------------------------------
// DOM refs
// -----------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const fileInput = $("file-input");
const searchInput = $("search-input");
const tmdbUrlInput = $("tmdb-url-input");
const addBtn = $("add-btn");
const addStatus = $("add-status");
const downloadBtn = $("download-btn");
const movieList = $("movie-list");
const countEl = $("count");
const dirtyIndicator = $("dirty-indicator");
const cardTemplate = $("movie-card-template");
const newOnlyToggle = $("new-only-toggle");
const newOnlyLabel = $("new-only-label");
const newCountEl = $("new-count");

// Memo bulk-import UI. The .memo-bar section is always visible. When a
// Gemini key is inlined at build time (dev builds) it's used directly and
// the runtime key input stays hidden. Otherwise (production builds) the
// key input (#gemini-key-input) is revealed so the user can supply their
// own key, persisted to this browser's localStorage. See the bottom of
// this file for the boot-time wiring.
const memoInput = $("memo-input");
const geminiKeyInput = $("gemini-key-input");
const geminiModelSelect = $("gemini-model-select");
const processMemoBtn = $("process-memo-btn");
const memoStatus = $("memo-status");
const reviewPane = $("review-pane");
const reviewList = $("review-list");
const reviewSummary = $("review-summary");
const commitAllBtn = $("commit-all-btn");
const discardAllBtn = $("discard-all-btn");
const reviewCardTemplate = $("review-card-template");

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------
function persist() {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(movies));
  } catch (e) {
    console.warn("localStorage write failed:", e);
  }
}

function restoreFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return false;
    movies = parsed;
    return true;
  } catch (e) {
    console.warn("localStorage restore failed:", e);
    return false;
  }
}

function setDirty(v) {
  dirty = v;
  dirtyIndicator.hidden = !dirty;
  // Persist so a page reload knows whether localStorage holds unsaved edits.
  // The auto-load uses this to decide whether to clobber localStorage with
  // the server copy or preserve in-progress work.
  try {
    localStorage.setItem(DIRTY_STORAGE_KEY, dirty ? "1" : "0");
  } catch (e) {
    console.warn("localStorage write failed:", e);
  }
}

function restoreDirty() {
  try {
    return localStorage.getItem(DIRTY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// "Newly added" tracking
// -----------------------------------------------------------------------------
function persistNewIds() {
  try {
    localStorage.setItem(NEW_IDS_STORAGE_KEY, JSON.stringify([...newImdbIds]));
  } catch (e) {
    console.warn("localStorage write failed:", e);
  }
}

function restoreNewIds() {
  try {
    const raw = localStorage.getItem(NEW_IDS_STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) newImdbIds = new Set(arr);
  } catch (e) {
    console.warn("localStorage restore failed:", e);
  }
}

// Reset on natural workflow boundaries: a fresh YML load, or after the user
// downloads (treat the download as "shipped — start a new batch").
function clearNewIds() {
  newImdbIds = new Set();
  newOnly = false;
  persistNewIds();
}

// Always show the toggle in the toolbar; disable it when there are no new
// entries to filter to (clicking "New" with N=0 would just empty the list).
function refreshNewIndicator() {
  const n = newImdbIds.size;
  if (n === 0) newOnly = false;
  newCountEl.textContent = n > 0 ? `(${n})` : "";
  newOnlyLabel.textContent = newOnly ? "New" : "All";
  newOnlyToggle.setAttribute("aria-pressed", newOnly ? "true" : "false");
  newOnlyToggle.disabled = n === 0;
}

// -----------------------------------------------------------------------------
// Status messages
// -----------------------------------------------------------------------------
function setAddStatus(msg, level = "") {
  addStatus.textContent = msg;
  addStatus.className = `status ${level}`;
}

// -----------------------------------------------------------------------------
// Load YML
// -----------------------------------------------------------------------------
fileInput.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const text = await f.text();
    const parsed = yaml.load(text, YAML_LOAD_OPTIONS);
    if (!Array.isArray(parsed)) {
      throw new Error("YML root is not a list of movies");
    }
    movies = parsed;
    clearNewIds();
    setDirty(false);
    persist();
    setAddStatus(`Loaded ${movies.length} movies from ${f.name}`, "success");
    syncLoadedAwardsThenRenderAll(); // overwrite curated awards from awards.yml + render
  } catch (err) {
    setAddStatus(`Failed to load: ${err.message}`, "error");
  } finally {
    fileInput.value = ""; // allow re-loading the same file
  }
});

// -----------------------------------------------------------------------------
// Add via TMDB URL
// -----------------------------------------------------------------------------
async function fetchTmdbMovie(tmdbId) {
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=credits`;
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`TMDB API ${r.status}: ${r.statusText}`);
  }
  return r.json();
}

addBtn.addEventListener("click", async () => {
  const url = tmdbUrlInput.value.trim();
  if (!url) {
    setAddStatus("Paste a TMDB URL first.", "error");
    return;
  }
  const id = extractTmdbIdFromUrl(url);
  if (!id) {
    setAddStatus("Couldn't extract a TMDB ID from that URL.", "error");
    return;
  }
  // Dup check by TMDB ID first — runs before the fetch so a re-paste
  // short-circuits without hitting the API.
  const tmdbUrl = `https://www.themoviedb.org/movie/${id}`;
  const dupByTmdb = movies.find((m) => m.tmdb_url === tmdbUrl);
  if (dupByTmdb) {
    setAddStatus(
      `Already in list: ${dupByTmdb.title} (TMDB id ${id}). Not added.`,
      "error"
    );
    return;
  }
  setAddStatus("Fetching from TMDB…");
  try {
    const tmdb = await fetchTmdbMovie(id);
    const entry = buildMovieEntryFromTmdb(tmdb);
    // Reuse a romanized→Korean director name the user has curated for any
    // already-loaded entry. Same lookup as the bulk-import path; spares the
    // user from re-typing the Korean form for repeat directors.
    const koreanDirectorMap = buildKoreanDirectorMap(movies);
    const romanized = entry.tmdb_director_name_1;
    if (romanized && koreanDirectorMap.has(romanized)) {
      entry.director = koreanDirectorMap.get(romanized);
      entry.is_korean_director = true;
    }
    // Dup check by IMDB ID after the fetch — catches the rare case where two
    // distinct TMDB records share the same imdb_id.
    const dupByImdb = movies.find((m) => m.imdb_id === entry.imdb_id);
    if (dupByImdb) {
      setAddStatus(
        `Already in list: ${dupByImdb.title} (imdb_id ${entry.imdb_id}). Not added.`,
        "error"
      );
      return;
    }
    // Auto-fill curated awards from the awards.yml ground truth.
    applyAwardsToEntry(entry);
    entry.date_committed = todayDateString();
    if (entry.year === null) {
      setAddStatus(
        `Added (${entry.title}) — TMDB has no release_date; please set Year manually.`,
        "success"
      );
    } else {
      setAddStatus(`Added: ${entry.title}`, "success");
    }
    movies.push(entry);
    newImdbIds.add(entry.imdb_id);
    persistNewIds();
    setDirty(true);
    persist();
    renderAll();
    tmdbUrlInput.value = "";
  } catch (err) {
    setAddStatus(`Failed: ${err.message}`, "error");
  }
});

tmdbUrlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addBtn.click();
});

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------
// Renders a CAPPED subset of the collection, not the whole thing — building a
// DOM card for all 800+ entries on every render is what made the initial load
// slow. The rendered set is, in `sortMovies` display order:
//   • every "new" entry that passes the current filter (pinned — these are
//     what the user is actively editing), plus
//   • the top RENDER_LIMIT of the filtered list.
// Everything else is reachable by searching: the search box re-renders the top
// matches (this function runs on every keystroke), so the user narrows the set
// by refining keywords rather than scrolling hundreds of cards. Safe to rebuild
// on every keystroke because card edits persist to the model immediately via
// the `change` listeners in renderCard() → onEdit().
function renderAll() {
  movieList.innerHTML = "";
  refreshNewIndicator();
  if (movies.length === 0) {
    movieList.innerHTML =
      '<li class="empty-state">No movies loaded. Use "Load YML" or paste a TMDB URL above.</li>';
    countEl.textContent = "";
    return;
  }

  const q = searchInput.value.trim().toLowerCase();
  const display = sortMovies(movies);
  const matches = (entry) => {
    const okQuery = !q || buildSearchText(entry).includes(q);
    const okNew = !newOnly || newImdbIds.has(entry.imdb_id);
    return okQuery && okNew;
  };
  const filtered = display.filter(matches);
  // Pinned new entries + the top RENDER_LIMIT of the filtered list, kept in
  // display order. New entries already passed `matches`, so during a search
  // only matching movies appear; with no query they all trivially match.
  const topN = new Set(filtered.slice(0, RENDER_LIMIT));
  const toRender = filtered.filter(
    (entry) => topN.has(entry) || newImdbIds.has(entry.imdb_id)
  );

  if (filtered.length === 0) {
    movieList.innerHTML =
      '<li class="empty-state">No matches — try a different search.</li>';
  } else {
    for (const entry of toRender) {
      movieList.appendChild(renderCard(entry));
    }
  }
  updateCount({ total: movies.length, matched: filtered.length, rendered: toRender.length, q });
}

// Count label that makes the render cap visible, so a user doesn't mistake the
// capped view for the whole collection.
function updateCount({ total, matched, rendered, q }) {
  if (q || newOnly) {
    countEl.textContent =
      rendered < matched
        ? `Showing ${rendered} of ${matched} matches — refine search to narrow`
        : `${matched} of ${total} movies`;
  } else {
    countEl.textContent =
      rendered < total
        ? `Showing top ${rendered} of ${total} movies — search to find others`
        : `${total} movies`;
  }
}

// Fill the read-only display shared by the movie card and the memo review card:
// poster, title, TMDB title, and the language + IMDB + TMDB line. Safe to call
// again to rebind a card to a different entry (e.g. after a candidate swap).
function fillCardDisplay(node, entry) {
  const posterLink = node.querySelector(".poster-link");
  const poster = node.querySelector(".poster");
  if (entry.tmdb_poster_url) {
    poster.src = entry.tmdb_poster_url;
    poster.style.background = "";
  } else {
    poster.removeAttribute("src");
    poster.alt = "(no poster)";
    poster.style.background = "#ddd";
  }
  posterLink.href =
    entry.tmdb_url ||
    entry.imdb_url ||
    (entry.imdb_id ? `https://www.imdb.com/title/${entry.imdb_id}` : "#");

  node.querySelector(".title").textContent =
    entry.tmdb_original_title || entry.title || "";
  node.querySelector(".tmdb-title").textContent = entry.tmdb_title || "";

  // language, IMDB, TMDB all on one line.
  const idsLine = node.querySelector(".ids");
  idsLine.innerHTML = "";
  if (entry.tmdb_original_language) {
    const sp = document.createElement("span");
    sp.className = "language";
    sp.textContent = `🗣 ${entry.tmdb_original_language}`;
    idsLine.appendChild(sp);
  }
  if (entry.imdb_url) {
    const a = document.createElement("a");
    a.href = entry.imdb_url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `IMDB ${entry.imdb_id}`;
    idsLine.appendChild(a);
  }
  if (entry.tmdb_url) {
    const a = document.createElement("a");
    a.href = entry.tmdb_url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "TMDB";
    idsLine.appendChild(a);
  }
}

// Wire the shared editable fields (Year, Director, Title in Korean, Rating,
// Note) to whatever entry `getEntry()` returns, calling `onChange()` after each
// edit. `getEntry` is a function (not a fixed entry) so the review card can swap
// the underlying entry when a different TMDB candidate is picked. Returns a
// `refresh()` that re-reads the inputs from the current entry.
function bindCommonFields(node, getEntry, onChange = () => {}) {
  const yearInput = node.querySelector(".year");
  yearInput.addEventListener("change", () => {
    const e = getEntry();
    const y = Number(yearInput.value);
    if (Number.isInteger(y) && y >= 1900 && y < 2100) {
      e.year = y;
      onChange();
    } else {
      yearInput.value = e.year ?? "";
    }
  });

  const dirInput = node.querySelector(".director");
  dirInput.addEventListener("change", () => {
    const e = getEntry();
    const v = dirInput.value.trim();
    e.director = v;
    e.is_korean_director = isKoreanLanguage(v);
    onChange();
  });

  const cktInput = node.querySelector(".custom-korean-title");
  cktInput.addEventListener("change", () => {
    const e = getEntry();
    const v = cktInput.value.trim();
    if (v) e.custom_korean_title = v;
    else delete e.custom_korean_title;
    onChange();
  });

  const ratingSelect = node.querySelector(".rating");
  ratingSelect.addEventListener("change", () => {
    const e = getEntry();
    delete e.masterpiece;
    delete e.my_best;
    if (ratingSelect.value === "masterpiece") e.masterpiece = true;
    else if (ratingSelect.value === "my_best") e.my_best = true;
    onChange();
  });

  const noteArea = node.querySelector(".note");
  noteArea.addEventListener("change", () => {
    const e = getEntry();
    const v = noteArea.value.trim();
    if (v) e.note = v;
    else delete e.note;
    onChange();
  });

  function refresh() {
    const e = getEntry();
    yearInput.value = e.year ?? "";
    dirInput.value = e.director ?? "";
    cktInput.value = e.custom_korean_title ?? "";
    ratingSelect.value = e.masterpiece ? "masterpiece" : e.my_best ? "my_best" : "";
    noteArea.value = e.note ?? "";
  }
  refresh();
  return { refresh };
}

// Fill the read-only awards row (full names) from entry.award_names; hide it
// when the entry has none. Shared by the movie card and the memo review card.
// Award curation is owned by data/awards.yml — the editor only displays it.
function fillAwardsDisplay(node, entry) {
  const awardsRow = node.querySelector(".awards");
  const names = entry.award_names ?? [];
  if (names.length > 0) {
    node.querySelector(".awards-list").textContent = names.join(", ");
    awardsRow.hidden = false;
  } else {
    awardsRow.hidden = true;
  }
}

function renderCard(entry) {
  const node = cardTemplate.content.firstElementChild.cloneNode(true);

  fillCardDisplay(node, entry);
  bindCommonFields(node, () => entry, onEdit);
  fillAwardsDisplay(node, entry);

  // Delete
  node.querySelector(".delete").addEventListener("click", () => {
    if (
      !confirm(`Delete "${entry.tmdb_original_title || entry.title}"? This cannot be undone in this UI.`)
    )
      return;
    const idx = movies.indexOf(entry);
    if (idx !== -1) movies.splice(idx, 1);
    if (newImdbIds.delete(entry.imdb_id)) persistNewIds();
    setDirty(true);
    persist();
    renderAll();
  });

  return node;
}

// Lowercased blob of every searchable field, used by renderAll()'s filter.
// Lives here (not on the DOM node) because filtering now happens in JS against
// the `movies` model before any card is built.
function buildSearchText(entry) {
  return [
    entry.title,
    entry.tmdb_title,
    entry.tmdb_original_title,
    entry.custom_korean_title,
    entry.director,
    entry.tmdb_director_name_1,
    entry.tmdb_director_name_2,
    entry.year,
    entry.tmdb_original_language,
    (entry.award_names || []).join(" "),
    entry.note,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function onEdit() {
  setDirty(true);
  persist();
}

// -----------------------------------------------------------------------------
// Search / filter
// -----------------------------------------------------------------------------
// Filtering is no longer a cheap class-toggle over already-rendered cards: the
// DOM only ever holds the capped subset, so both the search box and the
// All/New toggle re-run renderAll() to recompute and rebuild that subset.
searchInput.addEventListener("input", renderAll);
newOnlyToggle.addEventListener("click", () => {
  newOnly = !newOnly;
  renderAll();
});

// -----------------------------------------------------------------------------
// Download
// -----------------------------------------------------------------------------
downloadBtn.addEventListener("click", () => {
  const processed = sortMovies(canonicalizeAll(movies));
  const text = yaml.dump(processed, YAML_DUMP_OPTIONS);
  const blob = new Blob([text], { type: "application/x-yaml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "movies.yml";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  clearNewIds();
  setDirty(false);
  renderAll();
});

// -----------------------------------------------------------------------------
// Award ground-truth sync (data/awards.yml)
// -----------------------------------------------------------------------------

// Fetch a relative data file (cache-busted), trying the same origin first and
// falling back to the live site when that fails or 404s — see LIVE_DATA_ORIGIN.
// Returns the Response (which the caller still checks for `.ok`), or null when
// no source could be reached.
async function fetchDataFile(url) {
  try {
    const res = await fetch(`${url}?_=${Date.now()}`, { cache: "no-store" });
    if (res.ok) return res;
  } catch (err) {
    console.info(`Same-origin fetch of ${url} failed, trying live site:`, err.message);
  }
  // Already on the live site → no point re-fetching the same origin.
  if (location.origin === LIVE_DATA_ORIGIN) return null;
  try {
    return await fetch(`${LIVE_DATA_ORIGIN}/${url}?_=${Date.now()}`, {
      cache: "no-store",
    });
  } catch (err) {
    console.info(`Live-site fetch of ${url} failed:`, err.message);
    return null;
  }
}

// Fetch data/awards.yml. Best-effort: if it's missing or unparseable,
// awardsByImdb stays null and the sync becomes a no-op.
async function loadAwardsGroundTruth() {
  const res = await fetchDataFile(AWARDS_DATA_URL);
  if (!res || !res.ok) {
    if (res) console.info(`awards.yml skipped (HTTP ${res.status})`);
    return;
  }
  try {
    const doc = yaml.load(await res.text(), YAML_LOAD_OPTIONS);
    awardsByImdb = doc?.by_imdb ?? null;
  } catch (err) {
    console.info("awards.yml load skipped:", err.message);
  }
}

// Overwrite one entry's awards entirely from awards.yml (matched by imdb_id):
// award_names become exactly what awards.yml lists for the film, or none if it
// isn't there. Mutates `entry`; returns true if anything changed. The derived
// `awards` badge list is dropped so canonicalizeEntry re-derives it on download.
function applyAwardsToEntry(entry) {
  if (!awardsByImdb || !entry.imdb_id) return false;
  const gt = awardsByImdb[entry.imdb_id]?.award_names ?? [];
  const r = reconcileAwardNames(entry.award_names ?? [], gt);
  if (!r.changed) return false;
  if (r.award_names.length > 0) entry.award_names = r.award_names;
  else delete entry.award_names;
  delete entry.awards;
  return true;
}

// Sync every loaded movie's curated awards against awards.yml, then re-render.
// Called after the collection settles (boot auto-load, or a manual YML load).
// Deliberately does NOT set the dirty flag: the change is derived from ground
// truth, not a user edit, so it must not block the next boot's auto-load — a
// Download still captures it (canonicalize reads the reconciled award_names).
function syncLoadedAwardsThenRenderAll() {
  if (awardsByImdb) {
    let changed = 0;
    for (const m of movies) if (applyAwardsToEntry(m)) changed++;
    if (changed > 0) {
      persist();
      setAddStatus(
        `Synced awards from data/awards.yml — updated ${changed} movie(s). Download to save.`,
        "success"
      );
    }
  }
  renderAll();
}

// -----------------------------------------------------------------------------
// Auto-load the published collection from data/movies.yml
// -----------------------------------------------------------------------------
// On boot, fetch the canonical YML from the same site that's serving the page.
// Lets the deployed editor track new pushes to data/movies.yml automatically.
// Skipped if the user has unsaved local edits (dirty=true), so in-progress work
// isn't clobbered. Falls back silently when fetch isn't possible (file:// URLs
// or 404).
async function tryAutoLoadFromServer() {
  const res = await fetchDataFile(DEFAULT_DATA_URL);
  if (!res) {
    console.info("Auto-load skipped (no data source reachable)");
    return;
  }
  if (!res.ok) {
    console.info(`Auto-load skipped (HTTP ${res.status})`);
    return;
  }
  let parsed;
  try {
    parsed = yaml.load(await res.text(), YAML_LOAD_OPTIONS);
  } catch (err) {
    setAddStatus(`Auto-load failed to parse data/movies.yml: ${err.message}`, "error");
    return;
  }
  if (!Array.isArray(parsed)) return;
  if (dirty) {
    setAddStatus(
      `Server has ${parsed.length} movies in data/movies.yml — kept your unsaved local edits instead. (Click "Load YML" to override.)`,
      ""
    );
    return;
  }
  movies = parsed;
  clearNewIds();
  setDirty(false);
  persist();
  renderAll();
  setAddStatus(`Auto-loaded ${movies.length} movies from data/movies.yml`, "success");
}

// -----------------------------------------------------------------------------
// Process button gating
// -----------------------------------------------------------------------------
// The effective Gemini key is whichever is available: the one inlined at
// build time (dev builds) or, failing that, the one the user typed into the
// memo bar's key input at runtime (production builds). Returns null if
// neither is present.
function getEffectiveGeminiKey() {
  const inlined = getGeminiKey();
  if (inlined) return inlined;
  const typed = geminiKeyInput?.value.trim();
  return typed || null;
}

// Enabled iff (a) a Gemini key is available — inlined at build time OR typed
// by the user — AND (b) the memo has at least one non-whitespace character.
function refreshProcessButton() {
  const keyPresent = !!getEffectiveGeminiKey();
  const memoNonEmpty = memoInput.value.trim().length > 0;
  processMemoBtn.disabled = !(keyPresent && memoNonEmpty);
}

memoInput.addEventListener("input", refreshProcessButton);

// Persist the user-supplied key to this browser and re-gate the button as
// they type. Only wired up when the runtime key input is shown (no inlined
// key) — see the boot section at the bottom of this file.
if (geminiKeyInput) {
  geminiKeyInput.addEventListener("input", () => {
    try {
      const v = geminiKeyInput.value.trim();
      if (v) localStorage.setItem(GEMINI_KEY_STORAGE_KEY, v);
      else localStorage.removeItem(GEMINI_KEY_STORAGE_KEY);
    } catch (e) {
      console.warn("localStorage write failed:", e);
    }
    refreshProcessButton();
  });
}

// -----------------------------------------------------------------------------
// Memo bulk-import
// -----------------------------------------------------------------------------
// State for the active review session. Reset every time Process memo runs.
let activeReviews = []; // [{ rawLine, result, approved, cardEl, currentEntry, currentDetailsById }]

function setMemoStatus(msg, level = "") {
  memoStatus.textContent = msg;
  memoStatus.className = `status ${level}`;
}

function setReviewSummary(msg) {
  reviewSummary.textContent = msg;
}

function openReviewPane() {
  reviewList.innerHTML = "";
  reviewPane.hidden = false;
  memoInput.disabled = true;
  processMemoBtn.disabled = true;
}

function closeReviewPane() {
  reviewList.innerHTML = "";
  reviewPane.hidden = true;
  activeReviews = [];
  memoInput.disabled = false;
  refreshProcessButton();
}

function createPlaceholderCard(rawLine) {
  const node = reviewCardTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.status = "pending";
  node.querySelector(".review-status-badge").textContent = "⏳ processing…";
  node.querySelector(".review-raw-line").textContent = rawLine;
  return node;
}

// Build a candidate-picker <option> from a TMDB search result.
function buildCandidateOption(c) {
  const opt = document.createElement("option");
  opt.value = String(c.id);
  const year = c.release_date?.slice(0, 4) || "—";
  const dirs = (c.directors ?? []).join(", ") || "—";
  opt.textContent = `${c.title || c.original_title} (${year}) · ${dirs}`;
  return opt;
}

// Render the final state of a review card given the pipeline result.
function renderReviewCard(review) {
  const node = reviewCardTemplate.content.firstElementChild.cloneNode(true);
  const r = review.result;
  node.querySelector(".review-raw-line").textContent = review.rawLine;

  const statusBadge = node.querySelector(".review-status-badge");
  const body = node.querySelector(".review-body");
  const approveLabel = node.querySelector(".review-approve");
  const approveCb = node.querySelector(".approve-cb");

  if (r.status === "not_movie") {
    node.dataset.status = "not_movie";
    statusBadge.textContent = "↷ not a movie";
    body.hidden = true;
    approveLabel.hidden = true;
    review.approved = false;
    review.cardEl = node;
    return node;
  }
  if (r.status === "error") {
    node.dataset.status = "error";
    statusBadge.textContent = `× error`;
    body.hidden = true;
    approveLabel.hidden = true;
    const msg = document.createElement("span");
    msg.style.fontSize = "0.85rem";
    msg.style.color = "#c00";
    msg.textContent = r.error || "unknown error";
    node.querySelector(".review-card-header").appendChild(msg);
    review.approved = false;
    review.cardEl = node;
    return node;
  }
  if (r.status === "no_match") {
    node.dataset.status = "no_match";
    statusBadge.textContent = "∅ no TMDB match";
    body.hidden = true;
    approveLabel.hidden = true;
    const hint = document.createElement("span");
    hint.style.fontSize = "0.85rem";
    hint.style.color = "#555";
    hint.textContent =
      "Use the TMDB URL paste above to add this one manually.";
    node.querySelector(".review-card-header").appendChild(hint);
    review.approved = false;
    review.cardEl = node;
    return node;
  }

  // status === "ok"
  const confidence = r.matchResult?.confidence || "low";
  node.dataset.status = "ok";
  node.dataset.confidence = confidence;
  statusBadge.textContent = `✓ ${confidence}`;
  approveLabel.hidden = false;
  body.hidden = false;
  review.approved = true; // default-on for high/medium; user can untick

  // Wire approval checkbox
  approveCb.addEventListener("change", () => {
    review.approved = approveCb.checked;
  });

  // The entry the pipeline built. We may swap it if the user picks a different
  // candidate from the dropdown — kept in `review.currentEntry`.
  review.currentEntry = r.entry;
  review.currentDetailsById = new Map();
  for (const c of r.candidates ?? []) {
    if (c._details) review.currentDetailsById.set(c.id, c._details);
  }

  // Same display + editable fields as the movie card. No persistence during
  // review (the entry is committed later), so onChange is a no-op. Awards are
  // filled from the data/awards.yml ground truth so the user sees exactly what
  // will be committed.
  applyAwardsToEntry(review.currentEntry);
  fillCardDisplay(node, review.currentEntry);
  const fields = bindCommonFields(node, () => review.currentEntry);
  fillAwardsDisplay(node, review.currentEntry);

  // Candidate picker (review-only). Swapping the candidate rebuilds the entry
  // from TMDB but preserves the candidate-independent fields the user may have
  // edited (Title in Korean, Rating, Note); Year/Director come from TMDB.
  const picker = node.querySelector(".candidate-picker");
  for (const c of r.candidates ?? []) {
    picker.appendChild(buildCandidateOption(c));
  }
  picker.value = String(r.matchResult.matched_tmdb_id);
  picker.addEventListener("change", async () => {
    const newId = Number(picker.value);
    let details = review.currentDetailsById.get(newId);
    if (!details) {
      try {
        const r2 = await fetch(
          `https://api.themoviedb.org/3/movie/${newId}?api_key=${TMDB_API_KEY}&append_to_response=credits`
        );
        if (!r2.ok) throw new Error(`TMDB ${r2.status}`);
        details = await r2.json();
        review.currentDetailsById.set(newId, details);
      } catch (err) {
        setMemoStatus(`Couldn't load TMDB id ${newId}: ${err.message}`, "error");
        return;
      }
    }
    let newEntry;
    try {
      newEntry = buildMovieEntryFromTmdb(details);
    } catch (err) {
      setMemoStatus(
        `Can't use TMDB id ${newId}: ${err.message}. Pick a different candidate.`,
        "error"
      );
      return;
    }
    // Carry over the candidate-independent fields the user edited.
    const prev = review.currentEntry;
    if (prev.custom_korean_title) newEntry.custom_korean_title = prev.custom_korean_title;
    if (prev.note) newEntry.note = prev.note;
    if (prev.masterpiece) newEntry.masterpiece = true;
    else if (prev.my_best) newEntry.my_best = true;
    applyAwardsToEntry(newEntry); // awards follow the chosen candidate's imdb_id
    review.currentEntry = newEntry;
    fillCardDisplay(node, newEntry);
    fields.refresh();
    fillAwardsDisplay(node, newEntry);
  });

  // Reasoning (review-only)
  node.querySelector(".reasoning").textContent =
    r.matchResult?.reasoning || "(none)";

  review.cardEl = node;
  return node;
}

processMemoBtn.addEventListener("click", async () => {
  const key = getEffectiveGeminiKey();
  if (!key) {
    // No inlined key and the user hasn't entered one. The button should
    // already be disabled in this state — defend against a UI-state bug.
    setMemoStatus("Enter a Gemini API key to process the memo.", "error");
    return;
  }
  const lines = memoInput.value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    setMemoStatus("Memo is empty.", "error");
    return;
  }
  const koreanDirectorMap = buildKoreanDirectorMap(movies);
  openReviewPane();
  setMemoStatus("");
  setReviewSummary(`Processing ${lines.length} line(s)…`);

  activeReviews = lines.map((rawLine) => {
    const placeholder = createPlaceholderCard(rawLine);
    reviewList.appendChild(placeholder);
    return { rawLine, placeholder, approved: false, result: null, cardEl: null };
  });

  let completed = 0;
  await Promise.all(
    activeReviews.map(async (review) => {
      let result;
      try {
        result = await processMemoLine({
          rawLine: review.rawLine,
          geminiKey: key,
          tmdbApiKey: TMDB_API_KEY,
          koreanDirectorMap,
          geminiModel: geminiModelSelect?.value || DEFAULT_GEMINI_MODEL,
        });
      } catch (e) {
        result = { rawLine: review.rawLine, status: "error", error: e.message };
      }
      review.result = result;
      const cardEl = renderReviewCard(review);
      review.placeholder.replaceWith(cardEl);
      completed++;
      setReviewSummary(
        `Processed ${completed} / ${activeReviews.length}…`
      );
    })
  );

  const okCount = activeReviews.filter((r) => r.result?.status === "ok").length;
  const skipped = activeReviews.length - okCount;
  setReviewSummary(
    `Done. ${okCount} ready for review, ${skipped} skipped or unmatched.`
  );
});

commitAllBtn.addEventListener("click", () => {
  let added = 0;
  let dupCount = 0;
  for (const r of activeReviews) {
    if (!r.approved) continue;
    if (r.result?.status !== "ok" || !r.currentEntry) continue;
    const entry = r.currentEntry;
    const dup =
      movies.some((m) => m.imdb_id === entry.imdb_id) ||
      movies.some((m) => m.tmdb_url === entry.tmdb_url);
    if (dup) {
      dupCount++;
      continue;
    }
    // Auto-fill curated awards from the awards.yml ground truth.
    applyAwardsToEntry(entry);
    entry.date_committed = todayDateString();
    movies.push(entry);
    newImdbIds.add(entry.imdb_id);
    added++;
  }
  persistNewIds();
  if (added > 0) {
    setDirty(true);
    persist();
  }
  closeReviewPane();
  memoInput.value = "";
  renderAll();
  const dupMsg = dupCount ? `, skipped ${dupCount} duplicate(s)` : "";
  setMemoStatus(`Committed ${added} new movie(s)${dupMsg}.`, added > 0 ? "success" : "");
});

discardAllBtn.addEventListener("click", () => {
  closeReviewPane();
  setMemoStatus("Discarded.", "");
});

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
window.addEventListener("beforeunload", (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

restoreNewIds();
if (restoreFromLocalStorage()) {
  // Re-hydrate the dirty flag so we know whether localStorage has unsaved edits.
  setDirty(restoreDirty());
  setAddStatus(`Restored ${movies.length} movies from this browser's storage.`, "success");
}
renderAll();
// The memo bulk-import section is always visible (the markup has no `hidden`
// attribute on it). When a Gemini key was inlined at build time (dev builds
// via `npm run build:dev`), the import works out of the box and the runtime
// key input stays hidden. Otherwise (production builds via `npm run build`),
// we surface the key input so the user can supply their own key; the Process
// memo button stays disabled until they do. A previously entered key is
// restored from this browser.
if (geminiKeyInput && !getGeminiKey()) {
  geminiKeyInput.hidden = false;
  try {
    const savedKey = localStorage.getItem(GEMINI_KEY_STORAGE_KEY);
    if (savedKey) geminiKeyInput.value = savedKey;
  } catch (e) {
    console.warn("localStorage restore failed:", e);
  }
}
// Restore a previously chosen model tier (debug picker, see
// GEMINI_MODEL_STORAGE_KEY above). Falls back to the <select>'s own default
// (DEFAULT_GEMINI_MODEL) if nothing was saved or the option no longer exists.
if (geminiModelSelect) {
  try {
    const savedModel = localStorage.getItem(GEMINI_MODEL_STORAGE_KEY);
    if (savedModel) geminiModelSelect.value = savedModel;
  } catch (e) {
    console.warn("localStorage restore failed:", e);
  }
  geminiModelSelect.addEventListener("change", () => {
    try {
      localStorage.setItem(GEMINI_MODEL_STORAGE_KEY, geminiModelSelect.value);
    } catch (e) {
      console.warn("localStorage write failed:", e);
    }
  });
}
refreshProcessButton();

// Load the award ground truth, refresh the published movie list, then overwrite
// every movie's curated awards from data/awards.yml.
(async () => {
  await loadAwardsGroundTruth();
  await tryAutoLoadFromServer();
  syncLoadedAwardsThenRenderAll();
})();
