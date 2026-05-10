// UI glue + entry point. The pure data-correctness logic lives in the
// sibling lib/* modules (tested). This file handles DOM, file I/O, TMDB
// fetching, and localStorage persistence.

import yaml from "js-yaml";

import {
  buildMovieEntryFromTmdb,
  extractTmdbIdFromUrl,
} from "./tmdb_utils.js";
import { canonicalizeAll } from "./canonicalize.js";
import {
  sortMovies,
  YAML_DUMP_OPTIONS,
  AWARD_NAMES,
  deriveAwardBadges,
  isKoreanDirector,
} from "./utils.js";

// TMDB API key — same as data-manager.py:35; already public in this repo.
const TMDB_API_KEY = "f6d7fb04f4d4d6b07d2d750811e73a4c";

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

// Default location of the published collection. Resolves relative to the
// page URL, so it works both in local dev (python -m http.server in this
// repo serves data/movies.yml at /data/movies.yml) and on GitHub Pages
// (nambin.github.io/movies_editor.html → /data/movies.yml).
const DEFAULT_DATA_URL = "data/movies.yml";

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
    const parsed = yaml.load(text);
    if (!Array.isArray(parsed)) {
      throw new Error("YML root is not a list of movies");
    }
    movies = parsed;
    clearNewIds();
    setDirty(false);
    persist();
    renderAll();
    setAddStatus(`Loaded ${movies.length} movies from ${f.name}`, "success");
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
function renderAll() {
  movieList.innerHTML = "";
  refreshNewIndicator();
  if (movies.length === 0) {
    movieList.innerHTML =
      '<li class="empty-state">No movies loaded. Use "Load YML" or paste a TMDB URL above.</li>';
    countEl.textContent = "";
    return;
  }
  // Render in current display order — sorted on download but not necessarily
  // here, so the user sees the file as-loaded. Still apply the sort visually
  // so newly-added entries appear in the right spot.
  const display = sortMovies(movies);
  for (const m of display) {
    const node = renderCard(m);
    movieList.appendChild(node);
  }
  applyFilter(searchInput.value);
}

