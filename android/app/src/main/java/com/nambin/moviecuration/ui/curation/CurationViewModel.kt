package com.nambin.moviecuration.ui.curation

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.nambin.moviecuration.MovieCurationApplication
import com.nambin.moviecuration.core.*
import com.nambin.moviecuration.data.AddOutcome
import com.nambin.moviecuration.data.CollectionStats
import com.nambin.moviecuration.data.CommitAttemptOutcome
import com.nambin.moviecuration.data.CurationEditor
import com.nambin.moviecuration.data.PendingChange
import com.nambin.moviecuration.settings.GeminiModelSetting
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

data class CurationUiState(
    // True while the boot fetch of data/movies.yml + data/awards.yml is in flight.
    val loading: Boolean = true,
    // Non-null when that boot fetch failed — shows the error view with a Retry button.
    val loadError: String? = null,
    // Boot-time collection stats, shown while the search box is empty — a static
    // snapshot copied from CurationEditor once per (re)boot, never recomputed
    // during the session. The empty default is never visible: home only renders
    // after a successful boot has filled it.
    val collectionStats: CollectionStats = CollectionStats(0, emptyList()),

    // Session change counts, mirrored from CurationEditor after every mutation —
    // drive the "N new, M update" label and the Commit button's enablement.
    val newCount: Int = 0,
    val updateCount: Int = 0,

    // True while the memo pipeline (Gemini parse + TMDB search) is running —
    // disables the Add input/button and guards against double-submits.
    val addBusy: Boolean = false,
    // Status line under the Add box ("No match found…", pipeline errors); null = hidden.
    val addStatus: String? = null,
    // Whether addStatus renders in the error color or as a neutral message.
    val addStatusIsError: Boolean = false,
    // The already-curated entry an add collided with — shows the
    // "Already curated — tap to open and edit instead" affordance.
    val duplicateEntry: MovieEntry? = null,

    // TMDB candidates for the picker, shown in new-entry mode when the search
    // returned more than one plausible match.
    val candidates: List<TmdbCandidate> = emptyList(),
    // Pre-built movie entry for every candidate (built up front by MemoPipeline),
    // so swapping candidates is synchronous — no refetch, nothing that can fail.
    val entriesByCandidateId: Map<Int, MovieEntry> = emptyMap(),
    // Which candidate the active entry was built from; null outside new-entry mode.
    val selectedCandidateId: Int? = null,
    // Candidate ids to flag "(already curated)" in the picker.
    val alreadyCuratedCandidateIds: Set<Int> = emptySet(),

    // "Search to update" box: the raw query and its live results.
    val searchQuery: String = "",
    val searchResults: List<MovieEntry> = emptyList(),

    // Entry open in the shared detail view; null = no detail view showing.
    // NOTE: this is the same object CurationEditor mutates in place, not a copy.
    val activeEntry: MovieEntry? = null,
    // True when activeEntry is an uncommitted new addition (enables the candidate
    // picker), false when it's an existing entry being edited.
    val activeIsNew: Boolean = false,
    // activeEntry's imdb_id — the key passed to CurationEditor's field-edit calls.
    val activeImdbId: String? = null,
    // True when the currently-open detail view was reached by tapping a row
    // on the Review changes screen — closing it should return there (with a
    // freshly recomputed diff) instead of falling back to Curation's home.
    val openedFromReview: Boolean = false,

    // The pending batch shown on the Review changes screen; non-null = that
    // screen is open (it doubles as the navigation flag).
    val reviewChanges: List<PendingChange>? = null,
    // True while the GitHub commit is in flight — disables Cancel/Confirm.
    val commitBusy: Boolean = false,
    // Commit failure message, shown inline at the top of the Review screen.
    val commitError: String? = null,
    // Transient success message — CurationScreen shows it as a Toast, then
    // immediately calls dismissCommitSuccess() to null it back out.
    val commitSuccessMessage: String? = null,
)

