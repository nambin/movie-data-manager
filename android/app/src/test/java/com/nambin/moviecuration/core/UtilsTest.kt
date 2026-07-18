package com.nambin.moviecuration.core

import org.junit.Assert.*
import org.junit.Test

/** Kotlin port of tests/utils.test.js + tests/korean.test.js. */
class UtilsTest {

    // -- getLanguageName ------------------------------------------------------

    @Test
    fun `getLanguageName standard ISO 639-1 codes`() {
        assertEquals("Korean", getLanguageName("ko"))
        assertEquals("English", getLanguageName("en"))
        assertEquals("Japanese", getLanguageName("ja"))
        assertEquals("French", getLanguageName("fr"))
        assertEquals("Chinese", getLanguageName("zh"))
    }

    @Test
    fun `getLanguageName TMDb override cn to Cantonese`() {
        assertEquals("Cantonese", getLanguageName("cn"))
    }

    // Broader coverage of common non-English-cinema TMDB original_language
    // codes, beyond the 5 spot-checked above — java.util.Locale is a
    // different underlying data source than the web app's Intl.DisplayNames,
    // so this pins that the two still agree on names a curator is likely to
    // actually see, not just the handful exercised elsewhere.
    @Test
    fun `getLanguageName common non-English cinema codes`() {
        assertEquals("Spanish", getLanguageName("es"))
        assertEquals("Portuguese", getLanguageName("pt"))
        assertEquals("German", getLanguageName("de"))
        assertEquals("Italian", getLanguageName("it"))
        assertEquals("Russian", getLanguageName("ru"))
        assertEquals("Hindi", getLanguageName("hi"))
        assertEquals("Arabic", getLanguageName("ar"))
        assertEquals("Turkish", getLanguageName("tr"))
        assertEquals("Thai", getLanguageName("th"))
        assertEquals("Vietnamese", getLanguageName("vi"))
        assertEquals("Indonesian", getLanguageName("id"))
        assertEquals("Polish", getLanguageName("pl"))
        assertEquals("Swedish", getLanguageName("sv"))
        assertEquals("Danish", getLanguageName("da"))
        assertEquals("Norwegian Bokmål", getLanguageName("nb"))
        assertEquals("Finnish", getLanguageName("fi"))
        assertEquals("Czech", getLanguageName("cs"))
        assertEquals("Hungarian", getLanguageName("hu"))
        assertEquals("Greek", getLanguageName("el"))
        assertEquals("Hebrew", getLanguageName("he"))
    }

    @Test
    fun `getLanguageName unknown code falls back to the code as-is`() {
        assertEquals("xx", getLanguageName("xx"))
    }

    @Test
    fun `getLanguageName empty or null returns null`() {
        assertNull(getLanguageName(""))
        assertNull(getLanguageName(null))
    }

    // -- deriveAwardBadges --------------------------------------------------------

    @Test
    fun `deriveAwardBadges Anora-style two-name input`() {
        // Real entry from data/movies.yml: Anora has both Cannes + Oscar.
        assertEquals(listOf("cannes", "oscar"), deriveAwardBadges(listOf("Cannes Palme d'Or", "Oscar Best Picture")))
    }

    @Test
    fun `deriveAwardBadges Parasite-style four-name input collapses two names to one badge`() {
        assertEquals(
            listOf("blue_dragon", "cannes", "oscar"),
            deriveAwardBadges(
                listOf(
                    "청룡영화제 최우수 작품상",
                    "Cannes Palme d'Or",
                    "Oscar Best Picture",
                    "Oscar Best International Film",
                ),
            ),
        )
    }

    @Test
    fun `deriveAwardBadges drops names without a badge mapping`() {
        assertEquals(listOf("cannes"), deriveAwardBadges(listOf("Hong Kong Film Awards", "Cannes Palme d'Or")))
    }

    @Test
    fun `deriveAwardBadges returns empty list when no badges map`() {
        assertEquals(emptyList<String>(), deriveAwardBadges(listOf("César Award for Best Film")))
        assertEquals(emptyList<String>(), deriveAwardBadges(emptyList()))
    }

