## Movie Data Manager

A Python utility to enrich a personal movie list with authoritative data from The Movie Database (TMDb). This script is the data engine for my personal [movie log website](https://nambin.github.io/movies.html).

It takes a simple, personally curated CSV file of movies and reconciles it with TMDb records to retrieve metadata like IMDb pages, poster URLs, and original titles, outputting a YAML file ready for a static site generator like Jekyll. It uses two TMDB APIs, [Search API](https://developer.themoviedb.org/reference/search-movie) and [Movie Details API](https://developer.themoviedb.org/reference/movie-details). 

Search API examples
- [Oppenheimer 2023](https://api.themoviedb.org/3/search/movie?api_key=f6d7fb04f4d4d6b07d2d750811e73a4c&query=Oppenheimer&primary_release_year=2023)
- [Parasite 2019](https://api.themoviedb.org/3/search/movie?api_key=f6d7fb04f4d4d6b07d2d750811e73a4c&query=Parasite&primary_release_year=2019)
- [기생충 2019](https://api.themoviedb.org/3/search/movie?api_key=f6d7fb04f4d4d6b07d2d750811e73a4c&query=기생충&primary_release_year=2019)


Movie API examples
- [Parasite](https://api.themoviedb.org/3/movie/496243?api_key=f6d7fb04f4d4d6b07d2d750811e73a4c&append_to_response=credits)
- [Oppenheimer](https://api.themoviedb.org/3/movie/872585?api_key=f6d7fb04f4d4d6b07d2d750811e73a4c&append_to_response=credits)
- [Shoplifters](https://api.themoviedb.org/3/movie/505192?api_key=f6d7fb04f4d4d6b07d2d750811e73a4c&append_to_response=credits)
- [The Witches](https://api.themoviedb.org/3/movie/531219?api_key=f6d7fb04f4d4d6b07d2d750811e73a4c&append_to_response=credits)

Parasite
- https://www.themoviedb.org/movie/496243
- https://image.tmdb.org/t/p/w200/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg

### How to Run

To execute the script, run the following command in your terminal:

```bash
pip install pycountry
pip install pyyaml
pip install thefuzz python-Levenshtein
python data-manager.py
```