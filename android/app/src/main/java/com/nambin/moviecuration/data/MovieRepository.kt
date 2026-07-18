package com.nambin.moviecuration.data

import com.nambin.moviecuration.core.MovieEntry
import com.nambin.moviecuration.core.buildKoreanDirectorMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

private const val DEFAULT_MOVIES_URL = "https://nambin.github.io/data/movies.yml"
private const val DEFAULT_AWARDS_URL = "https://nambin.github.io/data/awards.yml"

/**
 * Holds the in-memory movie collection for a Curation session. Boot fetch is
 * blocking and uncached — see prompt-android-app.md's Boot behavior: every
 * cold start re-fetches both files fresh so Add/Commit never act on stale
 * data. Not thread-safe beyond what a single ViewModel/coroutine scope
 * calling it sequentially already guarantees.
 *
 * [moviesUrl]/[awardsUrl] default to the production data files; overridable
 * so tests can point them at a local MockWebServer instead.
 */
class MovieRepository(
    private val client: OkHttpClient,
    private val moviesUrl: String = DEFAULT_MOVIES_URL,
    private val awardsUrl: String = DEFAULT_AWARDS_URL,
) {

    private var _movies: MutableList<MovieEntry> = mutableListOf()
    val movies: List<MovieEntry> get() = _movies

    /** imdb_id -> award_names, from data/awards.yml's by_imdb map. */
    var awardsByImdb: Map<String, List<String>> = emptyMap()
        private set

    /** Romanized director name -> Korean form, built from the loaded collection. */
    var koreanDirectorMap: Map<String, String> = emptyMap()
        private set

    private suspend fun fetchText(url: String): String = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("$url?_=${System.currentTimeMillis()}").get().build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("$url -> HTTP ${response.code}")
            response.body?.string() ?: throw IOException("$url -> empty body")
        }
    }

    /**
     * Fetch and parse both data files fresh. Throws on any failure — see Boot
     * behavior. The two files are unrelated, so they're fetched concurrently
     * rather than one after the other.
     */
    suspend fun loadFromServer() {
        val (moviesText, awardsText) = coroutineScope {
            val moviesDeferred = async { fetchText(moviesUrl) }
            val awardsDeferred = async { fetchText(awardsUrl) }
            moviesDeferred.await() to awardsDeferred.await()
        }

        _movies = YamlCodec.loadMovies(moviesText)

        val awardsDoc = YamlCodec.loadAwardsDocument(awardsText)
        @Suppress("UNCHECKED_CAST")
        val byImdb = awardsDoc["by_imdb"] as? Map<String, Any?> ?: emptyMap()
        awardsByImdb = byImdb.mapValues { (_, v) ->
            @Suppress("UNCHECKED_CAST")
            val entry = v as? Map<String, Any?> ?: emptyMap()
            (entry["award_names"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
        }

        rebuildKoreanDirectorMap()
    }

    fun rebuildKoreanDirectorMap() {
        koreanDirectorMap = buildKoreanDirectorMap(movies)
    }

    /** Inserts [entry] and keeps [koreanDirectorMap] in sync — callers never need a separate rebuild call. */
    fun add(entry: MovieEntry) {
        _movies.add(entry)
        rebuildKoreanDirectorMap()
    }

    /** Removes [entry] and keeps [koreanDirectorMap] in sync — callers never need a separate rebuild call. */
    fun remove(entry: MovieEntry) {
        _movies.remove(entry)
        rebuildKoreanDirectorMap()
    }

    fun findByImdbId(imdbId: String?): MovieEntry? {
        if (imdbId.isNullOrEmpty()) return null
        return movies.find { it["imdb_id"] == imdbId }
    }

    fun findByTmdbUrl(tmdbUrl: String?): MovieEntry? {
        if (tmdbUrl.isNullOrEmpty()) return null
        return movies.find { it["tmdb_url"] == tmdbUrl }
    }

    /** Duplicate check by imdb_id first, then tmdb_url — mirrors the web app's add-by-URL check. */
    fun findDuplicate(entry: MovieEntry): MovieEntry? =
        findByImdbId(entry["imdb_id"] as? String) ?: findByTmdbUrl(entry["tmdb_url"] as? String)

    /** Search across exactly title/director/year/language, per the app's search spec. */
    fun search(query: String, limit: Int = 20): List<MovieEntry> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return emptyList()
        return movies.asSequence().filter { matchesSearch(it, q) }.take(limit).toList()
    }

    private fun matchesSearch(m: MovieEntry, q: String): Boolean {
        val stringFields = listOf(
            m["title"], m["tmdb_title"], m["tmdb_original_title"], m["custom_korean_title"],
            m["director"], m["tmdb_director_name_1"], m["tmdb_director_name_2"],
            m["tmdb_original_language"],
        )
        if (stringFields.any { (it as? String)?.lowercase()?.contains(q) == true }) return true
        return m["year"]?.toString()?.contains(q) == true
    }
}
