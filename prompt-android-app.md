# Movie Curation Android App — Implementation Prompt

> Companion to [prompt-web-app.md](prompt-web-app.md) (data model, YAML round-trip rules, sort order, field semantics), [prompt-web-app-with-llm.md](prompt-web-app-with-llm.md) (memo-driven LLM pipeline), and [prompt-award-curation.md](prompt-award-curation.md) (`data/awards.yml` schema and taxonomy). This draft does **not** change any of those — it specifies a **native Android app** that is a curation-only front door onto the same `data/movies.yml`, reading `data/awards.yml` as read-only ground truth, and committing directly to GitHub instead of producing a browser download.

## Goal

Today, curating movies means opening the web editor on a laptop. Build a phone-native app so movie curation (adding a title I just thought of, bumping a rating, jotting a note) can happen anywhere, with the same LLM-assisted matching the web app already has, and no manual "download YML → copy into the repo → git commit" step — the app commits `data/movies.yml` straight to GitHub.

Goal in one line: **a pocket-sized, curation-only client for `data/movies.yml`** — memo-based add, simple search-based edit, one-tap commit.

## Non-goals

- **No TMDB-URL add path.** The one existing way to add a movie in this app is the memo/LLM flow (one title at a time). No URL paste box, no "Add movie" button.
- **No manual load/download.** The app always auto-loads `data/movies.yml` + `data/awards.yml` from the live site at session start; there is no file picker and no "save file" affordance. Committing *is* the save.
- **No awards editing.** Same posture as the existing web app: `award_names`/`awards` are owned entirely by `data/awards.yml` (curated out-of-band by `cli/curate-awards.mjs`, see [prompt-award-curation.md](prompt-award-curation.md)) and are display-only here. The app never writes them by hand.
- **No delete.** The web app has a delete button; this draft does not carry it over (curation on a phone is add/update, not pruning). Revisit if it turns out to be needed.
- **No offline-first sync / conflict UI beyond a single retry.** This is a personal, single-user tool talking to a repo only this user pushes to. A lost race is handled by re-fetching and retrying once, not a merge UI.
- **No bulk/multi-line memo paste.** The web app's memo box accepts many lines at once with a review pane of N cards; this app takes **one title at a time**, reflecting how curation actually happens on a phone. The underlying per-line pipeline (Call A parse → TMDB search → Call B match) is identical, just invoked for a single line.
- **`data/awards.yml` is never written by this app** — read-only ground truth, same as the web app.

## App structure

### Navigation

A left-hand navigation drawer (`ModalNavigationDrawer`, per the Compose decision below) with three destinations:

- **Movies**
- **Curation**
- **Settings**

The drawer is **collapsed by default** and opens via a hamburger icon (☰, three horizontal lines) in the top app bar — standard `ActionBarDrawerToggle` / `TopAppBar` navigation-icon pattern. **Curation** is the default destination shown when the app launches (not Movies, not whatever screen was open last).

### "Movies" destination

A full-screen `WebView` that loads:

```
https://nambin.github.io/movies.html?recent=true
```

- Enable JavaScript and DOM storage (the site page uses both).
- Wire `WebView.canGoBack()`/`goBack()` to the system back gesture/button while this screen is active, so in-page navigation (if any) doesn't immediately exit the tab.
- No pull-to-refresh or custom chrome needed beyond a loading spinner — this is a thin viewport onto the existing public page, not a feature this app re-implements.

### "Settings" destination

User-editable — the **only** thing on this screen:

| Setting | Control | Notes |
| --- | --- | --- |
| Gemini model tier | Dropdown: **Flash Lite** / **Flash** / **Pro** | Maps to the same model IDs the web app already uses in [lib/gemini_utils.js](lib/gemini_utils.js) — `gemini-flash-lite-latest` / `gemini-flash-latest` / `gemini-pro-latest`. Default: **Flash** (matches `DEFAULT_GEMINI_MODEL` today). |

**Not** user-editable — hardcoded at build time (see *Build-time configuration* below) and either omitted from this screen entirely or shown as read-only lines for reassurance:

