package com.nambin.moviecuration.core

import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

/**
 * Kotlin port of movie-data-manager/lib/memo_pipeline.js — one per-line
 * pipeline: Call A (parse) -> TMDB search -> Call B (match) -> entry build.
 * Korean director resolution falls back to the romanized->Korean map only.
 */

private const val TMDB_URL_BASE = "https://api.themoviedb.org/3"

// Upper bound on TMDB candidates handed to Call B — mirrors CANDIDATE_SEARCH_LIMIT
// in lib/memo_pipeline.js.
private const val CANDIDATE_SEARCH_LIMIT = 20

private val tmdbJson = Json { ignoreUnknownKeys = true }

/**
 * Raw JSON shape of one entry in TMDB's *Search* endpoint response
 * (`GET /search/movie`, see [tmdbSearch] below) — hence snake_case fields,
 * matching the wire format directly. Deliberately thin: Search doesn't
 * return `imdb_id` or credits/directors, only [TmdbMovieDetails] (fetched
 * separately, per candidate, in [enrichCandidatesForMatch]) has those.
 */
@Serializable
private data class TmdbSearchResultRaw(
    val id: Int,
    val title: String? = null,
    val original_title: String? = null,
    val release_date: String? = null,
    val popularity: Double? = null,
)

@Serializable
private data class TmdbSearchResponse(val results: List<TmdbSearchResultRaw> = emptyList())

/** Sealed result of processing one memo line, mirroring the JS status strings. */
sealed class MemoPipelineResult {
    abstract val rawLine: String

    data class NotMovie(override val rawLine: String, val parseResult: CallAResult) : MemoPipelineResult()

    /** Truly nothing to offer: no TMDB search results, or none with a confirmed imdb_id. */
    data class NoMatch(
        override val rawLine: String,
        val parseResult: CallAResult? = null,
    ) : MemoPipelineResult()

    data class Error(override val rawLine: String, val error: String) : MemoPipelineResult()

    /**
     * At least one imdb_id-confirmed candidate exists, each already carrying
     * a ready-to-show entry (buildMovieEntryFromTmdb + Korean-director
     * resolution applied to every one up front — pure, already-fetched-data
     * transforms, no extra network cost). `selectedCandidateId` defaults to
     * Call B's pick when it's actually one of [candidates] (else the top/
     * most-popular one) — but that's only ever a suggested starting point,
     * never special: the user is always free to swap to any other
     * candidate's already-built entry via the picker. No distinction between
     * "Call B was confident" and "Call B declined" — both just mean "here
     * are the candidates, here's which one to show first."
     */
    data class Ok(
        override val rawLine: String,
        val parseResult: CallAResult,
        val candidates: List<TmdbCandidate>,
        val entriesByCandidateId: Map<Int, MovieEntry>,
        val matchResult: CallBResult,
        val selectedCandidateId: Int,
    ) : MemoPipelineResult()
}

/**
 * Search TMDB for candidates matching Call A's parsed query.
 *   - Uses primary_release_year (not `year`) as the TMDB filter.
 *   - When a year is given, runs three searches in parallel — primary year,
 *     year+1, year-1 — to absorb TMDB release-date discrepancies. Results
 *     are merged in input order (primary year first) and deduped by id.
 *   - A transient error on one offset doesn't poison the others; throws only
 *     if ALL searches fail.
 */
private suspend fun tmdbSearch(parsed: CallAResult, tmdbApiKey: String, client: OkHttpClient): List<TmdbSearchResultRaw> {
    val q = parsed.title?.trim()
    if (q.isNullOrEmpty()) return emptyList()

    fun buildUrl(year: Int?): String {
        val builder = "$TMDB_URL_BASE/search/movie".toHttpUrl().newBuilder()
            .addQueryParameter("api_key", tmdbApiKey)
            .addQueryParameter("query", q)
        if (year != null) builder.addQueryParameter("primary_release_year", year.toString())
        return builder.build().toString()
    }

    val years: List<Int?> = parsed.year?.let { listOf(it, it + 1, it - 1) } ?: listOf(null)

    val results: List<Result<List<TmdbSearchResultRaw>>> = coroutineScope {
        years.map { year ->
            async(Dispatchers.IO) {
                runCatching {
                    val request = Request.Builder().url(buildUrl(year)).get().build()
                    client.newCall(request).execute().use { response ->
                        if (!response.isSuccessful) {
                            throw IOException("TMDB search ${response.code}: ${response.message}")
                        }
                        val body = response.body?.string().orEmpty()
                        tmdbJson.decodeFromString(TmdbSearchResponse.serializer(), body).results
                    }
                }
            }
        }.awaitAll()
    }

    if (results.all { it.isFailure }) {
        throw results.first().exceptionOrNull() ?: IOException("TMDB search failed")
    }

    val seen = HashSet<Int>()
    val merged = mutableListOf<TmdbSearchResultRaw>()
    for (r in results) {
        val list = r.getOrNull() ?: continue
        for (item in list) {
            if (seen.add(item.id)) merged.add(item)
        }
    }
    return merged.take(CANDIDATE_SEARCH_LIMIT)
}

suspend fun fetchTmdbDetails(tmdbId: Int, tmdbApiKey: String, client: OkHttpClient): TmdbMovieDetails {
    val url = "$TMDB_URL_BASE/movie/$tmdbId".toHttpUrl().newBuilder()
        .addQueryParameter("api_key", tmdbApiKey)
        .addQueryParameter("append_to_response", "credits")
        .build()
    return withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url).get().build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("TMDB details ${response.code}: ${response.message}")
            val body = response.body?.string().orEmpty()
            tmdbJson.decodeFromString(TmdbMovieDetails.serializer(), body)
        }
    }
}

