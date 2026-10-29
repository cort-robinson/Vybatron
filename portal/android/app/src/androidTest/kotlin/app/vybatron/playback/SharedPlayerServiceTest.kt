package app.vybatron.playback

import android.content.ComponentName
import android.content.Intent
import android.webkit.CookieManager
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The app as a device of the shared player with no page at all (ADR-0018): only the
 * playback service, which the page handed its session before it went away. A local
 * server stands in for the portal: its listener stream makes this device the active
 * one, then relays a pause, and the service carries it out and reports it.
 */
@RunWith(AndroidJUnit4::class)
class SharedPlayerServiceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val server = MockWebServer()
    // Each listener stream the service opens gets the next of these, or waits for one.
    private val streams = LinkedBlockingQueue<String>()
    private val events = Collections.synchronizedList(ArrayList<RecordedRequest>())
    private val posts = Collections.synchronizedList(ArrayList<Pair<RecordedRequest, JSONObject>>())
    private lateinit var controller: MediaController
    private val me = "AndroidTestDevice_0123"

    private fun silence(seconds: Int): Buffer {
        val samples = 8000 * seconds
        val wav = java.nio.ByteBuffer.allocate(44 + samples * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        wav.put("RIFF".toByteArray()).putInt(36 + samples * 2).put("WAVE".toByteArray()).put("fmt ".toByteArray())
            .putInt(16).putShort(1).putShort(1).putInt(8000).putInt(16000).putShort(2).putShort(16)
            .put("data".toByteArray()).putInt(samples * 2)
        return Buffer().write(wav.array())
    }

    private val song = JSONObject().put("id", "longbbbbbbb").put("title", "First").put("author", "M83").put("uri", "https://www.youtube.com/watch?v=longbbbbbbb")
        .put("source", "youtube").put("durationMs", 30_000).put("artworkUrl", JSONObject.NULL).put("isStream", false)
    private fun player(generation: Long, active: String?, updatedAt: Long) = JSONObject()
        .put("guildId", "1").put("revision", 1).put("generation", generation).put("generationAt", 0).put("activeDeviceId", active ?: JSONObject.NULL)
        .put("playbackVersion", 1).put("current", JSONObject().put("entryId", "entryAAAAAAA").put("track", song)).put("queue", JSONArray()).put("history", JSONArray())
        .put("playhead", JSONObject().put("positionMs", 0).put("at", System.currentTimeMillis()).put("playing", true)).put("volume", 100).put("repeat", "off")
        .put("updatedAt", updatedAt)
    private fun frame(event: String, data: JSONObject) = "event:$event\ndata:$data\n\n"
    private fun view(player: JSONObject) = JSONObject().put("player", player).put("devices", JSONArray())

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                return when {
                    path == "/api/me/events" -> {
                        events.add(request)
                        val body = streams.poll(30, TimeUnit.SECONDS) ?: return MockResponse.Builder().code(503).build()
                        MockResponse.Builder().addHeader("Content-Type", "text/event-stream").body("retry: 5000\n\n: connected\n\n$body").build()
                    }
                    path == "/api/me/time" -> MockResponse.Builder().addHeader("Content-Type", "application/json")
                        .body(JSONObject().put("now", System.currentTimeMillis()).toString()).build()
                    path == "/api/me/player" -> {
                        posts.add(request to JSONObject(request.body!!.utf8()))
                        MockResponse.Builder().addHeader("Content-Type", "application/json")
                            .body(view(player(1, me, 2)).put("ok", true).put("relayed", false).toString()).build()
                    }
                    path.startsWith("/api/guilds/1/audio/") -> MockResponse.Builder().addHeader("Content-Type", "audio/wav").body(silence(30)).build()
                    else -> MockResponse.Builder().code(404).build()
                }
            }
        }
        server.start()
        val base = "http://127.0.0.1:${server.port}"
        // A service started earlier keeps the address it started with: it starts again pointed here.
        context.stopService(Intent(context, PlaybackService::class.java))
        waitFor("an earlier player service to stop", 10_000) { PlaybackService.player == null }
        PlaybackService.testBase = base
        instrumentation.runOnMainSync { CookieManager.getInstance().setCookie(base, "vybertron_session=test-session") }
        controller = MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java)))
            .buildAsync().get(20, TimeUnit.SECONDS)
    }

    @After fun stop() {
        instrumentation.runOnMainSync {
            PlaybackService.player?.handle(PlayerRequest.Stop)
            controller.release()
        }
        context.stopService(Intent(context, PlaybackService::class.java))
        waitFor("the player service to stop", 10_000) { PlaybackService.player == null }
        PlaybackService.testBase = null
        streams.clear()
        server.close()
    }

    private fun state(): JSONObject { var state = JSONObject(); instrumentation.runOnMainSync { state = PlaybackService.player!!.state() }; return state }
    private fun waitFor(what: String, timeoutMs: Long = 20_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) { if (condition()) return; Thread.sleep(100) }
        throw AssertionError("Timed out waiting for $what; posts ${posts.map { it.second }}")
    }

    @Test fun withNoPageTheServicePlaysTheSharedPlayerAndReportsARelayedPause() {
        // The page hands over its session as it loads, then goes away; nothing else of it is involved.
        instrumentation.runOnMainSync {
            assertTrue(PlaybackService.link!!.handle(PlayerRequest.Subscribe(LinkSession("csrf-test", me, "Android app", "1"))).isSuccess)
        }
        // Another device makes this one the active device while the song plays.
        streams.add(frame("player", view(player(0, "otherDevice_0123456789", 1))) + frame("player", view(player(1, me, 2))))
        waitFor("the shared player's song to play here") {
            state().let { it.optJSONObject("current")?.optString("entryId") == "entryAAAAAAA" && it.optString("status") == "playing" && !it.optBoolean("waiting") }
        }
        val opened = events.first()
        assertEquals("android", opened.url.queryParameter("kind")); assertEquals(me, opened.url.queryParameter("device"))
        assertEquals("1", opened.url.queryParameter("protocol")); assertEquals("Android app", opened.url.queryParameter("name"))
        assertTrue(opened.headers["Cookie"].orEmpty().contains("vybertron_session=test-session"))

        // That device pauses it: the portal relays the control to this one, which plays under generation 1.
        streams.add(frame("player", view(player(1, me, 2))) + frame("command", JSONObject().put("action", "pause").put("generation", 1)))
        waitFor("the pause to be reported") {
            posts.any { (_, body) -> body.optString("op") == "report" && body.optJSONObject("playhead")?.optBoolean("playing") == false }
        }
        assertEquals("paused", state().optString("status"))
        val (request, report) = posts.first { (_, body) -> body.optJSONObject("playhead")?.optBoolean("playing") == false }
        assertEquals(1, report.getInt("generation")); assertEquals(me, report.getString("deviceId"))
        assertEquals("entryAAAAAAA", report.getJSONObject("playhead").getString("entryId"))
        // The portal's checks: its own origin, the session's CSRF token and its cookie.
        assertEquals(PlaybackService.testBase, request.headers["Origin"])
        assertEquals("csrf-test", request.headers["X-CSRF-Token"])
        assertTrue(request.headers["Cookie"].orEmpty().contains("vybertron_session=test-session"))
        // Reports count from 1 in the generation and go in order.
        val numbers = posts.map { it.second }.filter { it.optString("op") == "report" }.map { it.getInt("seq") }
        assertEquals((1..numbers.size).toList(), numbers)
    }
}
