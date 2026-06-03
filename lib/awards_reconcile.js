// Reconcile the curated award data in data/movies.yml against the
// auto-generated data/awards.yml, treating awards.yml as the ground truth for
// the curated awards. Awards OUTSIDE that set (only `IIFA Awards` remains
// uncurated) are preserved untouched. See cli/reconcile-awards.mjs.

import { AWARD_QID_TO_NAME, WIKIPEDIA_AWARDS } from "./awards_curation.js";

// Every award awards.yml is authoritative over — the seven Wikidata awards plus
// the Wikipedia-sourced ones (Blue Dragon, César, Japan Academy). Uses the exact
// AWARD_NAMES strings (curly apostrophe in Venice, Korean Blue Dragon name) so
// set membership matches movies.yml byte-for-byte.
export const CURATED_AWARD_NAMES = new Set([
  ...Object.values(AWARD_QID_TO_NAME),
  ...WIKIPEDIA_AWARDS.map((a) => a.name),
]);

// Reconcile one movie's `award_names` against the ground-truth curated set.
//   - Non-curated names are always kept, in their original position.
//   - A curated name is kept only if it's in `groundTruthNames`; otherwise it's
//     removed (strict — applies even when the film is absent from awards.yml,
//     i.e. groundTruthNames is empty).
//   - Curated names in `groundTruthNames` not already present are appended.
// Returns the new list plus what was added/removed.
export function reconcileAwardNames(
  existingNames,
  groundTruthNames,
  curated = CURATED_AWARD_NAMES
) {
  const existing = Array.isArray(existingNames) ? existingNames : [];
  const gt = Array.isArray(groundTruthNames) ? groundTruthNames : [];
  const gtSet = new Set(gt);
  const kept = existing.filter((n) => !curated.has(n) || gtSet.has(n));
  const added = gt.filter((n) => curated.has(n) && !existing.includes(n));
  const removed = existing.filter((n) => curated.has(n) && !gtSet.has(n));
  return {
    award_names: [...kept, ...added],
    added,
    removed,
    changed: added.length > 0 || removed.length > 0,
  };
}

// Reconcile a whole movies array against awards.yml's `by_imdb` map. Returns:
//   movies:    new array (entries copied only when changed)
//   changes:   [{ imdb_id, title, added, removed }] for each modified movie
//   unmatched: imdb-less entries that carry curated awards (can't be reconciled)
// The derived `awards` badge list is dropped from changed entries so that
// canonicalizeEntry re-derives it from the new award_names on dump.
export function reconcileMovies(movies, byImdb, curated = CURATED_AWARD_NAMES) {
  const changes = [];
  const unmatched = [];
  const out = movies.map((m) => {
    if (!m.imdb_id) {
      const cur = (m.award_names ?? []).filter((n) => curated.has(n));
      if (cur.length) unmatched.push({ title: m.title, award_names: cur });
      return m;
    }
    const gt = byImdb[m.imdb_id]?.award_names ?? [];
    const r = reconcileAwardNames(m.award_names ?? [], gt, curated);
    if (!r.changed) return m;
    changes.push({
      imdb_id: m.imdb_id,
      title: m.title,
      added: r.added,
      removed: r.removed,
    });
    const next = { ...m };
    if (r.award_names.length) next.award_names = r.award_names;
    else delete next.award_names;
    delete next.awards; // re-derived by canonicalizeEntry on dump
    return next;
  });
  return { movies: out, changes, unmatched };
}
