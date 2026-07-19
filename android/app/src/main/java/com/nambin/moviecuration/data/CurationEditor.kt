package com.nambin.moviecuration.data

import com.nambin.moviecuration.core.MovieEntry
import com.nambin.moviecuration.core.TmdbCandidate
import com.nambin.moviecuration.core.applyAwardsToEntry
import com.nambin.moviecuration.core.canonicalizeAll
import com.nambin.moviecuration.core.isKoreanLanguage
import com.nambin.moviecuration.core.sortMovies
import com.nambin.moviecuration.core.todayDateStringSeoul
import com.nambin.moviecuration.github.CommitOutcome
import com.nambin.moviecuration.github.GitHubContentsClient

/**
 * Result of [CurationEditor.addNew] / [CurationEditor.swapCandidate].
 *
 * [Added]: the entry is now in the collection and tracked as new for this
 * session — [entry] is the live (inserted) object and [imdbId] its key.
 * [Duplicate]: nothing was inserted because [existing] already covers the
 * same movie (matched by imdb_id, then tmdb_url) — the UI offers to open
 * [existing] for editing instead.
 */
sealed class AddOutcome {
    data class Added(val entry: MovieEntry, val imdbId: String) : AddOutcome()
    data class Duplicate(val existing: MovieEntry) : AddOutcome()
}

/**
 * Result of [CurationEditor.commit] — the pre-push safety checks plus the
 * GitHub push itself, as one exhaustive set of cases for the UI to map to
 * messages.
 *
 * [Success]: pushed and the session was cleared; [summary] is the
 * user-facing "Committed N new, M updated." line.
 * [DuplicateImdbIds]: aborted before pushing — the defensive re-check found
 * the same imdb_id on more than one entry (should be impossible via the
 * normal add path, but never push a corrupt file).
 * [DiffTooLarge]: aborted before pushing — the change would exceed the
 * diff-size safety cap (see DiffSizeGuard), a guard against accidentally
 * rewriting the whole file.
 * [Conflict]: someone else updated the file and the one automatic retry also
 * conflicted — the user should just retry.
 * [Failure]: any other error (network, GitHub API), with a displayable message.
 * In every case but [Success] the session's pending changes are kept intact.
 */
sealed class CommitAttemptOutcome {
    data class Success(val summary: String) : CommitAttemptOutcome()
    data class DuplicateImdbIds(val imdbIds: List<String>) : CommitAttemptOutcome()
    data class DiffTooLarge(val changedLines: Int, val limit: Int) : CommitAttemptOutcome()
    data object Conflict : CommitAttemptOutcome()
    data class Failure(val message: String) : CommitAttemptOutcome()
}

/** One row on the Review changes screen — see prompt-android-app.md. */
data class PendingChange(
    val imdbId: String,
    val isNew: Boolean,
    val entry: MovieEntry,
    val diffs: List<FieldDiff> = emptyList(), // only populated for updates
)

/**
 * One director line of the boot-time stats block: [director] is the entry's
 * `director` field verbatim, [latestEntry] that director's most recent film
 * (their first in canonical sort order — a live reference into the
 * collection, so tapping the line edits the same object the update flow
 * does), and [moreCount] the director's film count minus that one (the
 * ", M more" suffix, omitted at 0).
 */
data class DirectorStat(val director: String, val latestEntry: MovieEntry, val moreCount: Int)

/**
 * The stats block Curation home shows while the search box is empty —
 * computed once per boot from the collection as loaded, deliberately never
 * recomputed during the session (see prompt-android-app.md's "Collection
 * stats fill the default view"): a static snapshot that may go slightly
 * stale as the session adds/edits movies, an accepted trade-off that keeps
 * the code free of recomputation hooks.
 */
data class CollectionStats(val totalMovies: Int, val topDirectors: List<DirectorStat>)

/** Number of director lines in the stats block. */
private const val STATS_TOP_DIRECTORS = 7

/**
 * Pure computation behind [CurationEditor.collectionStats]: entries are
 * grouped by the exact `director` string (blank/missing directors count
 * toward the total but form no line) and ranked by film count, ties broken
 * by canonical collection order — the director appearing earlier wins.
 */
fun computeCollectionStats(movies: List<MovieEntry>): CollectionStats {
    val byDirector = sortMovies(movies)
        .filter { !(it["director"] as? String).isNullOrBlank() }
        .groupBy { it["director"] as String }
    // groupBy preserves first-encounter (= canonical) order and
    // sortedByDescending is stable, so equal-count ties keep that order.
    val top = byDirector.entries
        .sortedByDescending { it.value.size }
        .take(STATS_TOP_DIRECTORS)
        .map { (director, films) -> DirectorStat(director, films.first(), films.size - 1) }
    return CollectionStats(totalMovies = movies.size, topDirectors = top)
}

