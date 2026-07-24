package com.nambin.moviecuration.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.Locale

/**
 * Kotlin port of movie-data-manager/lib/gemini_utils.js — the Gemini API
 * integration for the memo-driven add flow (Call A: parse, Call B: TMDB
 * candidate match). Call C (Korean director translation) is NOT ported —
 * it's disabled in the web app's shipped behavior too, so there's nothing
 * to invoke; port it from gemini_utils.js if it's ever re-enabled. See
 * MemoPipeline.kt.
 */

enum class GeminiModelTier(val label: String, val modelId: String) {
    FLASH_LITE("Flash Lite", "gemini-flash-lite-latest"),
    FLASH("Flash", "gemini-flash-latest"),
    PRO("Pro", "gemini-pro-latest"),
}

val DEFAULT_GEMINI_MODEL = GeminiModelTier.FLASH_LITE

private fun geminiEndpoint(model: GeminiModelTier): String =
    "https://generativelanguage.googleapis.com/v1beta/models/${model.modelId}:generateContent"

private val json = Json { ignoreUnknownKeys = true }

// -----------------------------------------------------------------------------
// Low-level call
// -----------------------------------------------------------------------------

class GeminiException(message: String) : IOException(message)

private suspend fun callGeminiRaw(
    systemPrompt: String,
    userPrompt: String,
    schema: JsonObject,
    apiKey: String,
    model: GeminiModelTier,
    client: OkHttpClient,
): String {
    if (apiKey.isBlank()) throw GeminiException("Missing Gemini API key")

    val body = buildJsonObject {
        putJsonObject("system_instruction") {
            putJsonArray("parts") { addJsonObject { put("text", systemPrompt) } }
        }
        putJsonArray("contents") {
            addJsonObject {
                put("role", "user")
                putJsonArray("parts") { addJsonObject { put("text", userPrompt) } }
            }
        }
        putJsonObject("generationConfig") {
            put("responseMimeType", "application/json")
            put("responseSchema", schema)
            put("temperature", 0)
        }
    }

    // addQueryParameter URL-encodes the key, mirroring encodeURIComponent in
    // gemini_utils.js — plain string interpolation would break on a key with
    // a reserved character.
    val url = geminiEndpoint(model).toHttpUrl().newBuilder()
        .addQueryParameter("key", apiKey)
        .build()
    val request = Request.Builder()
        .url(url)
        .post(json.encodeToString(JsonObject.serializer(), body).toRequestBody("application/json".toMediaType()))
        .build()

    return withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val detail = runCatching {
                    json.parseToJsonElement(text).jsonObject["error"]
                        ?.jsonObject?.get("message")?.jsonPrimitive?.content
                }.getOrNull()
                throw GeminiException(
                    "Gemini ${response.code}${if (!detail.isNullOrBlank()) ": $detail" else ": ${response.message}"}"
                )
            }
            val root = json.parseToJsonElement(text).jsonObject
            val partText = root["candidates"]?.jsonArray?.getOrNull(0)
                ?.jsonObject?.get("content")?.jsonObject?.get("parts")?.jsonArray?.getOrNull(0)
                ?.jsonObject?.get("text")?.jsonPrimitive?.content
                ?: throw GeminiException("Gemini response had no text content")
            partText
        }
    }
}

// -----------------------------------------------------------------------------
// Call A: parse one memo line
// -----------------------------------------------------------------------------

val CALL_A_SYSTEM = """
You receive a single line from an unstructured memo of movie titles. Decide whether it names a movie. If it does not (e.g. a note like "watched with J", a date, a comment), return {"is_movie": false}. Otherwise return a TMDB-searchable query.

A very common case is that a non-Korean movie is written in Korean phonetic transliteration (e.g. "보헤미안 랩소디" = "Bohemian Rhapsody", "플라워킬링문" = "Killers of the Flower Moon", "에밀리아 페레스" = "Emilia Pérez"). For these, return the original English title in "title". Do NOT put the Korean phonetic form in "title_korean_overlay".

For a Korean original-language movie (e.g. "어쩔수가없다", "기생충"), return the canonical Korean title in "title". Light normalization is fine — fix obvious typos, adjust whitespace, expand common abbreviations — but keep the result in Korean script. TMDB search handles Korean originals natively.

"title_korean_overlay" is ONLY for the explicit "English Title (한국어)" parenthetical pattern, e.g. "Adolescence (소년의 시간)" → title_korean_overlay: "소년의 시간".

Do not invent year or director unless they are explicit in the line.
""".trimIndent()

private val CALL_A_SCHEMA = buildJsonObject {
    put("type", "object")
    putJsonObject("properties") {
        putJsonObject("is_movie") { put("type", "boolean") }
        putJsonObject("title") { put("type", "string"); put("nullable", true) }
        putJsonObject("year") { put("type", "integer"); put("nullable", true) }
        putJsonObject("director") { put("type", "string"); put("nullable", true) }
        putJsonObject("title_korean_overlay") { put("type", "string"); put("nullable", true) }
    }
    putJsonArray("required") { add(JsonPrimitive("is_movie")) }
}

@Serializable
data class CallAResult(
    val is_movie: Boolean,
    val title: String? = null,
    val year: Int? = null,
    val director: String? = null,
    val title_korean_overlay: String? = null,
)

