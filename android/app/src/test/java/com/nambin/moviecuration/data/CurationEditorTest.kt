package com.nambin.moviecuration.data

import com.nambin.moviecuration.core.MovieEntry
import com.nambin.moviecuration.core.TmdbCandidate
import com.nambin.moviecuration.core.TmdbMovieDetails
import com.nambin.moviecuration.core.movieEntryOf
import com.nambin.moviecuration.github.GitHubContentsClient
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
import java.util.Base64

/**
 * Exercises the repository+session choreography CurationEditor owns —
 * addNew, swapCandidate, the update methods, buildReviewChanges, commit —
 * seeding MovieRepository directly (no network fetch needed, since
 * MovieRepository.add() is public production API). Only commit() needs a
 * MockWebServer.
 */
class CurationEditorTest {

    private lateinit var server: MockWebServer
    private lateinit var repository: MovieRepository
    private lateinit var editor: CurationEditor

    private fun b64(s: String) = Base64.getEncoder().encodeToString(s.toByteArray(Charsets.UTF_8))

    private fun entry(imdbId: String, vararg extra: Pair<String, Any?>): MovieEntry =
        movieEntryOf("imdb_id" to imdbId, "title" to imdbId, *extra)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        repository = MovieRepository(client = OkHttpClient())
        val gitHubClient = GitHubContentsClient(
            client = OkHttpClient(),
            owner = "nambin",
            repo = "nambin.github.io",
            branch = "main",
            token = "test-token",
            apiBaseUrl = server.url("/").toString().removeSuffix("/"),
        )
        editor = CurationEditor(repository = repository, gitHubClient = gitHubClient)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    // -- addNew ---------------------------------------------------------------

    @Test
    fun `addNew inserts a fresh entry and marks it new`() {
        val e = entry("tt1")
        val outcome = editor.addNew(e)
        assertTrue(outcome is AddOutcome.Added)
        assertEquals("tt1", (outcome as AddOutcome.Added).imdbId)
        assertTrue(e in repository.movies)
        assertEquals(1, editor.newCount)
    }

    @Test
    fun `addNew returns Duplicate and does not insert when imdb_id already exists`() {
        val existing = entry("tt1")
        editor.addNew(existing)
        val duplicateAttempt = entry("tt1", "title" to "a different title")

        val outcome = editor.addNew(duplicateAttempt)

        assertTrue(outcome is AddOutcome.Duplicate)
        assertSame(existing, (outcome as AddOutcome.Duplicate).existing)
        assertEquals(1, repository.movies.size)
        assertEquals(1, editor.newCount)
    }

    // -- swapCandidate ----------------------------------------------------------

    @Test
    fun `swapCandidate carries over user edits and replaces the entry`() {
        val current = entry("tt1")
        editor.addNew(current)
        current["custom_korean_title"] = "기생충"
        current["note"] = "great film"
        current["masterpiece"] = true
        current["date_committed"] = "2026-01-01"

        val candidate = entry("tt2")
        val outcome = editor.swapCandidate(current, candidate)

        assertTrue(outcome is AddOutcome.Added)
        assertEquals("tt2", (outcome as AddOutcome.Added).imdbId)
        assertFalse(current in repository.movies)
        assertTrue(candidate in repository.movies)
        assertEquals("기생충", candidate["custom_korean_title"])
        assertEquals("great film", candidate["note"])
        assertEquals(true, candidate["masterpiece"])
        assertEquals("2026-01-01", candidate["date_committed"])
        assertEquals(1, editor.newCount) // old retired, new marked — net unchanged
    }

    @Test
    fun `swapCandidate retires the old entry even when the new candidate is a duplicate`() {
        val alreadyCurated = entry("tt2")
        editor.addNew(alreadyCurated)
        val current = entry("tt1")
        editor.addNew(current)

        val candidate = entry("tt2") // collides with the already-curated entry
        val outcome = editor.swapCandidate(current, candidate)

        assertTrue(outcome is AddOutcome.Duplicate)
        assertFalse(current in repository.movies)
        assertEquals(1, editor.newCount) // only `alreadyCurated` remains marked new
    }

    // -- discardNew / revertUpdate ------------------------------------------------

    @Test
    fun `discardNew retires an uncommitted addition and makes it re-addable`() {
        val e = entry("tt1")
        editor.addNew(e)

        editor.discardNew(e)

        assertFalse(e in repository.movies)
        assertEquals(0, editor.newCount)
        assertTrue(editor.buildReviewChanges().isEmpty())
        assertTrue(editor.addNew(entry("tt1")) is AddOutcome.Added)
    }

