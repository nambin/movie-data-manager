package com.nambin.moviecuration.core

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

/** Kotlin port of tests/tmdb_utils.test.js, against the same fixture files. */
class TmdbUtilsTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun loadFixture(name: String): TmdbMovieDetails {
        val stream = javaClass.classLoader!!.getResourceAsStream("fixtures/$name.json")
            ?: error("fixture not found: $name")
        val text = stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        return json.decodeFromString(TmdbMovieDetails.serializer(), text)
    }

    /**
     * Asserts [actual] matches [expected] in one call: same keys in the same
     * order, and the same values. `assertEquals` alone on two maps checks
     * content only (Map.equals() ignores iteration order), which is why key
     * order needs its own explicit check — folded in here so callers don't
     * have to repeat both assertions inline.
     */
    private fun assertMovieEntry(expected: MovieEntry, actual: MovieEntry) {
        assertEquals(expected.keys.toList(), actual.keys.toList())
        assertEquals(expected, actual)
    }

    // -- buildMovieEntryFromTmdb, fixture-driven --------------------------------

    @Test
    fun `Parasite Korean original English tmdb_title`() {
        val entry = buildMovieEntryFromTmdb(loadFixture("tmdb-parasite"))
        assertMovieEntry(
            movieEntryOf(
                "title" to "Parasite (기생충)",
                "year" to 2019,
                "director" to "Bong Joon Ho",
                "is_korean_director" to false,
                "imdb_id" to "tt6751668",
                "imdb_url" to "https://www.imdb.com/title/tt6751668",
                "tmdb_url" to "https://www.themoviedb.org/movie/496243",
                "tmdb_title" to "Parasite",
                "tmdb_original_title" to "기생충",
                "tmdb_original_language" to "Korean",
                "tmdb_director_name_1" to "Bong Joon Ho",
                "tmdb_director_name_2" to null,
                "tmdb_num_directors" to 1,
                "tmdb_poster_url" to "https://image.tmdb.org/t/p/w200/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg",
            ),
            entry,
        )
    }

    @Test
    fun `Oppenheimer English original tmdb_title is null`() {
        val entry = buildMovieEntryFromTmdb(loadFixture("tmdb-oppenheimer"))
        assertMovieEntry(
            movieEntryOf(
                "title" to "Oppenheimer",
                "year" to 2023,
                "director" to "Christopher Nolan",
                "is_korean_director" to false,
                "imdb_id" to "tt15398776",
                "imdb_url" to "https://www.imdb.com/title/tt15398776",
                "tmdb_url" to "https://www.themoviedb.org/movie/872585",
                "tmdb_title" to null,
                "tmdb_original_title" to "Oppenheimer",
                "tmdb_original_language" to "English",
                "tmdb_director_name_1" to "Christopher Nolan",
                "tmdb_director_name_2" to null,
                "tmdb_num_directors" to 1,
                "tmdb_poster_url" to "https://image.tmdb.org/t/p/w200/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg",
            ),
            entry,
        )
    }

    @Test
    fun `Shoplifters Japanese original English tmdb_title`() {
        val entry = buildMovieEntryFromTmdb(loadFixture("tmdb-shoplifters"))
        assertMovieEntry(
            movieEntryOf(
                "title" to "Shoplifters (万引き家族)",
                "year" to 2018,
                "director" to "Hirokazu Kore-eda",
                "is_korean_director" to false,
                "imdb_id" to "tt8075192",
                "imdb_url" to "https://www.imdb.com/title/tt8075192",
                "tmdb_url" to "https://www.themoviedb.org/movie/505192",
                "tmdb_title" to "Shoplifters",
                "tmdb_original_title" to "万引き家族",
                "tmdb_original_language" to "Japanese",
                "tmdb_director_name_1" to "Hirokazu Kore-eda",
                "tmdb_director_name_2" to null,
                "tmdb_num_directors" to 1,
                "tmdb_poster_url" to "https://image.tmdb.org/t/p/w200/4nfRUOv3LX5zLn98WS1WqVBk9E9.jpg",
            ),
            entry,
        )
    }

    @Test
    fun `The Witches apostrophe title equals original tmdb_title is null`() {
        val entry = buildMovieEntryFromTmdb(loadFixture("tmdb-the-witches"))
        assertMovieEntry(
            movieEntryOf(
                "title" to "Roald Dahl's The Witches",
                "year" to 2020,
                "director" to "Robert Zemeckis",
                "is_korean_director" to false,
                "imdb_id" to "tt0805647",
                "imdb_url" to "https://www.imdb.com/title/tt0805647",
                "tmdb_url" to "https://www.themoviedb.org/movie/531219",
                "tmdb_title" to null,
                "tmdb_original_title" to "Roald Dahl's The Witches",
                "tmdb_original_language" to "English",
                "tmdb_director_name_1" to "Robert Zemeckis",
                "tmdb_director_name_2" to null,
                "tmdb_num_directors" to 1,
                "tmdb_poster_url" to "https://image.tmdb.org/t/p/w200/ht6EfsM5hrsUPSR4ReJQFDVU71F.jpg",
            ),
            entry,
        )
    }

    @Test
    fun `Police Story Cantonese override`() {
        val entry = buildMovieEntryFromTmdb(loadFixture("tmdb-police-story"))
        assertMovieEntry(
            movieEntryOf(
                "title" to "Police Story (警察故事)",
                "year" to 1985,
                "director" to "Jackie Chan",
                "is_korean_director" to false,
                "imdb_id" to "tt0089374",
                "imdb_url" to "https://www.imdb.com/title/tt0089374",
                "tmdb_url" to "https://www.themoviedb.org/movie/9056",
                "tmdb_title" to "Police Story",
                "tmdb_original_title" to "警察故事",
                // "cn" is TMDB's own (non-standard) language code for Cantonese —
                // the TMDB-specific override, not a raw passthrough
                // Intl.DisplayNames couldn't resolve.
                "tmdb_original_language" to "Cantonese",
                "tmdb_director_name_1" to "Jackie Chan",
                "tmdb_director_name_2" to null,
                "tmdb_num_directors" to 1,
                "tmdb_poster_url" to "https://image.tmdb.org/t/p/w200/1eFB0Iy1TMU4VO5hMcoCE064JAT.jpg",
            ),
            entry,
        )
    }

    @Test
    fun `Infernal Affairs two directors`() {
        val entry = buildMovieEntryFromTmdb(loadFixture("tmdb-infernal-affairs"))
        assertMovieEntry(
            movieEntryOf(
                "title" to "Infernal Affairs (無間道)",
                "year" to 2002,
                "director" to "Alan Mak Siu-Fai",
                "is_korean_director" to false,
                "imdb_id" to "tt0338564",
                "imdb_url" to "https://www.imdb.com/title/tt0338564",
                "tmdb_url" to "https://www.themoviedb.org/movie/10775",
                "tmdb_title" to "Infernal Affairs",
                "tmdb_original_title" to "無間道",
                "tmdb_original_language" to "Cantonese",
                "tmdb_director_name_1" to "Alan Mak Siu-Fai",
                "tmdb_director_name_2" to "Andrew Lau Wai-Keung",
                "tmdb_num_directors" to 2,
                "tmdb_poster_url" to "https://image.tmdb.org/t/p/w200/gix9thDBXfjJ8M7rYbihqbQGBcP.jpg",
            ),
            entry,
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun `missing imdb_id throws`() {
        val fake = TmdbMovieDetails(
            id = 999999,
            title = "X",
            original_title = "X",
            original_language = "en",
            release_date = "2020-01-01",
            poster_path = null,
            imdb_id = "",
            credits = TmdbCredits(emptyList()),
        )
        buildMovieEntryFromTmdb(fake)
    }

    @Test
    fun `missing release_date year is null`() {
        val fixture = loadFixture("tmdb-oppenheimer").copy(release_date = "")
        val entry = buildMovieEntryFromTmdb(fixture)
        // Same as the normal Oppenheimer entry (see above) except `year`, which
        // an empty release_date can't derive a year from.
        assertMovieEntry(
            movieEntryOf(
                "title" to "Oppenheimer",
                "year" to null,
                "director" to "Christopher Nolan",
                "is_korean_director" to false,
                "imdb_id" to "tt15398776",
                "imdb_url" to "https://www.imdb.com/title/tt15398776",
                "tmdb_url" to "https://www.themoviedb.org/movie/872585",
                "tmdb_title" to null,
                "tmdb_original_title" to "Oppenheimer",
                "tmdb_original_language" to "English",
                "tmdb_director_name_1" to "Christopher Nolan",
                "tmdb_director_name_2" to null,
                "tmdb_num_directors" to 1,
                "tmdb_poster_url" to "https://image.tmdb.org/t/p/w200/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg",
            ),
            entry,
        )
    }

    @Test
    fun `missing poster_path tmdb_poster_url is null`() {
        val fixture = loadFixture("tmdb-oppenheimer").copy(poster_path = null)
        val entry = buildMovieEntryFromTmdb(fixture)
        // Same as the normal Oppenheimer entry except `tmdb_poster_url`, which
        // a null poster_path can't build an image URL from.
        assertMovieEntry(
            movieEntryOf(
                "title" to "Oppenheimer",
                "year" to 2023,
                "director" to "Christopher Nolan",
                "is_korean_director" to false,
                "imdb_id" to "tt15398776",
                "imdb_url" to "https://www.imdb.com/title/tt15398776",
                "tmdb_url" to "https://www.themoviedb.org/movie/872585",
                "tmdb_title" to null,
                "tmdb_original_title" to "Oppenheimer",
                "tmdb_original_language" to "English",
                "tmdb_director_name_1" to "Christopher Nolan",
                "tmdb_director_name_2" to null,
                "tmdb_num_directors" to 1,
                "tmdb_poster_url" to null,
            ),
            entry,
        )
    }

    @Test
    fun `no Director crew director defaults empty names null`() {
        val fixture = loadFixture("tmdb-oppenheimer")
        val noDirectors = fixture.copy(credits = TmdbCredits(fixture.credits!!.crew.filter { it.job != "Director" }))
        val entry = buildMovieEntryFromTmdb(noDirectors)
        // Same as the normal Oppenheimer entry except everything director-related:
        // `director` defaults to "" (not null), and both tmdb_director_name_*
        // fields plus tmdb_num_directors reflect zero credited directors.
        assertMovieEntry(
            movieEntryOf(
                "title" to "Oppenheimer",
                "year" to 2023,
                "director" to "",
                "is_korean_director" to false,
                "imdb_id" to "tt15398776",
                "imdb_url" to "https://www.imdb.com/title/tt15398776",
                "tmdb_url" to "https://www.themoviedb.org/movie/872585",
                "tmdb_title" to null,
                "tmdb_original_title" to "Oppenheimer",
                "tmdb_original_language" to "English",
                "tmdb_director_name_1" to null,
                "tmdb_director_name_2" to null,
                "tmdb_num_directors" to 0,
                "tmdb_poster_url" to "https://image.tmdb.org/t/p/w200/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg",
            ),
            entry,
        )
    }
}
