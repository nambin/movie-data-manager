package com.nambin.moviecuration.data

import com.nambin.moviecuration.core.MovieEntry
import com.nambin.moviecuration.core.canonicalizeAll
import com.nambin.moviecuration.core.movieEntryOf
import com.nambin.moviecuration.core.sortMovies
import java.io.File
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Kotlin port of the spirit of tests/yaml-roundtrip.test.js, at a small-fixture scale. */
class YamlCodecTest {

    /**
     * Mirrors tests/yaml-roundtrip.test.js's DATA_DIR/sibling-checkout
     * resolution: movies.yml lives in the nambin.github.io repo, not this
     * one. Walk up from the working directory (which Gradle may set to the
     * module dir, the android/ root, or elsewhere depending on invocation)
     * looking for that sibling checkout, honoring a DATA_DIR override same
     * as the JS tests. Returns null — callers should skip, not fail — when
     * the sibling checkout isn't present (e.g. CI without it).
     */
    private fun resolveMoviesYml(): File? {
        System.getProperty("DATA_DIR")?.let { override ->
            val f = File(override, "movies.yml")
            return if (f.exists()) f else null
        }
        var dir: File? = File(".").canonicalFile
        while (dir != null) {
            val candidate = File(dir, "nambin.github.io/data/movies.yml")
            if (candidate.exists()) return candidate
            dir = dir.parentFile
        }
        return null
    }

    private data class MovieEntrySummary(
        val keys: List<String>,
        val director: String?,
        val year: Int?,
        val isKoreanDirector: Boolean?,
        val tmdbTitle: String?,
        val awardNames: List<String>?,
    )

    private fun MovieEntry.summary() = MovieEntrySummary(
        keys = keys.toList(),
        director = this["director"] as? String,
        year = this["year"] as? Int,
        isKoreanDirector = this["is_korean_director"] as? Boolean,
        tmdbTitle = this["tmdb_title"] as? String,
        awardNames = this["award_names"] as? List<String>,
    )

    /** Pairs an entry with its key order, so a single assertEquals catches both content and field-order drift. */
    private data class OrderedEntry(val entry: MovieEntry, val keys: List<String>)

    private fun MovieEntry.ordered() = OrderedEntry(this, keys.toList())

    @Test
    fun `dump then load round-trips structurally`() {
        val movies = listOf(
            movieEntryOf(
                "title" to "어쩔수가없다",
                "year" to 2025,
                "director" to "박찬욱",
                "is_korean_director" to true,
                "imdb_id" to "tt1527793",
                "imdb_url" to "https://www.imdb.com/title/tt1527793",
                "tmdb_url" to "https://www.themoviedb.org/movie/639988",
                "tmdb_title" to null,
                "tmdb_original_title" to "어쩔수가없다",
                "tmdb_original_language" to "Korean",
                "tmdb_director_name_1" to "Park Chan-wook",
                "tmdb_director_name_2" to null,
                "tmdb_num_directors" to 1,
                "tmdb_poster_url" to "https://image.tmdb.org/t/p/w200/i38zFYpbBnWbqcRayu9F1n71yVT.jpg",
                "date_committed" to "2026-01-04",
                "award_names" to listOf("Cannes Palme d'Or"),
                "awards" to listOf("cannes"),
            ),
        )

        val text = YamlCodec.dumpMovies(movies)
        val loaded = YamlCodec.loadMovies(text)

        assertEquals(1, loaded.size)
        assertEquals(
            MovieEntrySummary(
                keys = listOf(
                    "title", "year", "director", "is_korean_director", "imdb_id", "imdb_url",
                    "tmdb_url", "tmdb_title", "tmdb_original_title", "tmdb_original_language",
                    "tmdb_director_name_1", "tmdb_director_name_2", "tmdb_num_directors",
                    "tmdb_poster_url", "date_committed", "award_names", "awards",
                ),
                director = "박찬욱",
                year = 2025,
                isKoreanDirector = true,
                tmdbTitle = null,
                awardNames = listOf("Cannes Palme d'Or"),
            ),
            loaded[0].summary(),
        )
    }

    @Test
    fun `date_committed round-trips as a plain string, not a Date`() {
        val movies = listOf(movieEntryOf("title" to "X", "date_committed" to "2026-01-04"))
        val text = YamlCodec.dumpMovies(movies)
        assertTrue("expected a bare date scalar, got:\n$text", text.contains("date_committed: 2026-01-04"))
        assertFalse("must not gain a time component", text.contains("T00:00:00"))
        val loaded = YamlCodec.loadMovies(text)
        assertEquals("2026-01-04", loaded[0]["date_committed"])
    }

