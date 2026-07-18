package com.nambin.moviecuration.core

import kotlinx.serialization.Serializable

/**
 * Two intentional behaviors worth knowing (carried over verbatim):
 *   1. `country` is NOT emitted for newly added entries.
 *   2. `title` is composed from TMDB's `title` and `original_title`:
 *        - if either is missing, use whichever is present
 *        - if both are present and identical, use one (no duplication)
 *        - if both differ, combine as "<tmdb title> (<original title>)"
 */

@Serializable
data class TmdbCrewMember(
    val job: String? = null,
    val name: String? = null,
)

@Serializable
data class TmdbCredits(
    val crew: List<TmdbCrewMember> = emptyList(),
)

/**
 * Raw JSON shape of TMDB's *Details* endpoint (`GET /movie/{id}?append_to_response=credits`),
 * one field per response key — hence snake_case, matching the wire format
 * kotlinx.serialization maps onto directly (no `@SerialName` overrides).
 * This is the *only* place `imdb_id` and `credits` (director names) come
 * from; fetching it costs one API call per movie, unlike the cheap
 * multi-result Search endpoint below.
 */
@Serializable
data class TmdbMovieDetails(
    val id: Int,
    val title: String? = null,
    val original_title: String? = null,
    val original_language: String? = null,
    val release_date: String? = null,
    val poster_path: String? = null,
    val imdb_id: String? = null,
    val popularity: Double? = null,
    val credits: TmdbCredits? = null,
)

/**
 * One row in the candidate list: a cheap, always-present summary (from the
 * Search endpoint, fetched once for all candidates) plus an optional,
 * best-effort enrichment (from the per-candidate Details endpoint above,
 * which the memo pipeline tolerates failing for any individual candidate).
 *
 * [title]/[originalTitle]/[releaseDate]/[popularity] intentionally duplicate
 * fields also present inside [details] — they are NOT redundant. They come
 * from Search and are always populated, whereas [details] is `null` whenever
 * that specific candidate's Details fetch failed (or hasn't run yet). Code
 * that must work for every candidate regardless of enrichment success (the
 * candidate-picker dropdown, Call B's prompt) reads these top-level fields;
 * only [directors] and the has_imdb signal require reaching into [details].
 */
data class TmdbCandidate(
    val id: Int,
    val title: String?,
    val originalTitle: String?,
    val releaseDate: String?,
    val popularity: Double?,
    val directors: List<String> = emptyList(),
    val details: TmdbMovieDetails? = null,
)

/** TMDB Movie Details JSON -> movie entry. Keys are in the canonical YAML field order. */
fun buildMovieEntryFromTmdb(tmdb: TmdbMovieDetails): MovieEntry {
    if (tmdb.imdb_id.isNullOrEmpty()) {
        throw IllegalArgumentException(
            "buildMovieEntryFromTmdb: TMDB response has no imdb_id (TMDB id=${tmdb.id})"
        )
    }

    val directors = (tmdb.credits?.crew ?: emptyList()).filter { it.job == "Director" }
    val tmdbDirectorName1 = directors.getOrNull(0)?.name
    val tmdbDirectorName2 = directors.getOrNull(1)?.name
    // The user-typed `director` defaults to TMDB's English/romanized `name`.
    // For Korean directors the user (or the Korean-director map) fixes this up.
    val director = tmdbDirectorName1 ?: ""

    val releaseYear = tmdb.release_date?.take(4)
    val year = releaseYear?.toIntOrNull()

    val tmdbTitle = tmdb.title
    val tmdbOriginalTitle = tmdb.original_title

    val title: String? = when {
        tmdbTitle.isNullOrEmpty() -> tmdbOriginalTitle
        tmdbOriginalTitle.isNullOrEmpty() || tmdbTitle == tmdbOriginalTitle -> tmdbTitle
        else -> "$tmdbTitle ($tmdbOriginalTitle)"
    }

    return movieEntryOf(
        "title" to title,
        "year" to year,
        "director" to director,
        "is_korean_director" to isKoreanLanguage(director),
        "imdb_id" to tmdb.imdb_id,
        "imdb_url" to "https://www.imdb.com/title/${tmdb.imdb_id}",
        "tmdb_url" to "https://www.themoviedb.org/movie/${tmdb.id}",
        "tmdb_title" to if (tmdbTitle != tmdbOriginalTitle) tmdbTitle else null,
        "tmdb_original_title" to tmdbOriginalTitle,
        "tmdb_original_language" to getLanguageName(tmdb.original_language),
        "tmdb_director_name_1" to tmdbDirectorName1,
        "tmdb_director_name_2" to tmdbDirectorName2,
        "tmdb_num_directors" to directors.size,
        "tmdb_poster_url" to if (!tmdb.poster_path.isNullOrEmpty()) {
            "https://image.tmdb.org/t/p/w200${tmdb.poster_path}"
        } else {
            null
        },
    )
}