/**
 * Thin adapter between the Curation Compose UI and [CurationEditor]: it
 * translates UI events into calls on the editor and maps the results into
 * [CurationUiState] — it makes no independent data-mutation decisions of
 * its own.
 */
class CurationViewModel(
    private val editor: CurationEditor,
    private val geminiModelSetting: GeminiModelSetting,
    private val client: OkHttpClient,
    private val geminiApiKey: String,
    private val tmdbApiKey: String,
) : ViewModel() {

    private val _uiState = MutableStateFlow(CurationUiState())
    val uiState: StateFlow<CurationUiState> = _uiState.asStateFlow()

    private var currentModelTier: GeminiModelTier = DEFAULT_GEMINI_MODEL

    init {
        viewModelScope.launch { geminiModelSetting.modelTierFlow.collect { currentModelTier = it } }
        boot()
    }

    fun boot() {
        _uiState.update { it.copy(loading = true, loadError = null) }
        viewModelScope.launch {
            try {
                editor.loadFromServer()
                _uiState.update { it.copy(loading = false, loadError = null, collectionStats = editor.collectionStats) }
            } catch (e: Exception) {
                _uiState.update { it.copy(loading = false, loadError = e.message ?: "Failed to load data/movies.yml") }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Add flow
    // -----------------------------------------------------------------------

    // Curation's home screen (the only place Add/Search are reachable) and
    // the shared detail view are mutually exclusive in CurationScreen's
    // dispatch, so there's never a *second* in-flight detail view to guard
    // against here — but a fast double-tap on Add before Compose recomposes
    // the disabled button could still launch two independent pipelines for
    // the same input. Guard on `addBusy` itself (checked synchronously,
    // before any suspension point) rather than on `activeEntry`.
    fun addMovie(rawLine: String) {
        if (rawLine.isBlank()) return
        if (_uiState.value.addBusy) return
        _uiState.update {
            it.copy(
                addBusy = true, addStatus = null, addStatusIsError = false, duplicateEntry = null,
                candidates = emptyList(), entriesByCandidateId = emptyMap(),
            )
        }
        viewModelScope.launch {
            // Names the model tier actually used for this request — the way the
            // spec's acceptance test verifies a Settings model-tier switch took
            // effect on the next memo add, without a rebuild.
            Log.d("CurationViewModel", "processMemoLine using Gemini model ${currentModelTier.modelId}")
            val result = try {
                processMemoLine(rawLine.trim(), geminiApiKey, tmdbApiKey, editor.koreanDirectorMap, currentModelTier, client)
            } catch (e: Exception) {
                MemoPipelineResult.Error(rawLine, e.message ?: "Unknown error")
            }
            handlePipelineResult(result)
        }
    }

    private fun handlePipelineResult(result: MemoPipelineResult) {
        when (result) {
            is MemoPipelineResult.NotMovie -> _uiState.update {
                it.copy(addBusy = false, addStatus = "That doesn't look like a movie title — try rephrasing.", addStatusIsError = true)
            }
            is MemoPipelineResult.Error -> _uiState.update {
                it.copy(addBusy = false, addStatus = result.error, addStatusIsError = true)
            }
            is MemoPipelineResult.NoMatch -> {
                // Show what was actually searched (Call A's parsed title), not the
                // raw memo line — the two can differ (e.g. a Korean transliteration
                // resolved to an English title before the TMDB search ran).
                val searched = result.parseResult?.title?.takeIf { it.isNotBlank() } ?: result.rawLine
                _uiState.update {
                    it.copy(addBusy = false, addStatus = "No match found on TMDB for \"$searched\".", addStatusIsError = true)
                }
            }
            is MemoPipelineResult.Ok ->
                openNewEntry(result.candidates, result.entriesByCandidateId, result.selectedCandidateId)
        }
    }

    private fun openNewEntry(candidates: List<TmdbCandidate>, entriesByCandidateId: Map<Int, MovieEntry>, selectedId: Int) {
        val entry = entriesByCandidateId.getValue(selectedId)
        // Computed before addNew() inserts `entry` so the just-picked movie
        // doesn't show up flagged as "already curated" against itself.
        val alreadyCuratedIds = editor.alreadyCuratedCandidateIds(candidates)
        when (val outcome = editor.addNew(entry)) {
            is AddOutcome.Duplicate -> {
                if (candidates.size > 1) {
                    // Ambiguous title: the duplicate may just be the wrong
                    // pick, so go straight to the detail view with the full
                    // picker — showing the *existing* entry (in-view notice;
                    // edits apply to it directly) rather than dead-ending.
                    val existingId = outcome.existing["imdb_id"] as? String
                    if (existingId != null) editor.ensureSnapshot(existingId, outcome.existing)
                    _uiState.update {
                        it.copy(
                            addBusy = false,
                            addStatus = null,
                            duplicateEntry = null,
                            activeEntry = outcome.existing,
                            activeIsNew = false,
                            activeImdbId = existingId,
                            candidates = candidates,
                            entriesByCandidateId = entriesByCandidateId,
                            selectedCandidateId = selectedId,
                            alreadyCuratedCandidateIds = alreadyCuratedIds,
                        )
                    }
                } else {
                    // Single candidate: the classic dead-end message with the
                    // tap-to-edit handoff — there's nothing else to pick.
                    _uiState.update {
                        it.copy(
                            addBusy = false,
                            addStatus = null,
                            duplicateEntry = outcome.existing,
                            candidates = emptyList(),
                            entriesByCandidateId = emptyMap(),
                        )
                    }
                }
            }
            is AddOutcome.Added -> _uiState.update {
                it.copy(
                    addBusy = false,
                    addStatus = null,
                    activeEntry = outcome.entry,
                    activeIsNew = true,
                    activeImdbId = outcome.imdbId,
                    candidates = candidates,
                    entriesByCandidateId = entriesByCandidateId,
                    selectedCandidateId = selectedId,
                    alreadyCuratedCandidateIds = alreadyCuratedIds,
                    newCount = editor.newCount,
                    updateCount = editor.updateCount,
                )
            }
        }
    }

    fun openDuplicateForEdit() {
        val dup = _uiState.value.duplicateEntry ?: return
        openExistingForEdit(dup)
        _uiState.update { it.copy(duplicateEntry = null) }
    }

    // -----------------------------------------------------------------------
    // Candidate picker (Add flow only)
    // -----------------------------------------------------------------------

    // Every candidate's entry was already built up front by MemoPipeline (see
    // MemoPipelineResult.Ok) — swapping is just picking a different one of
    // these already-built entries, synchronously, no fetch/build/re-resolve
    // needed and nothing that can fail on the network.
    fun selectCandidate(candidateId: Int) {
        val state = _uiState.value
        val current = state.activeEntry ?: return
        if (candidateId == state.selectedCandidateId) return
        val newEntry = state.entriesByCandidateId[candidateId] ?: return

        val outcome = if (state.activeIsNew) {
            // Swap retires the in-flight entry and carries the user's edits
            // over when the target is insertable.
            editor.swapCandidate(current, newEntry)
        } else {
            // Currently showing an already-curated entry — nothing in-flight
            // to retire, and edits made to it are legitimate updates that
            // stay. addNew doubles as the resolver: Added inserts the new
            // pick, Duplicate hands back the target's existing entry.
            editor.addNew(newEntry)
        }
        when (outcome) {
            is AddOutcome.Added -> _uiState.update {
                it.copy(
                    activeEntry = outcome.entry,
                    activeIsNew = true,
                    activeImdbId = outcome.imdbId,
                    selectedCandidateId = candidateId,
                    newCount = editor.newCount,
                    updateCount = editor.updateCount,
                )
            }
            is AddOutcome.Duplicate -> {
                // The picked candidate is already curated: keep the picker
                // and show the *existing* entry in this same view — the
                // in-view notice explains that edits apply to it directly.
                val existingId = outcome.existing["imdb_id"] as? String
                if (existingId != null) editor.ensureSnapshot(existingId, outcome.existing)
                _uiState.update {
                    it.copy(
                        activeEntry = outcome.existing,
                        activeIsNew = false,
                        activeImdbId = existingId,
                        selectedCandidateId = candidateId,
                        newCount = editor.newCount,
                        updateCount = editor.updateCount,
                    )
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Search / update flow
    // -----------------------------------------------------------------------

    fun updateSearchQuery(query: String) {
        _uiState.update { it.copy(searchQuery = query, searchResults = editor.search(query)) }
    }

    fun openSearchResult(entry: MovieEntry) {
        openExistingForEdit(entry)
    }

    private fun openExistingForEdit(entry: MovieEntry) {
        val imdbId = entry["imdb_id"] as? String ?: return
        editor.ensureSnapshot(imdbId, entry)
        _uiState.update {
            it.copy(
                activeEntry = entry,
                activeIsNew = false,
                activeImdbId = imdbId,
                candidates = emptyList(),
                entriesByCandidateId = emptyMap(),
                selectedCandidateId = null,
                alreadyCuratedCandidateIds = emptySet(),
                duplicateEntry = null,
                openedFromReview = false,
            )
        }
    }

    /** Jump back into the shared detail view from a Review changes row, without losing the rest of the pending batch. */
    fun openEntryFromReview(change: PendingChange) {
        if (!change.isNew) {
            editor.ensureSnapshot(change.imdbId, change.entry) // no-op if already snapshotted
        }
        _uiState.update {
            it.copy(
                reviewChanges = null,
                activeEntry = change.entry,
                activeIsNew = change.isNew,
                activeImdbId = change.imdbId,
                candidates = emptyList(),
                entriesByCandidateId = emptyMap(),
                selectedCandidateId = null,
                alreadyCuratedCandidateIds = emptySet(),
                openedFromReview = true,
            )
        }
    }

    /**
     * Aborts an in-flight add: retires the uncommitted entry (removed from
     * the collection, un-marked as new) and leaves the detail view — what
     * the back arrow (and system back) does for a new entry. See
     * prompt-android-app.md's "Shared detail view".
     */
    fun discardActiveNewEntry() {
        val state = _uiState.value
        val entry = state.activeEntry ?: return
        if (!state.activeIsNew) return
        editor.discardNew(entry)
        val returnToReview = state.openedFromReview
        _uiState.update {
            it.copy(
                activeEntry = null,
                activeIsNew = false,
                activeImdbId = null,
                candidates = emptyList(),
                entriesByCandidateId = emptyMap(),
                selectedCandidateId = null,
                alreadyCuratedCandidateIds = emptySet(),
                openedFromReview = false,
                newCount = editor.newCount,
                updateCount = editor.updateCount,
            )
        }
        // Return to the Review batch only if something is still pending.
        if (returnToReview && editor.newCount + editor.updateCount > 0) openReviewChanges()
    }

    fun closeDetail() {
        val returnToReview = _uiState.value.openedFromReview
        _uiState.update {
            it.copy(
                activeEntry = null,
                activeIsNew = false,
                activeImdbId = null,
                candidates = emptyList(),
                entriesByCandidateId = emptyMap(),
                selectedCandidateId = null,
                alreadyCuratedCandidateIds = emptySet(),
                openedFromReview = false,
            )
        }
        if (returnToReview) openReviewChanges()
    }

    // -----------------------------------------------------------------------
    // Field edits — staged in the view, applied only on Accept (see Decisions made)
    // -----------------------------------------------------------------------

    /**
     * Commits the staged Director/Rating/Note (and, for a new entry, the
     * Recent checkbox) onto the active entry in one step, then leaves the
     * detail view exactly like [closeDetail]. For a new entry this finalizes
     * the add; for an existing entry each `editor.updateX` call already
     * no-ops when its value didn't actually change, and [recent] is ignored
     * (an existing entry's `date_committed` was already decided at its real
     * add time).
     */
    fun acceptActiveEntry(director: String, rating: String, note: String, recent: Boolean) {
        val imdbId = _uiState.value.activeImdbId ?: return
        editor.updateDirector(imdbId, director)
        editor.updateRating(imdbId, rating)
        editor.updateNote(imdbId, note)
        if (_uiState.value.activeIsNew) editor.applyRecency(imdbId, recent)
        _uiState.update { it.copy(newCount = editor.newCount, updateCount = editor.updateCount) }
        closeDetail()
    }

    // -----------------------------------------------------------------------
    // Commit — Review changes screen, then Confirm & Commit
    // -----------------------------------------------------------------------

    fun openReviewChanges() {
        _uiState.update { it.copy(reviewChanges = editor.buildReviewChanges(), commitError = null) }
    }

    fun closeReviewChanges() {
        _uiState.update { it.copy(reviewChanges = null, commitError = null) }
    }

    /**
     * Removes one pending change from the Review batch: a NEW row discards
     * the addition entirely; an UPDATED row reverts the entry to its
     * pre-edit snapshot. An emptied batch returns to Curation home (there
     * is nothing left to confirm).
     */
    fun removePendingChange(change: PendingChange) {
        if (change.isNew) editor.discardNew(change.entry) else editor.revertUpdate(change.imdbId)
        val remaining = editor.buildReviewChanges()
        _uiState.update {
            it.copy(
                reviewChanges = if (remaining.isEmpty()) null else remaining,
                newCount = editor.newCount,
                updateCount = editor.updateCount,
            )
        }
    }

    fun confirmCommit() {
        _uiState.update { it.copy(commitBusy = true, commitError = null) }
        viewModelScope.launch {
            when (val outcome = editor.commit()) {
                is CommitAttemptOutcome.Success -> _uiState.update {
                    it.copy(
                        commitBusy = false,
                        reviewChanges = null,
                        commitSuccessMessage = outcome.summary,
                        newCount = 0,
                        updateCount = 0,
                    )
                }
                is CommitAttemptOutcome.DuplicateImdbIds -> _uiState.update {
                    it.copy(
                        commitBusy = false,
                        commitError = "Duplicate imdb_id(s) detected — aborted before committing: ${outcome.imdbIds.joinToString()}",
                    )
                }
                is CommitAttemptOutcome.DiffTooLarge -> _uiState.update {
                    it.copy(
                        commitBusy = false,
                        commitError = "This commit would change ${outcome.changedLines} lines (limit: ${outcome.limit}) — aborted before pushing to GitHub.",
                    )
                }
                is CommitAttemptOutcome.Conflict -> _uiState.update {
                    it.copy(commitBusy = false, commitError = "Someone else updated data/movies.yml — please retry.")
                }
                is CommitAttemptOutcome.Failure -> _uiState.update {
                    it.copy(commitBusy = false, commitError = outcome.message)
                }
            }
        }
    }

    fun dismissCommitSuccess() {
        _uiState.update { it.copy(commitSuccessMessage = null) }
    }
}

class CurationViewModelFactory(private val app: MovieCurationApplication) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return CurationViewModel(
            editor = CurationEditor(repository = app.movieRepository, gitHubClient = app.gitHubContentsClient),
            geminiModelSetting = app.geminiModelSetting,
            client = app.okHttpClient,
            geminiApiKey = com.nambin.moviecuration.BuildConfig.GEMINI_API_KEY,
            tmdbApiKey = com.nambin.moviecuration.BuildConfig.TMDB_API_KEY,
        ) as T
    }
}
