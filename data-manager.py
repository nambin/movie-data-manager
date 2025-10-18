import csv
import math
import yaml
import requests
from datetime import datetime
import time
import os
import sys
import pycountry
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


def get_language_name(code):
    """
    Convert ISO 639-1 language code to full language name.
    """
    try:
        language = pycountry.languages.get(alpha_2=code)
        return language.name if language else code
    except Exception:
        assert False, f"Invalid language code: {code}"


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
        log(WARNING, f"API request failure: {e}")
        return []


# https://developer.themoviedb.org/reference/movie-details
#
# Returns detailed movie information in JSON from TMDB.
# Returns None if API request fails.
def call_tmdb_movie_details_api(tmdb_id):
    movie_url = f"https://api.themoviedb.org/3/movie/{tmdb_id}?api_key={TMDB_API_KEY}&append_to_response=credits"
    log(DEBUG, f"call_tmdb_movie_details_api => {movie_url}")
    try:
        response = requests.get(movie_url)
        response.raise_for_status()  # Raise for errors
        return response.json()
    except requests.exceptions.RequestException as e:
        log(WARNING, f"API request failure: {e}")
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
def get_tmdb_movie_entry(movie_title_set: title_parser.MovieTitleSet, year, director):
    _HARDCODED_TMDB_IDS = {
        ("이준익", "님은 먼 곳에"): 41538,
        ("Robert Zemeckis", "The Witches"): 531219,
        ("Justin Kurzel", "Macbeth"): 225728,
        ("John Crowley", "Brooklyn"): 167073,
        ("Alejandro González Iñárritu", "Birdman"): 194662,
        ("John Crowley", "Brooklyn"): 167073,
        ("David Fincher", "Seven"): 807,
    }
    raw_title = movie_title_set.raw_title
    debug_msg = f"{raw_title} ({year})"

    tmdb_id = None
    if (director, raw_title) in _HARDCODED_TMDB_IDS:
        tmdb_id = _HARDCODED_TMDB_IDS[(director, raw_title)]
        log(INFO, f"Using hardcoded TMDB ID {tmdb_id}: {debug_msg}")
    else:
        tmdb_search_entry = get_tmdb_search_entry(movie_title_set, year)
        if not tmdb_search_entry:
            log(DEBUG, f"Not found in TMDB: {debug_msg})")
            return None

        tmdb_id = tmdb_search_entry.get("id")
        assert tmdb_id, f"TMDB ID not found in search result: {debug_msg}"

    time.sleep(SLEEP_TIME)
    tmdb_movie_entry = call_tmdb_movie_details_api(tmdb_id)
    if not tmdb_movie_entry:
        log(WARNING, f"No TMDB movie entry for {tmdb_id}: {debug_msg}")
        return None
    return tmdb_movie_entry


# Returns a pair of set and dict.
# The 1st set consists of (director, year, title) tuples from the given CSV file. These keys are used to process the CSV file incrementally.
# The key of the dict is (director, year, title).
# The value of the dict is a movie entry dictionary parsed from the given YAML file. These entries are supposed to be merged into the output YAML file.
def generate_diff(csv_file_path, yml_file_path):
    key_set_csv = set()
    with open(csv_file_path, mode="r", encoding="utf-8") as csv_file:
        csv_reader = csv.reader(csv_file)
        for row in csv_reader:
            director = row[0].strip()
            year = int(row[1])
            title = row[2].strip()
            key_set_csv.add((director, year, title))

    key_set_yml = set()
    value_survive_dict_yml = dict()
    with open(yml_file_path, "r", encoding="utf-8") as yml_file:
        movies = yaml.safe_load(yml_file)

        for movie in movies:
            director = movie.get("director")
            year = movie.get("year")
            title = movie.get("title")
            key = (director, year, title)

            key_set_yml.add(key)
            if key in key_set_csv:
                value_survive_dict_yml[key] = movie

    key_diff_set_csv = key_set_csv - key_set_yml

    log(
        INFO,
        f"Parsed {len(key_set_csv)} movies from '{csv_file_path}' and {len(key_set_yml)} movies from '{yml_file_path}'.",
    )
    return key_diff_set_csv, value_survive_dict_yml


