package com.nambin.moviecuration.data

import com.nambin.moviecuration.core.MovieEntry

/**
 * Session-scoped state for one Curation session: which entries are new vs.
 * updated since the last commit, and the pre-edit snapshot needed to render
 * a field-level diff on the Review changes screen.
 *
 * In-memory only, by design — see prompt-android-app.md's "Session-edit
 * persistence" decision: a process death before Commit loses this state,
 * accepted as a fine v1 trade-off rather than adding an on-disk cache.
 */
class CurationSession {
    private val _newImdbIds: MutableSet<String> = linkedSetOf()
    private val _updatedImdbIds: MutableSet<String> = linkedSetOf()
    val newImdbIds: Set<String> get() = _newImdbIds
    val updatedImdbIds: Set<String> get() = _updatedImdbIds
    private val preEditSnapshotsByImdbId: MutableMap<String, MovieEntry> = mutableMapOf()

    fun markNew(imdbId: String) {
        _newImdbIds.add(imdbId)
    }

    /** Retires an entry that was previously [markNew]'d without it ever being committed (e.g. a candidate swap). */
    fun unmarkNew(imdbId: String) {
        _newImdbIds.remove(imdbId)
    }

    /**
     * Call before mutating an existing (non-new) entry. Captures the
     * pre-edit snapshot only on the *first* touch this session — later edits
     * keep comparing against that same original snapshot, so the Review
     * screen always shows the full cumulative diff since the last commit,
     * not just the latest edit.
     */
    fun ensureSnapshot(imdbId: String, currentEntry: MovieEntry) {
        if (imdbId in _newImdbIds) return // new entries have no "before" state to diff against
        preEditSnapshotsByImdbId.putIfAbsent(imdbId, MovieEntry(currentEntry))
    }

    /**
     * Recompute whether an existing entry currently differs from its
     * pre-edit snapshot, and add/remove it from [updatedImdbIds] to match.
     * Unlike a one-way "mark and never unmark," this means reverting a field
     * back to its original value within the same session correctly drops
     * the entry back out of the "N update" count instead of leaving a
     * phantom update behind (the entry was never actually changed, from the
     * next commit's point of view). No-op for entries already tracked as new.
     */
    fun refreshUpdatedStatus(imdbId: String, currentEntry: MovieEntry) {
        if (imdbId in _newImdbIds) return
        val snapshot = preEditSnapshotsByImdbId[imdbId] ?: return
        if (diffEntry(snapshot, currentEntry).isEmpty()) {
            _updatedImdbIds.remove(imdbId)
        } else {
            _updatedImdbIds.add(imdbId)
        }
    }

    fun snapshotFor(imdbId: String): MovieEntry? = preEditSnapshotsByImdbId[imdbId]

    val newCount: Int get() = _newImdbIds.size
    val updateCount: Int get() = _updatedImdbIds.size
    val hasPendingChanges: Boolean get() = _newImdbIds.isNotEmpty() || _updatedImdbIds.isNotEmpty()

    fun clearAfterCommit() {
        _newImdbIds.clear()
        _updatedImdbIds.clear()
        preEditSnapshotsByImdbId.clear()
    }
}

/** The masterpiece/my_best rating, as a single value — the one place this precedence rule is implemented. */
enum class Rating(val value: String, val label: String) {
    NONE("", "(none)"),
    MY_BEST("my_best", "My Best"),
    MASTERPIECE("masterpiece", "Masterpiece");

    /** Sets [entry]'s masterpiece/my_best fields to reflect this rating, clearing the other. */
    fun applyTo(entry: MovieEntry) {
        entry.remove("masterpiece")
        entry.remove("my_best")
        when (this) {
            MASTERPIECE -> entry["masterpiece"] = true
            MY_BEST -> entry["my_best"] = true
            NONE -> Unit
        }
    }

    companion object {
        fun of(entry: MovieEntry): Rating = when {
            entry["masterpiece"] == true -> MASTERPIECE
            entry["my_best"] == true -> MY_BEST
            else -> NONE
        }

        fun fromValue(value: String): Rating = entries.find { it.value == value } ?: NONE
    }
}

/** Human-readable rating label, used by both the Rating dropdown and the diff view. */
fun ratingLabel(entry: MovieEntry): String = Rating.of(entry).label

data class FieldDiff(val label: String, val oldValue: String, val newValue: String) {
    // Rating's value is always one of "(none)"/"My Best"/"Masterpiece" (never truly
    // empty), so it's shown bare. Free-text fields (Director, Note) render bare when
    // non-empty, but an actually-empty value is quoted (`""`) rather than mislabeled
    // "(none)" — so a cleared field reads as "empty string" rather than "no value
    // was ever set".
    val oldDisplay: String get() = display(oldValue)
    val newDisplay: String get() = display(newValue)
    private fun display(value: String): String = if (label == "Rating" || value.isNotEmpty()) value else "\"\""
}

/**
 * Field-level diff between the pre-edit snapshot and the current entry,
 * covering only the fields this app lets the user edit. Unchanged fields
 * are omitted — this is a diff, not a full re-render. See the Review
 * changes screen in prompt-android-app.md.
 */
fun diffEntry(before: MovieEntry, after: MovieEntry): List<FieldDiff> {
    val diffs = mutableListOf<FieldDiff>()

    val beforeDirector = before["director"] as? String ?: ""
    val afterDirector = after["director"] as? String ?: ""
    if (beforeDirector != afterDirector) diffs.add(FieldDiff("Director", beforeDirector, afterDirector))

    val beforeRating = ratingLabel(before)
    val afterRating = ratingLabel(after)
    if (beforeRating != afterRating) diffs.add(FieldDiff("Rating", beforeRating, afterRating))

    val beforeNote = before["note"] as? String ?: ""
    val afterNote = after["note"] as? String ?: ""
    if (beforeNote != afterNote) diffs.add(FieldDiff("Note", beforeNote, afterNote))

    return diffs
}
