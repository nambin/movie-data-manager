package com.nambin.moviecuration.ui.curation

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.nambin.moviecuration.data.PendingChange
import com.nambin.moviecuration.data.ratingLabel

/**
 * Shown when the user taps Commit. Lists every pending change — NEW cards in
 * full, UPDATED entries as a field-level diff — before anything is pushed to
 * GitHub. See prompt-android-app.md's "Review changes screen".
 */
@Composable
fun ReviewChangesScreen(
    changes: List<PendingChange>,
    newCount: Int,
    updateCount: Int,
    busy: Boolean,
    error: String?,
    onOpenEntry: (PendingChange) -> Unit,
    onRemoveChange: (PendingChange) -> Unit,
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Text("Review changes", style = MaterialTheme.typography.titleLarge)
        Text("$newCount new, $updateCount update", style = MaterialTheme.typography.bodyMedium)

        Spacer(Modifier.height(12.dp))

        if (error != null) {
            Text(error, color = MaterialTheme.colorScheme.error)
            Spacer(Modifier.height(12.dp))
        }

        LazyColumn(modifier = Modifier.weight(1f)) {
            items(changes, key = { it.imdbId }) { change ->
                PendingChangeCard(
                    change,
                    onClick = { onOpenEntry(change) },
                    onRemove = { onRemoveChange(change) },
                )
                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
            }
        }

        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onCancel, enabled = !busy) { Text("Cancel") }
            Spacer(Modifier.width(8.dp))
            Button(onClick = onConfirm, enabled = !busy) {
                if (busy) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Text("Confirm & Commit")
                }
            }
        }
    }
}

@Composable
private fun PendingChangeCard(change: PendingChange, onClick: () -> Unit, onRemove: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick), // jump back into the detail view to adjust this entry further
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AssistChip(
                onClick = {},
                label = { Text(if (change.isNew) "NEW" else "UPDATED") },
            )
            Spacer(Modifier.width(8.dp))
            Text(
                displayTitle(change.entry),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            // NEW → discard the pending addition; UPDATED → revert to the
            // pre-edit snapshot. See "Review changes screen" in the spec.
            IconButton(onClick = onRemove) {
                Icon(Icons.Filled.Close, contentDescription = "Remove change")
            }
        }

        if (change.isNew) {
            val posterUrl = change.entry["tmdb_poster_url"] as? String
            val director = change.entry["director"] as? String
            val note = change.entry["note"] as? String
            val rating = ratingLabel(change.entry)
            @Suppress("UNCHECKED_CAST")
            val awards = (change.entry["award_names"] as? List<String>).orEmpty()
            Row(modifier = Modifier.padding(top = 4.dp)) {
                if (posterUrl != null) {
                    AsyncImage(
                        model = posterUrl,
                        contentDescription = "Poster",
                        modifier = Modifier.size(width = 56.dp, height = 84.dp),
                    )
                    Spacer(Modifier.width(12.dp))
                }
                Column {
                    if (!director.isNullOrBlank()) Text("Director: $director")
                    Text("Rating: $rating")
                    if (!note.isNullOrBlank()) Text("Note: $note")
                    if (awards.isNotEmpty()) Text("Awards: ${awards.joinToString(", ")}")
                }
            }
        } else {
            change.diffs.forEach { diff ->
                Text("${diff.label}: ${diff.oldDisplay} → ${diff.newDisplay}")
            }
        }
    }
}
