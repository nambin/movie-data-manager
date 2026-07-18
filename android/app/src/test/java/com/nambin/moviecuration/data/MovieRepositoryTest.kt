package com.nambin.moviecuration.data

import com.nambin.moviecuration.core.movieEntryOf
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Exercises loadFromServer() (concurrent fetch), search, and duplicate-detection against a local MockWebServer. */
class MovieRepositoryTest {

    private lateinit var server: MockWebServer
    private lateinit var repository: MovieRepository

    private val moviesYaml = """
        - title: Parasite
          year: 2019
          director: 봉준호
          is_korean_director: true
          imdb_id: tt6751668
          imdb_url: https://www.imdb.com/title/tt6751668
          tmdb_url: https://www.themoviedb.org/movie/496243
          tmdb_title: null
          tmdb_original_title: 기생충
          tmdb_original_language: Korean
          tmdb_director_name_1: Bong Joon Ho
          tmdb_director_name_2: null
          tmdb_num_directors: 1
          tmdb_poster_url: null
        - title: Oppenheimer
          year: 2023
          director: Christopher Nolan
          is_korean_director: false
          imdb_id: tt15398776
          imdb_url: https://www.imdb.com/title/tt15398776
          tmdb_url: https://www.themoviedb.org/movie/872585
          tmdb_title: null
          tmdb_original_title: Oppenheimer
          tmdb_original_language: English
          tmdb_director_name_1: Christopher Nolan
          tmdb_director_name_2: null
          tmdb_num_directors: 1
          tmdb_poster_url: null
        - title: Oldboy
          year: 2003
          director: 박찬욱
          is_korean_director: true
          imdb_id: tt0364569
          imdb_url: https://www.imdb.com/title/tt0364569
          tmdb_url: https://www.themoviedb.org/movie/670
          tmdb_title: null
          tmdb_original_title: 올드보이
          tmdb_original_language: Korean
          tmdb_director_name_1: Park Chan-wook
          tmdb_director_name_2: null
          tmdb_num_directors: 1
          tmdb_poster_url: null
        - title: Anora
          year: 2024
          director: Sean Baker
          is_korean_director: false
          imdb_id: tt28607951
          imdb_url: https://www.imdb.com/title/tt28607951
          tmdb_url: https://www.themoviedb.org/movie/1064213
          tmdb_title: null
          tmdb_original_title: Anora
          tmdb_original_language: English
          tmdb_director_name_1: Sean Baker
          tmdb_director_name_2: null
          tmdb_num_directors: 1
          tmdb_poster_url: null
    """.trimIndent()

    private val awardsYaml = """
        generated_at: '2026-01-01'
        by_imdb:
          tt6751668:
            tmdb_id: 496243
            title: Parasite
            award_names:
              - Cannes Palme d'Or
            awards:
              - cannes
          tt0364569:
            tmdb_id: 670
            title: Oldboy
            award_names:
              - Cannes Grand Prix
              - Baeksang Best Film
            awards:
              - cannes
              - baeksang
    """.trimIndent()

    @Before
    fun setUp() {
        server = MockWebServer()
        // The two fetches inside loadFromServer() run concurrently, so a plain
        // FIFO enqueue() would be a race between which file lands first —
        // dispatch by path instead.
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path?.startsWith("/movies.yml") == true -> MockResponse().setResponseCode(200).setBody(moviesYaml)
                request.path?.startsWith("/awards.yml") == true -> MockResponse().setResponseCode(200).setBody(awardsYaml)
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        repository = MovieRepository(
            client = OkHttpClient(),
            moviesUrl = server.url("/movies.yml").toString(),
            awardsUrl = server.url("/awards.yml").toString(),
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `loadFromServer parses movies and awards and builds the Korean director map`() = runTest {
        repository.loadFromServer()
        assertEquals(4, repository.movies.size)
        assertEquals("봉준호", repository.koreanDirectorMap["Bong Joon Ho"])
        assertEquals("박찬욱", repository.koreanDirectorMap["Park Chan-wook"])
        assertEquals(listOf("Cannes Palme d'Or"), repository.awardsByImdb["tt6751668"])
        assertEquals(listOf("Cannes Grand Prix", "Baeksang Best Film"), repository.awardsByImdb["tt0364569"])
        assertNull(repository.awardsByImdb["tt28607951"]) // Anora has no awards.yml entry
    }

    @Test
    fun `findDuplicate matches by imdb_id first`() = runTest {
        repository.loadFromServer()
        val candidate = movieEntryOf("imdb_id" to "tt6751668", "tmdb_url" to "https://www.themoviedb.org/movie/999")
        assertEquals("Parasite", repository.findDuplicate(candidate)?.get("title"))
    }

    @Test
    fun `findDuplicate falls back to tmdb_url when imdb_id has no match`() = runTest {
        repository.loadFromServer()
        val candidate = movieEntryOf("imdb_id" to "tt0000000", "tmdb_url" to "https://www.themoviedb.org/movie/872585")
        assertEquals("Oppenheimer", repository.findDuplicate(candidate)?.get("title"))
    }

    @Test
    fun `findDuplicate returns null when nothing matches`() = runTest {
        repository.loadFromServer()
        val candidate = movieEntryOf("imdb_id" to "tt0000000", "tmdb_url" to "https://www.themoviedb.org/movie/1")
        assertNull(repository.findDuplicate(candidate))
    }

    @Test
    fun `search matches across title, director, year, and language`() = runTest {
        repository.loadFromServer()
        assertEquals(1, repository.search("parasite").size)
        assertEquals(1, repository.search("봉준호").size)
        assertEquals(1, repository.search("2023").size)
        assertEquals(2, repository.search("korean").size) // Parasite and Oldboy are both tmdb_original_language: Korean
        assertEquals(0, repository.search("nonexistent movie title xyz").size)
    }

    @Test
    fun `search is case-insensitive and a blank query returns nothing`() = runTest {
        repository.loadFromServer()
        assertEquals(1, repository.search("PARASITE").size)
        assertEquals(0, repository.search("   ").size)
    }

    @Test
    fun `add inserts the entry and refreshes koreanDirectorMap without a separate rebuild call`() = runTest {
        repository.loadFromServer()
        val entry = movieEntryOf(
            "imdb_id" to "tt9999999",
            "director" to "이창동",
            "is_korean_director" to true,
            "tmdb_director_name_1" to "Lee Chang-dong",
        )
        repository.add(entry)
        assertEquals(5, repository.movies.size)
        assertTrue(entry in repository.movies)
        assertEquals("이창동", repository.koreanDirectorMap["Lee Chang-dong"])
    }

    @Test
    fun `remove drops the entry and refreshes koreanDirectorMap without a separate rebuild call`() = runTest {
        repository.loadFromServer()
        val parasite = repository.findByImdbId("tt6751668")!!
        assertEquals("봉준호", repository.koreanDirectorMap["Bong Joon Ho"])

        repository.remove(parasite)

        assertEquals(3, repository.movies.size)
        assertFalse(parasite in repository.movies)
        assertNull(repository.koreanDirectorMap["Bong Joon Ho"])
    }
}
