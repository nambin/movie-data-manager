package com.nambin.moviecuration.ui

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.nambin.moviecuration.ui.curation.CurationScreen
import com.nambin.moviecuration.ui.movies.MoviesScreen
import com.nambin.moviecuration.ui.movies.MoviesWebViewHolder
import com.nambin.moviecuration.ui.settings.SettingsScreen
import kotlinx.coroutines.launch

private data class Destination(val route: String, val label: String)

private val DESTINATIONS = listOf(
    Destination("movies", "Movies"),
    Destination("curation", "Curation"),
    Destination("settings", "Settings"),
)

private const val START_DESTINATION = "curation"

/**
 * Root composable: a left-hand nav drawer (collapsed by default, opened via
 * the hamburger icon) with three destinations. Curation is the default view
 * on launch. See prompt-android-app.md's "Navigation" section.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MovieCurationApp() {
    val navController = rememberNavController()
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    // The Movies tab's WebView, created on the first visit and then retained
    // here (the root survives destination switches) so returning to Movies
    // resumes the page instead of reloading it — see MoviesWebViewHolder.
    val context = LocalContext.current
    val moviesWebViewHolder = remember { lazy { MoviesWebViewHolder(context) } }

    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route ?: START_DESTINATION

    MaterialTheme {
        ModalNavigationDrawer(
            drawerState = drawerState,
            // Only while the drawer is open: edge-swipe-to-open steals
            // horizontal scrolls (worst in the Movies WebView), so opening is
            // hamburger-only — but swipe/scrim-tap still close an open drawer.
            gesturesEnabled = drawerState.isOpen,
            drawerContent = {
                ModalDrawerSheet {
                    Spacer(modifier = Modifier.height(12.dp))
                    DESTINATIONS.forEach { dest ->
                        NavigationDrawerItem(
                            label = { Text(dest.label) },
                            selected = currentRoute == dest.route,
                            onClick = {
                                scope.launch { drawerState.close() }
                                if (currentRoute != dest.route) {
                                    navController.navigate(dest.route) {
                                        popUpTo(navController.graph.startDestinationId) { saveState = true }
                                        launchSingleTop = true
                                        restoreState = true
                                    }
                                }
                            },
                            modifier = Modifier.padding(horizontal = 12.dp),
                        )
                    }
                }
            },
        ) {
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = { Text(DESTINATIONS.find { it.route == currentRoute }?.label ?: "Movie Curation") },
                        navigationIcon = {
                            IconButton(onClick = { scope.launch { drawerState.open() } }) {
                                Icon(Icons.Filled.Menu, contentDescription = "Menu")
                            }
                        },
                    )
                },
            ) { padding ->
                NavHost(
                    navController = navController,
                    startDestination = START_DESTINATION,
                    modifier = Modifier.padding(padding),
                ) {
                    composable("movies") { MoviesScreen(moviesWebViewHolder.value) }
                    composable("curation") { CurationScreen() }
                    composable("settings") { SettingsScreen() }
                }
            }
        }
    }
}