    @Test
    fun `revertUpdate restores the snapshot in place and un-marks the entry`() {
        val e = entry("tt1", "director" to "Bong Joon Ho")
        repository.add(e)
        editor.updateDirector("tt1", "Park Chan-wook")
        editor.updateNote("tt1", "rewatch")
        assertEquals(1, editor.updateCount)

        editor.revertUpdate("tt1")

        assertEquals(0, editor.updateCount)
        assertSame(e, repository.findByImdbId("tt1")) // same object, reverted in place
        assertEquals("Bong Joon Ho", e["director"])
        assertFalse(e.containsKey("note"))
        assertTrue(editor.buildReviewChanges().isEmpty())
    }

    @Test
    fun `revertUpdate is a no-op when the entry was never edited`() {
        val e = entry("tt1", "director" to "Bong Joon Ho")
        repository.add(e)

        editor.revertUpdate("tt1") // no snapshot exists

        assertEquals(0, editor.updateCount)
        assertEquals("Bong Joon Ho", e["director"])
    }

    // -- alreadyCuratedCandidateIds -----------------------------------------------

    @Test
    fun `alreadyCuratedCandidateIds flags candidates whose imdb_id already exists`() {
        editor.addNew(entry("tt1"))
        val candidates = listOf(
            TmdbCandidate(
                id = 1, title = "A", originalTitle = "A", releaseDate = null, popularity = null,
                details = TmdbMovieDetails(id = 101, imdb_id = "tt1"),
            ),
            TmdbCandidate(
                id = 2, title = "B", originalTitle = "B", releaseDate = null, popularity = null,
                details = TmdbMovieDetails(id = 102, imdb_id = "tt2"),
            ),
        )
        assertEquals(setOf(1), editor.alreadyCuratedCandidateIds(candidates))
    }

    // -- update* ----------------------------------------------------------------

    @Test
    fun `updateDirector mutates the field and derives is_korean_director`() {
        val e = entry("tt1", "director" to "")
        repository.add(e) // pre-existing entry, not tracked as new

        val changed = editor.updateDirector("tt1", "봉준호")

        assertTrue(changed)
        assertEquals("봉준호", e["director"])
        assertEquals(true, e["is_korean_director"])
        assertEquals(1, editor.updateCount)
    }

    @Test
    fun `updateDirector is a no-op when the value is unchanged`() {
        val e = entry("tt1", "director" to "Bong Joon Ho")
        repository.add(e)

        assertFalse(editor.updateDirector("tt1", "Bong Joon Ho"))
        assertEquals(0, editor.updateCount)
    }

    @Test
    fun `updateRating reverting to the original value un-marks the entry as updated`() {
        val e = entry("tt1")
        repository.add(e)

        assertTrue(editor.updateRating("tt1", "masterpiece"))
        assertEquals(1, editor.updateCount)

        assertTrue(editor.updateRating("tt1", ""))
        assertEquals(0, editor.updateCount)
    }

    @Test
    fun `updateNote trims input and removes the key entirely when cleared`() {
        val e = entry("tt1")
        repository.add(e)

        assertTrue(editor.updateNote("tt1", "  rewatch candidate  "))
        assertEquals("rewatch candidate", e["note"])

        assertTrue(editor.updateNote("tt1", "   "))
        assertFalse(e.containsKey("note"))
        assertEquals(0, editor.updateCount)
    }

    // -- buildReviewChanges -------------------------------------------------------

    @Test
    fun `buildReviewChanges lists new entries and updated entries with non-empty diffs`() {
        editor.addNew(entry("tt1"))

        val existing = entry("tt2", "director" to "Bong Joon Ho")
        repository.add(existing)
        editor.updateDirector("tt2", "Park Chan-wook")

        val changes = editor.buildReviewChanges()

        assertEquals(2, changes.size)
        assertTrue(changes.any { it.imdbId == "tt1" && it.isNew })
        val updated = changes.find { it.imdbId == "tt2" }
        assertNotNull(updated)
        assertFalse(updated!!.isNew)
        assertTrue(updated.diffs.any { it.label == "Director" })
    }

    @Test
    fun `buildReviewChanges omits updated entries whose diff is empty`() {
        val existing = entry("tt1", "director" to "Bong Joon Ho")
        repository.add(existing)
        editor.ensureSnapshot("tt1", existing)
        // No field mutation ever ran, so tt1 was never added to updatedImdbIds.
        assertTrue(editor.buildReviewChanges().isEmpty())
    }

    // -- commit -------------------------------------------------------------------

