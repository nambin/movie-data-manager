package com.nambin.moviecuration.core

/**
 * Enforces field order, omit-when-empty rules, and derives `awards` from `award_names`.
 */

// Canonical field order for a movie entry. `country` is preserved verbatim
// when present on legacy entries; new entries from this app omit it.
private val MAIN_KEY_ORDER = listOf(
    "title",
    "year",
    "director",
    "country",
    "is_korean_director",
    "imdb_id",
    "imdb_url",
    "tmdb_url",
    "tmdb_title",
    "tmdb_original_title",
    "tmdb_original_language",
    "tmdb_director_name_1",
    "tmdb_director_name_2",
    "tmdb_num_directors",
    "tmdb_poster_url",
)

// `date_committed` precedes the curation fields; `note` precedes
// `award_names` and `awards` — see the web app's verified actual emit order.
private val OPTIONAL_KEY_ORDER = listOf(
    "date_committed",
    "custom_korean_title",
    "masterpiece",
    "my_best",
    "note",
    "award_names",
    "awards",
)

private val ALL_KNOWN_KEYS: Set<String> = (MAIN_KEY_ORDER + OPTIONAL_KEY_ORDER).toSet()

private fun trimOrEmpty(v: Any?): String = (v as? String)?.trim() ?: ""

/**
 * Canonicalize one entry. Pure: returns a new map.
 *   - Recomputes `is_korean_director` from `director`.
 *   - Trims string values for the user-edited text fields.
 *   - Omits empty optional fields entirely (no false/""/[] placeholders).
 *   - Derives `awards` from `award_names`.
 *   - Preserves `date_committed` verbatim if present.
 *   - Enforces mutual exclusion of `masterpiece`/`my_best` (masterpiece wins).
 *   - Preserves any unknown keys at the end (defensive — shouldn't happen,
 *     but prevents data loss if a future field is added to the YML).
 *
 * Note on the JS version's "throws on non-object input" behavior: Kotlin's
 * static typing (`entry: MovieEntry`, not `Any?`) makes that check unreachable
 * here — the type system is the guard.
 */
fun canonicalizeEntry(entry: MovieEntry): MovieEntry {
    val out = MovieEntry()

    for (k in MAIN_KEY_ORDER) {
        if (!entry.containsKey(k)) continue
        when (k) {
            "director" -> out[k] = trimOrEmpty(entry[k])
            "is_korean_director" -> out[k] = isKoreanLanguage(trimOrEmpty(entry["director"]))
            else -> out[k] = entry[k]
        }
    }

    val dateCommitted = entry["date_committed"] as? String
    if (!dateCommitted.isNullOrEmpty()) out["date_committed"] = dateCommitted

    val ckt = trimOrEmpty(entry["custom_korean_title"])
    if (ckt.isNotEmpty()) out["custom_korean_title"] = ckt

    // masterpiece XOR my_best. If both somehow set, masterpiece wins.
    if (entry["masterpiece"] == true) {
        out["masterpiece"] = true
    } else if (entry["my_best"] == true) {
        out["my_best"] = true
    }

    val note = trimOrEmpty(entry["note"])
    if (note.isNotEmpty()) out["note"] = note

    val rawAwardNames = entry["award_names"] as? List<*>
    if (!rawAwardNames.isNullOrEmpty()) {
        val names = mutableListOf<String>()
        for (n in rawAwardNames) {
            // Defensive against malformed YAML, mirroring lib/canonicalize.js's
            // `typeof n === "string" ? n.trim() : ""` — a non-string element is
            // dropped rather than crashing the whole canonicalize pass.
            val t = (n as? String)?.trim() ?: ""
            if (t.isNotEmpty() && t !in names) names.add(t)
        }
        if (names.isNotEmpty()) {
            out["award_names"] = names
            val badges = deriveAwardBadges(names)
            if (badges.isNotEmpty()) out["awards"] = badges
        }
    }

    // Defensive passthrough for any future/unknown keys, appended at the end.
    for ((k, v) in entry) {
        if (k !in ALL_KNOWN_KEYS) out[k] = v
    }

    return out
}

/** Canonicalize a whole list. Returns a new list. */
fun canonicalizeAll(movies: List<MovieEntry>): List<MovieEntry> = movies.map(::canonicalizeEntry)
