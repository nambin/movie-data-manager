package com.nambin.moviecuration.core

import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

/**
 * A movie entry is represented the same way js-yaml represents it in the web
 * app: an ordered string-keyed map, not a rigid data class, so field
 * presence/absence and key order carry over exactly on YAML round-trip.
 *
 * Keys, in canonical order (see Canonicalize.kt's MAIN_KEY_ORDER / OPTIONAL_KEY_ORDER
 * for the authoritative list — this is a readability summary, not a second
 * source of truth):
 */
typealias MovieEntry = LinkedHashMap<String, Any?>

fun movieEntryOf(vararg pairs: Pair<String, Any?>): MovieEntry {
    val m = MovieEntry()
    for ((k, v) in pairs) m[k] = v
    return m
}

// -----------------------------------------------------------------------------
// Awards
// -----------------------------------------------------------------------------
// Note: lib/utils.js's AWARD_NAMES (the full award-picker option list) has no
// Android counterpart — this app never shows an award-editing UI (awards are
// read-only, sourced entirely from data/awards.yml), so only the badge-key
// mapping below is actually needed here.
val BADGE_KEY_BY_NAME: Map<String, String> = mapOf(
    "청룡영화제 최우수 작품상" to "blue_dragon",
    "Oscar Best Picture" to "oscar",
    "Oscar Best International Film" to "oscar",
    "Cannes Palme d'Or" to "cannes",
    "Venice Leone d’oro" to "venice",
    "Berlin Goldener Bär" to "berlin",
)

/** Preserves input order, dedupes badge keys, drops names with no mapping. */
fun deriveAwardBadges(awardNames: List<String>): List<String> {
    val out = mutableListOf<String>()
    for (name in awardNames) {
        val badge = BADGE_KEY_BY_NAME[name] ?: continue
        if (badge !in out) out.add(badge)
    }
    return out
}

// -----------------------------------------------------------------------------
// Korean detection
// -----------------------------------------------------------------------------

/** Returns true iff [s] contains any character in U+AC00..U+D7A3. */
fun isKoreanLanguage(s: String?): Boolean {
    if (s.isNullOrEmpty()) return false
    return s.codePoints().anyMatch { it in 0xAC00..0xD7A3 }
}

/**
 * Build a romanized -> Korean director-name map from already-loaded entries.
 * Only tmdb_director_name_1 -> director is mapped: on a two-director film,
 * `director` holds the Korean form of the *first* director only, so mapping
 * the second director's romanization here would associate the wrong name.
 */
fun buildKoreanDirectorMap(movies: List<MovieEntry?>): Map<String, String> {
    val map = LinkedHashMap<String, String>()
    for (m in movies) {
        if (m == null) continue
        if (m["is_korean_director"] != true) continue
        val director = m["director"] as? String
        if (director.isNullOrEmpty() || !isKoreanLanguage(director)) continue
        val romanized = m["tmdb_director_name_1"] as? String
        if (romanized != null && !map.containsKey(romanized)) {
            map[romanized] = director
        }
    }
    return map
}

/**
 * Resolve [entry]'s director via the romanized->Korean map; no-op if there's
 * no map hit. Shared by MemoPipeline.kt (Call B's picked candidate) and
 * CurationViewModel.kt (the top-candidate fallback and candidate-swap paths)
 * so the resolution rule lives in exactly one place.
 */
fun resolveKoreanDirectorFromMap(entry: MovieEntry, koreanDirectorMap: Map<String, String>) {
    val romanized = entry["tmdb_director_name_1"] as? String
    if (romanized != null && koreanDirectorMap.containsKey(romanized)) {
        entry["director"] = koreanDirectorMap.getValue(romanized)
        entry["is_korean_director"] = true
    }
}

// -----------------------------------------------------------------------------
// Language names
// -----------------------------------------------------------------------------

// TMDb tags Cantonese-language films (Hong Kong cinema) with "cn". ISO 639-1
// has no Cantonese code; the BCP-47 form is "zh-yue".
private val TMDB_LANGUAGE_OVERRIDES = mapOf(
    "cn" to "Cantonese",
)

fun getLanguageName(code: String?): String? {
    if (code.isNullOrEmpty()) return null
    TMDB_LANGUAGE_OVERRIDES[code]?.let { return it }
    return try {
        val name = Locale.forLanguageTag(code).getDisplayLanguage(Locale.ENGLISH)
        name.ifEmpty { code }
    } catch (e: Exception) {
        code
    }
}

// -----------------------------------------------------------------------------
// Misc
// -----------------------------------------------------------------------------

/** Today's date in Asia/Seoul, ISO (YYYY-MM-DD) — mirrors todayDateString() in lib/app.js. */
fun todayDateStringSeoul(): String = LocalDate.now(ZoneId.of("Asia/Seoul")).toString()

// -----------------------------------------------------------------------------
// Sort
// -----------------------------------------------------------------------------

private fun boolRank(v: Any?): Int = if (v == true) 1 else 0

private fun awardsLen(m: MovieEntry): Int {
    val awards = m["awards"]
    return (awards as? List<*>)?.size ?: 0
}

/**
 * Sort movies by, descending: (year, masterpiece, my_best, len(awards),
 * director). Missing masterpiece/my_best are treated as false. Returns a new
 * list — does not mutate the input, mirroring sortMovies in lib/utils.js.
 */
fun sortMovies(movies: List<MovieEntry>): List<MovieEntry> {
    val comparator = compareByDescending<MovieEntry> { (it["year"] as? Number)?.toInt() ?: 0 }
        .thenByDescending { boolRank(it["masterpiece"]) }
        .thenByDescending { boolRank(it["my_best"]) }
        .thenByDescending { awardsLen(it) }
        .thenByDescending { (it["director"] as? String) ?: "" }
    return movies.sortedWith(comparator)
}
