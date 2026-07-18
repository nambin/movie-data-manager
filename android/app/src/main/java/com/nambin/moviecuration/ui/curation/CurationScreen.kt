package com.nambin.moviecuration.ui.curation

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.nambin.moviecuration.MovieCurationApplication
import com.nambin.moviecuration.core.MovieEntry

/**
 * The Curation destination — the app's main screen. Dispatches between the
 * home content (Add box + Search box, both always visible), the shared
 * detail view, and the Review changes screen, based on CurationViewModel's
 * state. See prompt-android-app.md's "Curation" destination.
 */
@Composable
fun CurationScreen(
    viewModel: CurationViewModel = viewModel(
        factory = CurationViewModelFactory(LocalContext.current.applicationContext as MovieCurationApplication),
    ),
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current

    // Spec says "toast/snackbar" for the commit-success message — a Toast is
    // the simplest fit here since Curation isn't otherwise wrapped in its own
    // Scaffold/SnackbarHost.
    LaunchedEffect(state.commitSuccessMessage) {
        state.commitSuccessMessage?.let { msg ->
            Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
            viewModel.dismissCommitSuccess()
        }
    }

    when {
        state.loading -> LoadingView()
        state.loadError != null -> ErrorView(state.loadError!!, onRetry = viewModel::boot)
        state.reviewChanges != null -> ReviewChangesScreen(
            changes = state.reviewChanges!!,
            newCount = state.newCount,
            updateCount = state.updateCount,
            busy = state.commitBusy,
            error = state.commitError,
            onOpenEntry = viewModel::openEntryFromReview,
            onRemoveChange = viewModel::removePendingChange,
            onCancel = viewModel::closeReviewChanges,
            onConfirm = viewModel::confirmCommit,
        )
        state.activeEntry != null -> DetailScreen(
            entry = state.activeEntry!!,
            isNew = state.activeIsNew,
            candidates = state.candidates,
            selectedCandidateId = state.selectedCandidateId,
            alreadyCuratedCandidateIds = state.alreadyCuratedCandidateIds,
            onSelectCandidate = viewModel::selectCandidate,
            onDirectorChange = viewModel::updateDirector,
            onRatingChange = viewModel::updateRating,
            onNoteChange = viewModel::updateNote,
            onDiscard = viewModel::discardActiveNewEntry,
            onClose = viewModel::closeDetail,
        )
        else -> CurationHome(state, viewModel)
    }
}

@Composable
private fun LoadingView() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

@Composable
private fun ErrorView(message: String, onRetry: () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Couldn't load the collection", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(4.dp))
            Text(message, color = MaterialTheme.colorScheme.error)
            Spacer(Modifier.height(12.dp))
            Button(onClick = onRetry) { Text("Retry") }
        }
    }
}

@Composable
private fun CurationHome(state: CurationUiState, viewModel: CurationViewModel) {
    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        // ---- Add a movie (memo-based, single title) ----
        var memoText by remember { mutableStateOf("") }
        val keyboardController = LocalSoftwareKeyboardController.current
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            OutlinedTextField(
                value = memoText,
                onValueChange = { memoText = it },
                label = { Text("Movie name") },
                singleLine = true,
                enabled = !state.addBusy,
                // The keyboard's Done action submits exactly like the Add
                // button, then tucks the keyboard away for the busy wait.
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = {
                    if (!state.addBusy && memoText.isNotBlank()) {
                        keyboardController?.hide()
                        viewModel.addMovie(memoText)
                    }
                }),
                trailingIcon = {
                    if (memoText.isNotEmpty() && !state.addBusy) {
                        IconButton(onClick = { memoText = "" }) {
                            Icon(Icons.Filled.Close, contentDescription = "Clear")
                        }
                    }
                },
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            Button(
                // The typed line deliberately stays in the field: the input is
                // disabled while addBusy, and on a no-detail-view outcome (no
                // match, not a movie, duplicate) it remains editable for a
                // tweak-and-resubmit retry. On success the detail view replaces
                // CurationHome in the composition, so this remembered field
                // resets to empty by itself when the user returns home.
                onClick = { viewModel.addMovie(memoText) },
                enabled = !state.addBusy && memoText.isNotBlank(),
            ) {
                if (state.addBusy) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Text("Add")
                }
            }
        }

        state.addStatus?.let { msg ->
            Text(
                msg,
                color = if (state.addStatusIsError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        // Only the single-candidate duplicate lands here — an ambiguous
        // (multi-candidate) duplicate goes straight to the detail view with
        // the picker instead. See the duplicate-prevention gate in the spec.
        state.duplicateEntry?.let { dup ->
            TextButton(onClick = viewModel::openDuplicateForEdit) {
                Text("Already curated: ${displayTitle(dup)} — tap to open and edit instead.")
            }
        }

        Spacer(Modifier.height(12.dp))

        // ---- Search to update (always visible alongside Add — no mode toggle) ----
        OutlinedTextField(
            value = state.searchQuery,
            onValueChange = viewModel::updateSearchQuery,
            label = { Text("Title, director, year, or language") },
            singleLine = true,
            trailingIcon = {
                if (state.searchQuery.isNotEmpty()) {
                    IconButton(onClick = { viewModel.updateSearchQuery("") }) {
                        Icon(Icons.Filled.Close, contentDescription = "Clear")
                    }
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
        LazyColumn(modifier = Modifier.weight(1f)) {
            items(state.searchResults, key = { it["imdb_id"] as? String ?: it.hashCode().toString() }) { entry ->
                SearchResultRow(entry, onClick = { viewModel.openSearchResult(entry) })
            }
        }

        // ---- Commit ----
        HorizontalDivider()
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                onClick = viewModel::openReviewChanges,
                enabled = (state.newCount + state.updateCount) > 0,
            ) {
                Text("Commit")
            }
            Spacer(Modifier.width(12.dp))
            Text("${state.newCount} new, ${state.updateCount} update")
        }
    }
}

@Composable
private fun SearchResultRow(entry: MovieEntry, onClick: () -> Unit) {
    val director = entry["director"] as? String
    val posterUrl = entry["tmdb_poster_url"] as? String
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (posterUrl != null) {
            AsyncImage(
                model = posterUrl,
                contentDescription = "Poster",
                modifier = Modifier.size(width = 40.dp, height = 60.dp),
            )
            Spacer(Modifier.width(12.dp))
        }
        Column {
            Text(displayTitle(entry), style = MaterialTheme.typography.bodyLarge)
            if (!director.isNullOrBlank()) {
                Text(director, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
