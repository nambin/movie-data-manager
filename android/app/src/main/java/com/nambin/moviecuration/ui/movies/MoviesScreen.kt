package com.nambin.moviecuration.ui.movies

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

private const val MOVIES_URL = "https://nambin.github.io/movies.html?recent=true"

/**
 * Owns the Movies tab's WebView for the whole activity lifetime, so switching
 * tabs and coming back resumes exactly where the user left off (applied
 * filters, scroll position, in-page history) instead of reloading the page —
 * see prompt-android-app.md's "Movies" destination. Created lazily on the
 * first visit and remembered at the app root (see MovieCurationApp); a fresh
 * page load happens only when the activity itself is recreated.
 */
@SuppressLint("SetJavaScriptEnabled")
class MoviesWebViewHolder(context: Context) {
    // Mirrored from WebViewClient callbacks — reading WebView.canGoBack()
    // directly (without Compose State) never triggers a recomposition as
    // browsing happens inside the page, so BackHandler's `enabled` would
    // stay frozen at its initial value forever.
    val canGoBack = mutableStateOf(false)
    val isLoading = mutableStateOf(true)

    val webView: WebView = WebView(context).apply {
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                isLoading.value = true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                isLoading.value = false
                canGoBack.value = view?.canGoBack() == true
            }

            override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                canGoBack.value = view?.canGoBack() == true
            }
        }
        loadUrl(MOVIES_URL)
    }
}

/**
 * A full-screen WebView onto the existing public movies.html?recent=true
 * page — a thin viewport, not a feature this app re-implements. See
 * prompt-android-app.md's "Movies" destination.
 */
@Composable
fun MoviesScreen(holder: MoviesWebViewHolder) {
    val canGoBack by holder.canGoBack
    val isLoading by holder.isLoading

    BackHandler(enabled = canGoBack) {
        holder.webView.goBack()
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = {
                // Re-attach the retained instance — it may still be parented
                // from the previous visit to this tab.
                (holder.webView.parent as? ViewGroup)?.removeView(holder.webView)
                holder.webView
            },
            // Detach only, never destroy(): the instance (and the loaded
            // page) is deliberately retained for the next visit.
            onRelease = { (it.parent as? ViewGroup)?.removeView(it) },
        )
        if (isLoading) {
            CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
        }
    }
}
