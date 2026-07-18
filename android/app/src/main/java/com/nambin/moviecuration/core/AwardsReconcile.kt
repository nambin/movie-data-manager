package com.nambin.moviecuration.core

/**
 * Kotlin port of movie-data-manager/lib/awards_reconcile.js.
 * 
 * Overwrites the award data on a movie entry from data/awards.yml, which is 
 * the COMPLETE source of truth for awards: a movie's `award_names` become
 * exactly what awards.yml lists for that film (by imdb_id), and anything awards.yml
 * does not list is removed. There is no "preserved" subset.
 */

data class ReconcileResult(
    val awardNames: List<String>,
    val added: List<String>,
    val removed: List<String>,
    val changed: Boolean,
)

/**
 * Overwrite one movie's award_names from the ground truth (awards.yml's
 * list for the film). The result IS [groundTruthNames] — empty when the
 * film is not in awards.yml, so any award previously on the movie that
 * awards.yml doesn't list is dropped.
 */
fun reconcileAwardNames(existingNames: List<String>?, groundTruthNames: List<String>?): ReconcileResult {
    val existing = existingNames ?: emptyList()
    val gt = groundTruthNames ?: emptyList()
    val added = gt.filter { it !in existing }
    val removed = existing.filter { it !in gt }
    return ReconcileResult(
        awardNames = gt.toList(),
        added = added,
        removed = removed,
        changed = added.isNotEmpty() || removed.isNotEmpty(),
    )
}

/**
 * Overwrite one entry's `award_names` entirely from awards.yml (matched by
 * imdb_id). Mutates [entry]; returns true if anything changed. The derived
 * `awards` badge list is dropped so canonicalizeEntry re-derives it on dump.
 */
fun applyAwardsToEntry(entry: MovieEntry, awardsByImdb: Map<String, List<String>>): Boolean {
    val imdbId = entry["imdb_id"] as? String ?: return false
    val groundTruth = awardsByImdb[imdbId] ?: emptyList()
    @Suppress("UNCHECKED_CAST")
    val existing = entry["award_names"] as? List<String> ?: emptyList()
    val r = reconcileAwardNames(existing, groundTruth)
    if (!r.changed) return false
    if (r.awardNames.isNotEmpty()) entry["award_names"] = r.awardNames else entry.remove("award_names")
    entry.remove("awards")
    return true
}
