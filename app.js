// UI glue. The pure data-correctness logic lives in lib/* (tested).
// This file handles DOM, file I/O, TMDB fetching, and localStorage persistence.

import yaml from "js-yaml";

import {
  buildMovieEntryFromTmdb,
  extractTmdbIdFromUrl,
} from "./lib/tmdb_utils.js";
import { canonicalizeAll } from "./lib/canonicalize.js";
import {
  sortMovies,
  YAML_DUMP_OPTIONS,
  AWARD_NAMES,
  deriveAwardBadges,
  isKoreanDirector,
} from "./lib/utils.js";

// TMDB API key — same as data-manager.py:35; already public in this repo.
const TMDB_API_KEY = "f6d7fb04f4d4d6b07d2d750811e73a4c";

const LOCAL_STORAGE_KEY = "movie-collection-v1";

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
let movies = []; // array of entry objects
let dirty = false;

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
  setAddStatus("Fetching from TMDB…");
  try {
    const tmdb = await fetchTmdbMovie(id);
    const entry = buildMovieEntryFromTmdb(tmdb);
    if (entry.year === null) {
      setAddStatus(
        `Added (${entry.title}) — TMDB has no release_date; please set Year manually.`,
        "success"
      );
    } else {
      const dup = movies.find((m) => m.imdb_id === entry.imdb_id);
      if (dup) {
        const proceed = confirm(
          `A movie with imdb_id ${entry.imdb_id} (${dup.title}) is already in the list.\n\nAdd anyway?`
        );
        if (!proceed) {
          setAddStatus("Add cancelled.", "");
          return;
        }
      }
      setAddStatus(`Added: ${entry.title}`, "success");
    }
    movies.push(entry);
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
  countEl.textContent = `${movies.length} movies`;
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
    setDirty(true);
    persist();
    renderAll();
  });

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
    const matches = !q || li.dataset.searchText.includes(q);
    li.classList.toggle("hidden", !matches);
    if (matches) visible++;
  }
  if (q) {
    countEl.textContent = `${visible} of ${movies.length} movies`;
  } else {
    countEl.textContent = `${movies.length} movies`;
  }
}

searchInput.addEventListener("input", () => applyFilter(searchInput.value));

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
  a.download = "prod-output-movies.yml";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setDirty(false);
});

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
window.addEventListener("beforeunload", (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

if (restoreFromLocalStorage()) {
  setAddStatus(`Restored ${movies.length} movies from this browser's storage.`, "success");
}
renderAll();
