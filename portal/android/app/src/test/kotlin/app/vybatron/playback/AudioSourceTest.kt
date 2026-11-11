package app.vybatron.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class AudioSourceTest {
    private val spotify = song("a", "https://open.spotify.com/track/abc")

    @Test fun aYouTubeSongPlaysItsOwnVideoWithOrWithoutAGuild() {
        assertEquals(AudioSource.Video("a0000000000"), sourceOf(song("a"), "123456789012345678"))
        assertEquals(AudioSource.Video("a0000000000"), sourceOf(song("a"), null))
    }

    @Test fun aSongFromAnotherCatalogIsLookedUpInTheGuild() {
        assertEquals(AudioSource.Lookup("123456789012345678", "M83 A"), sourceOf(spotify, "123456789012345678"))
    }

    // Nothing to look it up in: a lookup that never runs would leave the deck waiting forever.
    @Test fun withoutAGuildASongFromAnotherCatalogIsNotLookedUp() {
        assertFalse(sourceOf(spotify, null) is AudioSource.Lookup)
    }
}