    @Test
    fun `deriveAwardBadges preserves input order across mapped names`() {
        // Reverse order should yield reversed badge order.
        assertEquals(listOf("oscar", "cannes"), deriveAwardBadges(listOf("Oscar Best Picture", "Cannes Palme d'Or")))
    }

    // -- isKoreanLanguage -------------------------------------------------------

    @Test
    fun `isKoreanLanguage pure Korean`() {
        assertTrue(isKoreanLanguage("박찬욱"))
        assertTrue(isKoreanLanguage("봉준호"))
    }

    @Test
    fun `isKoreanLanguage pure English`() {
        assertFalse(isKoreanLanguage("Christopher Nolan"))
        assertFalse(isKoreanLanguage("Park Chan-wook"))
    }

    @Test
    fun `isKoreanLanguage mixed Korean and English`() {
        assertTrue(isKoreanLanguage("박찬욱 (Park Chan-wook)"))
    }

    @Test
    fun `isKoreanLanguage Japanese kanji is not Korean`() {
        assertFalse(isKoreanLanguage("是枝裕和"))
    }

    @Test
    fun `isKoreanLanguage Chinese is not Korean`() {
        assertFalse(isKoreanLanguage("李安"))
    }

    @Test
    fun `isKoreanLanguage empty or non-string-like`() {
        assertFalse(isKoreanLanguage(""))
        assertFalse(isKoreanLanguage(null))
    }

    @Test
    fun `isKoreanLanguage U+AC00 to U+D7A3 boundary`() {
        assertTrue(isKoreanLanguage("가"))
        assertTrue(isKoreanLanguage("힣"))
        assertFalse(isKoreanLanguage(String(Character.toChars(0xABFF))))
        assertFalse(isKoreanLanguage(String(Character.toChars(0xD7A4))))
    }

    // -- buildKoreanDirectorMap ---------------------------------------------------

    private fun entry(
        isKorean: Boolean = true,
        director: String = "박찬욱",
        romanized1: String? = "Park Chan-wook",
        romanized2: String? = null,
    ): MovieEntry = movieEntryOf(
        "is_korean_director" to isKorean,
        "director" to director,
        "tmdb_director_name_1" to romanized1,
        "tmdb_director_name_2" to romanized2,
    )

    @Test
    fun `buildKoreanDirectorMap empty input to empty map`() {
        val map = buildKoreanDirectorMap(emptyList())
        assertEquals(0, map.size)
    }

    @Test
    fun `buildKoreanDirectorMap maps romanized to Korean`() {
        val map = buildKoreanDirectorMap(listOf(entry(director = "봉준호", romanized1 = "Bong Joon Ho")))
        assertEquals("봉준호", map["Bong Joon Ho"])
    }

    @Test
    fun `buildKoreanDirectorMap collects multiple distinct directors`() {
        val map = buildKoreanDirectorMap(
            listOf(
                entry(director = "박찬욱", romanized1 = "Park Chan-wook"),
                entry(director = "봉준호", romanized1 = "Bong Joon Ho"),
                entry(director = "윤가은", romanized1 = "Yoon Ga-eun"),
            ),
        )
        assertEquals(3, map.size)
        assertEquals("박찬욱", map["Park Chan-wook"])
        assertEquals("봉준호", map["Bong Joon Ho"])
        assertEquals("윤가은", map["Yoon Ga-eun"])
    }

    @Test
    fun `buildKoreanDirectorMap skips non-Korean director entries`() {
        val map = buildKoreanDirectorMap(
            listOf(entry(isKorean = false, director = "Christopher Nolan", romanized1 = "Christopher Nolan")),
        )
        assertEquals(0, map.size)
    }

    @Test
    fun `buildKoreanDirectorMap skips entries with null romanized name`() {
        val map = buildKoreanDirectorMap(listOf(entry(romanized1 = null)))
        assertEquals(0, map.size)
    }

