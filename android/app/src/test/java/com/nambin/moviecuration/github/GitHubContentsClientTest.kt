package com.nambin.moviecuration.github

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

/** Exercises the commit happy path, 409 retry, and the diff-size safety cap against a local MockWebServer. */
class GitHubContentsClientTest {

    private lateinit var server: MockWebServer
    private lateinit var client: GitHubContentsClient

    private fun b64(s: String) = Base64.getEncoder().encodeToString(s.toByteArray(Charsets.UTF_8))

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = GitHubContentsClient(
            client = OkHttpClient(),
            owner = "nambin",
            repo = "nambin.github.io",
            branch = "main",
            token = "test-token",
            apiBaseUrl = server.url("/").toString().removeSuffix("/"),
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `commitFile succeeds on the happy path`() = runTest {
        val oldContent = (1..10).joinToString("\n") { "line $it" }
        val newContent = "$oldContent\nline 11"

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.method) {
                "GET" -> MockResponse().setResponseCode(200)
                    .setBody("""{"content": "${b64(oldContent)}", "sha": "sha-1"}""")
                "PUT" -> MockResponse().setResponseCode(200)
                    .setBody("""{"commit": {"html_url": "https://github.com/nambin/nambin.github.io/commit/abc"}}""")
                else -> MockResponse().setResponseCode(404)
            }
        }

        val outcome = client.commitFile("data/movies.yml", newContent, "test commit")
        assertTrue(outcome is CommitOutcome.Success)
        assertEquals("https://github.com/nambin/nambin.github.io/commit/abc", (outcome as CommitOutcome.Success).commitUrl)
    }

    @Test
    fun `commitFile retries once on a 409 conflict and succeeds on the second attempt`() = runTest {
        var putAttempts = 0
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.method) {
                "GET" -> MockResponse().setResponseCode(200)
                    .setBody("""{"content": "${b64("line 1\nline 2")}", "sha": "sha-${System.nanoTime()}"}""")
                "PUT" -> {
                    putAttempts++
                    if (putAttempts == 1) {
                        MockResponse().setResponseCode(409)
                    } else {
                        MockResponse().setResponseCode(200)
                            .setBody("""{"commit": {"html_url": "https://example.com/commit"}}""")
                    }
                }
                else -> MockResponse().setResponseCode(404)
            }
        }

        val outcome = client.commitFile("data/movies.yml", "line 1\nline 2\nline 3", "test commit")
        assertTrue(outcome is CommitOutcome.Success)
        assertEquals(2, putAttempts)
    }

    @Test
    fun `commitFile gives up after a second consecutive 409`() = runTest {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.method) {
                "GET" -> MockResponse().setResponseCode(200)
                    .setBody("""{"content": "${b64("a\nb")}", "sha": "sha-${System.nanoTime()}"}""")
                "PUT" -> MockResponse().setResponseCode(409)
                else -> MockResponse().setResponseCode(404)
            }
        }

        val outcome = client.commitFile("data/movies.yml", "a\nb\nc", "test commit")
        assertTrue(outcome is CommitOutcome.Conflict)
    }

    @Test
    fun `commitFile short-circuits before PUT when the diff exceeds the safety cap`() = runTest {
        val oldContent = (1..200).joinToString("\n") { "line $it" }
        val newContent = (1..200).joinToString("\n") { "different $it" }

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.method) {
                "GET" -> MockResponse().setResponseCode(200)
                    .setBody("""{"content": "${b64(oldContent)}", "sha": "sha-1"}""")
                // No PUT case — if commitFile ever calls PUT here, this 500
                // turns into a Failure outcome instead of a silent Success,
                // so the test still catches it.
                else -> MockResponse().setResponseCode(500)
            }
        }

        val outcome = client.commitFile("data/movies.yml", newContent, "test commit")
        assertTrue(outcome is CommitOutcome.DiffTooLarge)
        assertEquals(200, (outcome as CommitOutcome.DiffTooLarge).limit)
    }
}