suspend fun parseMemoLine(line: String, apiKey: String, model: GeminiModelTier, client: OkHttpClient): CallAResult {
    val text = callGeminiRaw(CALL_A_SYSTEM, line, CALL_A_SCHEMA, apiKey, model, client)
    return try {
        json.decodeFromString(CallAResult.serializer(), text)
    } catch (e: Exception) {
        throw GeminiException("Gemini returned non-JSON: ${text.take(200)}")
    }
}

// -----------------------------------------------------------------------------
// Call B: TMDB candidate match
// -----------------------------------------------------------------------------

val CALL_B_SYSTEM = """
You are matching one user memo line to one TMDB movie. The app provides the raw memo line, a parsed search query, and a list of TMDB candidates with selected fields including title, year, director, popularity, and IMDB-ID presence.

Pick which candidate (if any) matches the memo line. Matching cues:

(1) Title likeness across romanization, transliteration, or translation (e.g. "보헤미안 랩소디" matches "Bohemian Rhapsody"). A foreign film whose English "title" matches the query but whose "original_title" is in another language (a translation — e.g. title "I'm Still Here" / original_title "Ainda Estou Aqui") is a FULL title match. Do NOT prefer a candidate that matches both title and original_title exactly over such a translated-title candidate; a translated original_title does not make a match weaker.

(2) Year (when the memo specifies one) — but TMDB release dates can be off by ±1 year from what the user remembers, so don't reject solely on year.

(3) Director (when the memo specifies one).

(4) Popularity — the user logs films that became culturally popular, so popularity is the primary disambiguator among same-titled films. Common titles get reused across many films and decades; when several candidates share essentially the same title, pick the markedly more popular one — a candidate whose popularity is clearly higher (several times the others') is almost always the film the user means, even if a less-popular candidate matches the title or original_title more exactly. (Popularity above 1.0 usually means a real released film; below 0.1 is usually a short film, festival piece, or unreleased entry.)

(5) has_imdb — "yes" means TMDB has an IMDB ID for the film (catalogued, almost always a released film). "no" means it lacks an IMDB ID (often unreleased or obscure). "unknown" means full details weren't fetched for this candidate. Strongly prefer has_imdb=yes candidates; reject has_imdb=no unless the title is a near-exact match AND no "yes" candidate fits. has_imdb=unknown is neutral — judge by the other cues.

If no candidate is a confident match, return matched_tmdb_id: null. Be willing to reject all candidates — a wrong match is worse than no match.

The "reasoning" field should be one short sentence explaining the pick.
""".trimIndent()

private val CALL_B_SCHEMA = buildJsonObject {
    put("type", "object")
    putJsonObject("properties") {
        putJsonObject("matched_tmdb_id") { put("type", "integer"); put("nullable", true) }
        putJsonObject("confidence") {
            put("type", "string")
            putJsonArray("enum") {
                add(JsonPrimitive("high"))
                add(JsonPrimitive("medium"))
                add(JsonPrimitive("low"))
            }
        }
        putJsonObject("reasoning") { put("type", "string") }
    }
    putJsonArray("required") {
        add(JsonPrimitive("matched_tmdb_id"))
        add(JsonPrimitive("confidence"))
    }
}

@Serializable
data class CallBResult(
    val matched_tmdb_id: Int? = null,
    val confidence: String = "low",
    val reasoning: String = "",
)

suspend fun matchTmdbCandidate(
    rawLine: String,
    parsed: CallAResult,
    candidates: List<TmdbCandidate>,
    apiKey: String,
    model: GeminiModelTier,
    client: OkHttpClient,
): CallBResult {
    val lines = mutableListOf(
        "User memo line: $rawLine",
        "Parsed query: title=\"${parsed.title.orEmpty()}\" year=${parsed.year?.toString() ?: "-"} director=\"${parsed.director.orEmpty()}\"",
        "",
        "TMDB candidates:",
    )
    candidates.forEachIndexed { i, c ->
        val year = c.releaseDate?.take(4)?.ifEmpty { null } ?: "-"
        val dirs = c.directors.joinToString(", ").ifEmpty { "-" }
        // Locale.US, not the device default — matches JS's locale-independent
        // toFixed(1), which always uses "." regardless of device locale.
        val pop = c.popularity?.let { String.format(Locale.US, "%.1f", it) } ?: "-"
        val hasImdb = when {
            c.details != null -> if (!c.details.imdb_id.isNullOrEmpty()) "yes" else "no"
            else -> "unknown"
        }
        lines.add(
            "${i + 1}. tmdb_id=${c.id} title=\"${c.title.orEmpty()}\" original_title=\"${c.originalTitle.orEmpty()}\" " +
                "year=$year directors=\"$dirs\" popularity=$pop has_imdb=$hasImdb"
        )
    }
    val text = callGeminiRaw(CALL_B_SYSTEM, lines.joinToString("\n"), CALL_B_SCHEMA, apiKey, model, client)
    return try {
        json.decodeFromString(CallBResult.serializer(), text)
    } catch (e: Exception) {
        throw GeminiException("Gemini returned non-JSON: ${text.take(200)}")
    }
}