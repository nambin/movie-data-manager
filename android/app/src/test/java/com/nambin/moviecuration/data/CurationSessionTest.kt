package com.nambin.moviecuration.data

import com.nambin.moviecuration.core.movieEntryOf
import org.junit.Assert.*
import org.junit.Test

class CurationSessionTest {

    private fun entry(imdbId: String, director: String = "Bong Joon Ho", note: String = ""): com.nambin.moviecuration.core.MovieEntry {
        val e = movieEntryOf("imdb_id" to imdbId, "director" to director)
        if (note.isNotEmpty()) e["note"] = note
        return e
    }

    @Test
    fun `markNew adds to newImdbIds and is reflected in newCount`() {
        val session = CurationSession()
        session.markNew("tt1")
        assertEquals(1, session.newCount)
        assertTrue(session.hasPendingChanges)
    }

    @Test
    fun `unmarkNew removes an id that was never committed`() {
        val session = CurationSession()
        session.markNew("tt1")
        session.unmarkNew("tt1")
        assertEquals(0, session.newCount)
        assertFalse("tt1" in session.newImdbIds)
    }

    @Test
    fun `ensureSnapshot captures state only on first touch`() {
        val session = CurationSession()
        val e = entry("tt1")
        session.ensureSnapshot("tt1", e)
        e["director"] = "Changed Director"
        session.ensureSnapshot("tt1", e) // second call — should NOT overwrite the snapshot
        val snapshot = session.snapshotFor("tt1")
        assertEquals("Bong Joon Ho", snapshot?.get("director"))
    }

    @Test
    fun `ensureSnapshot is a no-op for entries tracked as new`() {
        val session = CurationSession()
        session.markNew("tt1")
        session.ensureSnapshot("tt1", entry("tt1"))
        assertNull(session.snapshotFor("tt1"))
    }

    @Test
    fun `refreshUpdatedStatus adds an id when the entry differs from its snapshot`() {
        val session = CurationSession()
        val e = entry("tt1")
        session.ensureSnapshot("tt1", e)
        e["director"] = "New Director"
        session.refreshUpdatedStatus("tt1", e)
        assertEquals(1, session.updateCount)
        assertTrue("tt1" in session.updatedImdbIds)
    }

    @Test
    fun `refreshUpdatedStatus removes an id once the entry is reverted back to its snapshot`() {
        val session = CurationSession()
        val e = entry("tt1")
        session.ensureSnapshot("tt1", e)
        e["director"] = "New Director"
        session.refreshUpdatedStatus("tt1", e)
        assertEquals(1, session.updateCount)

        e["director"] = "Bong Joon Ho" // revert back to the original snapshot value
        session.refreshUpdatedStatus("tt1", e)
        assertEquals(0, session.updateCount)
        assertFalse("tt1" in session.updatedImdbIds)
    }

    @Test
    fun `refreshUpdatedStatus is a no-op for entries tracked as new`() {
        val session = CurationSession()
        session.markNew("tt1")
        session.refreshUpdatedStatus("tt1", entry("tt1", director = "Changed"))
        assertEquals(0, session.updateCount)
        assertEquals(1, session.newCount)
    }

    @Test
    fun `refreshUpdatedStatus is a no-op when there is no snapshot at all`() {
        val session = CurationSession()
        session.refreshUpdatedStatus("tt1", entry("tt1"))
        assertEquals(0, session.updateCount)
    }

    @Test
    fun `clearAfterCommit resets new, updated, and snapshots`() {
        val session = CurationSession()
        val e = entry("tt1")
        session.markNew("tt2")
        session.ensureSnapshot("tt1", e)
        e["director"] = "Changed"
        session.refreshUpdatedStatus("tt1", e)

        session.clearAfterCommit()

        assertEquals(0, session.newCount)
        assertEquals(0, session.updateCount)
        assertFalse(session.hasPendingChanges)
        assertNull(session.snapshotFor("tt1"))
    }

    // -- ratingLabel / diffEntry ------------------------------------------------

    @Test
    fun `ratingLabel reflects masterpiece, my_best, or none`() {
        assertEquals("Masterpiece", ratingLabel(movieEntryOf("masterpiece" to true)))
        assertEquals("My Best", ratingLabel(movieEntryOf("my_best" to true)))
        assertEquals("(none)", ratingLabel(movieEntryOf()))
    }

    @Test
    fun `diffEntry reports only fields that changed`() {
        val before = movieEntryOf("director" to "Bong Joon Ho", "note" to "")
        val after = movieEntryOf("director" to "Bong Joon Ho", "note" to "great film", "masterpiece" to true)
        val diffs = diffEntry(before, after)
        assertEquals(2, diffs.size)
        assertTrue(diffs.any { it.label == "Note" && it.oldValue == "" && it.newValue == "great film" })
        assertTrue(diffs.any { it.label == "Rating" && it.oldValue == "(none)" && it.newValue == "Masterpiece" })
    }

    @Test
    fun `diffEntry is empty when nothing user-editable changed`() {
        val before = movieEntryOf("director" to "Bong Joon Ho", "tmdb_poster_url" to "https://example.com/a.jpg")
        val after = movieEntryOf("director" to "Bong Joon Ho", "tmdb_poster_url" to "https://example.com/DIFFERENT.jpg")
        // tmdb_poster_url isn't one of the user-editable fields diffEntry tracks.
        assertTrue(diffEntry(before, after).isEmpty())
    }
}