    @Test
    fun `commit succeeds, clears the session, and returns a summary`() = runTest {
        editor.addNew(entry("tt1"))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.method) {
                "GET" -> MockResponse().setResponseCode(200).setBody("""{"content": "${b64("[]")}", "sha": "sha-1"}""")
                "PUT" -> MockResponse().setResponseCode(200)
                    .setBody("""{"commit": {"html_url": "https://example.com/commit"}}""")
                else -> MockResponse().setResponseCode(404)
            }
        }

        val outcome = editor.commit()

        assertTrue(outcome is CommitAttemptOutcome.Success)
        assertEquals(0, editor.newCount)
        assertEquals(0, editor.updateCount)
    }

    @Test
    fun `commit aborts with DuplicateImdbIds when the repository has a collision`() = runTest {
        // add() does not itself dedupe — addNew()'s findDuplicate check is the
        // caller's responsibility, so this simulates a data-sanity slip getting
        // caught by commit()'s defensive re-check.
        repository.add(entry("tt1"))
        repository.add(entry("tt1"))

        val outcome = editor.commit()

        assertTrue(outcome is CommitAttemptOutcome.DuplicateImdbIds)
        assertEquals(listOf("tt1"), (outcome as CommitAttemptOutcome.DuplicateImdbIds).imdbIds)
    }

    // -- computeCollectionStats ---------------------------------------------------

    private fun film(imdbId: String, director: String?, year: Int): MovieEntry {
        val e = movieEntryOf("imdb_id" to imdbId, "tmdb_title" to "T-$imdbId", "year" to year)
        if (director != null) e["director"] = director
        return e
    }

    @Test
    fun `computeCollectionStats counts every entry and ranks directors by film count`() {
        val stats = computeCollectionStats(
            listOf(
                film("tt1", "Bong", 2020), film("tt2", "Bong", 2010), film("tt3", "Bong", 2000),
                film("tt4", "Park", 2022), film("tt5", "Park", 2012),
                film("tt6", "Kim", 2021),
            ),
        )

        assertEquals(6, stats.totalMovies)
        // Bong's 3 films outrank Park's 2 even though Park's latest is newer.
        assertEquals(listOf("Bong", "Park", "Kim"), stats.topDirectors.map { it.director })
        assertEquals(listOf(2, 1, 0), stats.topDirectors.map { it.moreCount })
    }

    @Test
    fun `computeCollectionStats picks the canonically-first film as latest, regardless of input order`() {
        val older = film("tt1", "Bong", 2003)
        val newest = film("tt2", "Bong", 2019)
        val middle = film("tt3", "Bong", 2013)

        val stats = computeCollectionStats(listOf(older, newest, middle))

        // Same live object, not a copy — the UI opens it for editing directly.
        assertSame(newest, stats.topDirectors.single().latestEntry)
    }

    @Test
    fun `computeCollectionStats caps the list at seven directors`() {
        val movies = (1..8).map { film("tt$it", "d$it", 2026 - it) }

        val stats = computeCollectionStats(movies)

        assertEquals(8, stats.totalMovies)
        assertEquals((1..7).map { "d$it" }, stats.topDirectors.map { it.director })
    }

    @Test
    fun `computeCollectionStats breaks count ties by canonical collection order`() {
        val stats = computeCollectionStats(
            listOf(
                film("tt1", "Park", 2020), film("tt2", "Park", 2010),
                film("tt3", "Lee", 2022), film("tt4", "Lee", 2001),
            ),
        )

        // Both have 2 films; Lee's 2022 film puts Lee first in canonical order.
        assertEquals(listOf("Lee", "Park"), stats.topDirectors.map { it.director })
    }

    @Test
    fun `computeCollectionStats counts director-less entries in the total but gives them no line`() {
        val stats = computeCollectionStats(
            listOf(film("tt1", "Bong", 2020), film("tt2", null, 2019), film("tt3", "", 2018)),
        )

        assertEquals(3, stats.totalMovies)
        assertEquals(listOf("Bong"), stats.topDirectors.map { it.director })
    }

    @Test
    fun `loadFromServer computes the boot-time stats snapshot`() = runTest {
        val moviesYaml = """
            - title: Parasite
              year: 2019
              director: 봉준호
              imdb_id: tt6751668
            - title: Memories of Murder
              year: 2003
              director: 봉준호
              imdb_id: tt0353969
            - title: Oldboy
              year: 2003
              director: 박찬욱
              imdb_id: tt0364569
        """.trimIndent()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path!!.startsWith("/movies.yml") -> MockResponse().setBody(moviesYaml)
                request.path!!.startsWith("/awards.yml") -> MockResponse().setBody("by_imdb: {}")
                else -> MockResponse().setResponseCode(404)
            }
        }
        val statsEditor = CurationEditor(
            repository = MovieRepository(
                client = OkHttpClient(),
                moviesUrl = server.url("/movies.yml").toString(),
                awardsUrl = server.url("/awards.yml").toString(),
            ),
            gitHubClient = GitHubContentsClient(
                client = OkHttpClient(), owner = "nambin", repo = "nambin.github.io", branch = "main",
                token = "test-token", apiBaseUrl = server.url("/").toString().removeSuffix("/"),
            ),
        )

        statsEditor.loadFromServer()

        assertEquals(3, statsEditor.collectionStats.totalMovies)
        assertEquals(listOf("봉준호", "박찬욱"), statsEditor.collectionStats.topDirectors.map { it.director })
        assertEquals("Parasite", statsEditor.collectionStats.topDirectors[0].latestEntry["title"])
        assertEquals(1, statsEditor.collectionStats.topDirectors[0].moreCount)
    }
}
