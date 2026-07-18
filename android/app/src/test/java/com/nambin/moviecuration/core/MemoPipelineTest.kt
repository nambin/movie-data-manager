package com.nambin.moviecuration.core

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/**
 * End-to-end tests for processMemoLine's main branches, against a local
 * MockWebServer standing in for both Gemini and TMDB (both hardcode their
 * hosts, so requests are redirected via an interceptor rather than making
 * the endpoints configurable in production code). Dispatch is by request
 * *path* rather than FIFO order, since a memo line with a year fires three
 * concurrent TMDB searches (year, year+1, year-1) whose arrival order isn't
 * guaranteed.
 */
class MemoPipelineTest {

    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient

    private fun loadFixtureText(name: String): String {
        val stream = javaClass.classLoader!!.getResourceAsStream("fixtures/$name.json")
            ?: error("fixture not found: $name")
        return stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }

    /** Dispatcher helper for a candidate id whose TMDB details were never captured (real API 404). */
    private fun MockResponse.asNotFound() = setResponseCode(404)

    /** The handful of built-entry fields worth asserting for one candidate. */
    private data class EntrySummary(
        val title: String?,
        val director: String?,
        val isKoreanDirector: Boolean?,
        val year: Int?,
        val imdbId: String?,
    )

    private fun MovieEntry.summary() = EntrySummary(
        title = this["title"] as? String,
        director = this["director"] as? String,
        isKoreanDirector = this["is_korean_director"] as? Boolean,
        year = this["year"] as? Int,
        imdbId = this["imdb_id"] as? String,
    )

    /**
     * Every [MemoPipelineResult.Ok] attribute any test in this file cares
     * about, in one comparable struct — `null` for any other result type.
     * `entriesByCandidateId` covers *every* surviving candidate's own
     * pre-built entry, not just the selected one — `selectedEntry` was
     * dropped in favor of this because it only verified the one candidate
     * Call B happened to pick, silently skipping whether every other
     * candidate's entry was *also* built correctly.
     */
    private data class OkSummary(
        val selectedCandidateId: Int,
        val confidence: String,
        val entriesByCandidateId: Map<Int, EntrySummary>,
    )

    private fun MemoPipelineResult.okSummary(): OkSummary? = when (this) {
        is MemoPipelineResult.Ok -> OkSummary(
            selectedCandidateId = selectedCandidateId,
            confidence = matchResult.confidence,
            entriesByCandidateId = entriesByCandidateId.mapValues { (_, entry) -> entry.summary() },
        )
        else -> null
    }