/**
 * Fetch /movie/{id} details for every candidate (search results carry no
 * credits/imdb_id). A candidate whose details fetch fails passes through
 * with directors=[] and details=null, and is then excluded by the
 * `pickerCandidates` filter below — this app requires a positively
 * confirmed imdb_id for anything offered to Call B, the candidate picker,
 * or a saved entry (buildMovieEntryFromTmdb requires one), never giving an
 * unconfirmed candidate the benefit of the doubt. Bounded by
 * CANDIDATE_SEARCH_LIMIT.
 */
private suspend fun enrichCandidatesForMatch(
    raw: List<TmdbSearchResultRaw>,
    tmdbApiKey: String,
    client: OkHttpClient,
): List<TmdbCandidate> = coroutineScope {
    val tasks: List<Deferred<TmdbCandidate>> = raw.map { c ->
        async(Dispatchers.IO) {
            try {
                val details = fetchTmdbDetails(c.id, tmdbApiKey, client)
                val directors = (details.credits?.crew ?: emptyList())
                    .filter { it.job == "Director" }
                    .mapNotNull { it.name }
                TmdbCandidate(c.id, c.title, c.original_title, c.release_date, c.popularity, directors, details)
            } catch (e: Exception) {
                TmdbCandidate(c.id, c.title, c.original_title, c.release_date, c.popularity, emptyList(), null)
            }
        }
    }
    tasks.awaitAll()
}

/**
 * Process one memo line end-to-end. 
 */
suspend fun processMemoLine(
    rawLine: String,
    geminiApiKey: String,
    tmdbApiKey: String,
    koreanDirectorMap: Map<String, String>,
    geminiModel: GeminiModelTier,
    client: OkHttpClient,
): MemoPipelineResult {
    // -- Call A: parse -----------------------------------------------------
    val parseMemoLineResponse = try {
        parseMemoLine(rawLine, geminiApiKey, geminiModel, client)
    } catch (e: Exception) {
        return MemoPipelineResult.Error(rawLine, "Call A failed: ${e.message}")
    }
    if (!parseMemoLineResponse.is_movie) {
        return MemoPipelineResult.NotMovie(rawLine, parseMemoLineResponse)
    }
    if (parseMemoLineResponse.title.isNullOrBlank()) {
        return MemoPipelineResult.Error(rawLine, "Call A returned is_movie=true but no title")
    }

    // -- TMDB search ---------------------------------------------------------
    val rawCandidates = try {
        tmdbSearch(parseMemoLineResponse, tmdbApiKey, client)
    } catch (e: Exception) {
        return MemoPipelineResult.Error(rawLine, e.message ?: "TMDB search failed")
    }
    if (rawCandidates.isEmpty()) {
        return MemoPipelineResult.NoMatch(rawLine, parseMemoLineResponse)
    }
    val enriched = enrichCandidatesForMatch(rawCandidates, tmdbApiKey, client)

    // Restricted to imdb_id-confirmed candidates only, before Call B ever
    // sees the list — an unconfirmed candidate can never become a saved
    // entry (buildMovieEntryFromTmdb requires one), so there's no point
    // offering it to the matcher or the candidate picker. Fed to both Call B
    // (below) and Ok's `.candidates` — one list, one guarantee, nothing
    // downstream ever sees an unconfirmed candidate.
    val pickerCandidates = enriched.filter { it.details != null && !it.details.imdb_id.isNullOrEmpty() }
    if (pickerCandidates.isEmpty()) {
        return MemoPipelineResult.NoMatch(rawLine, parseMemoLineResponse)
    }

    // -- Call B: match ---------------------------------------------------------
    val matchCandidateResponse = try {
        matchTmdbCandidate(rawLine, parseMemoLineResponse, pickerCandidates, geminiApiKey, geminiModel, client)
    } catch (e: Exception) {
        return MemoPipelineResult.Error(rawLine, "Call B failed: ${e.message}")
    }

    // Build candidate entries up front, so that the picker can show them all.
    val custom_korean_title_overlay = parseMemoLineResponse.title_korean_overlay?.trim()
    val entriesByCandidateId: Map<Int, MovieEntry> = pickerCandidates.mapNotNull { candidate ->
        val entry = try {
            buildMovieEntryFromTmdb(candidate.details!!) // pickerCandidates guarantees non-null details
        } catch (e: Exception) {
            return@mapNotNull null
        }
        // title_korean_overlay -> custom_korean_title (a property of the memo
        // line itself, not of any one candidate, so applied uniformly here).
        if (!custom_korean_title_overlay.isNullOrEmpty()) entry["custom_korean_title"] = custom_korean_title_overlay
        // Korean director resolution: map hit -> else leave the TMDB romanization.
        resolveKoreanDirectorFromMap(entry, koreanDirectorMap)
        candidate.id to entry
    }.toMap()
    if (entriesByCandidateId.isEmpty()) {
        return MemoPipelineResult.NoMatch(rawLine, parseMemoLineResponse)
    }
    val candidatesWithEntries = pickerCandidates.filter { it.id in entriesByCandidateId }

    // Call B's pick becomes the default selection when it's actually one of
    // these candidates; otherwise (declined, or a hallucinated/out-of-list
    // id) default to the top (most popular) one. Either way it's only ever a
    // suggestion — see MemoPipelineResult.Ok.
    val selectedCandidateId = matchCandidateResponse.matched_tmdb_id?.takeIf { it in entriesByCandidateId }
        ?: candidatesWithEntries.first().id

    return MemoPipelineResult.Ok(rawLine, parseMemoLineResponse, candidatesWithEntries, entriesByCandidateId, matchCandidateResponse, selectedCandidateId)
}
