package app.vybatron.playback

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class NativeTrackTest {
    @Test fun findsTheYouTubeVideoLikeThePortal() {
        assertEquals("dX3k_QDnzHE", NativeTrack.youtubeId("https://www.youtube.com/watch?v=dX3k_QDnzHE"))
        assertEquals("dX3k_QDnzHE", NativeTrack.youtubeId("https://music.youtube.com/watch?list=RD&v=dX3k_QDnzHE"))
        assertEquals("dX3k_QDnzHE", NativeTrack.youtubeId("https://youtu.be/dX3k_QDnzHE"))
        listOf(null, "", "https://open.spotify.com/track/abc", "https://www.youtube.com/watch?v=short",
            "https://www.youtube.com/embed/dX3k_QDnzHE", "https://evil.test/watch?v=dX3k_QDnzHE", "not a url")
            .forEach { assertNull(it, NativeTrack.youtubeId(it)) }
    }

    @Test fun ownedSongsLoseTheirRequesterAndAutoplayMark() {
        val raw = song("a").raw.put("suggested", true)
        val owned = NativeTrack.parse(raw)!!.own()
        assertEquals(JSONObject.NULL, owned.raw.get("requestedBy"))
        assertFalse(owned.raw.has("suggested"))
        assertEquals("a", owned.id)
    }

    @Test fun refusesSongsWithoutAnIdOrTitle() {
        assertNull(NativeTrack.parse(JSONObject().put("title", "x")))
        assertNull(NativeTrack.parse(JSONObject().put("id", "x")))
        assertNull(NativeTrack.parse("a string"))
    }
}
