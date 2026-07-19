# Movie Curation Android App — Performance Improvements Prompt

> Companion to [prompt-android-app.md](prompt-android-app.md). This spec changes **no behavior** — same screens, same data flow, same YAML output, same commit mechanics. It moves the app's three heaviest CPU-bound operations off the main thread onto `Dispatchers.Default`.

## Context

A performance review of `android/` found the app generally well-structured: network I/O is on `Dispatchers.IO`, the two boot fetches run concurrently, TMDB candidate enrichment fans out in parallel, and the Compose lists are lazy with stable keys.

The gap is that the heaviest CPU-bound work runs on the **main thread**: the `suspend` functions containing it are launched from `viewModelScope` (`Dispatchers.Main.immediate`), and only the inner network calls dispatch to IO. Three spots:

1. **Boot** — SnakeYAML parse of ~488 KB `movies.yml` + ~185 KB `awards.yml`, plus `buildKoreanDirectorMap` and `computeCollectionStats` (which sorts all ~929 entries). A loading spinner masks it, but it is real main-thread work with jank/ANR risk that grows with the dataset.
2. **Commit** — `canonicalizeAll` (deep copy of every entry) + `sortMovies` + `YamlCodec.dumpMovies` (full-file YAML dump plus the `reindentNestedListItems` line-by-line string pass).
3. **Commit diff guard** — `DiffSizeGuard.computeDiffSize` runs a Myers line diff over two ~15k-line strings between the GET and PUT.

Explicitly **out of scope** (reviewed and declined for now): replacing the cache-busted boot fetch with ETag conditional GETs, debouncing search keystrokes, and explicit Coil request sizing for list thumbnails.

## Changes

All paths under `android/app/src/main/java/com/nambin/moviecuration/`.

### 1. Boot parse — `data/MovieRepository.kt` (`loadFromServer`)

Wrap the post-fetch CPU work in `withContext(Dispatchers.Default)`: the `YamlCodec.loadMovies(moviesText)` parse, the awards-document parse + `awardsByImdb` mapping, and `rebuildKoreanDirectorMap()`. The two `fetchText` calls already dispatch to IO internally and stay as-is. Field assignment can happen inside the block — the class is documented as single-caller sequential, so this introduces no new thread-safety concern.

### 2. Boot stats — `data/CurationEditor.kt` (`loadFromServer`)

Wrap `computeCollectionStats(repository.movies)` in `withContext(Dispatchers.Default)` — it calls `sortMovies` over the full collection.

### 3. Commit serialization — `data/CurationEditor.kt` (`commit`)

Wrap the duplicate-imdb_id grouping check and the `canonicalizeAll` → `sortMovies` → `YamlCodec.dumpMovies` sequence in a single `withContext(Dispatchers.Default)` block. The early return for `DuplicateImdbIds` needs light restructuring since you can't `return` from inside `withContext` to the outer function — compute the outcome/yamlText inside the block and branch after it.

### 4. Commit diff guard — `github/GitHubContentsClient.kt` (`attemptCommit`)

Wrap the `DiffSizeGuard.computeDiffSize(currentContent, newContent)` call in `withContext(Dispatchers.Default)`. Do **not** make `computeDiffSize` itself suspend — it is a pure function used directly by tests; dispatch at the call site instead.

## Verification

- Run the existing JUnit suite: `.\gradlew test` from `android/`. The suite covers repository loading (MockWebServer), the editor commit flow, and the diff guard; `withContext(Dispatchers.Default)` inside suspend functions is transparent to `runTest`-based tests.
- Build the app: `.\gradlew assembleDebug` to confirm compilation.
- No behavior change expected: identical YAML output, identical commit flow, only the executing dispatcher changes.
