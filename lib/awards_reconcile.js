// Reconcile the award data in data/movies.yml against the auto-generated
// data/awards.yml. awards.yml is the COMPLETE source of truth for awards: a
// movie's award_names are set to exactly what awards.yml lists for that film
// (by imdb_id), and anything awards.yml does not list is removed. There is no
// "preserved" subset — every award on a movie comes from awards.yml.
// See cli/reconcile-awards.mjs.

// Overwrite one movie's `award_names` from the ground truth (awards.yml's list
// for the film). The result IS `groundTruthNames` — empty when the film is not
// in awards.yml, so any award previously on the movie that awards.yml doesn't
// list is dropped. `added`/`removed` are reported for the change log.
export function reconcileAwardNames(existingNames, groundTruthNames) {
  const existing = Array.isArray(existingNames) ? existingNames : [];
  const gt = Array.isArray(groundTruthNames) ? groundTruthNames : [];
  const added = gt.filter((n) => !existing.includes(n));
  const removed = existing.filter((n) => !gt.includes(n));
  return {
    award_names: [...gt],
    added,
    removed,
    changed: added.length > 0 || removed.length > 0,
  };
}

// Reconcile a whole movies array against awards.yml's `by_imdb` map. Returns:
//   movies:    new array (entries copied only when changed)
//   changes:   [{ imdb_id, title, added, removed }] for each modified movie
//   unmatched: imdb-less entries that still carry awards (can't be reconciled —
//              there's no key to look them up by; left untouched and reported)
// The derived `awards` badge list is dropped from changed entries so that
// canonicalizeEntry re-derives it from the new award_names on dump.
export function reconcileMovies(movies, byImdb) {
  const changes = [];
  const unmatched = [];
  const out = movies.map((m) => {
    if (!m.imdb_id) {
      if ((m.award_names ?? []).length) {
        unmatched.push({ title: m.title, award_names: m.award_names });
      }
      return m;
    }
    const gt = byImdb[m.imdb_id]?.award_names ?? [];
    const r = reconcileAwardNames(m.award_names ?? [], gt);
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
