import yaml from "js-yaml";
import { YAML_LOAD_OPTIONS } from "./utils.js";

const REPO_RAW_URL =
  "https://raw.githubusercontent.com/nambin/nambin.github.io/main/data/movies.yml";
const SAME_ORIGIN_URL = "/data/movies.yml";

// 1x1 transparent GIF — placeholder `src` until includes/movies.js's
// initLazyImagesLoader() swaps in the real poster from `data-src`.
const LAZY_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABBwABAQAIBAABBAQAOw==";

const BADGE_ICON_BY_AWARD = {
  oscar: { icon: "logo-oscar.svg", alt: "Oscar" },
  cannes: { icon: "logo-cannes.svg", alt: "Cannes" },
  berlin: { icon: "logo-berlin.svg", alt: "Berlin" },
  venice: { icon: "logo-venice.svg", alt: "Venice" },
  blue_dragon: { icon: "logo-blue_dragon.svg", alt: "Blue Dragon (청룡영화제)" },
};

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.text();
}

async function fetchMoviesYamlText() {
  try {
    return await fetchText(REPO_RAW_URL);
  } catch (err) {
    console.warn(
      `Fetching ${REPO_RAW_URL} failed (${err.message}); falling back to ${SAME_ORIGIN_URL}`
    );
    return await fetchText(SAME_ORIGIN_URL);
  }
}

