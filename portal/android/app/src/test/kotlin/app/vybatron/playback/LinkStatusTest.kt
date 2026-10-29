package app.vybatron.playback

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** What the page hears about the service's own connection, to know whether it has to pass controls on. */
class LinkStatusTest {
    private val me = "m".repeat(22)
    private val session = LinkSession("csrf-1", me, "Android app", "1")
    private val local = FakeLocal()
    private val net = FakeNet()
    private val link = PlayerLink(local, net, FakeTimers(), { Shared.NOW }, { Shared.NOW })
    private val heard = ArrayList<String>()
    private var updated = 1L

    init { link.addStatusListener { heard.add(it.toString()) } }

    private fun stream(player: JSONObject) = link.onEvent("player", Shared.view(player.put("updatedAt", ++updated)).toString())
    private fun status(linked: Boolean, generation: Long?) = JSONObject().put("linked", linked).put("generation", generation ?: JSONObject.NULL).toString()

    @Test fun thePageHearsWhenTheStreamIsLiveAndWhichGenerationThisDevicePlays() {
        val reply = link.handle(PlayerRequest.Subscribe(session)).getOrThrow()
        assertEquals(status(false, null), reply.getJSONObject("link").toString())
        stream(Shared.player(generation = 1, current = Shared.entry("a")))
        stream(Shared.player(generation = 2, active = me, current = Shared.entry("a"), playing = true))
        link.onEnded(null)
        assertEquals(listOf(status(true, null), status(true, 2), status(false, 2)), heard)
        assertEquals(status(false, 2), link.handle(PlayerRequest.Subscribe()).getOrThrow().getJSONObject("link").toString())
    }

    @Test fun stopWithoutALiveStreamStopsHereOnly() {
        link.start(session)
        local.handle(PlayerRequest.Load("1", song("a"), emptyList(), emptyList(), 0, true, 100, Repeat.OFF))
        link.handle(PlayerRequest.Stop)
        assertEquals(null, local.songs.current)
        assertTrue(net.posts.isEmpty())
    }
}
