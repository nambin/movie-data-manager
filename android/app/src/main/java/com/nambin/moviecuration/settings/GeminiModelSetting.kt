package com.nambin.moviecuration.settings

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.nambin.moviecuration.core.DEFAULT_GEMINI_MODEL
import com.nambin.moviecuration.core.GeminiModelTier
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import java.io.IOException

private val Context.settingsDataStore by preferencesDataStore(name = "movie_curation_settings")

private val GEMINI_MODEL_KEY = stringPreferencesKey("gemini_model_tier")

/**
 * DataStore-backed persistence for the one user-editable Setting: Gemini
 * model tier. Everything else (GitHub repo/branch/token, Gemini/TMDB keys)
 * is hardcoded at build time — see prompt-android-app.md's Settings section.
 */
class GeminiModelSetting(private val context: Context) {

    val modelTierFlow: Flow<GeminiModelTier> = context.settingsDataStore.data
        .catch { e ->
            // A corrupted/unreadable preferences file is a real DataStore
            // failure mode (e.g. process death mid-write) — fall back to
            // defaults instead of crashing the app on next open.
            if (e is IOException) emit(emptyPreferences()) else throw e
        }
        .map { prefs ->
            val stored = prefs[GEMINI_MODEL_KEY]
            GeminiModelTier.entries.find { it.name == stored } ?: DEFAULT_GEMINI_MODEL
        }

    suspend fun setModelTier(tier: GeminiModelTier) {
        context.settingsDataStore.edit { it[GEMINI_MODEL_KEY] = tier.name }
    }
}