def generate_yaml(csv_file_path, yml_file_path, is_incremental=False):
    assert os.path.exists(csv_file_path), f"File not found: {csv_file_path}"

    key_diff_set_csv = None
    value_survive_dict_yml = None
    if is_incremental:
        assert os.path.exists(yml_file_path), f"File not found: {yml_file_path}"
        key_diff_set_csv, value_survive_dict_yml = generate_diff(
            csv_file_path, yml_file_path
        )
        log(
            INFO,
            f"Incremental mode: {len(key_diff_set_csv)} movies to be processed, {len(value_survive_dict_yml)} movies to be survived from '{yml_file_path}'",
        )

    movies_output_dict = dict()
    num_movies_inputs = 0
    num_imdb_id = 0
    num_tmdb_poster = 0

    with open(csv_file_path, mode="r", encoding="utf-8") as csv_file:
        log(INFO, f"'{csv_file_path}' is successfully opened.")
        csv_reader = csv.reader(csv_file)

        for row in csv_reader:
            director = row[0].strip()
            year = int(row[1])
            title = row[2].strip()
            country = row[3].strip()
            debug_msg = f"{title} ({year})"

            if is_incremental and (director, year, title) not in key_diff_set_csv:
                log(
                    DEBUG,
                    f"Incremental mode: Already exists in '{yml_file_path}': {debug_msg}",
                )
                continue

            _HARDCODED_IMDB_IDS = {
                ("Victor Fleming", "The Wizard of Oz at Sphere"): "tt38084416",
            }

            num_movies_inputs += 1

            movie_title_set = title_parser.MovieTitleSet(title)
            tmdb_movie_entry = get_tmdb_movie_entry(movie_title_set, year, director)
            if not tmdb_movie_entry and (director, title) not in _HARDCODED_IMDB_IDS:
                log(WARNING, f"Skip: Not found in TMDB: {debug_msg})")
                continue

            imdb_id = None
            if (director, title) in _HARDCODED_IMDB_IDS:
                imdb_id = _HARDCODED_IMDB_IDS[(director, title)]
                log(INFO, f"Using hardcoded IMDB ID {imdb_id}: {debug_msg}")
            else:
                assert tmdb_movie_entry
                imdb_id = tmdb_movie_entry.get("imdb_id")

            if imdb_id:
                num_imdb_id += 1
            else:
                log(WARNING, f"Skip: No IMDB ID found: {debug_msg}")
                continue

            tmdb_poster_path = (
                tmdb_movie_entry.get("poster_path") if tmdb_movie_entry else None
            )
            if tmdb_poster_path:
                num_tmdb_poster += 1
            else:
                log(WARNING, f"No TMDB poster path: {debug_msg}")

            def _get_tmdb_directors(tmdb_movie_entry):
                tmdb_crew_list = tmdb_movie_entry.get("credits", {}).get("crew", [])
                if not tmdb_crew_list:
                    return []

                return [
                    crew for crew in tmdb_crew_list if crew.get("job") == "Director"
                ]

            tmdb_directors = (
                _get_tmdb_directors(tmdb_movie_entry) if tmdb_movie_entry else []
            )
            if tmdb_directors:
                director_name_score = max(
                    fuzz.ratio(
                        tmdb_directors[0].get("name", "").lower(), director.lower()
                    ),
                    fuzz.ratio(
                        tmdb_directors[0].get("original_name", "").lower(),
                        director.lower(),
                    ),
                )
                if director_name_score < 85 and (
                    tmdb_directors[0].get("name").lower() not in director.lower()
                ):
                    log(
                        WARNING,
                        f"Director name mismatch: {debug_msg} {director_name_score}, '{director}' vs '{tmdb_directors[0].get('name')}' '{tmdb_directors[0].get('original_name')}'",
                    )

            tmdb_original_lang = (
                tmdb_movie_entry.get("original_language") if tmdb_movie_entry else None
            )
            tmdb_original_title = (
                tmdb_movie_entry.get("original_title") if tmdb_movie_entry else None
            )
            tmdb_title = tmdb_movie_entry.get("title") if tmdb_movie_entry else None
            # tmdb_year = (
            #     int(tmdb_movie_entry.get("release_date", "0000-00-00").split("-")[0])
            #     if tmdb_movie_entry and tmdb_movie_entry.get("release_date")
            #     else year
            # )
            # if tmdb_year != year:
            #     log(INFO, f"Year differences - {debug_msg}: {year} vs {tmdb_year}")

            # Prepare movie entry in YAML.
            movie_entry = {
                "title": title,
                "year": year,
                "director": director,
                "country": country,
                "is_korean_director": any("\uac00" <= char <= "\ud7a3" for char in director),
                "imdb_id": imdb_id,
                "imdb_url": f"https://www.imdb.com/title/{imdb_id}",
                "tmdb_url": (
                    f"https://www.themoviedb.org/movie/{tmdb_movie_entry.get('id')}"
                    if tmdb_movie_entry
                    else None
                ),
                "tmdb_title": tmdb_title if tmdb_title != tmdb_original_title else None,
                "tmdb_original_title": tmdb_original_title,
                "tmdb_original_language": (
                    get_language_name(tmdb_original_lang)
                    if tmdb_original_lang
                    else None
                ),
                "tmdb_director_name_1": (
                    tmdb_directors[0].get("name") if len(tmdb_directors) > 0 else None
                ),
                "tmdb_director_name_2": (
                    tmdb_directors[1].get("name") if len(tmdb_directors) > 1 else None
                ),
                "tmdb_num_directors": len(tmdb_directors),
                "tmdb_poster_url": (
                    f"https://image.tmdb.org/t/p/w200{tmdb_poster_path}"
                    if tmdb_poster_path
                    else None
                ),
            }

            # Populate Korean title if the original language is not Korean.
            if tmdb_original_lang != "ko":
                custom_korean_title = movie_title_set.get_title_by_locale("Korean")
                if imdb_id == "tt0442268":
                    custom_korean_title = "지금, 만나러 갑니다"
                if custom_korean_title:
                    movie_entry["custom_korean_title"] = custom_korean_title

            movies_output_dict[(director, year, title)] = movie_entry
            if num_movies_inputs % 50 == 0:
                log(
                    INFO,
                    f"Processed {num_movies_inputs} movies. Outputs {len(movies_output_dict)} movies with {num_imdb_id} IMDB IDs and {num_tmdb_poster} TMDB poster paths.",
                )

    num_movies_identified = len(movies_output_dict)
    if is_incremental:
        log(
            INFO,
            f"'Incremental mode: Processed {num_movies_inputs} movies. Identified {num_movies_identified} with {num_imdb_id} IMDB IDs and {num_tmdb_poster} TMDB poster paths.",
        )

    if is_incremental and value_survive_dict_yml is not None:
        with open(
            os.path.basename(yml_file_path) + "_incremental.yml",
            mode="w",
            encoding="utf-8",
        ) as yml_file:
            yaml.dump(movies_output_dict, yml_file, allow_unicode=True, sort_keys=False)

        for key, value in value_survive_dict_yml.items():
            assert (
                key not in movies_output_dict
            ), f"Duplicate movie entry found during incremental update: {key}"
            movies_output_dict[key] = value

    # Update metadata such as "my_best" and "awards" from the CSV file.
    # This is done after all TMDB API calls to update the metadata for all movies including those survived from the previous YAML file.
    with open(csv_file_path, mode="r", encoding="utf-8") as csv_file:
        log(INFO, f"'{csv_file_path}' is successfully opened for metadata population.")
        csv_reader = csv.reader(csv_file)

        for row in csv_reader:
            director = row[0].strip()
            year = int(row[1])
            title = row[2].strip()
            country = row[3].strip()
            debug_msg = f"{title} ({year})"

            movie_entry = movies_output_dict.get((director, year, title))
            if not movie_entry:
                continue

            movie_entry.pop("my_best", None)
            movie_entry.pop("awards", None)

            # Populate my preferences.
            if row[4] == "Masterpiece":
                movie_entry["masterpiece"] = True
            if row[4] == "Special":
                movie_entry["my_best"] = True

            # Populate award information.
            _FILM_AWARDS = {
                "청룡영화제 최우수 작품상": "blue_dragon",
                "Oscar Best Picture": "oscar",
                "Oscar Best International Film": "oscar",
                "Cannes Palme d'Or": "cannes",
                "Venice Leone d’oro": "venice",
                "Berlin Goldener Bär": "berlin",
            }
            _HARDCODED_AWARDS = {
                ("봉준호", "기생충 (Parasite)"): ["blue_dragon", "oscar", "cannes"],
            }
            if (director, title) in _HARDCODED_AWARDS:
                movie_entry["awards"] = _HARDCODED_AWARDS[(director, title)]
                continue

            if row[5] in _FILM_AWARDS or row[6] in _FILM_AWARDS:
                awards = []
                for award in _FILM_AWARDS.keys():
                    if award == row[5] or award == row[6]:
                        if award not in awards:
                            awards.append(_FILM_AWARDS[award])
                if awards:
                    movie_entry["awards"] = awards

    sorted_movies_output_list = sorted(
        list(movies_output_dict.values()),
        key=lambda movie: (
            movie.get("year", 0),
            movie.get("masterpiece", False),
            movie.get("my_best", False),
            len(movie.get("awards", [])),
            movie.get("director", ""),
        ),
        reverse=True,
    )
    with open(yml_file_path, mode="w", encoding="utf-8") as yml_file:
        yaml.dump(
            sorted_movies_output_list, yml_file, allow_unicode=True, sort_keys=False
        )

    log(
        INFO,
        f"'{yml_file_path}' is successfully generated. Processed {num_movies_inputs} movies. Identified {num_movies_identified}. Outputs {len(movies_output_dict)} movies with {num_imdb_id} IMDB IDs and {num_tmdb_poster} TMDB poster paths.",
    )


generate_yaml(
    "golden-input-movies.csv", "golden-output-movies.yml", is_incremental=False
)
generate_yaml("input-movies.csv", "output-movies.yml", is_incremental=False)
