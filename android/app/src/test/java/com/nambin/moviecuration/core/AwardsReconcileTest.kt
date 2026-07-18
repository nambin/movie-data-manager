package com.nambin.moviecuration.core

import org.junit.Assert.*
import org.junit.Test

/** Kotlin port of tests/awards_reconcile.test.js. */
class AwardsReconcileTest {

    @Test
    fun `award_names become exactly the ground-truth list`() {
        val r = reconcileAwardNames(
            listOf("Cannes Palme d'Or", "Some Old Tag"),
            listOf("Cannes Palme d'Or", "Oscar Best Picture"),
        )
        assertEquals(listOf("Cannes Palme d'Or", "Oscar Best Picture"), r.awardNames)
        assertEquals(listOf("Oscar Best Picture"), r.added)
        assertEquals(listOf("Some Old Tag"), r.removed)
        assertTrue(r.changed)
    }

    @Test
    fun `a film absent from awards yml loses all its awards`() {
        val r = reconcileAwardNames(listOf("Venice Leone d’oro", "Some Old Tag"), emptyList())
        assertEquals(emptyList<String>(), r.awardNames)
        assertEquals(listOf("Venice Leone d’oro", "Some Old Tag"), r.removed)
        assertEquals(emptyList<String>(), r.added)
        assertTrue(r.changed)
    }

    @Test
    fun `replaces a wrong award with the ground-truth one`() {
        val r = reconcileAwardNames(listOf("Oscar Best International Film"), listOf("Venice Leone d’oro"))
        assertEquals(listOf("Oscar Best International Film"), r.removed)
        assertEquals(listOf("Venice Leone d’oro"), r.added)
        assertEquals(listOf("Venice Leone d’oro"), r.awardNames)
    }

    @Test
    fun `no change when awards already match exactly`() {
        val names = listOf("Cannes Palme d'Or", "Oscar Best Picture")
        val r = reconcileAwardNames(names, names)
        assertFalse(r.changed)
        assertEquals(names, r.awardNames)
    }
}
