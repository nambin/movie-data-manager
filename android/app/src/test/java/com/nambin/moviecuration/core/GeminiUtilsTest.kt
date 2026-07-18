package com.nambin.moviecuration.core

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Exercises the Gemini request/response shape against a local MockWebServer.
 * GeminiUtils.kt hardcodes generativelanguage.googleapis.com, so requests are
 * redirected to the mock server via an OkHttp interceptor rather than making
 * the endpoint itself configurable in production code.
 */
class GeminiUtilsTest {

    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient

    @Before
    fun setUp() {
        server = MockWebServer()
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

    /** Extracts the exact `system_instruction` text from a recorded request body. */
    private fun systemPromptOf(bodyJson: String): String =
        Json.parseToJsonElement(bodyJson).jsonObject["system_instruction"]!!
            .jsonObject["parts"]!!.jsonArray[0].jsonObject["text"]!!.jsonPrimitive.content

    /** Extracts the exact user-prompt text (`contents[0]`) from a recorded request body. */
    private fun userPromptOf(bodyJson: String): String =
        Json.parseToJsonElement(bodyJson).jsonObject["contents"]!!.jsonArray[0]
            .jsonObject["parts"]!!.jsonArray[0].jsonObject["text"]!!.jsonPrimitive.content

    @Test
    fun `parseMemoLine sends the expected request shape and parses the response`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"candidates":[{"content":{"parts":[{"text":"{\"is_movie\":true,\"title\":\"Parasite\",\"year\":2019}"}]}}]}""",
            ),
        )

        val result = parseMemoLine("기생충", "test-key", GeminiModelTier.FLASH, client)

        // CallAResult is a data class, so assertEquals already does full
        // structural comparison in one call — no MovieEntry-style key-order
        // matcher needed here.
        assertEquals(CallAResult(is_movie = true, title = "Parasite", year = 2019), result)

        val recorded = server.takeRequest()
        assertEquals("POST", recorded.method)
        assertTrue(recorded.path?.contains("generateContent") == true)
        assertTrue(recorded.path?.contains("key=test-key") == true)
        val body = recorded.body.readUtf8()
        assertTrue(body.contains("system_instruction"))
        assertTrue(body.contains("responseSchema"))
        assertTrue(body.contains("기생충"))
    }

    @Test
    fun `parseMemoLine sends CALL_A_SYSTEM verbatim as the system instruction`() = runTest {
        // Guards against an accidental prompt edit silently changing Call A's
        // behavior for only one client — see GeminiUtils.kt's file comment on
        // reusing the exact prompt text so match quality doesn't drift.
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"candidates":[{"content":{"parts":[{"text":"{\"is_movie\":false}"}]}}]}""",
            ),
        )
        parseMemoLine("기생충", "test-key", GeminiModelTier.FLASH, client)
        assertEquals(CALL_A_SYSTEM, systemPromptOf(server.takeRequest().body.readUtf8()))
    }

    @Test
    fun `parseMemoLine sends the raw memo line verbatim as the user prompt`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"candidates":[{"content":{"parts":[{"text":"{\"is_movie\":false}"}]}}]}""",
            ),
        )
        val rawLine = "보헤미안 랩소디 (2018)"
        parseMemoLine(rawLine, "test-key", GeminiModelTier.FLASH, client)
        assertEquals(rawLine, userPromptOf(server.takeRequest().body.readUtf8()))
    }

    @Test
    fun `matchTmdbCandidate sends CALL_B_SYSTEM verbatim as the system instruction`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"candidates":[{"content":{"parts":[{"text":"{\"matched_tmdb_id\":null,\"confidence\":\"low\"}"}]}}]}""",
            ),
        )
        val parsed = CallAResult(is_movie = true, title = "Parasite")
        matchTmdbCandidate("기생충", parsed, emptyList(), "test-key", GeminiModelTier.FLASH, client)
        assertEquals(CALL_B_SYSTEM, systemPromptOf(server.takeRequest().body.readUtf8()))
    }

    @Test
    fun `matchTmdbCandidate formats the candidate list exactly`() = runTest {
        // Locks in the precise line format Call B receives — including the
        // asymmetric null-fallbacks ("-" for year/popularity, "" for
        // title/director/original_title) that mirror lib/gemini_utils.js's
        // `?? "-"` vs `?? ""` distinction — so a refactor can't quietly
        // "clean up" this formatting into something Call B was never tuned on.
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"candidates":[{"content":{"parts":[{"text":"{\"matched_tmdb_id\":null,\"confidence\":\"low\"}"}]}}]}""",
            ),
        )
        val parsed = CallAResult(is_movie = true, title = "Parasite", year = 2019, director = "Bong Joon Ho")
        val candidates = listOf(
            TmdbCandidate(
                id = 496243,
                title = "Parasite",
                originalTitle = "기생충",
                releaseDate = "2019-05-30",
                popularity = 80.0,
                directors = listOf("Bong Joon Ho"),
                details = TmdbMovieDetails(id = 496243, imdb_id = "tt6751668"),
            ),
            TmdbCandidate(
                id = 42,
                title = null,
                originalTitle = null,
                releaseDate = null,
                popularity = null,
                directors = emptyList(),
                details = null,
            ),
            TmdbCandidate(
                id = 7,
                title = "Unreleased Thing",
                originalTitle = "Unreleased Thing",
                releaseDate = "2030-01-01",
                popularity = 0.3,
                directors = listOf("A Director", "Another Director"),
                details = TmdbMovieDetails(id = 7, imdb_id = null),
            ),
        )

        matchTmdbCandidate("기생충 (2019)", parsed, candidates, "test-key", GeminiModelTier.FLASH, client)

        val expected = listOf(
            "User memo line: 기생충 (2019)",
            "Parsed query: title=\"Parasite\" year=2019 director=\"Bong Joon Ho\"",
            "",
            "TMDB candidates:",
            "1. tmdb_id=496243 title=\"Parasite\" original_title=\"기생충\" year=2019 directors=\"Bong Joon Ho\" popularity=80.0 has_imdb=yes",
            "2. tmdb_id=42 title=\"\" original_title=\"\" year=- directors=\"-\" popularity=- has_imdb=unknown",
            "3. tmdb_id=7 title=\"Unreleased Thing\" original_title=\"Unreleased Thing\" year=2030 directors=\"A Director, Another Director\" popularity=0.3 has_imdb=no",
        ).joinToString("\n")

        assertEquals(expected, userPromptOf(server.takeRequest().body.readUtf8()))
    }

    @Test
    fun `matchTmdbCandidate sends candidate details and parses confidence`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"candidates":[{"content":{"parts":[{"text":"{\"matched_tmdb_id\":496243,\"confidence\":\"high\",\"reasoning\":\"Exact title match.\"}"}]}}]}""",
            ),
        )

        val parsed = CallAResult(is_movie = true, title = "Parasite", year = 2019)
        val candidates = listOf(
            TmdbCandidate(
                id = 496243,
                title = "Parasite",
                originalTitle = "기생충",
                releaseDate = "2019-05-30",
                popularity = 80.0,
                directors = listOf("Bong Joon Ho"),
            ),
        )

        val result = matchTmdbCandidate("기생충", parsed, candidates, "test-key", GeminiModelTier.FLASH, client)

        // CallBResult is a data class, so assertEquals does full structural
        // comparison in one call — this also locks in `reasoning`, which the
        // previous per-field assertions didn't check.
        assertEquals(
            CallBResult(matched_tmdb_id = 496243, confidence = "high", reasoning = "Exact title match."),
            result,
        )

        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("496243"))
        assertTrue(body.contains("Bong Joon Ho"))
    }

    @Test(expected = GeminiException::class)
    fun `callGeminiRaw throws GeminiException on a non-2xx response`() = runTest {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error": {"message": "bad request"}}"""))
        parseMemoLine("some line", "test-key", GeminiModelTier.FLASH, client)
    }

    @Test
    fun `parseMemoLine rejects a blank api key without hitting the network`() = runTest {
        try {
            parseMemoLine("some line", "", GeminiModelTier.FLASH, client)
            fail("expected GeminiException")
        } catch (e: GeminiException) {
            assertTrue(e.message?.contains("Missing Gemini API key") == true)
        }
        assertEquals(0, server.requestCount)
    }
}
