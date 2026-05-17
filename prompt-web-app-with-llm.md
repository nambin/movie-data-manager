# Memo-driven Bulk Import — Implementation Prompt (Draft)

> Companion to [prompt-web-app.md](prompt-web-app.md), which specifies the existing single-movie-via-TMDB-URL editor implemented in [index.html](index.html) and [lib/app.js](lib/app.js) (the entrypoint that esbuild bundles via `npm run build`; see [package.json](package.json)). This draft layers a memo-driven bulk-import flow on top; the data model, YAML round-trip rules, sort order, and field semantics from that document still apply unchanged.

## Goal

Looking up a TMDB URL per movie and filling fields one at a time is tedious. Add a path where I dump an **unstructured memo** (mostly titles, sometimes a year or director or a Korean overlay) into a textbox, and the tool parses the memo with an LLM, looks up each candidate on TMDB, and presents me a review pane of pre-filled entries to approve.

Goal in one line: **paste-many → review → commit**, replacing the one-URL-at-a-time bottleneck for backfill and catch-up sessions.

## Example memos

A realistic memo from this user — these are *not* Korean movies; they are Korean phonetic transliterations of foreign titles, which is the **dominant input shape** the LLM has to handle:

```
보헤미안 랩소디            → Bohemian Rhapsody
아임 스틸 히어             → I'm Still Here
센티맨털 밸류              → Sentimental Value
플라워킬링문               → Killers of the Flower Moon
그대들은 어떻게 살 것인가  → The Boy and the Heron  (Korean title for the Japanese film 君たちはどう生きるか)
카인드 오브 카인드니스     → Kinds of Kindness
올 오브 어스 스트레인저스  → All of Us Strangers
고지라-1.0                 → Godzilla Minus One
아메리칸 픽션              → American Fiction
메이 디셈버                → May December
디 아이언 클로             → The Iron Claw
에밀리아 페레스            → Emilia Pérez
신성한 무화과나무의 씨앗   → The Seed of the Sacred Fig
```

The LLM's job on each line is to **recognize the foreign movie behind the Korean phonetic spelling and emit a TMDB-searchable title** (typically the English title; original-language title is fine too — TMDB search handles both). The Korean form itself is not preserved anywhere in the data model — it's purely a lookup key the user finds convenient to type.

Other memo shapes the LLM must also handle gracefully when mixed in:

- An English title outright: `Anora 2024`
- A Korean *original* title for a Korean movie: `어쩔수가없다 박찬욱` — search TMDB in Korean, expect a Korean-original result.
- An English title with a parenthetical Korean overlay the user *does* want preserved: `Adolescence (소년의 시간)` — emit `korean_overlay: "소년의 시간"` so the editor sets `custom_korean_title`. **Only** this parenthetical pattern produces a `korean_overlay`; bare Korean transliterations like `보헤미안 랩소디` do not.

## Non-goals

- **Awards are out of scope for the LLM.** The existing awards checkboxes remain the only way to set `award_names`/`awards`. The LLM never reads, infers, or writes awards. (Too easy to confuse "nominee" with "winner"; the taxonomy is small enough to click.)
- **No editing of TMDB-sourced fields.** Same as the existing editor — the LLM is allowed to *choose* among TMDB candidates, but it does not invent titles, posters, languages, or IMDB IDs.
- **No persistence of the memo itself.** Once entries are committed, the memo is discarded. Re-pasting the same memo should be idempotent because duplicate-detection by TMDB ID already exists.
- **No server.** Everything stays client-side, same hosting story as today.

## User flow

1. **Paste** unstructured memo into a textarea at the top of [index.html](index.html), above (or below) the existing TMDB-URL "Add movie" bar.
2. Click **Process memo**. The button is disabled until both (a) the memo is non-empty and (b) a Gemini API key is stored (see *API key handling*).
3. The app splits the memo into one line per non-empty paragraph (a plain string split — no LLM call). Each line spawns an independent **per-movie pipeline** that runs in parallel with the others:
   1. **Call A — Parse** (1 LLM call): turn the line into a `MemoEntry { title, year?, director?, korean_overlay? }` TMDB-searchable query, or `{ is_movie: false }` if the line isn't a movie title at all (chatter, a date, a note).
   2. **TMDB search** (1–3 HTTP calls): `GET /search/movie` with the parsed query (filtered by year when present, retried without year on zero results); keep the top 5 candidates; for the top 2–3, fetch `/movie/{id}?append_to_response=credits` so director and poster are available for the next step.
   3. **Call B — Match** (1 LLM call): show Gemini the **raw memo line** alongside the candidate list (title, original title, year, director, poster URL) and let it pick the right candidate or explicitly declare "no match." This is the verification step — Gemini decides yes/no, returns a confidence level, and emits a one-sentence `reasoning` that the review pane can surface.
   4. **Entry build** (no LLM call): app constructs the YAML-shaped entry from the picked TMDB candidate, identical to the URL-paste flow.
   5. **Call C — Korean director** (0 or 1 LLM call, conditional): if the picked TMDB director is **not** in the romanized→Korean map and a Korean-context signal fires (see *Call C*), make a narrow Gemini call to translate. Skipped otherwise.
