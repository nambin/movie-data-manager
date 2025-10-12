import csv
import math
import yaml
import requests
from datetime import datetime
import time
import os
import sys
import title_parser
from thefuzz import fuzz

# Log levels
DEBUG = 10
DEBUG_2 = 15
INFO = 20
WARNING = 30
ERROR = 40

LEVEL_NAMES = {
    DEBUG: "DEBUG",
    DEBUG_2: "DEBUG_2",
    INFO: "INFO",
    WARNING: "WARNING",
    ERROR: "ERROR",
}

# Global variable to control the amount of logging output.
LOG_LEVEL = INFO
# See stats in https://www.themoviedb.org/settings/api/stats
# 0.01s => 1.9s / movie
# 0.10s => 2.1s / movie
# 0.50s => 3.3s / movie
SLEEP_TIME = 0.1
TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "f6d7fb04f4d4d6b07d2d750811e73a4c")


def log(level, message):
    if level < LOG_LEVEL:
        return

    timestamp = datetime.now().strftime("%H:%M:%S")
    log_message = f"[{timestamp}] [{LEVEL_NAMES.get(level, 'UNKNOWN')}] {message}"
    if level == ERROR:
        print(log_message, file=sys.stderr)
    else:
        print(log_message)


# https://developer.themoviedb.org/reference/search-movie
# https://developer.themoviedb.org/docs/search-and-query-for-details
#
# Returns a list of search results from TMDB. Can be empty.
# Returns [] if API request fails.
def call_tmdb_search_api(title, year=None):
    search_url = f"https://api.themoviedb.org/3/search/movie?api_key={TMDB_API_KEY}&query={title}"
    if year:
        search_url += f"&primary_release_year={year}"

    log(DEBUG, f"call_tmdb_search_api => {search_url}")
    try:
        response = requests.get(search_url)
        response.raise_for_status()  # Raise for errors
        return response.json().get("results", [])
    except requests.exceptions.RequestException as e:
        log(WARNING, f"  -> API request failure: {e}")
        return []


# https://developer.themoviedb.org/reference/movie-details
#
# Returns detailed movie information in JSON from TMDB.
# Returns None if API request fails.
def call_tmdb_movie_api(tmdb_id):
    movie_url = f"https://api.themoviedb.org/3/movie/{tmdb_id}?api_key={TMDB_API_KEY}"
    log(DEBUG, f"call_tmdb_movie_api => {movie_url}")
    try:
        response = requests.get(movie_url)
        response.raise_for_status()  # Raise for errors
        return response.json()
    except requests.exceptions.RequestException as e:
        log(WARNING, f"  -> API request failure: {e}")
        return None


def get_tmdb_search_results(title, year):
    time.sleep(SLEEP_TIME)
    search_results = call_tmdb_search_api(title, year)

    for year_offset in [1, -1]:
        time.sleep(SLEEP_TIME)
        tmp = call_tmdb_search_api(title, year + year_offset)
        if tmp:
            search_results.extend(tmp)

    return search_results


def get_tmdb_search_entry(movie_title_set: title_parser.MovieTitleSet, year):
    def _try_tmdb_search_api():
        search_results = get_tmdb_search_results(movie_title_set.main_title.text, year)
        if len(search_results) > 0:
            return search_results

        if not movie_title_set.supplemental_titles:
            return []

        search_results = get_tmdb_search_results(
            movie_title_set.supplemental_titles[0].text, year
        )
        return search_results

    debug_msg = f"{movie_title_set.raw_title} ({year})"
    search_results = _try_tmdb_search_api()

    if len(search_results) == 0:
        return None

    if len(search_results) == 1:
        return search_results[0]

    log(
        DEBUG,
        f"  -> {len(search_results)} candidates found in TMDB: {debug_msg})",
    )

    # Title & Year matching score calculation with popularity.
    def _movie_matching_score(tmdb_search_entry):
        tmdb_original_lang = tmdb_search_entry.get("original_language", "").lower()
        tmdb_original_title = tmdb_search_entry.get("original_title", "").lower()
        tmdb_title = tmdb_search_entry.get("title", "").lower()
        main_title = movie_title_set.main_title.text.lower()

        title_score = max(
            fuzz.ratio(tmdb_original_title, main_title),
            fuzz.ratio(tmdb_title, main_title),
        )
        if title_score < 99.9:
            for sup_title in movie_title_set.supplemental_titles:
                sup_title_text = sup_title.text.lower()
                title_score = max(
                    title_score,
                    fuzz.ratio(tmdb_original_title, sup_title_text),
                    fuzz.ratio(tmdb_title, sup_title_text),
                )
                if title_score > 99.9:
                    break
        if title_score < 85:
            title_score = 0

        year_score = 0
        release_date = tmdb_search_entry.get("release_date", "")
        if release_date:
            try:
                movie_year = int(release_date.split("-")[0])
                year_difference = abs(movie_year - year)
                year_score = max(0, 100 - (year_difference * 35))
            except (ValueError, IndexError):
                year_score = 0

        popularity = tmdb_search_entry.get("popularity", 0)
        # math.log(popularity + 1) helps normalize the score.
        # The divisor (e.g., 8.5) is a scaling factor. log(5000) is ~8.5.
        # This scaling brings most popularity scores into a reasonable 0-100 range.
        normalized_popularity_score = min(100, (math.log(popularity + 1) / 8.5) * 100)

        if title_score > 0:
            log(
                DEBUG_2,
                f"  ({tmdb_original_title}, {tmdb_title}) : title_score={title_score}, year_score={year_score}, popularity={popularity} => normalized_popularity_score={normalized_popularity_score}",
            )
        # TODO: For popular titles such as "The Witches" "Macbeth" and "Brooklyn", we may need more sophisticated scoring with other metadata such as director name.
        return (
            (title_score * 0.70)
            + (year_score * 0.25)
            + (normalized_popularity_score * 0.05)
        )

    log(DEBUG_2, f"Scoring started: {debug_msg}")
    sorted_candidates = sorted(search_results, key=_movie_matching_score, reverse=True)
    return sorted_candidates[0]


