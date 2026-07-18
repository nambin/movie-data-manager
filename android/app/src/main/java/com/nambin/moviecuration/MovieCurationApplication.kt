package com.nambin.moviecuration

import android.app.Application
import com.nambin.moviecuration.data.MovieRepository
import com.nambin.moviecuration.github.GitHubContentsClient
import com.nambin.moviecuration.settings.GeminiModelSetting
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Simple hand-rolled DI container (no Hilt/Koin — this app is small enough
 * that a dependency-injection framework would be overhead, not clarity).
 * Everything here is a singleton for the process lifetime.
 */
class MovieCurationApplication : Application() {

    val okHttpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    val movieRepository: MovieRepository by lazy { MovieRepository(okHttpClient) }

    val gitHubContentsClient: GitHubContentsClient by lazy {
        GitHubContentsClient(
            client = okHttpClient,
            owner = BuildConfig.GITHUB_OWNER,
            repo = BuildConfig.GITHUB_REPO,
            branch = BuildConfig.GITHUB_BRANCH,
            token = BuildConfig.GITHUB_TOKEN,
        )
    }

    val geminiModelSetting: GeminiModelSetting by lazy { GeminiModelSetting(this) }
}
