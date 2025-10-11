import csv
import yaml
import requests
from datetime import datetime
import time
import os
import sys

# Log levels
DEBUG = 10
INFO = 20
WARNING = 30
ERROR = 40

LEVEL_NAMES = {
    DEBUG: "DEBUG",
    INFO: "INFO",
    WARNING: "WARNING",
    ERROR: "ERROR",
}

# Global variable to control the amount of logging output.
# csv_file_path = "input-movies.csv"
# yml_file_path = "output-movies.yml"
# csv_file_path = "golden-input-movies.csv"
# yml_file_path = "golden-output-movies.yml"
csv_file_path = "golden-251011-input-movies.csv"
yml_file_path = "golden-251011-output-movies.yml"

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
# Example - https://api.themoviedb.org/3/search/movie?query=Oppenheimer&api_key=f6d7fb04f4d4d6b07d2d750811e73a4c
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
# Example - https://api.themoviedb.org/3/movie/872585?api_key=f6d7fb04f4d4d6b07d2d750811e73a4c&append_to_response=credits
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
    search_results = call_tmdb_search_api(title, year)
    for year_offset in [-1, 1]:
        time.sleep(SLEEP_TIME)
        tmp = call_tmdb_search_api(title, year + year_offset)
        if tmp:
            search_results.extend(tmp)
    return search_results


def get_tmdb_search_entry(title, year):
    search_results = get_tmdb_search_results(title, year)
    if len(search_results) == 0:
        return None

    if len(search_results) == 1:
        return search_results[0]

    log(
        DEBUG,
        f"  -> {len(search_results)} candidates found in TMDB: '{title}' ({year})",
    )
    # TODO: Better matching logic may be needed such as director name filtering.
    sorted_candidates = sorted(
        search_results,
        key=lambda movie: movie.get("popularity", 0),
        reverse=True,
    )
    return sorted_candidates[0]


# Returns (IMDB ID, TMDB poster path) or (None, None) if not found.
def get_tmdb_movie_entry(title, year):
    tmdb_search_entry = get_tmdb_search_entry(title, year)
    if not tmdb_search_entry:
        log(ERROR, f"  -> Not found in TMDB: {title} ({year})")
        return None

    tmdb_id = tmdb_search_entry.get("id")
    if not tmdb_id:
        log(ERROR, f"  -> No TMDB ID: '{title}' ({year})")
        return None

    time.sleep(SLEEP_TIME)
    tmdb_movie_entry = call_tmdb_movie_api(tmdb_id)
    if not tmdb_movie_entry:
        log(ERROR, f"  -> No TMDB movie entry for {tmdb_id}: '{title}' ({year})")
        return None
    return tmdb_movie_entry


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

        tmdb_movie_entry = get_tmdb_movie_entry(title, year)
        if not tmdb_movie_entry:
            continue

        num_movies_outputs += 1

        imdb_id = tmdb_movie_entry.get("imdb_id")
        if imdb_id:
            num_imdb_id += 1
        else:
            log(WARNING, f"  -> No IMDB ID in TMDB: '{title}' ({year})")

        tmdb_poster_path = tmdb_movie_entry.get("poster_path")
        if tmdb_poster_path:
            num_tmdb_poster += 1
        else:
            log(WARNING, f"  -> No TMDB poster path: '{title}' ({year})")

        movie_entry = {
            "title": title,
            "year": year,
            "director": director,
            "country": country,
            "imdb_id": imdb_id,
            "imdb_url": f"https://www.imdb.com/title/{imdb_id}/" if imdb_id else None,
            "tmdb_url": f"https://www.themoviedb.org/movie/{tmdb_movie_entry.get('id')}",
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

log(INFO, f"'{yml_file_path}' is successfully generated.")
log(
    INFO,
    f"Processed {num_movies_inputs} movies. Outputs {num_movies_outputs} movies with {num_imdb_id} IMDB IDs and {num_tmdb_poster} TMDB poster paths.",
)
