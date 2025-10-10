import csv
import yaml
import requests
import time
import os

TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "f6d7fb04f4d4d6b07d2d750811e73a4c")
csv_file_path = "input-movies.csv"
yml_file_path = "output-movies.yml"

movies_data = []

# Returns IMDB ID and poster path from TMDB.
def get_movie_details(title, year, director):
    # https://api.themoviedb.org/3/search/movie?query=Oppenheimer&api_key=f6d7fb04f4d4d6b07d2d750811e73a4c
    search_url = f"https://api.themoviedb.org/3/search/movie?api_key={TMDB_API_KEY}&query={title}"
    try:
        search_response = requests.get(search_url)
        search_response.raise_for_status()  # Raise for errors
        search_results = search_response.json().get("results", [])

        if not search_results:
            print(f"  -> Not found in TMDB: {title} ({year})")
            return None, None

        chosen_movie = None
        if len(search_results) == 1:
            chosen_movie = search_results[0]
        else:
            # If multiple candidates, filter by year.
            candidates = [
                movie
                for movie in search_results
                if movie.get("release_date", "").startswith(str(year))
                or movie.get("release_date", "").startswith(str(year - 1))
                or movie.get("release_date", "").startswith(str(year + 1))
                or movie.get("release_date", "").startswith(str(year - 2))
                or movie.get("release_date", "").startswith(str(year + 2))
            ]

            if len(candidates) == 1:
                chosen_movie = candidates[0]
            else:
                sorted_candidates = sorted(
                    candidates,
                    key=lambda movie: movie.get("popularity", 0),
                    reverse=True,
                )
                chosen_movie = sorted_candidates[0]
                # print(
                #     f"  -> {len(candidates)} candidates found in TMDB: '{title}' ({year})"
                # )
                # tmdb_id = chosen_movie.get("id")
                # print (f"  -> https://api.themoviedb.org/3/movie/{tmdb_id}?api_key={TMDB_API_KEY}")

        # Getting more detailed information including IMDB ID.
        tmdb_id = chosen_movie.get("id")
        if not tmdb_id:
            print(f"  -> Should not reach here - No TMDB ID: '{title}' ({year})")
            return None, None

        poster_path = chosen_movie.get("poster_path")

        # https://api.themoviedb.org/3/movie/872585?api_key=f6d7fb04f4d4d6b07d2d750811e73a4c&append_to_response=credits
        # Monster
        #   https://api.themoviedb.org/3/movie/1203484?api_key=f6d7fb04f4d4d6b07d2d750811e73a4c&append_to_response=credits
        #   https://api.themoviedb.org/3/movie/1050035?api_key=f6d7fb04f4d4d6b07d2d750811e73a4c&append_to_response=credits
        details_url = (
            f"https://api.themoviedb.org/3/movie/{tmdb_id}?api_key={TMDB_API_KEY}"
        )
        details_response = requests.get(details_url)
        details_response.raise_for_status()
        imdb_id = details_response.json().get("imdb_id")

        return imdb_id, poster_path

    except requests.exceptions.RequestException as e:
        print(f"  -> API request failure: {e}")
        return None, None


num_movies = 0
num_imdb_id = 0
num_tmdb_poster = 0
with open(csv_file_path, mode="r", encoding="utf-8") as csv_file:
    csv_reader = csv.reader(csv_file)

    for row in csv_reader:
        director = row[0]
        year = int(row[1])
        title = row[2]
        country = row[3]
        imdb_id, tmdb_poster_path = get_movie_details(title, year, director)

        num_movies += 1
        if imdb_id:
            num_imdb_id += 1
        if tmdb_poster_path:
            num_tmdb_poster += 1

        movie_entry = {
            "title": title,
            "year": year,
            "director": director,
            "country": country,
            "imdb_id": imdb_id,
            "tmdb_poster_path": tmdb_poster_path,
        }
        movies_data.append(movie_entry)
        if num_movies % 10 == 0:
            print(
                f"Processed {num_movies} movies with {num_imdb_id} IMDB IDs and {num_tmdb_poster} TMDB poster paths."
            )

with open(yml_file_path, mode="w", encoding="utf-8") as yml_file:
    yaml.dump(movies_data, yml_file, allow_unicode=True, sort_keys=False)

print(
    f"'{yml_file_path}' is successfully generated for {num_movies} movies with {num_imdb_id} IMDB IDs and {num_tmdb_poster} TMDB poster paths."
)
