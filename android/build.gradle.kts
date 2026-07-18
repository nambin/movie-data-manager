// Root build file. Per-module configuration lives in app/build.gradle.kts.
//
// AGP 8.13.2 for compileSdk/targetSdk 36 (API 36) support — older AGP lines
// (pre-8.7) don't recognize API 36. This pairing (AGP 8.13.2 / Kotlin 2.0.21 /
// Gradle 8.13) builds and passes the full unit suite locally.
plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21" apply false
}
