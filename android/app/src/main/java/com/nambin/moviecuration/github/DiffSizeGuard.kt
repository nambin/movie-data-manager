package com.nambin.moviecuration.github

import com.github.difflib.DiffUtils

/**
 * Hard stop against a bug (canonicalize/sort regression, YAML-formatting
 * drift, accidental full overwrite) silently turning a small curation
 * session into a commit that rewrites most of the file. The Review changes
 * screen catches wrong *intended* edits; this catches a wrong *mechanical*
 * diff. See prompt-android-app.md's "Diff-size safety cap".
 *
 * No in-app override — a genuinely large change should go through the web
 * editor or GitHub.com instead.
 */
object DiffSizeGuard {
    // 200, not 100: a rating edit relocates its entry within the sorted file,
    // and a line diff counts a moved entry twice (~2× entry size, 30+ lines per
    // rating edit) — the cap must leave room for a rating-heavy session while
    // still catching a real formatting/sort bug (a whole-file rewrite is
    // thousands of lines).
    const val MAX_COMMIT_DIFF_LINES = 200

    data class DiffSize(val inserted: Int, val deleted: Int) {
        val total: Int get() = inserted + deleted
    }

    /** Standard line-level diff (Myers/LCS) — the same notion `git diff --stat` reports. */
    fun computeDiffSize(oldText: String, newText: String): DiffSize {
        val patch = DiffUtils.diff(oldText.lines(), newText.lines())
        var inserted = 0
        var deleted = 0
        for (delta in patch.deltas) {
            inserted += delta.target.lines.size
            deleted += delta.source.lines.size
        }
        return DiffSize(inserted, deleted)
    }

    fun exceedsLimit(oldText: String, newText: String): Boolean =
        computeDiffSize(oldText, newText).total > MAX_COMMIT_DIFF_LINES
}