    @Test
    fun `round-trip against the live movies_yml is structurally identical`() {
        val ymlFile = resolveMoviesYml()
        assumeTrue("movies.yml not found in a sibling nambin.github.io checkout — skipping", ymlFile != null)

        val original = YamlCodec.loadMovies(ymlFile!!.readText())
        assertTrue("expected hundreds of movies, got ${original.size}", original.size > 900)

        val processed = sortMovies(canonicalizeAll(original))
        val dumped = YamlCodec.dumpMovies(processed)
        val reparsed = YamlCodec.loadMovies(dumped)

        assertEquals(original.size, reparsed.size)
        for (i in original.indices) {
            val o = original[i]
            val r = reparsed[i]
            assertEquals(
                "entry $i (${o["title"]} / ${o["imdb_id"]}) differs after round-trip",
                o.ordered(),
                r.ordered(),
            )
        }

        // Stronger than structural equality above: the GitHub commit flow
        // (CurationViewModel.confirmCommit) re-dumps the *entire* file on
        // every commit and diffs it against what's already on GitHub
        // (DiffSizeGuard). If dumpMovies's formatting drifts from the
        // on-disk convention even cosmetically, every untouched entry would
        // show up as changed, blowing the diff-size cap on every commit.
        val originalText = ymlFile.readText()
        assertEquals(
            "dumped YAML text no longer matches the on-disk file byte-for-byte " +
                "(originalText.length=${originalText.length}, dumped.length=${dumped.length})",
            originalText,
            dumped,
        )
    }

    @Test
    fun `sortMovies agrees with the live movies_yml's on-disk order`() {
        val ymlFile = resolveMoviesYml()
        assumeTrue("movies.yml not found in a sibling nambin.github.io checkout — skipping", ymlFile != null)

        val original = YamlCodec.loadMovies(ymlFile!!.readText())
        assertTrue("expected hundreds of movies, got ${original.size}", original.size > 900)

        val sorted = sortMovies(original)
        for (i in original.indices) {
            assertEquals(
                "entry $i: sortMovies disagrees with on-disk order " +
                    "(disk: ${original[i]["title"]} ${original[i]["year"]} / " +
                    "sort: ${sorted[i]["title"]} ${sorted[i]["year"]})",
                original[i]["imdb_id"],
                sorted[i]["imdb_id"],
            )
        }
    }

    @Test
    fun `dump produces block-style sequences, never flow style`() {
        val movies = listOf(
            movieEntryOf("title" to "X", "award_names" to listOf("Oscar Best Picture", "Cannes Palme d'Or")),
        )
        val dumped = YamlCodec.dumpMovies(movies)
        assertFalse("flow style leaked: $dumped", dumped.contains("[Oscar"))
        assertTrue("expected block style: $dumped", dumped.contains("- Oscar Best Picture"))
        assertTrue("expected block style: $dumped", dumped.contains("- Cannes Palme d'Or"))
    }

    @Test
    fun `awards yml by_imdb document loads`() {
        val text = """
            generated_at: '2026-06-10'
            by_imdb:
              tt0018578:
                tmdb_id: 28966
                title: Wings
                award_names:
                  - Oscar Best Picture
                awards:
                  - oscar
        """.trimIndent()
        val doc = YamlCodec.loadAwardsDocument(text)
        @Suppress("UNCHECKED_CAST")
        val byImdb = doc["by_imdb"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val wings = byImdb["tt0018578"] as Map<String, Any?>
        assertEquals(listOf("Oscar Best Picture"), wings["award_names"])
    }

    @Test
    fun `awards yml by_imdb document loads multiple movies`() {
        val text = """
            generated_at: '2026-06-10'
            by_imdb:
              tt0018578:
                tmdb_id: 28966
                title: Wings
                award_names:
                  - Oscar Best Picture
                awards:
                  - oscar
              tt6751668:
                tmdb_id: 496243
                title: Parasite
                award_names:
                  - Cannes Palme d'Or
                awards:
                  - cannes
        """.trimIndent()
        val doc = YamlCodec.loadAwardsDocument(text)
        @Suppress("UNCHECKED_CAST")
        val byImdb = doc["by_imdb"] as Map<String, Any?>
        assertEquals(setOf("tt0018578", "tt6751668"), byImdb.keys)
        @Suppress("UNCHECKED_CAST")
        val wings = byImdb["tt0018578"] as Map<String, Any?>
        assertEquals("Wings", wings["title"])
        assertEquals(listOf("Oscar Best Picture"), wings["award_names"])
        @Suppress("UNCHECKED_CAST")
        val parasite = byImdb["tt6751668"] as Map<String, Any?>
        assertEquals("Parasite", parasite["title"])
        assertEquals(listOf("Cannes Palme d'Or"), parasite["award_names"])
    }

    @Test
    fun `awards yml by_imdb document loads multiple awards for a single movie`() {
        val text = """
            generated_at: '2026-06-10'
            by_imdb:
              tt6751668:
                tmdb_id: 496243
                title: Parasite
                award_names:
                  - Cannes Palme d'Or
                  - Oscar Best Picture
                  - Oscar Best Director
                awards:
                  - cannes
                  - oscar
        """.trimIndent()
        val doc = YamlCodec.loadAwardsDocument(text)
        @Suppress("UNCHECKED_CAST")
        val byImdb = doc["by_imdb"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val parasite = byImdb["tt6751668"] as Map<String, Any?>
        assertEquals(
            listOf("Cannes Palme d'Or", "Oscar Best Picture", "Oscar Best Director"),
            parasite["award_names"],
        )
        assertEquals(listOf("cannes", "oscar"), parasite["awards"])
    }
}
