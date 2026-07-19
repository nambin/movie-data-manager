package com.nambin.moviecuration.ui.curation

import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import com.nambin.moviecuration.core.MovieEntry

/**
 * Prefers the Korean form for Korean-language films (`tmdb_original_title`),
 * falling back to `tmdb_title` then `tmdb_original_title`. Deliberately never
 * consults `custom_korean_title` for display.
 */
fun displayTitle(entry: MovieEntry): String {
    val koreanTitle = (entry["tmdb_original_title"] as? String)
        ?.takeIf { it.isNotBlank() && entry["tmdb_original_language"] == "Korean" }
    val title = koreanTitle
        ?: (entry["tmdb_title"] as? String)?.takeIf { it.isNotBlank() }
        ?: (entry["tmdb_original_title"] as? String)?.takeIf { it.isNotBlank() }
        ?: "(untitled)"
    val year = entry["year"]
    return if (year != null) "$title ($year)" else title
}

/** Opens [url] in a Chrome Custom Tab. */
fun openCustomTab(context: Context, url: String) {
    CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url))
}
