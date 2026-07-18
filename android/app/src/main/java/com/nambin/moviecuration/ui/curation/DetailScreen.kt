package com.nambin.moviecuration.ui.curation

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.nambin.moviecuration.core.MovieEntry
import com.nambin.moviecuration.core.TmdbCandidate
import com.nambin.moviecuration.data.Rating

/**
 * The shared add-confirmation / edit screen. Candidate picker only shows in
 * new-entry mode when TMDB search returned more than one plausible
 * candidate — see prompt-android-app.md's "Shared detail view".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailScreen(
    entry: MovieEntry,
    isNew: Boolean,
    candidates: List<TmdbCandidate>,
    selectedCandidateId: Int?,
    alreadyCuratedCandidateIds: Set<Int>,
    onSelectCandidate: (Int) -> Unit,
    onDirectorChange: (String) -> Unit,
    onRatingChange: (String) -> Unit,
    onNoteChange: (String) -> Unit,
    onDiscard: () -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            IconButton(onClick = onClose) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
            Text(if (isNew) "New movie" else "Edit movie", style = MaterialTheme.typography.titleMedium)
            if (isNew) {
                // Abort this add outright — retires the uncommitted entry.
                // New entries only: committed entries are never deleted here.
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onDiscard) { Text("Cancel") }
            }
        }

        Spacer(Modifier.height(8.dp))

        if (candidates.size > 1) {
            CandidatePicker(candidates, selectedCandidateId, alreadyCuratedCandidateIds, onSelectCandidate)
            Spacer(Modifier.height(16.dp))
        }

        // Add flow with the picker showing an already-curated selection: the
        // fields below display and edit the *existing* entry — say so.
        if (!isNew && candidates.isNotEmpty()) {
            Text(
                "Already curated — edits below update the existing entry.",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(16.dp))
        }

        val posterUrl = entry["tmdb_poster_url"] as? String
        val linkUrl = (entry["tmdb_url"] as? String) ?: (entry["imdb_url"] as? String)
        Box(
            modifier = Modifier
                .size(width = 120.dp, height = 180.dp)
                .clickable(enabled = linkUrl != null) { linkUrl?.let { openCustomTab(context, it) } },
        ) {
            if (posterUrl != null) {
                AsyncImage(model = posterUrl, contentDescription = "Poster", modifier = Modifier.fillMaxSize())
            } else {
                Box(modifier = Modifier.fillMaxSize()) { Text("(no poster)") }
            }
        }

        Spacer(Modifier.height(16.dp))
        Text(displayTitle(entry), style = MaterialTheme.typography.titleLarge)

        Spacer(Modifier.height(16.dp))
        var directorField by remember(entry["imdb_id"], selectedCandidateId) {
            mutableStateOf(entry["director"] as? String ?: "")
        }
        OutlinedTextField(
            value = directorField,
            onValueChange = {
                directorField = it
                onDirectorChange(it)
            },
            label = { Text("Director") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(16.dp))
        RatingDropdown(entry, selectedCandidateId, onRatingChange)

        Spacer(Modifier.height(16.dp))
        var noteField by remember(entry["imdb_id"], selectedCandidateId) {
            mutableStateOf(entry["note"] as? String ?: "")
        }
        OutlinedTextField(
            value = noteField,
            onValueChange = {
                noteField = it
                onNoteChange(it)
            },
            label = { Text("Note") },
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 96.dp),
        )

        @Suppress("UNCHECKED_CAST")
        val awardNames = (entry["award_names"] as? List<String>).orEmpty()
        if (awardNames.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            Text("Awards", style = MaterialTheme.typography.labelMedium)
            awardNames.forEach { Text(it) }
        }

        Spacer(Modifier.height(24.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CandidatePicker(
    candidates: List<TmdbCandidate>,
    selectedCandidateId: Int?,
    alreadyCuratedCandidateIds: Set<Int>,
    onSelectCandidate: (Int) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }

    fun labelFor(c: TmdbCandidate): String {
        val year = c.releaseDate?.take(4)?.ifEmpty { null } ?: "—"
        val dirs = c.directors.joinToString(", ").ifEmpty { "—" }
        val base = "${c.title ?: c.originalTitle ?: "?"} ($year) · $dirs"
        return if (c.id in alreadyCuratedCandidateIds) "$base (already curated)" else base
    }

    Column {
        ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
            val selected = candidates.find { it.id == selectedCandidateId }
            OutlinedTextField(
                value = selected?.let(::labelFor) ?: "Select a candidate",
                onValueChange = {},
                readOnly = true,
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
            )
            ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                candidates.forEach { c ->
                    DropdownMenuItem(
                        text = { Text(labelFor(c)) },
                        onClick = {
                            expanded = false
                            onSelectCandidate(c.id)
                        },
                    )
                }
            }
        }
    }
}

// `entry` is a mutable map the ViewModel updates in place, and `CurationUiState`
// often re-emits with every OTHER field unchanged (same object reference,
// same counts) after an edit — StateFlow's equality-based conflation then
// skips the emission entirely, so this composable would never re-read the
// map on a second rating change. Mirrors the same local-`remember` pattern
// already used for Director/Note above instead of reading `entry` directly.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RatingDropdown(entry: MovieEntry, selectedCandidateId: Int?, onRatingChange: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    var current by remember(entry["imdb_id"], selectedCandidateId) { mutableStateOf(Rating.of(entry)) }

    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = current.label,
            onValueChange = {},
            readOnly = true,
            label = { Text("Rating") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            Rating.entries.forEach { rating ->
                DropdownMenuItem(
                    text = { Text(rating.label) },
                    onClick = {
                        expanded = false
                        current = rating
                        onRatingChange(rating.value)
                    },
                )
            }
        }
    }
}
