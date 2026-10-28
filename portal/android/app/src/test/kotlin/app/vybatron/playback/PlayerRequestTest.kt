package app.vybatron.playback

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlayerRequestTest {
    private fun parse(type: String, body: String) = PlayerRequest.parse(type, JSONObject(body))
    private val track = song("a").raw.toString()
    private fun load(changes: Map<String, Any?> = emptyMap()): JSONObject {
        val body = JSONObject("""{"guildId":"123","current":$track,"queue":[$track],"history":[],"positionMs":1500,"playing":true,"volume":80,"repeat":"queue"}""")
        changes.forEach { (key, value) -> body.put(key, value ?: JSONObject.NULL) }
        return body
    }

    @Test fun readsALoad() {
        val request = PlayerRequest.parse("player.load", load()) as PlayerRequest.Load
        assertEquals("123", request.guildId); assertEquals("a", request.current?.id); assertEquals(1, request.queue.size)
        assertEquals(1500L, request.positionMs); assertEquals(true, request.playing); assertEquals(80, request.volume); assertEquals(Repeat.QUEUE, request.repeat)
        assertNull((PlayerRequest.parse("player.load", load(mapOf("current" to null))) as PlayerRequest.Load).current)
    }

    @Test fun refusesABadLoad() {
        listOf(
            mapOf("guildId" to "../x"), mapOf("guildId" to 123), mapOf("current" to JSONObject().put("id", 1)),
            mapOf("queue" to JSONArray().put("nope")), mapOf("queue" to JSONArray((1..501).map { JSONObject(track) })),
            mapOf("history" to JSONArray((1..101).map { JSONObject(track) })), mapOf("positionMs" to -1), mapOf("positionMs" to "5"),
            mapOf("playing" to "yes"), mapOf("volume" to 101), mapOf("repeat" to "all"),
        ).forEach { assertNull(it.toString(), PlayerRequest.parse("player.load", load(it))) }
    }

    @Test fun readsControls() {
        assertEquals(PlayerRequest.Play, parse("player.control", """{"action":"play"}"""))
        assertEquals(PlayerRequest.Next, parse("player.control", """{"action":"next"}"""))
        assertEquals(PlayerRequest.Seek(61_000), parse("player.control", """{"action":"seek","positionMs":61000}"""))
        assertEquals(PlayerRequest.SkipTo(2), parse("player.control", """{"action":"skipTo","index":2}"""))
        assertEquals(PlayerRequest.Volume(40), parse("player.control", """{"action":"volume","level":40}"""))
        assertEquals(PlayerRequest.SetRepeat(Repeat.TRACK), parse("player.control", """{"action":"repeat","mode":"track"}"""))
        assertEquals(PlayerRequest.SetQueue(listOf(), 7), parse("player.setQueue", """{"queue":[],"revision":7}"""))
        assertEquals(PlayerRequest.Subscribe, parse("player.subscribe", "{}"))
    }

    @Test fun refusesUnknownOrMalformedControls() {
        listOf("""{"action":"eject"}""", """{"action":"seek"}""", """{"action":"skipTo","index":1.5}""", """{"action":"skipTo","index":-1}""",
            """{"action":"volume","level":"loud"}""", """{"action":"repeat","mode":"forever"}""")
            .forEach { assertNull(it, parse("player.control", it)) }
        assertNull(parse("player.setQueue", """{"queue":[]}"""))
        assertNull(parse("player.fetch", "{}"))
    }
}