    private fun startServerWithDispatcher(dispatcher: Dispatcher) {
        server = MockWebServer()
        server.dispatcher = dispatcher
        server.start()
        val serverUrl = server.url("/")
        client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val original = chain.request()
                val redirected = original.url.newBuilder()
                    .scheme(serverUrl.scheme)
                    .host(serverUrl.host)
                    .port(serverUrl.port)
                    .build()
                chain.proceed(original.newBuilder().url(redirected).build())
            }
            .build()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `processMemoLine resolves a confident match end-to-end`() = runTest {
        val parasiteFixture = loadFixtureText("tmdb-parasite")
        var geminiCallCount = 0

        startServerWithDispatcher(object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath ?: ""
                return when {
                    path.contains("generateContent") -> {
                        geminiCallCount++
                        if (geminiCallCount == 1) {
                            // Call A
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"is_movie\":true,\"title\":\"Parasite\",\"year\":2019}"}]}}]}""",
                            )
                        } else {
                            // Call B
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"matched_tmdb_id\":496243,\"confidence\":\"high\",\"reasoning\":\"Exact match.\"}"}]}}]}""",
                            )
                        }
                    }
                    path.contains("/search/movie") -> MockResponse().setResponseCode(200).setBody(
                        """{"results":[{"id":496243,"title":"Parasite","original_title":"기생충","release_date":"2019-05-30","popularity":80.0}]}""",
                    )
                    path.contains("/movie/496243") -> MockResponse().setResponseCode(200).setBody(parasiteFixture)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        })

        val result = processMemoLine(
            rawLine = "Parasite 2019",
            geminiApiKey = "test-key",
            tmdbApiKey = "test-key",
            koreanDirectorMap = mapOf("Bong Joon Ho" to "봉준호"),
            geminiModel = GeminiModelTier.FLASH,
            client = client,
        )

        assertEquals(
            OkSummary(
                selectedCandidateId = 496243,
                confidence = "high",
                entriesByCandidateId = mapOf(
                    496243 to EntrySummary(
                        title = "Parasite (기생충)",
                        director = "봉준호", // resolved via the Korean-director map
                        isKoreanDirector = true,
                        year = 2019,
                        imdbId = "tt6751668",
                    ),
                ),
            ),
            result.okSummary(),
        )
        // 1 (Call A)
        // + 3 (TMDB search fired in parallel)
        // + 1 (enrichCandidatesForMatch fetching that one deduped candidate's details)
        // + 1 (Call B)
        assertEquals(6, server.requestCount)
    }

    @Test
    fun `processMemoLine returns NotMovie when Call A says so, without any TMDB call`() = runTest {
        startServerWithDispatcher(object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath ?: ""
                return if (path.contains("generateContent")) {
                    MockResponse().setResponseCode(200).setBody(
                        """{"candidates":[{"content":{"parts":[{"text":"{\"is_movie\":false}"}]}}]}""",
                    )
                } else {
                    MockResponse().setResponseCode(500) // should never be hit
                }
            }
        })

        val result = processMemoLine("watched with J", "test-key", "test-key", emptyMap(), GeminiModelTier.FLASH, client)
        assertTrue(result is MemoPipelineResult.NotMovie)
        assertEquals(1, server.requestCount) // only Call A fired
    }

    @Test
    fun `processMemoLine returns NoMatch when TMDB search returns zero results`() = runTest {
        startServerWithDispatcher(object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath ?: ""
                return when {
                    path.contains("generateContent") -> MockResponse().setResponseCode(200).setBody(
                        """{"candidates":[{"content":{"parts":[{"text":"{\"is_movie\":true,\"title\":\"Some Obscure Title\"}"}]}}]}""",
                    )
                    path.contains("/search/movie") -> MockResponse().setResponseCode(200).setBody("""{"results":[]}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        })

        val result = processMemoLine("some obscure title", "test-key", "test-key", emptyMap(), GeminiModelTier.FLASH, client)
        assertTrue(result is MemoPipelineResult.NoMatch)
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `processMemoLine defaults to the top candidate when Call B is not confident`() = runTest {
        startServerWithDispatcher(object : Dispatcher() {
            var geminiCallCount = 0
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath ?: ""
                return when {
                    path.contains("generateContent") -> {
                        geminiCallCount++
                        if (geminiCallCount == 1) {
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"is_movie\":true,\"title\":\"Common Title\"}"}]}}]}""",
                            )
                        } else {
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"matched_tmdb_id\":null,\"confidence\":\"low\",\"reasoning\":\"None of these look right.\"}"}]}}]}""",
                            )
                        }
                    }
                    path.contains("/search/movie") -> MockResponse().setResponseCode(200).setBody(
                        """{"results":[{"id":1,"title":"Common Title","original_title":"Common Title","release_date":"2001-01-01","popularity":1.0}]}""",
                    )
                    path.contains("/movie/1") -> MockResponse().setResponseCode(200).setBody(
                        """{"id":1,"title":"Common Title","original_title":"Common Title","original_language":"en","release_date":"2001-01-01","poster_path":null,"imdb_id":"tt0000001","credits":{"crew":[]}}""",
                    )
                    else -> MockResponse().setResponseCode(404)
                }
            }
        })

        val result = processMemoLine("common title", "test-key", "test-key", emptyMap(), GeminiModelTier.FLASH, client)
        // Call B declined (matched_tmdb_id: null), so selectedCandidateId
        // defaults to the top (only) candidate — its entry was already
        // pre-built along with every other candidate's, same as if Call B
        // had confidently picked it; the candidate picker lets the user swap.
        assertEquals(
            OkSummary(
                selectedCandidateId = 1,
                confidence = "low",
                entriesByCandidateId = mapOf(
                    1 to EntrySummary(
                        title = "Common Title",
                        director = "", // no Director in the mocked credits.crew
                        isKoreanDirector = false,
                        year = 2001,
                        imdbId = "tt0000001",
                    ),
                ),
            ),
            result.okSummary(),
        )
        assertEquals(4, server.requestCount)
    }

    // Ported from tests/memo_pipeline.test.js's "Bohemian Rhapsody with NO
    // year" scenario: when Call A returns no year, tmdbSearch must fire
    // exactly ONE search (no year±1 offset expansion), and that search must
    // omit primary_release_year entirely.
    @Test
    fun `processMemoLine with no year fires exactly one TMDB search and no primary_release_year param`() = runTest {
        val noYearSearch = loadFixtureText("memo/search-bohemian-rhapsody-no-year")
        val bohemianDetails = loadFixtureText("tmdb-bohemian-rhapsody")
        var geminiCallCount = 0

        startServerWithDispatcher(object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath ?: ""
                return when {
                    path.contains("generateContent") -> {
                        geminiCallCount++
                        if (geminiCallCount == 1) {
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"is_movie\":true,\"title\":\"Bohemian Rhapsody\"}"}]}}]}""",
                            )
                        } else {
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"matched_tmdb_id\":424694,\"confidence\":\"high\",\"reasoning\":\"most popular match\"}"}]}}]}""",
                            )
                        }
                    }
                    path.contains("/search/movie") -> MockResponse().setResponseCode(200).setBody(noYearSearch)
                    path.contains("/movie/424694") -> MockResponse().setResponseCode(200).setBody(bohemianDetails)
                    path.startsWith("/movie/") -> MockResponse().asNotFound() // other candidates: no captured fixture
                    else -> MockResponse().setResponseCode(404)
                }
            }
        })

        val result = processMemoLine("Bohemian Rhapsody", "test-key", "test-key", emptyMap(), GeminiModelTier.FLASH, client)

        assertEquals(
            // Only candidate 424694 has a captured fixture; every other raw
            // search result 404s on its details fetch and is excluded, so
            // it's the only candidate regardless of how many the search
            // fixture returned.
            OkSummary(
                selectedCandidateId = 424694,
                confidence = "high",
                entriesByCandidateId = mapOf(
                    424694 to EntrySummary(
                        title = "Bohemian Rhapsody",
                        director = "Bryan Singer",
                        isKoreanDirector = false,
                        year = 2018,
                        imdbId = "tt1727824",
                    ),
                ),
            ),
            result.okSummary(),
        )

        val searchRequests = server.requestCount.let { count ->
            (0 until count).map { server.takeRequest() }.filter { it.requestUrl?.encodedPath?.contains("/search/movie") == true }
        }
        assertEquals("no-year path must fire exactly one TMDB search", 1, searchRequests.size)
        assertFalse(
            "no-year search should omit primary_release_year",
            searchRequests[0].requestUrl?.queryParameterNames?.contains("primary_release_year") == true,
        )
    }

    // Ported from tests/memo_pipeline.test.js's "Korean phonetic with
    // off-by-one year (I'm Still Here / Ainda Estou Aqui)" regression test.
    // Call A parses year=2025, but the real release is 2024 — the year-1
    // offset search must still surface the correct candidate, and the built
    // entry's year comes from TMDB (2024), not Call A's guess (2025).
    @Test
    fun `processMemoLine resolves an off-by-one-year match (Ainda Estou Aqui)`() = runTest {
        val search2024 = loadFixtureText("memo/search-im-still-here-2024")
        val search2025 = loadFixtureText("memo/search-im-still-here-2025")
        val search2026 = loadFixtureText("memo/search-im-still-here-2026")
        val aindaDetails = loadFixtureText("tmdb-ainda-estou-aqui")
        var geminiCallCount = 0

        startServerWithDispatcher(object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath ?: ""
                val year = request.requestUrl?.queryParameter("primary_release_year")
                return when {
                    path.contains("generateContent") -> {
                        geminiCallCount++
                        if (geminiCallCount == 1) {
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"is_movie\":true,\"title\":\"I'm Still Here\",\"year\":2025}"}]}}]}""",
                            )
                        } else {
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"matched_tmdb_id\":1000837,\"confidence\":\"high\",\"reasoning\":\"the Brazilian film by Walter Salles, year is off by one\"}"}]}}]}""",
                            )
                        }
                    }
                    path.contains("/search/movie") && year == "2024" -> MockResponse().setResponseCode(200).setBody(search2024)
                    path.contains("/search/movie") && year == "2025" -> MockResponse().setResponseCode(200).setBody(search2025)
                    path.contains("/search/movie") && year == "2026" -> MockResponse().setResponseCode(200).setBody(search2026)
                    path.contains("/movie/1000837") -> MockResponse().setResponseCode(200).setBody(aindaDetails)
                    path.startsWith("/movie/") -> MockResponse().asNotFound() // other candidates: no captured fixture
                    else -> MockResponse().setResponseCode(404)
                }
            }
        })

        val result = processMemoLine("아임 스틸 히어 2025", "test-key", "test-key", emptyMap(), GeminiModelTier.FLASH, client)

        assertEquals(
            // Same reasoning as the no-year test: only 1000837 has a
            // captured details fixture, so it's the only surviving candidate.
            OkSummary(
                selectedCandidateId = 1000837,
                confidence = "high",
                entriesByCandidateId = mapOf(
                    1000837 to EntrySummary(
                        title = "I'm Still Here (Ainda Estou Aqui)",
                        director = "Walter Salles",
                        isKoreanDirector = false,
                        year = 2024, // from TMDB release_date, not Call A's 2025
                        imdbId = "tt14961016",
                    ),
                ),
            ),
            result.okSummary(),
        )
    }

    // Ported from tests/memo_pipeline.test.js's "drops enriched candidates
    // without an imdb_id before Call B" — a candidate whose details carry no
    // imdb_id can never become an entry, so it must never reach the matcher
    // or the caller-visible candidate list. Stricter than the JS reference
    // on one point, though: a candidate whose details fetch merely *failed*
    // (imdb_id unknown, not confirmed absent) is excluded here too, not kept
    // per JS's "unknown is neutral" three-state design — see the deliberate
    // divergence noted in prompt-android-app.md's "Ported logic" section.
    @Test
    fun `processMemoLine drops enriched candidates without an imdb_id before Call B`() = runTest {
        val searchResults = loadFixtureText("memo/search-imdb-filter")
        val details111 = loadFixtureText("memo/details-no-imdb-111")
        val details222 = loadFixtureText("memo/details-with-imdb-222")

        startServerWithDispatcher(object : Dispatcher() {
            var geminiCallCount = 0
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath ?: ""
                return when {
                    path.contains("generateContent") -> {
                        geminiCallCount++
                        if (geminiCallCount == 1) {
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"is_movie\":true,\"title\":\"Real Film\"}"}]}}]}""",
                            )
                        } else {
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"matched_tmdb_id\":222,\"confidence\":\"high\",\"reasoning\":\"the saveable candidate with an imdb_id\"}"}]}}]}""",
                            )
                        }
                    }
                    path.contains("/search/movie") -> MockResponse().setResponseCode(200).setBody(searchResults)
                    path.contains("/movie/111") -> MockResponse().setResponseCode(200).setBody(details111)
                    path.contains("/movie/222") -> MockResponse().setResponseCode(200).setBody(details222)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        })

        val result = processMemoLine("Real Film", "test-key", "test-key", emptyMap(), GeminiModelTier.FLASH, client)

        // The imdb_id-less candidate (111) must never reach the caller-visible list.
        assertEquals(
            OkSummary(
                selectedCandidateId = 222,
                confidence = "high",
                entriesByCandidateId = mapOf(
                    222 to EntrySummary(title = "Real Film", director = "Jane Doe", isKoreanDirector = false, year = 2024, imdbId = "tt2220000"),
                ),
            ),
            result.okSummary(),
        )
    }

    // Verifies MemoPipeline builds a ready-to-show entry for *every*
    // imdb_id-confirmed candidate up front, not just the one Call B picks —
    // every other test in this file happens to end up with exactly one
    // surviving candidate, so none of them would catch a regression back to
    // "only build the selected candidate's entry."
    @Test
    fun `processMemoLine builds an entry for every surviving candidate, not just the selected one`() = runTest {
        startServerWithDispatcher(object : Dispatcher() {
            var geminiCallCount = 0
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath ?: ""
                return when {
                    path.contains("generateContent") -> {
                        geminiCallCount++
                        if (geminiCallCount == 1) {
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"is_movie\":true,\"title\":\"Double Feature\"}"}]}}]}""",
                            )
                        } else {
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"matched_tmdb_id\":502,\"confidence\":\"high\",\"reasoning\":\"the more popular Double Feature\"}"}]}}]}""",
                            )
                        }
                    }
                    path.contains("/search/movie") -> MockResponse().setResponseCode(200).setBody(
                        """{"results":[{"id":501,"title":"Double Feature","original_title":"Double Feature","release_date":"1999-03-12","popularity":2.0},{"id":502,"title":"Double Feature","original_title":"Double Feature","release_date":"2010-07-04","popularity":9.0}]}""",
                    )
                    path.contains("/movie/501") -> MockResponse().setResponseCode(200).setBody(
                        """{"id":501,"title":"Double Feature","original_title":"Double Feature","original_language":"en","release_date":"1999-03-12","poster_path":null,"imdb_id":"tt0000501","credits":{"crew":[{"job":"Director","name":"Ann Director"}]}}""",
                    )
                    path.contains("/movie/502") -> MockResponse().setResponseCode(200).setBody(
                        """{"id":502,"title":"Double Feature","original_title":"Double Feature","original_language":"en","release_date":"2010-07-04","poster_path":null,"imdb_id":"tt0000502","credits":{"crew":[{"job":"Director","name":"Bob Director"}]}}""",
                    )
                    else -> MockResponse().setResponseCode(404)
                }
            }
        })

        val result = processMemoLine("double feature", "test-key", "test-key", emptyMap(), GeminiModelTier.FLASH, client)

        // Both candidates have their own correctly-built entry, even though
        // only 502 was picked — 501's entry isn't a leftover/placeholder,
        // it's independently correct (its own director, its own year).
        assertEquals(
            OkSummary(
                selectedCandidateId = 502,
                confidence = "high",
                entriesByCandidateId = mapOf(
                    501 to EntrySummary(title = "Double Feature", director = "Ann Director", isKoreanDirector = false, year = 1999, imdbId = "tt0000501"),
                    502 to EntrySummary(title = "Double Feature", director = "Bob Director", isKoreanDirector = false, year = 2010, imdbId = "tt0000502"),
                ),
            ),
            result.okSummary(),
        )
    }

    // Combines the two prior tests' concerns: with multiple candidates in
    // play, Korean-director resolution must apply per-candidate — not just
    // to whichever one Call B happens to pick. Deliberately picks the
    // *non*-Korean candidate (602) as the confident match, so the test can
    // only pass if candidate 601's director is resolved via the map even
    // though 601 is never selected.
    @Test
    fun `processMemoLine resolves Korean director names independently across multiple candidates`() = runTest {
        startServerWithDispatcher(object : Dispatcher() {
            var geminiCallCount = 0
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath ?: ""
                return when {
                    path.contains("generateContent") -> {
                        geminiCallCount++
                        if (geminiCallCount == 1) {
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"is_movie\":true,\"title\":\"Mirror Image\"}"}]}}]}""",
                            )
                        } else {
                            MockResponse().setResponseCode(200).setBody(
                                """{"candidates":[{"content":{"parts":[{"text":"{\"matched_tmdb_id\":602,\"confidence\":\"high\",\"reasoning\":\"the more recent adaptation\"}"}]}}]}""",
                            )
                        }
                    }
                    path.contains("/search/movie") -> MockResponse().setResponseCode(200).setBody(
                        """{"results":[{"id":601,"title":"Mirror Image","original_title":"Mirror Image","release_date":"2015-06-01","popularity":3.0},{"id":602,"title":"Mirror Image","original_title":"Mirror Image","release_date":"2020-11-15","popularity":7.0}]}""",
                    )
                    path.contains("/movie/601") -> MockResponse().setResponseCode(200).setBody(
                        """{"id":601,"title":"Mirror Image","original_title":"Mirror Image","original_language":"ko","release_date":"2015-06-01","poster_path":null,"imdb_id":"tt0000601","credits":{"crew":[{"job":"Director","name":"Kim Ji Woo"}]}}""",
                    )
                    path.contains("/movie/602") -> MockResponse().setResponseCode(200).setBody(
                        """{"id":602,"title":"Mirror Image","original_title":"Mirror Image","original_language":"en","release_date":"2020-11-15","poster_path":null,"imdb_id":"tt0000602","credits":{"crew":[{"job":"Director","name":"John Smith"}]}}""",
                    )
                    else -> MockResponse().setResponseCode(404)
                }
            }
        })

        val result = processMemoLine(
            rawLine = "mirror image",
            geminiApiKey = "test-key",
            tmdbApiKey = "test-key",
            koreanDirectorMap = mapOf("Kim Ji Woo" to "김지우"),
            geminiModel = GeminiModelTier.FLASH,
            client = client,
        )

        assertEquals(
            OkSummary(
                selectedCandidateId = 602,
                confidence = "high",
                entriesByCandidateId = mapOf(
                    // Not selected, but still resolved via the Korean-director map.
                    601 to EntrySummary(title = "Mirror Image", director = "김지우", isKoreanDirector = true, year = 2015, imdbId = "tt0000601"),
                    // Selected, and correctly left un-resolved (not in the map).
                    602 to EntrySummary(title = "Mirror Image", director = "John Smith", isKoreanDirector = false, year = 2020, imdbId = "tt0000602"),
                ),
            ),
            result.okSummary(),
        )
    }
}
