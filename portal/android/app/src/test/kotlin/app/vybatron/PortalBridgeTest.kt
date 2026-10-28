package app.vybatron

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PortalBridgeTest {
    private val info = PortalBridge.AppInfo("0.1.0", 1)
    private fun ask(message: String?) = JSONObject(PortalBridge.respond(message, info))

    @Test fun answersAppInfo() {
        val reply = ask("""{"id":7,"type":"app.info"}""")
        assertEquals(7, reply.getInt("id"))
        assertTrue(reply.getBoolean("ok"))
        assertEquals("android", reply.getJSONObject("result").getString("platform"))
        assertEquals("0.1.0", reply.getJSONObject("result").getString("version"))
        assertEquals(1, reply.getJSONObject("result").getInt("build"))
    }

    @Test fun refusesUnknownOperations() {
        val reply = ask("""{"id":"a","type":"http.request","url":"https://example.com"}""")
        assertEquals("a", reply.getString("id"))
        assertFalse(reply.getBoolean("ok"))
        assertEquals("unknown_type", reply.getString("error"))
    }

    @Test fun refusesMalformedMessages() {
        listOf(null, "", "not json", "[1,2]").forEach {
            val reply = ask(it)
            assertFalse(reply.getBoolean("ok"))
            assertEquals("bad_request", reply.getString("error"))
        }
    }

    @Test fun routesPlayerRequestsAndRefusesBadOnes() {
        val seen = mutableListOf<app.vybatron.playback.PlayerRequest>()
        val player = PortalBridge.Player { seen.add(it); Result.success(JSONObject().put("status", "idle")) }
        val reply = JSONObject(PortalBridge.respond("""{"id":3,"type":"player.control","action":"pause"}""", info, player))
        assertTrue(reply.getBoolean("ok")); assertEquals("idle", reply.getJSONObject("result").getString("status"))
        assertEquals(listOf(app.vybatron.playback.PlayerRequest.Pause), seen)

        assertEquals("bad_request", JSONObject(PortalBridge.respond("""{"id":4,"type":"player.control","action":"eject"}""", info, player)).getString("error"))
        assertEquals("unavailable", JSONObject(PortalBridge.respond("""{"id":5,"type":"player.subscribe"}""", info, null)).getString("error"))
        val stale = PortalBridge.Player { Result.failure(IllegalStateException("stale")) }
        assertEquals("stale", JSONObject(PortalBridge.respond("""{"id":6,"type":"player.setQueue","queue":[],"revision":1}""", info, stale)).getString("error"))
        assertEquals(1, seen.size)
    }
}
