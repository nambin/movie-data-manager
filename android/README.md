# Movie Curation — Android app

A phone-native, curation-only client for `data/movies.yml`, built from
[prompt-android-app.md](../prompt-android-app.md). See that file for the
full spec (screens, flows, decisions made, GitHub commit mechanism, the
diff-size safety cap). This README is just the "how to build it" complement.

## What's here

```
android/
├─ app/src/main/java/com/nambin/moviecuration/
│  ├─ core/       ← 1:1 Kotlin port of ../lib/*.js (see the table in prompt-android-app.md)
│  ├─ data/       ← MovieRepository, CurationSession, CurationEditor, YamlCodec — no JS equivalent
│  ├─ github/     ← GitHubContentsClient, DiffSizeGuard — no JS equivalent
│  ├─ settings/   ← GeminiModelSetting (DataStore)
│  └─ ui/         ← Compose screens: Movies (WebView), Settings, Curation (+Detail, +ReviewChanges)
├─ app/src/test/  ← JUnit ports of ../tests/*.test.js, sharing fixture JSON where possible
└─ secrets.properties.example  ← copy to secrets.properties and fill in
```

## Setup

1. **Secrets.** Copy `secrets.properties.example` to `secrets.properties` (same
   directory, already gitignored) and fill in:
   - `TMDB_API_KEY` — from themoviedb.org → Settings → API.
   - `GEMINI_API_KEY` — from Google AI Studio.
   - `GITHUB_TOKEN` — a **fine-grained** GitHub PAT scoped to only the
     `nambin/nambin.github.io` repository, with `Contents: Read and write`
     permission and nothing else. See prompt-android-app.md's "Build-time
     configuration & the secrets" for why this is the accepted trade-off
     here (side-loaded, personal-use-only APK).

   All three are compiled into the app as `BuildConfig` fields — there is no
   runtime UI to enter them (see the Settings screen, which only exposes the
   Gemini model tier).

2. **Open in Android Studio.** File → Open → select this `android/` folder.
   Let it sync Gradle. If the Gradle wrapper jar is missing (this repo ships
   `gradle/wrapper/gradle-wrapper.properties` but not the binary jar, since
   it can't be generated offline), Android Studio will either regenerate it
   automatically on sync or prompt you to; alternatively, if you have a
   system Gradle install, run `gradle wrapper` once from this directory.
   The pinned toolchain (AGP 9.2.1 / Kotlin 2.2.10 / Gradle 9.4.1 via the
   wrapper) is verified by real local builds; if Android Studio's sync
   suggests a newer pairing, accepting it is fine.

3. **Run.** Target is a single physical device — a Samsung Galaxy S24 running
   Android 16. `minSdk`/`targetSdk`/`compileSdk` are all pinned to **36**
   (Android 16) to match, per prompt-android-app.md's "Target device / SDK"
   decision (single device, no back-compat needed) — see
   `app/build.gradle.kts`. Build & run via Android Studio's Run button, or
   `./gradlew installDebug` once the wrapper is in place.

## Tests

`app/src/test/` holds JVM unit tests for everything in `core/`, `data/`, and
`github/` — the pure logic, no Android framework dependency, runnable with
`./gradlew testDebugUnitTest` (or via Android Studio's test runner). They
mirror `../tests/*.test.js` file-for-file where the equivalent module
exists; several reuse the exact same TMDB fixture JSON from
`../tests/fixtures/`, copied into `app/src/test/resources/fixtures/`.
`MemoPipelineTest`, `GeminiUtilsTest`, `MovieRepositoryTest`,
`CurationEditorTest`, and `GitHubContentsClientTest` drive their real
network-facing code against a
local `MockWebServer` (via `okhttp3.mockwebserver`) rather than mocking the
classes themselves — `GeminiUtils.kt`/`MemoPipeline.kt` hardcode the
Gemini/TMDB hosts, so requests are redirected to the mock server with an
OkHttp interceptor; `MovieRepository`/`GitHubContentsClient` instead take
the target URL as an optional constructor parameter (defaulting to
production) for the same purpose.

## Verified on device

The app is built, installed, and in real use — the
`curate: N new, M updated (via Android app)` commits on nambin.github.io
are authored by it. YAML output fidelity (the one "double-check on first
run" item this section used to carry) is handled in `YamlCodec`: the
`date_committed` date-scalar fix plus a post-dump re-indent of the two
nested list fields (`award_names`/`awards`) to match the on-disk js-yaml
format, so a session's commit diff stays limited to the intended edits —
enforced at commit time by `DiffSizeGuard`'s 200-line cap.
