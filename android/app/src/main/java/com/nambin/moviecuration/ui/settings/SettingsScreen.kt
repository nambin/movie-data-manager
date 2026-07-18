package com.nambin.moviecuration.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.nambin.moviecuration.MovieCurationApplication
import com.nambin.moviecuration.core.GeminiModelTier
import kotlinx.coroutines.launch

/**
 * Settings destination. Model tier is the only user-editable setting — the
 * Gemini API key, TMDB key, and all GitHub configuration are hardcoded at
 * build time. See prompt-android-app.md's "Settings" destination and
 * "Build-time configuration & the secrets".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen() {
    val context = LocalContext.current
    val app = context.applicationContext as MovieCurationApplication
    val scope = rememberCoroutineScope()

    val modelTier by app.geminiModelSetting.modelTierFlow.collectAsState(initial = com.nambin.moviecuration.core.DEFAULT_GEMINI_MODEL)
    var expanded by remember { mutableStateOf(false) }

    Column(modifier = Modifier.padding(16.dp).fillMaxWidth()) {
        Text("Gemini model", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
            OutlinedTextField(
                value = modelTier.label,
                onValueChange = {},
                readOnly = true,
                label = { Text("Model tier") },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
            )
            ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                GeminiModelTier.entries.forEach { tier ->
                    DropdownMenuItem(
                        text = { Text(tier.label) },
                        onClick = {
                            expanded = false
                            scope.launch { app.geminiModelSetting.setModelTier(tier) }
                        },
                    )
                }
            }
        }
    }
}