- Gemini API key
- TMDB API key
- GitHub repo owner/name (`nambin/nambin.github.io`)
- Target branch (`main`)
- The GitHub token used to commit

Rationale for hardcoding all of this at build time rather than exposing it as user input: this app is used by exactly one person, on their own devices, never distributed via the Play Store or otherwise handed out — there is no second user a settings UI would ever need to onboard, and no scenario where the app should point at a different repo, branch, or Gemini account. The only per-install choice worth surfacing is the model tier, since that's a genuine quality/cost/latency trade-off the user might want to flip on the fly (e.g. try Pro on a memo line Flash keeps missing) without a rebuild.

Persist Gemini settings with **Jetpack DataStore** (Preferences), not raw `SharedPreferences` — same durability, better Kotlin ergonomics, coroutine-friendly reads.

### "Curation" destination — the main screen

#### Boot behavior

On entering this screen (first time per app session is enough — no need to re-fetch on every visit unless the user pulls to refresh):

1. Fetch `https://nambin.github.io/data/movies.yml` and `https://nambin.github.io/data/awards.yml` over plain HTTPS (same URLs the web app's `LIVE_DATA_ORIGIN` fallback already uses — no auth needed, both files are public).
2. Parse both into memory (see *YAML handling* below).
3. Build the `by_imdb` awards lookup and the romanized→Korean director map (port of `buildKoreanDirectorMap`, [lib/utils.js](lib/utils.js)) from the loaded collection.
4. **Show no movie cards.** The screen's default state is search bar + "Add a movie" entry point + Commit button/status — an empty result area, not a list dump. This matches the phone use case: you came here to do one thing (add or find one movie), not browse 800 entries.

If the fetch fails (offline, GitHub Pages hiccup), show a retryable error state; Curation is unusable without the loaded collection (both for duplicate-detection and for the search/update flow), so don't silently proceed with an empty in-memory list.

#### Screen layout

The Curation screen shows **both** entry points together, always — an "Add a movie" input and a "Search to update" input stacked on one screen, no tab/mode toggle between them. Typing in one doesn't hide or disable the other; a user free-associating between "add this new one" and "fix that old rating" shouldn't have to switch modes to do both in one sitting.

#### Adding a new movie (memo-based, single title)

- A single-line text input: "Movie name" (optionally the user can also type a year or director inline — same free-text convention as the web app's memo lines, e.g. `Anora 2024` or `보헤미안 랩소디`).
- Submitting runs the **existing per-line pipeline**, ported to Kotlin (see *Ported logic* below):
  1. **Call A (Gemini)** — parse the line into `{ is_movie, title, year?, director?, title_korean_overlay? }`.
  2. If `is_movie: false` → show "That doesn't look like a movie title — try rephrasing."
  3. **TMDB search** — `primary_release_year` ± 1 windowed search when a year was parsed, merged/deduped, same as [lib/memo_pipeline.js](lib/memo_pipeline.js).
  4. If zero candidates → show "No match found on TMDB for 'title'." with a way to edit and retry (e.g. re-typing with a year or a more specific title).
  5. **Call B (Gemini)** — match the raw line against the candidate list.
  6. Build the entry from Call B's picked candidate (or, on `matched_tmdb_id: null`, from the top search result as a placeholder) via a Kotlin port of `buildMovieEntryFromTmdb` ([lib/tmdb_utils.js](lib/tmdb_utils.js)).
  7. Resolve `director`: romanized→Korean map hit → else leave the TMDB romanization (Call C — LLM Korean-name translation — stays **disabled**, matching the web app's current shipped behavior, not the original three-call design doc; see [lib/memo_pipeline.js:132](lib/memo_pipeline.js#L132) comment).
  8. Overwrite `award_names`/`awards` from the loaded `awards.yml` ground truth (port of `applyAwardsToEntry`/`reconcileAwardNames`, [lib/awards_reconcile.js](lib/awards_reconcile.js)).
  9. Duplicate check against the in-memory collection — see *Duplicate prevention & sort invariants* below for the exact check and the message shown to the user.
- On success (no duplicate found), hand off to the **shared detail view** (below), pre-filled from the built entry, in "new" mode. **The candidate picker lives on this same screen** — see below — so there is no separate intermediate "pick a candidate" step between the memo input and the detail view.

#### Updating an already-curated movie (search)

- A search box that filters the in-memory collection across exactly the four fields named in the requirements: **title** (`title`, `tmdb_title`, `tmdb_original_title`, `custom_korean_title`), **director** (`director`, `tmdb_director_name_1/2`), **year**, **language** (`tmdb_original_language`). Narrower than the web app's search (which also matches notes/awards) — deliberately, since the ask here is specifically title/director/year/language.
- Results render as a compact list (poster thumbnail + `Title (Year)` + director) — tap one to open it in the shared detail view, in "edit" mode.
- No render cap/pagination concern like the web app's `RENDER_LIMIT`: a phone search is expected to be typed narrow enough that results stay short, but cap displayed results at a sane number (e.g. 20) defensively.

#### Shared detail view (add-confirmation and edit are the same screen)

Regardless of whether the entry arrived via the memo/LLM flow or via search, the detail view shows:

| Element | Behavior |
| --- | --- |
| Candidate picker *(new-entry mode only, shown at the top of the screen when TMDB search returned more than one plausible candidate)* | A dropdown of the search's candidates (title, year, director). Defaults to Call B's pick when it returned one; defaults to the top search result when Call B returned `matched_tmdb_id: null`. Changing the selection **re-fills every field below on this same screen** (poster, Title (Year), director, awards) from the newly picked candidate — mirrors the web app's review card, where swapping the candidate rebinds the same card instead of navigating anywhere. This directly satisfies *"when multiple candidates are found, it needs to show a dropdown menu for users to be able to select the right one"* without a separate screen for it. Absent entirely in "edit" mode (an already-curated entry has no candidates to pick between). |
| Poster thumbnail | From `tmdb_poster_url`. Tapping opens `tmdb_url` (falling back to `imdb_url`) in a **Chrome Custom Tab** (`androidx.browser.customtabs`), not an in-app WebView — matches "goes to the corresponding TMDB webpage via CCT." |
| `Title (Year)` | Read-only, e.g. `Parasite (2019)`. Composed the same way the web app displays it (`tmdb_original_title` preferred, falling back to `title`) + year. |
| Director | **Editable** text field. Always editable (not gated behind "only if Korean") — same as the web app — but the map-lookup pre-fills the Korean form automatically for known directors, so manual edits are mainly needed for first-time Korean directors, matching the stated intent. Editing recomputes `is_korean_director`. |
| Rating | Dropdown: **(none)** / **My Best** / **Masterpiece** — mutually exclusive, same semantics as the web app. |
| Note | Multi-line text box, trimmed, omitted from YAML when blank. |
| Awards | Read-only row, populated from `awards.yml` by `imdb_id` — full names, comma-separated (or a small badge row using the same `BADGE_KEY_BY_NAME` icons `movies.html` uses, if bringing those icon assets over is easy; text-only is a fine v1). Hidden entirely when the film has none. Re-derived automatically when the candidate picker changes the underlying film. |

**Every field edit auto-saves to memory immediately** — no separate Save button, no "unsaved changes" state on this screen. Each change writes straight into the in-memory collection:

- **New entry** → the first auto-save appends it to the in-memory list and marks its `imdb_id` in a `newImdbIds` set (session-scoped); subsequent edits on the same screen (including swapping the candidate picker) just keep mutating that same appended entry. Stamp `date_committed` with today's date (Asia/Seoul, matching `todayDateString()` in [lib/app.js](lib/app.js)) at the moment it's first appended.
- **Existing entry being edited** → mutates in place; the first auto-save that actually changes a value marks its `imdb_id` in an `updatedImdbIds` set (session-scoped) and captures the pre-edit snapshot (see *Tracking pre-edit snapshots* below) — merely opening and leaving a detail view with no changes never marks it as updated.

#### Duplicate prevention & sort invariants

This app is the only other place besides the web editor that writes to `data/movies.yml`, so it has to uphold the same two guarantees the web app already relies on: **no duplicate movies, ever**, and **the file is always in canonical sort order on write.**

**Detecting an already-curated movie during Add.** The memo/LLM pipeline's duplicate check (step 11 above) runs against the **full in-memory `movies` list**, which already contains both everything loaded from `data/movies.yml` at boot *and* every entry added-and-saved earlier in the same session (those are appended to that same list immediately on Save — see above). So "I already added this one five minutes ago" and "this was already in the published collection" are the same check, not two code paths to keep in sync. Checked in this order, mirroring the web app's existing add-by-URL duplicate check ([lib/app.js](lib/app.js)):

1. **By `imdb_id`** — the primary, always-reliable key.
2. **By `tmdb_url`** — defense in depth, kept for parity with the existing web app check even though it's the less likely path to actually trigger.

When the pipeline's picked candidate matches an existing entry:

- The detail view for a **new** entry never opens in the first place. Instead, show a status message in the Add flow, e.g.:

  > **Already curated:** *Parasite (2019)* — tap to open and edit instead.

  Tapping it navigates straight into the shared detail view in **edit** mode for the existing entry, so a duplicate attempt lands the user somewhere useful (fix the rating, add a note) rather than at a dead end.
- If the detail view *did* open (because the top candidate was new) and the user then swaps the **candidate picker** to a different candidate that turns out to already be curated: annotate that option with an inline "(already curated)" hint in the dropdown, and selecting it swaps the whole screen into the same "already curated" message + edit-mode handoff described above, rather than silently turning the screen into a duplicate entry.
- A duplicate attempt never touches the in-memory list, `newImdbIds`, or any pending-change state — it's a dead end for **adding**, not a silent backdoor into **updating** unless the user explicitly follows through on the "tap to edit" affordance.

**One add/edit flow in progress at a time.** The check above only works because the in-memory `movies` list is always a true reflection of "everything saved so far this session" — which requires that at most one entry is ever "in flight" (built from the pipeline, or opened from search) but not yet saved. Enforce this in the UI: starting a new Add, or opening a search result, while another detail view already has unsaved changes should prompt to finish or discard that one first rather than silently stacking two pending edits.

**Defensive re-check at Commit.** As part of Confirm & Commit (before canonicalize/sort/dump/push), group the full in-memory collection by `imdb_id` and abort with a clear error if any key maps to more than one entry, instead of ever pushing a `data/movies.yml` with duplicate movies to GitHub. This should be unreachable given the checks above, but it's a cheap, final backstop — the same spirit as `canonicalizeEntry`'s defensive passthrough of unknown keys in [lib/canonicalize.js](lib/canonicalize.js).

**Sort order is enforced on every commit, for the whole file, not just the session's changes.** Confirm & Commit already runs the *entire* in-memory collection — every previously-committed entry plus every session addition/edit — through `sortMovies` ([lib/utils.js](lib/utils.js)) before dumping to YAML (see *Commit* below). It is a whole-collection re-sort every time, never an insert-in-place for just what changed this session, so the on-disk file stays in canonical order (`year` desc, `masterpiece` desc, `my_best` desc, `len(awards)` desc, `director` desc) regardless of where a new entry logically belongs or whether an edit (e.g. a rating change) moved an existing entry's position. This is identical to the web app's own download behavior — nothing new to design here, just a reminder that the Android port must not skip it as a shortcut.

#### Commit

A **Commit** button, always visible on the Curation screen, with a status line reading:

```
N new, M update
```

where `N = newImdbIds.size` and `M = updatedImdbIds.size` (both session-scoped counters, reset after a successful commit — mirrors the web app's `clearNewIds()`-on-download pattern). Disable/gray out Commit when `N + M == 0`.

Tapping Commit does **not** push to GitHub directly — it opens a **Review changes** screen first, and the push only happens if the user explicitly confirms from there.

##### Review changes screen

1. Build the change set: every entry tagged in `newImdbIds` (in full) plus every entry tagged in `updatedImdbIds`, each paired with the pre-edit snapshot captured when its editing began (see *Tracking pre-edit snapshots* below).
2. List every changed entry, one row/card each:
   - **New entries** — a compact read-only card (poster thumbnail, `Title (Year)`, director, rating, note, awards — the same fields the detail view shows), labeled **NEW**.
   - **Updated entries** — a **field-level diff**: only the fields that actually changed, each rendered as `Field: old → new`, e.g. `Rating: (none) → Masterpiece`, `Note: "" → "rewatch candidate"`, `Director: Bong Joon Ho → 봉준호`. Unchanged fields are omitted — this is a diff, not a full re-render of the entry. Labeled **UPDATED**.
   - Tapping any row jumps back into the shared detail view to adjust that entry further before committing, without losing the rest of the pending batch.
3. Header repeats the `N new, M update` summary. Two actions:
   - **Cancel** — returns to Curation with everything untouched: no push happens, `newImdbIds`/`updatedImdbIds` and all pending edits are preserved exactly as they were, so the user can keep curating and come back to Commit later.
   - **Confirm & Commit** — proceeds with the push:
     1. Canonicalize the full in-memory collection (port of `canonicalizeAll`/`canonicalizeEntry`, [lib/canonicalize.js](lib/canonicalize.js) — field order, omit-empty rules, re-derive `awards` from `award_names`, enforce `masterpiece` xor `my_best`).
     2. Sort it (port of `sortMovies`, [lib/utils.js](lib/utils.js) — year desc, masterpiece desc, my_best desc, `len(awards)` desc, director desc).
     3. Dump to YAML text matching the exact on-disk format (block-style sequences, unicode preserved, insertion-order keys, no flow style — see *YAML handling*).
     4. Commit straight to GitHub via the **Contents API** (see *GitHub commit mechanism* below) — no local git, no working copy.
     5. On success: clear `newImdbIds`/`updatedImdbIds` and the pre-edit snapshots, reset the status line, return to Curation, toast/snackbar "Committed N new, M updated."
     6. On failure (network, 409 conflict, auth): keep all in-memory state — including the full pending change set — untouched, and land back on the Review changes screen (not all the way back to Curation) so the user can immediately retry without re-confirming from scratch; surface the actual error (don't silently drop edits).

This is the mechanism behind *"the app needs to show the YML entries that are edited or added to the user so that the user can confirm the action. It commits to GitHub only after the user confirms."*

##### Tracking pre-edit snapshots

Rendering the "what changed" diff for an existing entry needs both the **before** and **after** state — the in-memory collection alone only holds the current (after) state once an edit is saved. So: the moment an existing entry's detail view is opened for editing, deep-copy the entry as it stood *before any change in this session* and keep that snapshot keyed by `imdb_id`, alongside `updatedImdbIds`. Only the entry's *first* edit since the last commit captures the snapshot — a second, third, etc. edit to an already-dirty entry keeps comparing against that same original snapshot, so the Review screen always shows the full cumulative diff since the last successful commit, not just the most recent edit. Snapshots are cleared together with `updatedImdbIds` on a successful commit (and are naturally irrelevant if the user cancels, since nothing was pushed).

## GitHub commit mechanism

The Android app has no working git checkout and shouldn't need one for a single-file update. Use the **GitHub REST Contents API**, which creates a real commit on the target branch in one authenticated call — no bundled git binary, no JGit dependency:

```
GET  /repos/nambin/nambin.github.io/contents/data/movies.yml?ref=main
     → { content (base64), sha, ... }         # sha is required for the update call
PUT  /repos/nambin/nambin.github.io/contents/data/movies.yml
     body: { message, content (base64 of new YAML), sha, branch: "main" }
     → creates a commit directly on main, authored as the token's identity
```

Flow:

1. `GET` the current file to obtain its `sha` (needed even though the app already has the content in memory — GitHub requires the blob `sha` of the version being replaced, as an optimistic-concurrency check).
2. `PUT` the new content with that `sha`.
3. **On 409 (sha mismatch — someone/something else committed in between, e.g. the weekly awards-curation Action)**: re-`GET` for the fresh `sha` and retry the `PUT` **once**. If it still conflicts, surface an explicit "someone else updated the file — please retry" error rather than looping or force-overwriting.
4. Commit message: something like `curate: N new, M updated (via Android app)`.

### Build-time configuration & the secrets

The repo owner/name/branch, a **GitHub Personal Access Token**, and the **Gemini API key** are all compiled into the app via Gradle `buildConfigField`s sourced from a gitignored `local.properties`/`.env`-equivalent — the exact same posture this codebase already uses for the TMDB and (dev-build) Gemini keys: *"Embedding it client-side is acceptable for this personal, single-user tool."* (See [lib/tmdb_utils.js:15-24](lib/tmdb_utils.js#L15-L24) and the README's API-keys section for the precedent this mirrors.) Unlike the web app's `build` vs. `build:dev` split — which exists *because* the production bundle is served publicly on GitHub Pages and would leak a Gemini key to any visitor's view-source — this app has exactly one build variant and one installer, so there is no "safe build"/"unsafe build" distinction to preserve here.

Two things make these secrets worth flagging explicitly rather than waving through on precedent alone:

- **Scope the GitHub PAT down as far as GitHub allows.** Use a **fine-grained** PAT restricted to the single `nambin.github.io` repository with only the `Contents: Read and write` permission — not a classic PAT with broad `repo` scope. A leaked fine-grained token can only touch this one repo's files; a classic token can touch every repo the account can see. The Gemini key has no equivalent per-project scoping in AI Studio — if it ever needs to be treated as compromised, the fix is rotating it (and updating `.env`), not scoping it down further.
- **An APK is not a safe with a secret in it.** Anyone with the installed APK can `apktool`/`jadx` it and recover a hardcoded string — this is fundamentally different from a `.env` file that never leaves your machine or a CI secret that never leaves GitHub's runners. That's an acceptable trade **only** because this app is side-loaded for personal use and never uploaded to the Play Store, never shared as an APK with anyone else, and never rebuilt for another person's device. Flagging this explicitly so it's a conscious choice, not an assumed one — worth confirming before writing code. If the APK ever does need to leave your own devices for any reason, rotate both the PAT and the Gemini key first.

## Data model — no changes

Every field, the sort order, the YAML dump conventions, and the awards taxonomy are exactly as documented in [prompt-web-app.md](prompt-web-app.md#data-model) and [prompt-award-curation.md](prompt-award-curation.md). This app is a new *front door*, not a schema change.

### YAML handling on Android

`js-yaml` (the web app's library) has no Android equivalent, so port the *behavior*, not the library. **SnakeYAML** (or `snakeyaml-engine` for pure YAML 1.2) is the natural JVM choice; configure its `DumperOptions` to match [lib/utils.js](lib/utils.js)'s `YAML_DUMP_OPTIONS` as closely as possible:

- `DumperOptions.FlowStyle.BLOCK` (never `[...]` inline sequences)
- `setAllowUnicode(true)` (preserve Korean/accented text unescaped)
- Preserve **insertion order** — back entries with `LinkedHashMap`, never a sorted map, and never enable SnakeYAML's key-sorting.
- No anchors/aliases (SnakeYAML doesn't emit these unless the same object instance repeats — safe by construction if entries are always fresh maps).
- Width: disable line-wrapping (`setWidth(Int.MAX_VALUE)` or SnakeYAML's equivalent) — mirrors `lineWidth: -1`.
- Watch the same date-scalar footgun `YAML_SCHEMA` works around in JS: don't let the loader auto-resolve `date_committed`/`generated_at` (`YYYY-MM-DD`) into a typed date that then dumps with a time component. SnakeYAML's default resolver has a similar timestamp auto-resolution; either disable that resolver or always treat those two fields as plain strings on load and on dump.
- Round-trip test: load the live `data/movies.yml`, dump immediately with no edits, and diff — should be structurally identical (cosmetic quoting differences, e.g. single vs. double quotes around a string containing `:`, are acceptable, same caveat the web app's acceptance test already carries).

## Ported logic — JS module → Android equivalent

None of this is a new design; it's a straight port of already-working, already-tested logic into Kotlin so behavior stays identical across both clients.

| Web app source | Android port covers |
| --- | --- |
| [lib/utils.js](lib/utils.js) | `AWARD_NAMES`, `BADGE_KEY_BY_NAME`, `deriveAwardBadges`, `isKoreanLanguage`, `buildKoreanDirectorMap`, `getLanguageName` (+ the `cn`→Cantonese override), `sortMovies` |
| [lib/tmdb_utils.js](lib/tmdb_utils.js) | `buildMovieEntryFromTmdb` (title composition, field order, `country` omitted for new entries) |
| [lib/gemini_utils.js](lib/gemini_utils.js) | Call A / Call B system prompts and JSON response schemas, verbatim — reuse the exact prompt text so match quality doesn't drift between clients |
| [lib/memo_pipeline.js](lib/memo_pipeline.js) | `processMemoLine` orchestration: TMDB year±1 windowed search, candidate enrichment (`/movie/{id}?append_to_response=credits`), the `imdb_id`-required candidate filter, Korean-director map resolution (Call C stays disabled) |
| [lib/canonicalize.js](lib/canonicalize.js) | `canonicalizeEntry`/`canonicalizeAll` — field order, omit-empty, masterpiece/my_best exclusivity |
| [lib/awards_reconcile.js](lib/awards_reconcile.js) | `reconcileAwardNames`/`applyAwardsToEntry`-equivalent — overwrite `award_names` from `awards.yml`'s `by_imdb`, drop `awards` so canonicalize re-derives it |

## Suggested tech stack

- **Kotlin + Jetpack Compose** for UI (drawer via `ModalNavigationDrawer`, screens as composables, `Navigation-Compose` for the three destinations).
- **OkHttp** (or Ktor client) for TMDB / Gemini / GitHub REST calls — all plain HTTPS + JSON, no need for Retrofit's code-gen ceremony given the small number of endpoints.
- **kotlinx.serialization** or Moshi for the JSON bodies (Gemini structured-output schemas, TMDB responses, GitHub Contents API payloads).
- **SnakeYAML** for YAML load/dump (see above).
- **androidx.browser (Custom Tabs)** for the poster → TMDB link.
- **Jetpack DataStore (Preferences)** for the one persisted Setting (Gemini model tier).
- **In-memory `ViewModel` state only** for the loaded collection + the session's `newImdbIds`/`updatedImdbIds`/pre-edit snapshots — no on-disk cache backing it. If Android kills the process mid-session before Commit, that session's uncommitted adds/edits are lost and must be redone; accepted as a fine v1 trade-off given how cheap re-adding a movie or re-editing a rating is, and it keeps this app free of the web app's `localStorage` dirty-state persistence machinery entirely. Revisit if losing a session in practice turns out to be more than a rare annoyance.

## Acceptance test

- Cold launch → drawer closed, Curation visible by default, no movie cards shown, Commit disabled (0 new, 0 update).
- Tap ☰ → drawer opens over/beside Curation; tap Movies → drawer closes, WebView loads `https://nambin.github.io/movies.html?recent=true`.
- Settings → switch model tier to Flash Lite → relaunch app → choice persisted, and the next memo add visibly uses it (e.g. checked via a debug log line naming the model in the Gemini request).
- Curation → type a well-known, unambiguous English title (e.g. `Parasite 2019`) → resolves to one candidate automatically, detail view shows poster/Title (Year)/director/rating/note/awards (`오스카 최우수 작품상`-style entries should show `Oscar Best Picture`, `Cannes Palme d'Or`).
- Curation → type a title with multiple plausible TMDB hits (a common word, e.g. `Anora` with no year) → the shared detail view opens directly with a candidate picker at the top (no separate intermediate screen); switching the picker's selection re-fills poster/Title (Year)/director/awards on that same screen.
- Curation → type gibberish / a non-movie phrase → "not found" / "not a movie" message, no detail view.
- Curation → add a movie already in `data/movies.yml` (e.g. `Parasite 2019`) → "Already curated: Parasite (2019) — tap to open and edit instead." message, no new-entry detail view opens, `newImdbIds` unchanged; tapping the message opens the shared detail view in edit mode for the existing entry.
- Curation → add a movie, save it, then immediately try to add the exact same title again in the same session (before committing) → same "already curated" message fires against the session-local addition, not just the boot-loaded collection.
- Curation → open a new-entry detail view for a not-yet-duplicate candidate, then switch its candidate picker to a different option that IS already curated → the picker option is annotated "(already curated)" and selecting it swaps the whole screen to the "already curated" message + edit-mode handoff, instead of building a duplicate.
- Start an Add, leave its detail view unsaved, then try to open a second Add or a search result → prompted to finish or discard the in-progress one first (not two pending edits stacked).
- Search by director-only (e.g. `봉준호`) → returns his films; tapping one opens the edit view with rating/note editable and Save reflected in the "update" counter.
- Tap poster → Chrome Custom Tab opens the film's TMDB page (not an in-app WebView, not the system browser app-switch).
- Add one new movie + edit one existing movie's rating → status line reads `1 new, 1 update` → tap Commit → **Review changes** screen shows one **NEW** card (poster/Title (Year)/director/rating/note/awards) and one **UPDATED** row showing only `Rating: (none) → …` (no other fields listed, since nothing else changed).
- On the Review changes screen, tap **Cancel** → back on Curation, status line still reads `1 new, 1 update`, no GitHub commit created, both pending changes still editable.
- Edit the same existing entry's Note *after* already editing its Rating (still pre-commit) → Review changes screen's diff for that entry shows **both** `Rating: …` and `Note: …` changes relative to the original pre-session values, not just the latest edit.
- From Review changes, tap **Confirm & Commit** → GitHub shows a new commit on `main` touching only `data/movies.yml`, with exactly those two changes in the diff, in the correct sorted position, canonical field order/omission rules honored; app returns to Curation with `0 new, 0 update` and Commit disabled again.
- Force a `sha` conflict (edit `data/movies.yml` on GitHub.com between load and commit) → confirming from the Review changes screen auto-retries once with a fresh `sha` and either succeeds or reports a clear conflict error while remaining on the Review changes screen — no data loss, no silent overwrite of the intervening change, and the user can retry without re-reviewing the diff from scratch.

## Decisions made

- **UI toolkit:** Kotlin + Jetpack Compose (not Views) — this app's screens are Compose's sweet spot, and there's no existing Views codebase pulling the other way.
- **Save behavior:** auto-save-on-change in the shared detail view; no separate Save button, no unsaved-changes state.
- **Curation home layout:** the Add box and the Search box are both always visible on one screen — no Add/Update tab toggle.
- **Candidate picker placement:** embedded at the top of the shared detail view itself, not a separate screen — swapping candidates re-fills the same card.
- **Session-edit persistence:** in-memory only; a process death before Commit loses that session's uncommitted work, accepted as a fine v1 trade-off.
- **Secret embedding:** both the GitHub PAT and the Gemini API key are hardcoded at build time (see *Build-time configuration & the secrets*), on the understanding that this APK is never distributed beyond the user's own devices.

## Open questions for review

1. **Should the app cache `movies.yml`/`awards.yml` to disk for instant reopen**, refreshing in the background, or always block on a fresh network fetch on first Curation visit per session? Draft assumes the latter (simpler, and the collection is the single source of truth for duplicate-detection so staleness is a real correctness risk, not just a UX nicety).
2. **Award badge icons.** Text-only award names (v1, simplest) vs. porting the small badge icon set from [movies.html](../nambin.github.io/movies.html) — nice-to-have, not load-bearing for the curation workflow.
3. **Min/target Android SDK.** Not yet specified anywhere in this doc. Since the app only ever runs on the user's own device(s), what's the oldest Android version it realistically needs to support? This picks the `minSdk` in `build.gradle` and determines which Compose/Material3/Custom-Tabs APIs are safely available.
4. **UX for "one add/edit flow in progress at a time."** When the user tries to start a second Add or open a search result while a detail view already has unsaved changes (see *Duplicate prevention & sort invariants*): silently block the new action, or show a lightweight "Discard in-progress edit?" confirmation dialog? Draft leans toward the confirmation dialog (cheap to add, avoids silently swallowing a tap) but this hasn't been explicitly decided.
