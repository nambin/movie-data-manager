package com.nambin.moviecuration.ui.curation

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.nambin.moviecuration.MovieCurationApplication
import com.nambin.moviecuration.core.MovieEntry
import com.nambin.moviecuration.data.CollectionStats
import com.nambin.moviecuration.data.DirectorStat

// Lifted from movies.html so the app's lists read like the public site:
// movie titles are slate `#2c3e50` (`.movie-info h2 a`), director names the
// bold blue `#3498db` of `.director-filter-link` — apt, since the site's blue
// director link filters by director just like the app's director tap. The
// `+M` pill borrows the site's `#eef7ff` filter-chip background.
private val WebMovieTitleColor = Color(0xFF2C3E50)
private val WebDirectorColor = Color(0xFF3498DB)
private val WebChipBackground = Color(0xFFEEF7FF)

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
        state.reviewChanges != null -> {
            // System back = Cancel: home with the batch preserved. Inert
            // while a commit is in flight, like the disabled Cancel button.
            BackHandler(enabled = !state.commitBusy) { viewModel.closeReviewChanges() }
            ReviewChangesScreen(
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
        }
        state.activeEntry != null -> {
            // System back = the view's Cancel when one exists (a new entry:
            // the in-flight add is discarded), else its back arrow (an
            // existing entry: close, returning to Review changes when the
            // entry was opened from there).
            BackHandler {
                if (state.activeIsNew) viewModel.discardActiveNewEntry() else viewModel.closeDetail()
            }
            DetailScreen(
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
        }
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
        if (state.searchQuery.isEmpty()) {
            // The otherwise-blank results area shows the boot-time stats
            // snapshot; typing a query replaces it with live results below.
            CollectionStatsBlock(
                stats = state.collectionStats,
                onDirectorClick = viewModel::updateSearchQuery,
                onMovieClick = viewModel::openSearchResult,
                modifier = Modifier.weight(1f),
            )
        } else {
            LazyColumn(modifier = Modifier.weight(1f)) {
                items(state.searchResults, key = { it["imdb_id"] as? String ?: it.hashCode().toString() }) { entry ->
                    SearchResultRow(entry, onClick = { viewModel.openSearchResult(entry) })
                }
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

/**
 * The boot-time stats snapshot filling the results area while the search box
 * is empty: "N movies loaded" plus up to 10 top-director poster rows, each with two
 * tap targets — the director (fills the search box with that exact text) and
 * their latest film (opens it in the shared detail view, same handoff as a
 * search result). See prompt-android-app.md's "Collection stats fill the
 * default view".
 */
@Composable
private fun CollectionStatsBlock(
    stats: CollectionStats,
    onDirectorClick: (String) -> Unit,
    onMovieClick: (MovieEntry) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.padding(top = 12.dp).verticalScroll(rememberScrollState())) {
        Text(
            "${stats.totalMovies} movies loaded",
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
        stats.topDirectors.forEach { stat ->
            DirectorStatRow(stat, onDirectorClick, onMovieClick)
        }
    }
}

@Composable
private fun DirectorStatRow(
    stat: DirectorStat,
    onDirectorClick: (String) -> Unit,
    onMovieClick: (MovieEntry) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PosterThumb(
            posterUrl = stat.latestEntry["tmdb_poster_url"] as? String,
            onClick = { onMovieClick(stat.latestEntry) },
        )
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                stat.director,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = WebDirectorColor,
                modifier = Modifier.clickable { onDirectorClick(stat.director) },
            )
            Spacer(Modifier.height(2.dp))
            Text(
                displayTitle(stat.latestEntry),
                style = MaterialTheme.typography.bodyMedium,
                color = WebMovieTitleColor,
                modifier = Modifier.clickable { onMovieClick(stat.latestEntry) },
            )
        }
        if (stat.moreCount > 0) {
            Spacer(Modifier.width(8.dp))
            Surface(
                shape = CircleShape,
                color = WebChipBackground,
                contentColor = WebDirectorColor,
                // Same action as tapping the director's name — the count is
                // about their filmography, so it leads to the same list.
                modifier = Modifier.clip(CircleShape).clickable { onDirectorClick(stat.director) },
            ) {
                Text(
                    "+${stat.moreCount}",
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
        }
    }
}

/**
 * The poster treatment shared by stats rows and search results — one size
 * and corner shape so the two lists read as the same system. Entries
 * without a poster get a same-footprint placeholder, keeping text columns
 * aligned across rows.
 */
@Composable
private fun PosterThumb(posterUrl: String?, onClick: (() -> Unit)? = null) {
    var thumbModifier = Modifier
        .size(width = 48.dp, height = 72.dp)
        .clip(RoundedCornerShape(8.dp))
    if (onClick != null) thumbModifier = thumbModifier.clickable(onClick = onClick)
    if (posterUrl != null) {
        AsyncImage(model = posterUrl, contentDescription = "Poster", modifier = thumbModifier)
    } else {
        Box(thumbModifier.background(MaterialTheme.colorScheme.surfaceVariant))
    }
}

// Styled to mirror a stats row with the lines flipped (movie first, since the
// movie is what was searched for): same poster treatment, same accent-colored
// movie text, same semibold director text.
@Composable
private fun SearchResultRow(entry: MovieEntry, onClick: () -> Unit) {
    val director = entry["director"] as? String
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PosterThumb(entry["tmdb_poster_url"] as? String)
        Spacer(Modifier.width(12.dp))
        Column {
            Text(
                displayTitle(entry),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = WebMovieTitleColor,
            )
            if (!director.isNullOrBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(
                    director,
                    style = MaterialTheme.typography.bodyMedium,
                    color = WebDirectorColor,
                )
            }
        }
    }
}