# Returns (IMDB ID, TMDB poster path) or (None, None) if not found.
def get_tmdb_movie_entry(
    movie_title_set: title_parser.MovieTitleSet, year, director
) -> (str, str):
    _HARDEDCODED_TMDB_IDS = {
        ("이준익", "님은 먼 곳에"): 41538,
        ("Robert Zemeckis", "The Witches"): 531219,
        ("Justin Kurzel", "Macbeth"): 225728,
        ("John Crowley", "Brooklyn"): 167073,
    }
    raw_title = movie_title_set.raw_title
    debug_msg = f"{raw_title} ({year})"

    tmdb_id = None
    if (director, raw_title) in _HARDEDCODED_TMDB_IDS:
        tmdb_id = _HARDEDCODED_TMDB_IDS[(director, raw_title)]
        log(INFO, f"  -> Using hardcoded TMDB ID {tmdb_id}: {debug_msg}")
    else:
        tmdb_search_entry = get_tmdb_search_entry(movie_title_set, year)
        if not tmdb_search_entry:
            log(ERROR, f"  -> Skip: Not found in TMDB: {debug_msg})")
            return None

        tmdb_id = tmdb_search_entry.get("id")
        if not tmdb_id:
            log(ERROR, f"  -> Skip: No TMDB ID: {debug_msg}")
            return None

    time.sleep(SLEEP_TIME)
    tmdb_movie_entry = call_tmdb_movie_api(tmdb_id)
    if not tmdb_movie_entry:
        log(ERROR, f"  -> Skip: No TMDB movie entry for {tmdb_id}: {debug_msg}")
        return None
    return tmdb_movie_entry


def generate_yaml(csv_file_path, yml_file_path):
    movies_output = []
    num_movies_inputs = 0
    num_movies_outputs = 0
    num_imdb_id = 0
    num_tmdb_poster = 0

    with open(csv_file_path, mode="r", encoding="utf-8") as csv_file:
        log(INFO, f"'{csv_file_path}' is successfully opened.")
        csv_reader = csv.reader(csv_file)

        for row in csv_reader:
            num_movies_inputs += 1

            director = row[0]
            year = int(row[1])
            title = row[2]
            country = row[3]
            imdb_id = None
            tmdb_poster_path = None

            movie_title_set = title_parser.MovieTitleSet(title)
            tmdb_movie_entry = get_tmdb_movie_entry(movie_title_set, year, director)
            if not tmdb_movie_entry:
                continue

            imdb_id = tmdb_movie_entry.get("imdb_id")
            if imdb_id:
                num_imdb_id += 1
            else:
                log(WARNING, f"  -> Skip: No IMDB ID in TMDB: '{title}' ({year})")
                continue

            tmdb_poster_path = tmdb_movie_entry.get("poster_path")
            if tmdb_poster_path:
                num_tmdb_poster += 1
            else:
                log(WARNING, f"  -> No TMDB poster path: '{title}' ({year})")

            tmdb_original_title = tmdb_movie_entry.get("original_title")
            tmdb_title = tmdb_movie_entry.get("title")

            num_movies_outputs += 1
            movie_entry = {
                "title": title,
                "year": year,
                "director": director,
                "country": country,
                "imdb_id": imdb_id,
                "imdb_url": (
                    f"https://www.imdb.com/title/{imdb_id}/" if imdb_id else None
                ),
                "tmdb_url": f"https://www.themoviedb.org/movie/{tmdb_movie_entry.get('id')}",
                "tmdb_title": tmdb_title if tmdb_title != tmdb_original_title else None,
                "tmdb_original_title": tmdb_original_title,
                "tmdb_poster_path": tmdb_poster_path,
                "tmdb_poster_url": (
                    f"https://image.tmdb.org/t/p/w200{tmdb_poster_path}"
                    if tmdb_poster_path
                    else None
                ),
            }
            movies_output.append(movie_entry)
            if num_movies_inputs % 10 == 0:
                log(
                    INFO,
                    f"Processed {num_movies_inputs} movies. Outputs {num_movies_outputs} movies with {num_imdb_id} IMDB IDs and {num_tmdb_poster} TMDB poster paths.",
                )

    sorted_movies_output = sorted(
        movies_output,
        key=lambda movie: (movie.get("year", 0), movie.get("director", "")),
        reverse=True,
    )
    with open(yml_file_path, mode="w", encoding="utf-8") as yml_file:
        yaml.dump(sorted_movies_output, yml_file, allow_unicode=True, sort_keys=False)

    log(
        INFO,
        f"'{yml_file_path}' is successfully generated. Processed {num_movies_inputs} movies. Outputs {num_movies_outputs} movies with {num_imdb_id} IMDB IDs and {num_tmdb_poster} TMDB poster paths.",
    )


generate_yaml("input-movies.csv", "output-movies.yml")
# generate_yaml("golden-251011-input-movies.csv", "golden-251011-output-movies.yml")
# generate_yaml("golden-input-movies.csv", "golden-output-movies.yml")
