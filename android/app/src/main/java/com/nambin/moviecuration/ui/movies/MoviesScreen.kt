package com.nambin.moviecuration.ui.movies

import android.annotation.SuppressLint
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

private const val MOVIES_URL = "https://nambin.github.io/movies.html?recent=true"

/**
 * A full-screen WebView onto the existing public movies.html?recent=true
 * page — a thin viewport, not a feature this app re-implements. See
 * prompt-android-app.md's "Movies" destination.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun MoviesScreen() {
    var webViewRef by remember { mutableStateOf<WebView?>(null) }
    // Tracked from WebViewClient callbacks below — reading WebView.canGoBack()
    // directly (without mirroring it into Compose State) never triggers a
    // recomposition as browsing happens inside the page, so BackHandler's
    // `enabled` would stay frozen at its initial value forever.
    var canGoBack by remember { mutableStateOf(false) }
    var isLoading by remember { mutableStateOf(true) }

    BackHandler(enabled = canGoBack) {
        webViewRef?.goBack()
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                WebView(context).apply {
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    webViewClient = object : WebViewClient() {
                        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                            isLoading = true
                        }

                        override fun onPageFinished(view: WebView?, url: String?) {
                            isLoading = false
                            canGoBack = view?.canGoBack() == true
                        }

                        override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                            canGoBack = view?.canGoBack() == true
                        }
                    }
                    webViewRef = this
                    loadUrl(MOVIES_URL)
                }
            },
            // Without this, the drawer's saveState/restoreState navigation
            // pattern disposes and recreates this WebView every time the user
            // switches away from and back to this tab, leaking the previous
            // instance's native buffers/thread/Context each time.
            onRelease = { it.destroy() },
        )
        if (isLoading) {
            CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
        }
    }
}