/**
 * Owns the choreography between [MovieRepository], [CurationSession], and the
 * pure `core` package functions for one Curation session, so callers (the
 * ViewModel) only need to translate UI events into calls here and map the
 * results into UI state — no independent data-mutation decisions of their own.
 */
class CurationEditor(
    private val repository: MovieRepository,
    private val gitHubClient: GitHubContentsClient,
    private val session: CurationSession = CurationSession(),
) {
    val newCount: Int get() = session.newCount
    val updateCount: Int get() = session.updateCount
    val koreanDirectorMap: Map<String, String> get() = repository.koreanDirectorMap

    /** Boot-time stats snapshot — set only by [loadFromServer], never by session mutations (see [CollectionStats]). */
    var collectionStats: CollectionStats = CollectionStats(0, emptyList())
        private set

    suspend fun loadFromServer() {
        repository.loadFromServer()
        collectionStats = computeCollectionStats(repository.movies)
    }

    fun search(query: String): List<MovieEntry> = repository.search(query)

    /**
     * imdb_ids (by TMDB candidate id) that are already curated — for the
     * picker's "(already curated)" hint. Must be called BEFORE [addNew]
     * inserts the picked entry, otherwise the just-picked movie would show up
     * flagged as already curated against itself.
     */
    fun alreadyCuratedCandidateIds(candidates: List<TmdbCandidate>): Set<Int> =
        candidates.filter { c -> c.details?.imdb_id?.let { repository.findByImdbId(it) != null } == true }
            .map { it.id }
            .toSet()

    fun addNew(entry: MovieEntry): AddOutcome {
        val duplicate = repository.findDuplicate(entry)
        if (duplicate != null) return AddOutcome.Duplicate(duplicate)

        applyAwardsToEntry(entry, repository.awardsByImdb)
        entry.putIfAbsent("date_committed", todayDateStringSeoul())
        repository.add(entry)
        val imdbId = requireNotNull(entry["imdb_id"] as? String) { "addNew: entry has no imdb_id" }
        session.markNew(imdbId)
        return AddOutcome.Added(entry, imdbId)
    }

    /**
     * Swaps the in-flight [current] candidate entry for [candidateEntry],
     * carrying over any fields the user already edited (candidate-independent
     * of which TMDB match is picked) before retiring [current] and inserting
     * [candidateEntry] in its place.
     */
    fun swapCandidate(current: MovieEntry, candidateEntry: MovieEntry): AddOutcome {
        (current["note"] as? String)?.let { candidateEntry["note"] = it }
        when {
            current["masterpiece"] == true -> candidateEntry["masterpiece"] = true
            current["my_best"] == true -> candidateEntry["my_best"] = true
        }
        candidateEntry["date_committed"] = (current["date_committed"] as? String) ?: todayDateStringSeoul()

        // Retire the previous in-flight candidate (candidate swap always
        // replaces, never accumulates) *before* the duplicate check, so a
        // swap into an "already curated" candidate can't strand the old
        // candidate's entry as an uncommitted phantom "new" addition.
        discardNew(current)

        val duplicate = repository.findDuplicate(candidateEntry)
        if (duplicate != null) return AddOutcome.Duplicate(duplicate)

        applyAwardsToEntry(candidateEntry, repository.awardsByImdb)
        repository.add(candidateEntry)
        val newImdbId = requireNotNull(candidateEntry["imdb_id"] as? String) { "swapCandidate: entry has no imdb_id" }
        session.markNew(newImdbId)
        return AddOutcome.Added(candidateEntry, newImdbId)
    }

    /**
     * Retires an uncommitted new entry: removes it from the collection and
     * un-marks it as new, as if the add never happened (the same movie is
     * immediately re-addable). Only ever applies to this session's own
     * uncommitted additions — committed entries are never deleted by this
     * app (see prompt-android-app.md's Non-goals).
     */
    fun discardNew(entry: MovieEntry) {
        repository.remove(entry)
        (entry["imdb_id"] as? String)?.let { session.unmarkNew(it) }
    }

    /**
     * Reverts an updated (non-new) entry back to its pre-edit snapshot,
     * mutating it in place — the entry object's identity must be preserved
     * because UI state holds the same reference. refreshUpdatedStatus then
     * sees an empty diff and un-marks the entry. No-op when there's no
     * snapshot (nothing was ever edited).
     */
    fun revertUpdate(imdbId: String) {
        val entry = repository.findByImdbId(imdbId) ?: return
        val snapshot = session.snapshotFor(imdbId) ?: return
        entry.clear()
        entry.putAll(snapshot)
        session.refreshUpdatedStatus(imdbId, entry)
        if (entry["director"] != null) repository.rebuildKoreanDirectorMap()
    }

    /** Call before an existing (non-new) entry becomes editable — no-op for new entries or repeat calls. */
    fun ensureSnapshot(imdbId: String, entry: MovieEntry) = session.ensureSnapshot(imdbId, entry)

    fun updateDirector(imdbId: String, value: String): Boolean = editField(imdbId) { entry ->
        val v = value.trim()
        if (entry["director"] as? String != v) {
            entry["director"] = v
            entry["is_korean_director"] = isKoreanLanguage(v)
            true
        } else {
            false
        }
    }

    /** [rating] is one of "masterpiece", "my_best", or "" for (none). */
    fun updateRating(imdbId: String, rating: String): Boolean = editField(imdbId) { entry ->
        val target = Rating.fromValue(rating)
        val changed = Rating.of(entry) != target
        if (changed) target.applyTo(entry)
        changed
    }

    fun updateNote(imdbId: String, value: String): Boolean = editField(imdbId) { entry ->
        val v = value.trim()
        if ((entry["note"] as? String ?: "") != v) {
            if (v.isNotEmpty()) entry["note"] = v else entry.remove("note")
            true
        } else {
            false
        }
    }

    private fun editField(imdbId: String, mutate: (MovieEntry) -> Boolean): Boolean {
        val entry = repository.findByImdbId(imdbId) ?: return false
        session.ensureSnapshot(imdbId, entry) // no-op for new entries or repeat calls
        val changed = mutate(entry)
        if (!changed) return false
        session.refreshUpdatedStatus(imdbId, entry) // no-op for new entries
        // Rebuild regardless of new-vs-existing: the web app always rebuilds this
        // map fresh from the live movies list immediately before each add, so a
        // director correction made to an existing (searched) entry this session
        // must be visible to the next memo add too, not just corrections made
        // while building a brand-new entry.
        if (entry["director"] != null) repository.rebuildKoreanDirectorMap()
        return true
    }

    fun buildReviewChanges(): List<PendingChange> {
        val changes = mutableListOf<PendingChange>()
        for (imdbId in session.newImdbIds) {
            val entry = repository.findByImdbId(imdbId) ?: continue
            changes.add(PendingChange(imdbId, isNew = true, entry = entry))
        }
        for (imdbId in session.updatedImdbIds) {
            val entry = repository.findByImdbId(imdbId) ?: continue
            val before = session.snapshotFor(imdbId) ?: continue
            val diffs = diffEntry(before, entry)
            if (diffs.isEmpty()) continue
            changes.add(PendingChange(imdbId, isNew = false, entry = entry, diffs = diffs))
        }
        return changes
    }

    suspend fun commit(): CommitAttemptOutcome {
        // Defensive re-check: never push a file with duplicate imdb_ids.
        val dupGroups = repository.movies
            .mapNotNull { it["imdb_id"] as? String }
            .groupingBy { it }
            .eachCount()
            .filterValues { it > 1 }
        if (dupGroups.isNotEmpty()) {
            return CommitAttemptOutcome.DuplicateImdbIds(dupGroups.keys.toList())
        }

        val canonical = canonicalizeAll(repository.movies)
        val sorted = sortMovies(canonical)
        val yamlText = YamlCodec.dumpMovies(sorted)
        val message = "curate: ${session.newCount} new, ${session.updateCount} updated (via Android app)"

        val outcome = try {
            gitHubClient.commitFile("data/movies.yml", yamlText, message)
        } catch (e: Exception) {
            CommitOutcome.Failure(e.message ?: "Unknown error")
        }

        return when (outcome) {
            is CommitOutcome.Success -> {
                val summary = "Committed ${session.newCount} new, ${session.updateCount} updated."
                session.clearAfterCommit()
                CommitAttemptOutcome.Success(summary)
            }
            is CommitOutcome.DiffTooLarge -> CommitAttemptOutcome.DiffTooLarge(outcome.changedLines, outcome.limit)
            is CommitOutcome.Conflict -> CommitAttemptOutcome.Conflict
            is CommitOutcome.Failure -> CommitAttemptOutcome.Failure(outcome.message)
        }
    }
}