    @Test
    fun `buildKoreanDirectorMap skips entries whose director has no Hangul`() {
        val map = buildKoreanDirectorMap(listOf(entry(director = "Park Chan-wook")))
        assertEquals(0, map.size)
    }

    @Test
    fun `buildKoreanDirectorMap ignores tmdb_director_name_2`() {
        val map = buildKoreanDirectorMap(
            listOf(entry(director = "봉준호", romanized1 = "Bong Joon Ho", romanized2 = "Andrew Lau Wai-Keung")),
        )
        assertEquals(1, map.size)
        assertEquals("봉준호", map["Bong Joon Ho"])
        assertFalse(map.containsKey("Andrew Lau Wai-Keung"))
    }

    @Test
    fun `buildKoreanDirectorMap first-write-wins for repeated director`() {
        val map = buildKoreanDirectorMap(
            listOf(
                entry(director = "박찬욱", romanized1 = "Park Chan-wook"),
                entry(director = "박찬욱", romanized1 = "Park Chan-wook"),
            ),
        )
        assertEquals(1, map.size)
        assertEquals("박찬욱", map["Park Chan-wook"])
    }

    @Test
    fun `buildKoreanDirectorMap handles null entries in the list`() {
        val map = buildKoreanDirectorMap(
            listOf(null, null, entry(director = "박찬욱", romanized1 = "Park Chan-wook")),
        )
        assertEquals(1, map.size)
        assertEquals("박찬욱", map["Park Chan-wook"])
    }

    @Test
    fun `buildKoreanDirectorMap mixed collection — only the qualifying entries appear`() {
        val map = buildKoreanDirectorMap(
            listOf(
                entry(director = "박찬욱", romanized1 = "Park Chan-wook"),
                entry(isKorean = false, director = "Christopher Nolan", romanized1 = "Christopher Nolan"),
                entry(director = "봉준호", romanized1 = "Bong Joon Ho"),
                entry(director = "윤가은", romanized1 = null), // no romanized name
            ),
        )
        assertEquals(2, map.size)
        assertEquals(mapOf("Park Chan-wook" to "박찬욱", "Bong Joon Ho" to "봉준호"), map)
    }

    // -- sortMovies ---------------------------------------------------------------

    private fun movie(
        year: Int?,
        masterpiece: Boolean = false,
        myBest: Boolean = false,
        awards: List<String> = emptyList(),
        director: String = "",
    ): MovieEntry {
        val m = movieEntryOf("year" to year, "director" to director)
        if (masterpiece) m["masterpiece"] = true
        if (myBest) m["my_best"] = true
        if (awards.isNotEmpty()) m["awards"] = awards
        return m
    }

    @Test
    fun `sortMovies orders by year descending`() {
        val sorted = sortMovies(listOf(movie(2020), movie(2024), movie(2019)))
        assertEquals(listOf(2024, 2020, 2019), sorted.map { it["year"] })
    }

    @Test
    fun `sortMovies masterpiece before my_best before none within the same year`() {
        val none = movie(2020, director = "C")
        val myBest = movie(2020, myBest = true, director = "B")
        val masterpiece = movie(2020, masterpiece = true, director = "A")
        val sorted = sortMovies(listOf(none, myBest, masterpiece))
        assertEquals(listOf(masterpiece, myBest, none), sorted)
    }

    @Test
    fun `sortMovies more awards before fewer within the same year and rating`() {
        val fewer = movie(2020, awards = listOf("oscar"))
        val more = movie(2020, awards = listOf("oscar", "cannes"))
        val sorted = sortMovies(listOf(fewer, more))
        assertEquals(listOf(more, fewer), sorted)
    }

    @Test
    fun `sortMovies director descending as final tiebreaker`() {
        val a = movie(2020, director = "Alpha")
        val z = movie(2020, director = "Zeta")
        val sorted = sortMovies(listOf(a, z))
        assertEquals(listOf(z, a), sorted)
    }

    @Test
    fun `sortMovies does not mutate the input`() {
        val input = listOf(movie(2019), movie(2024))
        sortMovies(input)
        assertEquals(2019, input[0]["year"])
    }
}
