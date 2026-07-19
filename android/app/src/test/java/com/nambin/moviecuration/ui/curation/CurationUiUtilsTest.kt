package com.nambin.moviecuration.ui.curation

import com.nambin.moviecuration.core.movieEntryOf
import org.junit.Assert.assertEquals
import org.junit.Test

class CurationUiUtilsTest {

    @Test
    fun `korean-language film shows its original title`() {
        val entry = movieEntryOf(
            "tmdb_title" to "Parasite",
            "tmdb_original_title" to "기생충",
            "tmdb_original_language" to "Korean",
            "year" to 2019,
        )
        assertEquals("기생충 (2019)", displayTitle(entry))
    }

    @Test
    fun `non-korean film ignores custom_korean_title for display`() {
        val entry = movieEntryOf(
            "tmdb_title" to "Amelie",
            "tmdb_original_title" to "Le Fabuleux Destin d'Amélie Poulain",
            "tmdb_original_language" to "French",
            "custom_korean_title" to "아멜리에",
            "year" to 2001,
        )
        assertEquals("Amelie (2001)", displayTitle(entry))
    }

    @Test
    fun `non-korean film without custom_korean_title keeps tmdb_title`() {
        val entry = movieEntryOf(
            "tmdb_title" to "The Godfather",
            "tmdb_original_title" to "The Godfather",
            "tmdb_original_language" to "English",
            "year" to 1972,
        )
        assertEquals("The Godfather (1972)", displayTitle(entry))
    }

    @Test
    fun `falls back to tmdb_original_title when tmdb_title is blank`() {
        val entry = movieEntryOf(
            "tmdb_title" to "",
            "tmdb_original_title" to "Sample",
            "tmdb_original_language" to "English",
            "year" to 2020,
        )
        assertEquals("Sample (2020)", displayTitle(entry))
    }

    @Test
    fun `untitled without year`() {
        val entry = movieEntryOf("tmdb_original_language" to "English")
        assertEquals("(untitled)", displayTitle(entry))
    }
}