function renderCard(entry) {
  const node = cardTemplate.content.firstElementChild.cloneNode(true);

  // Poster + link
  const posterLink = node.querySelector(".poster-link");
  const poster = node.querySelector(".poster");
  if (entry.tmdb_poster_url) {
    poster.src = entry.tmdb_poster_url;
  } else {
    poster.alt = "(no poster)";
    poster.style.background = "#ddd";
  }
  posterLink.href =
    entry.tmdb_url || entry.imdb_url || `https://www.imdb.com/title/${entry.imdb_id}`;

  // Read-only display
  node.querySelector(".title").textContent = entry.tmdb_original_title || entry.title || "";
  const tmdbTitleP = node.querySelector(".tmdb-title");
  tmdbTitleP.textContent = entry.tmdb_title || "";

  node.querySelector(".language").textContent = entry.tmdb_original_language
    ? `🗣 ${entry.tmdb_original_language}`
    : "";
  const korFlag = node.querySelector(".kor-flag");
  korFlag.textContent = entry.is_korean_director ? "🇰🇷 Korean dir" : "";

  // IDs / external links
  const idsLine = node.querySelector(".ids");
  idsLine.innerHTML = "";
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
  if (entry.country) {
    const sp = document.createElement("span");
    sp.textContent = `country: ${entry.country}`;
    idsLine.appendChild(sp);
  }

  // Editable inputs
  const yearInput = node.querySelector(".year");
  yearInput.value = entry.year ?? "";
  yearInput.addEventListener("change", () => {
    const y = Number(yearInput.value);
    if (Number.isInteger(y) && y >= 1900 && y < 2100) {
      entry.year = y;
      onEdit();
    } else {
      yearInput.value = entry.year ?? "";
    }
  });

  const dirInput = node.querySelector(".director");
  dirInput.value = entry.director ?? "";
  dirInput.addEventListener("change", () => {
    const v = dirInput.value.trim();
    entry.director = v;
    entry.is_korean_director = isKoreanDirector(v);
    korFlag.textContent = entry.is_korean_director ? "🇰🇷 Korean dir" : "";
    onEdit();
  });

  const cktInput = node.querySelector(".custom-korean-title");
  cktInput.value = entry.custom_korean_title ?? "";
  cktInput.addEventListener("change", () => {
    const v = cktInput.value.trim();
    if (v) entry.custom_korean_title = v;
    else delete entry.custom_korean_title;
    onEdit();
  });

  const ratingSelect = node.querySelector(".rating");
  if (entry.masterpiece) ratingSelect.value = "masterpiece";
  else if (entry.my_best) ratingSelect.value = "my_best";
  else ratingSelect.value = "";
  ratingSelect.addEventListener("change", () => {
    delete entry.masterpiece;
    delete entry.my_best;
    if (ratingSelect.value === "masterpiece") entry.masterpiece = true;
    else if (ratingSelect.value === "my_best") entry.my_best = true;
    onEdit();
  });

  // Award checkboxes
  const awardsBox = node.querySelector(".awards-checkboxes");
  const currentAwardNames = new Set(entry.award_names ?? []);
  for (const name of AWARD_NAMES) {
    const lbl = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = name;
    cb.checked = currentAwardNames.has(name);
    cb.addEventListener("change", () => {
      // Recompute the entry's award_names list IN THE ORDER defined by AWARD_NAMES
      // (so toggling a box keeps a stable on-disk order).
      const checked = [...awardsBox.querySelectorAll('input[type="checkbox"]')]
        .filter((c) => c.checked)
        .map((c) => c.value);
      if (checked.length > 0) {
        entry.award_names = checked;
        const badges = deriveAwardBadges(checked);
        if (badges.length > 0) entry.awards = badges;
        else delete entry.awards;
      } else {
        delete entry.award_names;
        delete entry.awards;
      }
      onEdit();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(` ${name}`));
    awardsBox.appendChild(lbl);
  }

  const noteArea = node.querySelector(".note");
  noteArea.value = entry.note ?? "";
  noteArea.addEventListener("change", () => {
    const v = noteArea.value.trim();
    if (v) entry.note = v;
    else delete entry.note;
    onEdit();
  });

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

  // Mark new entries so the "Only newly added" filter can pick them out.
  node.dataset.isNew = newImdbIds.has(entry.imdb_id) ? "1" : "0";

  // Build a search-text blob on the card for fast filtering.
  node.dataset.searchText = [
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

  return node;
}

function onEdit() {
  setDirty(true);
  persist();
}

// -----------------------------------------------------------------------------
// Search / filter
// -----------------------------------------------------------------------------
function applyFilter(query) {
  const q = (query ?? "").trim().toLowerCase();
  let visible = 0;
  for (const li of movieList.querySelectorAll(".movie-card")) {
    const matchesQuery = !q || li.dataset.searchText.includes(q);
    const matchesNew = !newOnly || li.dataset.isNew === "1";
    const matches = matchesQuery && matchesNew;
    li.classList.toggle("hidden", !matches);
    if (matches) visible++;
  }
  if (q || newOnly) {
    countEl.textContent = `${visible} of ${movies.length} movies`;
  } else {
    countEl.textContent = `${movies.length} movies`;
  }
}

searchInput.addEventListener("input", () => applyFilter(searchInput.value));
newOnlyToggle.addEventListener("click", () => {
  newOnly = !newOnly;
  refreshNewIndicator();
  applyFilter(searchInput.value);
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
// Auto-load the published collection from data/movies.yml
// -----------------------------------------------------------------------------
// On boot, fetch the canonical YML from the same site that's serving the page.
// Lets the deployed editor track new pushes to data/movies.yml automatically.
// Skipped if the user has unsaved local edits (dirty=true), so in-progress work
// isn't clobbered. Falls back silently when fetch isn't possible (file:// URLs
// or 404).
async function tryAutoLoadFromServer() {
  let res;
  try {
    res = await fetch(`${DEFAULT_DATA_URL}?_=${Date.now()}`, {
      cache: "no-store",
    });
  } catch (err) {
    console.info("Auto-load skipped (fetch failed):", err.message);
    return;
  }
  if (!res.ok) {
    console.info(`Auto-load skipped (HTTP ${res.status})`);
    return;
  }
  let parsed;
  try {
    parsed = yaml.load(await res.text());
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
tryAutoLoadFromServer();