function buildSearchText(m) {
  return [
    m.tmdb_original_title || m.title,
    m.tmdb_title,
    m.custom_korean_title,
    m.tmdb_director_name_1,
    m.tmdb_director_name_2,
    m.director,
    m.year,
    m.tmdb_original_language,
    Array.isArray(m.awards) ? m.awards.join(" ") : null,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .trim();
}

function directorFilterLink(name) {
  const a = document.createElement("a");
  a.href = `?director=${encodeURIComponent(name)}`;
  a.className = "director-filter-link";
  a.textContent = name;
  return a;
}

function badgeLink(href, title, icon, alt) {
  const a = document.createElement("a");
  a.href = href;
  a.className = "badge-link";
  if (title) a.title = title;
  const img = document.createElement("img");
  img.src = `/assets/${icon}`;
  img.alt = alt;
  img.className = "badge-icon";
  a.appendChild(img);
  return a;
}

function buildMovieCard(m) {
  const li = document.createElement("li");
  li.className = "movie-card";

  const useTmdbNameForDirectorAttr =
    !!m.tmdb_director_name_1 && m.is_korean_director === false;
  li.setAttribute(
    "data-director",
    useTmdbNameForDirectorAttr ? m.tmdb_director_name_1 : m.director
  );
  if (m.tmdb_director_name_2) {
    li.setAttribute("data-director-2", m.tmdb_director_name_2);
  }
  if (m.masterpiece) li.setAttribute("data-masterpiece", "true");
  if (m.my_best) li.setAttribute("data-my-best", "true");
  if (Array.isArray(m.awards) && m.awards.length > 0) {
    li.setAttribute("data-awards", m.awards.join(" "));
  }
  if (m.date_committed) li.setAttribute("data-date-committed", m.date_committed);
  li.setAttribute("data-search-text", buildSearchText(m));

  const posterSource = m.tmdb_poster_url || `/assets/movie_posters/${m.imdb_id}.jpg`;
  const movieUrl = m.tmdb_poster_url ? m.tmdb_url : m.imdb_url;

  const posterLink = document.createElement("a");
  posterLink.href = movieUrl || "#";
  posterLink.target = "_blank";
  posterLink.rel = "noopener noreferrer";
  const img = document.createElement("img");
  img.dataset.src = posterSource;
  img.src = LAZY_PLACEHOLDER;
  img.alt = `${m.tmdb_original_title || ""} Poster`;
  img.className = "movie-poster lazy";
  img.width = 120;
  img.height = 180;
  posterLink.appendChild(img);
  li.appendChild(posterLink);

  const info = document.createElement("div");
  info.className = "movie-info";

  const h2 = document.createElement("h2");
  const titleLink = document.createElement("a");
  titleLink.href = `https://www.imdb.com/title/${m.imdb_id}/`;
  titleLink.target = "_blank";
  titleLink.textContent = m.tmdb_original_title || m.title;
  h2.appendChild(titleLink);
  info.appendChild(h2);

  if (m.custom_korean_title && m.tmdb_title) {
    const p = document.createElement("p");
    const i = document.createElement("i");
    i.textContent = `${m.tmdb_title} (${m.custom_korean_title})`;
    p.appendChild(i);
    info.appendChild(p);
  } else if (m.tmdb_title) {
    const p = document.createElement("p");
    const i = document.createElement("i");
    i.textContent = m.tmdb_title;
    p.appendChild(i);
    info.appendChild(p);
  }

  const directorP = document.createElement("p");
  const showTmdbNameAsPrimary =
    (!!m.tmdb_director_name_1 && m.is_korean_director === false) ||
    !!m.tmdb_director_name_2;
  if (showTmdbNameAsPrimary) {
    directorP.appendChild(directorFilterLink(m.tmdb_director_name_1));
  } else {
    directorP.appendChild(directorFilterLink(m.director));
    if (m.is_korean_director && m.tmdb_director_name_1) {
      const span = document.createElement("span");
      span.textContent = ` (${m.tmdb_director_name_1})`;
      directorP.appendChild(span);
    }
  }
  if (m.tmdb_director_name_2) {
    directorP.appendChild(document.createTextNode(", "));
    directorP.appendChild(directorFilterLink(m.tmdb_director_name_2));
  }
  if (m.tmdb_num_directors && m.tmdb_num_directors > 2) {
    const span = document.createElement("span");
    span.textContent = `, +${m.tmdb_num_directors - 2} more`;
    directorP.appendChild(span);
  }
  info.appendChild(directorP);

  const yearP = document.createElement("p");
  let yearText = String(m.year ?? "");
  if (m.tmdb_original_language) yearText += ` · ${m.tmdb_original_language}`;
  yearP.textContent = yearText;
  info.appendChild(yearP);

  const badges = document.createElement("div");
  badges.className = "movie-badges";
  if (m.masterpiece) {
    badges.appendChild(
      badgeLink("?masterpiece=true", "Masterpiece", "logo-star.svg", "Masterpiece")
    );
  }
  if (m.my_best) {
    badges.appendChild(
      badgeLink("?my_best=true", "Personal Best", "logo-bulb.svg", "Personal Best")
    );
  }
  for (const award of m.awards || []) {
    const badge = BADGE_ICON_BY_AWARD[award];
    if (!badge) continue;
    badges.appendChild(badgeLink(`?award=${award}`, null, badge.icon, badge.alt));
  }
  info.appendChild(badges);

  li.appendChild(info);
  return li;
}

async function main() {
  const list = document.querySelector(".movie-list");
  if (!list) return;

  // The footer starts hidden (see movies.html) to avoid a flash near the
  // top of the still-short page before the list is populated. Reveal it
  // here once the initial load has settled — success or failure — so it
  // always lands already in its correct final position. A try/finally
  // (rather than revealing at each individual exit point) guarantees this
  // runs exactly once regardless of which branch below returns or throws.
  try {
    let movies;
    try {
      const text = await fetchMoviesYamlText();
      movies = yaml.load(text, YAML_LOAD_OPTIONS);
      if (!Array.isArray(movies)) throw new Error("movies.yml did not parse to a list");
    } catch (err) {
      console.error("Failed to load movies:", err);
      const li = document.createElement("li");
      li.className = "empty-state";
      li.textContent = `Failed to load movies: ${err.message}`;
      list.innerHTML = "";
      list.appendChild(li);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const movie of movies) frag.appendChild(buildMovieCard(movie));
    list.innerHTML = "";
    list.appendChild(frag);

    window.initMovieFilter?.();
    window.initLazyImagesLoader?.();
  } finally {
    const footer = document.querySelector("footer");
    if (footer) footer.style.visibility = "visible";
  }
}

main();
