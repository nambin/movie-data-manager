package com.nambin.moviecuration.github

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.Base64

/**
 * Commits a single file straight to GitHub via the REST Contents API — no
 * local git checkout, no JGit dependency. See prompt-android-app.md's
 * "GitHub commit mechanism".
 */

private val json = Json { ignoreUnknownKeys = true }

@Serializable
private data class ContentsGetResponse(val content: String, val sha: String)

@Serializable
private data class PutRequestBody(val message: String, val content: String, val sha: String, val branch: String)

@Serializable
private data class CommitInfo(val html_url: String? = null)

@Serializable
private data class PutResponse(val commit: CommitInfo? = null)

sealed class CommitOutcome {
    data class Success(val commitUrl: String?) : CommitOutcome()
    data class DiffTooLarge(val changedLines: Int, val limit: Int) : CommitOutcome()
    data object Conflict : CommitOutcome()
    data class Failure(val message: String) : CommitOutcome()
}

class GitHubContentsClient(
    private val client: OkHttpClient,
    private val owner: String,
    private val repo: String,
    private val branch: String,
    private val token: String,
    private val apiBaseUrl: String = "https://api.github.com",
) {
    private fun Request.Builder.withAuth(): Request.Builder = apply {
        addHeader("Authorization", "Bearer $token")
        addHeader("Accept", "application/vnd.github+json")
        addHeader("X-GitHub-Api-Version", "2022-11-28")
    }

    private fun contentsUrl(path: String) = "$apiBaseUrl/repos/$owner/$repo/contents/$path"

    private suspend fun getCurrent(path: String): Pair<String, String> = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("${contentsUrl(path)}?ref=$branch").get().withAuth().build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("GET contents ${response.code}: ${response.message}")
            }
            val body = response.body?.string().orEmpty()
            val parsed = json.decodeFromString(ContentsGetResponse.serializer(), body)
            val decoded = String(Base64.getMimeDecoder().decode(parsed.content.replace("\n", "")), Charsets.UTF_8)
            decoded to parsed.sha
        }
    }

    private suspend fun put(path: String, newContent: String, sha: String, message: String): CommitOutcome =
        withContext(Dispatchers.IO) {
            val encoded = Base64.getEncoder().encodeToString(newContent.toByteArray(Charsets.UTF_8))
            val bodyJson = json.encodeToString(
                PutRequestBody.serializer(),
                PutRequestBody(message = message, content = encoded, sha = sha, branch = branch),
            )
            val request = Request.Builder()
                .url(contentsUrl(path))
                .put(bodyJson.toRequestBody("application/json".toMediaType()))
                .withAuth()
                .build()
            client.newCall(request).execute().use { response ->
                when {
                    response.isSuccessful -> {
                        val respText = response.body?.string().orEmpty()
                        val parsed = runCatching { json.decodeFromString(PutResponse.serializer(), respText) }.getOrNull()
                        CommitOutcome.Success(parsed?.commit?.html_url)
                    }
                    response.code == 409 -> CommitOutcome.Conflict
                    else -> CommitOutcome.Failure("GitHub ${response.code}: ${response.message}")
                }
            }
        }

    /**
     * Commit [newContent] to [path]. Fetches the current file + sha, runs
     * the diff-size safety cap against it (aborting before any PUT if it
     * trips), pushes, and retries once on a 409 sha conflict (re-fetching
     * content+sha and re-running the cap against the fresh content).
     */
    suspend fun commitFile(path: String, newContent: String, message: String): CommitOutcome =
        attemptCommit(path, newContent, message, retriesLeft = 1)

    private suspend fun attemptCommit(path: String, newContent: String, message: String, retriesLeft: Int): CommitOutcome {
        val (currentContent, sha) = try {
            getCurrent(path)
        } catch (e: Exception) {
            return CommitOutcome.Failure(e.message ?: "Failed to fetch current file")
        }

        val diffSize = DiffSizeGuard.computeDiffSize(currentContent, newContent)
        if (diffSize.total > DiffSizeGuard.MAX_COMMIT_DIFF_LINES) {
            return CommitOutcome.DiffTooLarge(diffSize.total, DiffSizeGuard.MAX_COMMIT_DIFF_LINES)
        }

        val result = try {
            put(path, newContent, sha, message)
        } catch (e: Exception) {
            return CommitOutcome.Failure(e.message ?: "Failed to commit")
        }

        return if (result is CommitOutcome.Conflict && retriesLeft > 0) {
            attemptCommit(path, newContent, message, retriesLeft - 1)
        } else {
            result
        }
    }
}
