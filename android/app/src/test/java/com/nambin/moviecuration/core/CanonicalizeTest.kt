package com.nambin.moviecuration.core

import org.junit.Assert.*
import org.junit.Test

/** Kotlin port of tests/canonicalize.test.js. */
class CanonicalizeTest {

    private fun legacyEntry(extra: Map<String, Any?> = emptyMap()): MovieEntry {
        val m = movieEntryOf(
            "title" to "Sample",
            "year" to 2020,
            "director" to "Some Director",
            "country" to "US",
            "is_korean_director" to false,
            "imdb_id" to "tt0000001",
            "imdb_url" to "https://www.imdb.com/title/tt0000001",
            "tmdb_url" to "https://www.themoviedb.org/movie/1",
            "tmdb_title" to null,
            "tmdb_original_title" to "Sample",
            "tmdb_original_language" to "English",
            "tmdb_director_name_1" to "Some Director",
            "tmdb_director_name_2" to null,
            "tmdb_num_directors" to 1,
            "tmdb_poster_url" to null,
        )
        for ((k, v) in extra) m[k] = v
        return m
    }

    @Test
    fun `preserves legacy main field order including country`() {
        val out = canonicalizeEntry(legacyEntry())
        assertEquals(
            listOf(
                "title", "year", "director", "country", "is_korean_director", "imdb_id", "imdb_url",
                "tmdb_url", "tmdb_title", "tmdb_original_title", "tmdb_original_language",
                "tmdb_director_name_1", "tmdb_director_name_2", "tmdb_num_directors", "tmdb_poster_url",
            ),
            out.keys.toList(),
        )
    }

    @Test
    fun `omits country when not present`() {
        val e = legacyEntry()
        e.remove("country")
        val out = canonicalizeEntry(e)
        assertFalse(out.containsKey("country"))
        val keys = out.keys.toList()
        assertEquals("is_korean_director", keys[keys.indexOf("director") + 1])
    }

    @Test
    fun `recomputes is_korean_director from director`() {
        val out = canonicalizeEntry(legacyEntry(mapOf("director" to "박찬욱", "is_korean_director" to false)))
        assertEquals(true, out["is_korean_director"])
    }

    @Test
    fun `trims whitespace on director`() {
        val out = canonicalizeEntry(legacyEntry(mapOf("director" to "  Park Chan-wook  ")))
        assertEquals("Park Chan-wook", out["director"])
    }

    @Test
    fun `optional fields appear in canonical tail order`() {
        val out = canonicalizeEntry(
            legacyEntry(
                mapOf(
                    "date_committed" to "2026-05-10",
                    "custom_korean_title" to "기생충",
                    "masterpiece" to true,
                    "note" to "great",
                    "award_names" to listOf("Cannes Palme d'Or"),
                ),
            ),
        )
        val tail = out.keys.toList().drop(15)
        assertEquals(
            listOf("date_committed", "custom_korean_title", "masterpiece", "note", "award_names", "awards"),
            tail,
        )
        assertEquals(listOf("cannes"), out["awards"])
    }

    @Test
    fun `preserves date_committed verbatim`() {
        val out = canonicalizeEntry(legacyEntry(mapOf("date_committed" to "2026-06-26")))
        assertEquals("2026-06-26", out["date_committed"])
    }

    @Test
    fun `omits date_committed when not present`() {
        val out = canonicalizeEntry(legacyEntry())
        assertFalse(out.containsKey("date_committed"))
    }

    @Test
    fun `omits empty optional fields`() {
        val out = canonicalizeEntry(
            legacyEntry(
                mapOf(
                    "date_committed" to "",
                    "custom_korean_title" to "",
                    "masterpiece" to false,
                    "my_best" to false,
                    "note" to "   ",
                    "award_names" to emptyList<String>(),
                ),
            ),
        )
        for (k in listOf("date_committed", "custom_korean_title", "masterpiece", "my_best", "note", "award_names", "awards")) {
            assertFalse("$k should be omitted", out.containsKey(k))
        }
    }

    @Test
    fun `masterpiece wins over my_best if both set`() {
        val out = canonicalizeEntry(legacyEntry(mapOf("masterpiece" to true, "my_best" to true)))
        assertEquals(true, out["masterpiece"])
        assertFalse(out.containsKey("my_best"))
    }

    @Test
    fun `derives awards from award_names dropping unmapped names from awards`() {
        val out = canonicalizeEntry(
            legacyEntry(mapOf("award_names" to listOf("Hong Kong Film Awards", "Cannes Palme d'Or"))),
        )
        assertEquals(listOf("Hong Kong Film Awards", "Cannes Palme d'Or"), out["award_names"])
        assertEquals(listOf("cannes"), out["awards"])
    }

    @Test
    fun `badge-less award_names emitted awards omitted`() {
        val out = canonicalizeEntry(legacyEntry(mapOf("award_names" to listOf("César Award for Best Film"))))
        assertEquals(listOf("César Award for Best Film"), out["award_names"])
        assertFalse(out.containsKey("awards"))
    }

    @Test
    fun `dedupes award_names entries`() {
        val out = canonicalizeEntry(
            legacyEntry(mapOf("award_names" to listOf("Cannes Palme d'Or", "Cannes Palme d'Or"))),
        )
        assertEquals(listOf("Cannes Palme d'Or"), out["award_names"])
    }

    @Test
    fun `trims string note`() {
        val out = canonicalizeEntry(legacyEntry(mapOf("note" to "  hello  ")))
        assertEquals("hello", out["note"])
    }
}