4. The app renders a **review pane** — one card per memo line — showing the constructed entry the way the existing editor would render it (poster, title, year, director), plus a confidence badge (from Call B), a "🤖 LLM-filled" marker on the director field if Call C produced it, and Call B's `reasoning` accessible behind a disclosure triangle.
5. The user can, per card: approve, edit any of the standard editable fields (same controls as the existing editor), pick a different TMDB candidate from a dropdown of the top 5 search results, or drop the card entirely.
6. **Commit all approved** appends the cards to the in-memory collection (same data flow as today's "Add movie" button), the textbox is cleared, and the review pane closes. Duplicates (by TMDB ID, then by IMDB ID) are skipped silently with a footer note.

The flow is explicitly **review-then-commit**, not autopilot. Nothing reaches the collection without a click.

## LLM details

### Endpoint and model

- Provider: Google Gemini, public REST endpoint at `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}`.
- Model: **`gemini-flash-lite-latest`** (user-specified; chosen for cost and latency — memo parsing is shallow, no reasoning needed).
- Request mode: **structured output** via `generationConfig.responseMimeType = "application/json"` plus `responseSchema` constraining the output to the `MemoEntry[]` shape. This is the official Gemini equivalent of OpenAI's "json mode" and avoids parser fragility.
- Temperature: low (`0.0`–`0.2`) — we want deterministic extraction, not creativity.

### API key handling

- The key comes from the user's AI Studio account. The user pastes it once into a small settings UI (a "🔑 Gemini key" affordance in the header that opens a modal or expandable input).
- Persisted in `localStorage` under a single key, same posture as the TMDB key.
- Embedding it client-side is acceptable for this personal, single-user tool. (Same threat model as today's TMDB key being hard-coded into [data-manager.py:35](data-manager.py#L35).)
- If the key is missing, the **Process memo** button is disabled and a tooltip points the user at the settings affordance.

### LLM call budget — per movie

| Step                       | LLM calls | When fired                                              |
| -------------------------- | --------- | ------------------------------------------------------- |
| **A** — Parse memo line    | 1         | Always                                                  |
| **B** — TMDB candidate match | 1       | When TMDB search returned ≥1 candidate (skipped on no-match) |
| **C** — Korean director name | 0 or 1  | Map miss AND Korean-context signal AND Call B matched   |

- **Best case per movie: 1 call** — Call A says `is_movie: false`, or TMDB search returned zero hits.
- **Typical per movie: 2 calls** — parse + match. Director is non-Korean, or already in the romanized→Korean map.
- **Worst case per movie: 3 calls** — parse + match + first-time Korean director enrichment.

For a typical 10-line memo with 1–2 first-time Korean directors: **~21 Gemini calls total**, all running in parallel across per-line pipelines. Flash Lite's pricing and latency make this cheap enough that combining steps to save calls isn't worth the accuracy regression — the user explicitly preferred more calls if they improve match quality.

**Why per-line, not per-paste:**

- The model focuses on one title at a time, which is empirically better for transliterated foreign titles.
- A malformed line poisons only its own pipeline; the other 9 movies still resolve cleanly.
- Call B's verification *must* see TMDB's response, so it cannot be folded into Call A regardless of batching.
- Pipelines run in parallel, so per-line ≠ slow — wall time is dominated by the slowest single movie.

**Why three calls and not one with function-calling:** the simpler "LLM parses → app searches → LLM matches" split is easier to debug, lets each prompt stay narrow, and avoids browser-side tool-use plumbing. The trade-off (one extra round-trip per movie) is small on Flash Lite.

### Call A — Parse one memo line

System / instruction text, roughly:

> You receive a single line from an unstructured memo of movie titles. Decide whether it names a movie. If it does not (e.g. a note like "watched with J", a date, a comment), return `{ "is_movie": false }`. Otherwise return a TMDB-searchable query.
>
> A very common case is that **a non-Korean movie is written in Korean phonetic transliteration** (e.g. `보헤미안 랩소디` = "Bohemian Rhapsody", `플라워킬링문` = "Killers of the Flower Moon", `에밀리아 페레스` = "Emilia Pérez"). For these, return the original English title in `title`. Do **not** put the Korean phonetic form in `korean_overlay`.
>
> If the line is a Korean *original*-language movie (e.g. `어쩔수가없다`, `기생충`), return it as written — TMDB search handles Korean originals natively.
>
> `korean_overlay` is **only** for the explicit `English Title (한국어)` parenthetical pattern, e.g. `Adolescence (소년의 시간)` → `korean_overlay: "소년의 시간"`.
>
> Do not invent year or director unless they are explicit in the line. Return JSON conforming to the provided schema.

Response schema:

```jsonc
{
  "type": "object",
  "properties": {
    "is_movie":       { "type": "boolean" },
    "title":          { "type": "string",  "nullable": true }, // TMDB-searchable title
    "year":           { "type": "integer", "nullable": true },
    "director":       { "type": "string",  "nullable": true }, // as written in memo
    "korean_overlay": { "type": "string",  "nullable": true }  // ONLY the parenthetical pattern
  },
  "required": ["is_movie"]
}
```

When `is_movie: false`, the pipeline short-circuits — no TMDB call, no Call B, no review-pane card; the line is reported in a footer summary as "skipped (not a movie)".

The LLM is **not** asked about awards, ratings, notes, IMDB IDs, posters, or Korean director names at this step. Keep the prompt narrow.

### Call B — TMDB candidate match

After Call A and the TMDB search return, this call decides which TMDB candidate (if any) actually matches the user's memo line. It's the verification step — Gemini is allowed to look at all the candidates and say "none of these is right" rather than picking the heuristically-best one.

Prompt template (the app fills in the placeholders):

> You are matching one user memo line to one TMDB movie.
>
> The user wrote: `{raw_line}`
>
> Parsed query: `{parsed_title}` (year: `{year or "—"}`, director: `{director or "—"}`)
>
> TMDB search returned these candidates (ordered by TMDB popularity):
>
> ```
> 1. tmdb_id=496243 | title="Parasite" / original_title="기생충" | 2019 | directors: Bong Joon Ho | popularity: 89.2
> 2. tmdb_id=...    | ...
> ```
>
> Pick which candidate (if any) matches the memo line. Matching cues include title likeness across romanization, transliteration, or translation (e.g. `보헤미안 랩소디` matches "Bohemian Rhapsody"); year (when the memo specifies one); director (when the memo specifies one). If no candidate is a confident match, return `matched_tmdb_id: null`. Be willing to reject all candidates — a wrong match is worse than no match.

Response schema:

```jsonc
{
  "type": "object",
  "properties": {
    "matched_tmdb_id": { "type": "integer", "nullable": true },
    "confidence":      { "type": "string",  "enum": ["high", "medium", "low"] },
    "reasoning":       { "type": "string" }  // one sentence; shown behind a disclosure in the review pane
  },
  "required": ["matched_tmdb_id", "confidence"]
}
```

Review-pane treatment:

- `matched_tmdb_id != null && confidence == "high"` → card border green, candidate dropdown collapsed.
- `confidence == "medium"` → border yellow, dropdown collapsed but `reasoning` shown.
- `confidence == "low"` or `matched_tmdb_id == null` → border red, dropdown auto-expanded with all candidates visible, `reasoning` shown.

Even a `high`-confidence match can be overridden by the user in the candidate dropdown — Gemini is a strong default, not the final word.

### Call C — Korean director enrichment: map lookup, then gated LLM fallback

Today's YML stores Korean directors under their Korean name in `director` (e.g. `봉준호`), while `tmdb_director_name_1` carries the romanization (`Bong Joon Ho`). TMDB does not reliably return the Korean form. The existing YML already contains every romanized→Korean pair the user has curated, so the **primary path is a lookup**; the LLM is only a fallback for first-time Korean directors.

**Step 1 — Build the map on load.** Scan the loaded YML once:

```js
// All entries with is_korean_director: true contribute their Korean-name mapping.
const koreanDirectorMap = new Map();
for (const entry of movies) {
  if (!entry.is_korean_director) continue;
  for (const romanized of [entry.tmdb_director_name_1, entry.tmdb_director_name_2]) {
    if (romanized) koreanDirectorMap.set(romanized, entry.director);
  }
}
// e.g. "Bong Joon Ho" → "봉준호", "Park Chan-wook" → "박찬욱", "Yoon Ga-eun" → "윤가은", ...
```

**Step 2 — Resolve each new entry's director:**

1. **Map hit on `tmdb_director_name_1`** → use the Korean name from the map; recompute `is_korean_director` from the U+AC00–U+D7A3 check (it will be `true`). Done — Call C does **not** fire.
2. **Map miss, but a Korean-context signal fires** → make Call C (next paragraph). Use its result if non-null; otherwise fall to step 3.
3. **Map miss, no Korean signal, or Call C returned `null`** → leave `director` as the TMDB romanization. The review-pane card lets the user type the Korean form manually. Once that entry is committed and downloaded, the mapping is in the YML and will be picked up automatically on the next load — so the map grows organically and Call C is increasingly rare over time.

**Korean-context signals** (any one is enough to fire Call C):

- The memo line for this entry contained any character in U+AC00–U+D7A3 (the user typed Korean — a strong hint they expect a Korean director or Korean-overlay film).
- TMDB returns `original_language == "ko"`.
- TMDB returns a `production_countries` entry with `iso_3166_1 == "KR"`.

If none of these fire, the director is almost certainly non-Korean and Call C is skipped — no point asking Gemini whether "Christopher Nolan" should be Korean.

**Call C prompt:**

> The romanized name of a film's director is `{romanized_name}`. The film is `{movie_title}`. Return the director's name in Korean script (한글, U+AC00–U+D7A3) if and only if you are confident this person is Korean. Return `null` otherwise. Do not guess.

Response schema:

```jsonc
{
  "type": "object",
  "properties": {
    "korean_name": { "type": "string", "nullable": true }
  },
  "required": ["korean_name"]
}
```

Per-movie rather than batched: keeps each per-line pipeline independent and lets each review-pane card render as soon as its three calls complete. Batching across pipelines would save 1–2 round-trips per memo but introduces a synchronization barrier; not worth the complexity at this scale.

**Review pane treatment.** When the Korean name came from Call C (not the map), the review-pane card shows a "🤖 LLM-filled" badge next to the director field so the user knows to glance at it before approving. Map-hit values get no badge (they're already-vetted from prior commits).

The same lookup+fallback chain is useful enough that it should arguably also fire for the existing single-URL add path. Worth doing in the same change.

### Failure modes and surface

- Gemini 4xx on Call A (bad key, quota): surface a one-line error above the textarea and keep the textbox content intact for retry. Other per-movie pipelines that already kicked off are allowed to finish.
- Gemini returns JSON that doesn't fit the schema: log to console, render the affected card as a "parse failed" stub with the raw response viewable behind a disclosure triangle and a manual TMDB-URL fallback input.
- Call A returns `is_movie: false`: the line is reported in a footer summary as "skipped (not a movie)". No card, no further calls.
- TMDB search returns zero hits: the review-pane card shows a "no TMDB match" stub with the raw memo line and a manual TMDB-URL input so the user can fall back to the existing add-by-URL path. Call B is skipped.
- Call B returns `matched_tmdb_id: null`: same treatment as "no TMDB match" but with the candidate dropdown auto-expanded — the candidates exist, Gemini just didn't trust any of them, and the user is best placed to make the final call.
- Network failure mid-pipeline: that pipeline's card shows "retry" affordance; siblings unaffected.

## UI additions

A new section in the editor header — above the existing `.add-bar` — containing:

```text
[ textarea: paste your memo here, one movie per line ]
[ Process memo ] [ Cancel ]   [🔑 Gemini key]   [ X / Y entries parsed ]
```

When **Process memo** is clicked, the textarea collapses into a "processing…" indicator and the **review pane** appears below the header, replacing or overlaying the normal movie list. Each card in the review pane uses the same `#movie-card-template` as the main list (so the styling is shared), with two additions:

- A **confidence badge** on the title row (green / yellow / red dot).
- A **candidate picker** dropdown when multiple TMDB search hits exist — defaulting to the auto-picked top result.
- **Per-card actions**: Approve, Drop, plus a footer **Commit all approved / Discard all** pair.

The review pane is dismissed once all cards are resolved.

## TMDB search

The search itself is deliberately simple — Call B does the picking, so heuristic scoring is unnecessary.

For a `MemoEntry { title, year, director }`:

1. `GET /search/movie?query={title}&year={year}` (omit `year` if absent). TMDB's `year` filter is on `primary_release_year`.
2. If `total_results == 0` and `year` was set, retry without `year`.
3. If `total_results == 0`, mark the card as **no-match** (Call B is skipped).
4. Otherwise: keep the top 5 results ordered by TMDB's own popularity. For the top 2–3, fire `GET /movie/{id}?append_to_response=credits` so director names are available for Call B's prompt. (Bounding to top 2–3 keeps TMDB call volume reasonable; if Call B picks a candidate beyond that, the full details call happens on demand before entry construction.)
5. Hand the candidates to Call B; the candidate it picks is what the review-pane card displays. Confidence and reasoning come from Call B's response, not from heuristic scoring.

The user is always the final arbiter via the candidate dropdown in the review pane.

## Data model — no changes

Every approved card becomes an entry that follows the **exact** schema and field order in [prompt-web-app.md](prompt-web-app.md#data-model). The bulk-import path is just a different *front door* to the same `addMovie(tmdbDetails)` function the URL-paste flow uses today. Keep that function the single chokepoint so the YAML round-trip guarantees from the existing prompt stay intact.

Two specific reuses:

- `custom_korean_title` is set from `MemoEntry.korean_overlay` when the TMDB original language is not Korean. Same gate-relaxation as the existing editor — setting it for Korean originals is a no-op for rendering. **Korean phonetic spellings of foreign titles** (`보헤미안 랩소디`, etc.) do **not** populate this field; they only serve as the LLM's lookup key and are discarded post-resolution.
- `director` is resolved in this order: existing-YML romanized→Korean map hit → Call C (gated by Korean-context signals; see *Call C*) → TMDB `credits.crew[?job=Director][0].name` (i.e. the same default as the existing add-by-URL flow).

`awards` / `award_names` / `note` / `masterpiece` / `my_best` are **never** populated by the bulk-import path. The user clicks them in afterwards using the existing per-card controls.

## Acceptance test

Round-trip is unchanged from [prompt-web-app.md](prompt-web-app.md#acceptance-test). Additionally:

- Paste a memo of ~10 mixed-format lines (English titles, Korean phonetic transliterations of foreign titles like the *Example memos* section, Korean originals, titles with `(한글)` overlays, some with years, some without, plus one deliberate non-movie line like `watched with J`). Expect: every movie line yields a review-pane card or a "no-match" stub; the non-movie line is reported in the footer as "skipped" but produces no card.
- Of the example memo's 13 Korean-transliteration lines, at least 12 should produce a green-border (`confidence: high`) match to the correct TMDB entry without manual disambiguation. (Calibration target — actual rate is open question #4.)
- A line with a known Korean director's romanized name (e.g. `Park Chan-wook 2025`) hits the map and uses `박찬욱` directly without firing Call C.
- A line with a first-time Korean director (no map entry) fires Call C, gets a Korean name, and shows the "🤖 LLM-filled" badge in the review pane.
- Pasting the same memo twice in a row: the second pass produces all-duplicates and commits zero new entries (TMDB-ID dedup at the chokepoint).

## Open questions for review

1. **Textbox placement.** Above the `.add-bar` (most prominent) or behind a disclosure / tab (keeps the editor uncluttered for users who don't need bulk import)? Draft assumes "above, always visible."
2. **Should the review-pane cards write to `localStorage` between Process and Commit?** Right now I'm assuming no — a refresh wipes in-progress reviews. Persisting them would mean an extra state slot; probably fine to skip for v1.
3. **Should the new romanized→Korean director lookup also fire from the existing single-URL add path?** It's a strict improvement there too — currently the user types `박찬욱` by hand every time. Default assumption: yes, do it in the same change.
4. **Calibrate Call A and Call B accuracy on real memos.** The 12/13 high-confidence rate in the acceptance test is a guess. After implementation, paste 3–5 real memos and count: how often does Call A's `is_movie` flag agree with reality? How often does Call B pick correctly on first try vs. need manual override? If Call B's first pick is wrong >20% of the time, consider feeding it more candidates (top 10 instead of top 5) or fetching credits for all 5 instead of top 2–3.
5. **Concurrency cap on parallel pipelines.** For a 50-line memo paste, kicking off 50 parallel pipelines means up to 150 parallel Gemini calls plus TMDB load. Probably fine on Gemini's free tier, but worth a soft cap (e.g. process 8 pipelines at a time) to avoid burst-rate limits. Defer until it actually bites.
