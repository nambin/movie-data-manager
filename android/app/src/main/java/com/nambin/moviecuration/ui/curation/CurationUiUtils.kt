package com.nambin.moviecuration.ui.curation

import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import com.nambin.moviecuration.core.MovieEntry

/** The shared title convention: tmdb_title, falling back to tmdb_original_title. No year — see [displayTitle]. */
fun displayTitleNoYear(entry: MovieEntry): String =
    (entry["tmdb_title"] as? String)?.takeIf { it.isNotBlank() }
        ?: (entry["tmdb_original_title"] as? String)?.takeIf { it.isNotBlank() }
        ?: "(untitled)"

fun displayTitle(entry: MovieEntry): String {
    val title = displayTitleNoYear(entry)
    val year = entry["year"]
    return if (year != null) "$title ($year)" else title
}

/** Opens [url] in a Chrome Custom Tab. */
fun openCustomTab(context: Context, url: String) {
    CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url))
}
