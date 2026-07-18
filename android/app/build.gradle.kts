import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Secrets are read from secrets.properties (gitignored — see
// secrets.properties.example) and baked in as BuildConfig fields. This is
// the one Gradle module in this repo that intentionally embeds credentials
// in its output; see prompt-android-app.md's "Build-time configuration &
// the secrets" section for why that's an accepted trade-off here.
val secretsFile = rootProject.file("secrets.properties")
val secrets = Properties().apply {
    if (secretsFile.exists()) secretsFile.inputStream().use { load(it) }
}
fun secret(key: String): String = secrets.getProperty(key, "")

android {
    namespace = "com.nambin.moviecuration"
    // 36 = Android 16, matching the user's Galaxy S24 (see prompt-android-app.md's
    // "Target device / SDK" decision: single physical device, no back-compat needed).
    compileSdk = 36

    defaultConfig {
        applicationId = "com.nambin.moviecuration"
        minSdk = 36
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        buildConfigField("String", "TMDB_API_KEY", "\"${secret("TMDB_API_KEY")}\"")
        buildConfigField("String", "GEMINI_API_KEY", "\"${secret("GEMINI_API_KEY")}\"")
        buildConfigField("String", "GITHUB_TOKEN", "\"${secret("GITHUB_TOKEN")}\"")
        buildConfigField("String", "GITHUB_OWNER", "\"nambin\"")
        buildConfigField("String", "GITHUB_REPO", "\"nambin.github.io\"")
        buildConfigField("String", "GITHUB_BRANCH", "\"main\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        // Only the duplicate license files Compose/coroutines are known to
        // collide on — not a blanket META-INF/** glob, which would also strip
        // service descriptors and multi-release metadata some libraries need.
        resources.excludes.add("/META-INF/{AL2.0,LGPL2.1}")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.activity:activity-compose:1.9.2")

    val composeBom = platform("androidx.compose:compose-bom:2024.10.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    implementation("androidx.navigation:navigation-compose:2.8.2")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.browser:browser:1.8.0")
    implementation("io.coil-kt:coil-compose:2.7.0")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.yaml:snakeyaml:2.3")
    implementation("io.github.java-diff-utils:java-diff-utils:4.12")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
