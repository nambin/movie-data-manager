## Movie Data Manager

This project manages movie data to empower https://nambin.github.io/movies.html. This uses two TMDB APIs, [Search API](https://developer.themoviedb.org/reference/search-movie) and [Movie Details API](https://developer.themoviedb.org/reference/movie-details).

Search API examples
- [Oppenheimer 2023](https://api.themoviedb.org/3/search/movie?query=Oppenheimer&primary_release_year=2023&api_key=f6d7fb04f4d4d6b07d2d750811e73a4c)
- [Parasite 2019](https://api.themoviedb.org/3/search/movie?query=Parasite&primary_release_year=2019&api_key=f6d7fb04f4d4d6b07d2d750811e73a4c)
- [기생충 2019](https://api.themoviedb.org/3/search/movie?query=기생충&primary_release_year=2019&api_key=f6d7fb04f4d4d6b07d2d750811e73a4c)


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
pip install pyyaml
pip install thefuzz python-Levenshtein
python data-manager.py

### Remaining TODOs
# Show external ratings (e.g. rotten tomatos).
# Lazy loading for quick scroll on mobile.
# Low res homepage beatles SVG.
# Award cross-validation: CSS vs TMDB vs other sources.
# Technical 1-pager by Gemini.