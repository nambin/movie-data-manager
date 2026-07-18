package com.nambin.moviecuration.github

import org.junit.Assert.*
import org.junit.Test

class DiffSizeGuardTest {

    @Test
    fun `identical text has zero diff`() {
        val text = "a\nb\nc\n"
        val size = DiffSizeGuard.computeDiffSize(text, text)
        assertEquals(0, size.total)
        assertFalse(DiffSizeGuard.exceedsLimit(text, text))
    }

    @Test
    fun `small change stays under the limit`() {
        val old = (1..20).joinToString("\n") { "line $it" }
        val new = (1..20).joinToString("\n") { if (it == 5) "line 5 changed" else "line $it" }
        assertFalse(DiffSizeGuard.exceedsLimit(old, new))
    }

    @Test
    fun `a full-file rewrite exceeds the limit`() {
        val old = (1..200).joinToString("\n") { "line $it" }
        val new = (1..200).joinToString("\n") { "different $it" }
        assertTrue(DiffSizeGuard.exceedsLimit(old, new))
    }

    @Test
    fun `exactly at the boundary is not over the limit`() {
        // 100 lines changed => 100 deletions + 100 insertions = 200 total, not > 200.
        val old = (1..100).joinToString("\n") { "line $it" }
        val new = (1..100).joinToString("\n") { "changed $it" }
        val size = DiffSizeGuard.computeDiffSize(old, new)
        assertEquals(200, size.total)
        assertFalse(DiffSizeGuard.exceedsLimit(old, new))
    }
}
