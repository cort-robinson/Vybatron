package app.vybatron.playback

import android.content.ComponentName
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
import java.util.concurrent.TimeUnit

/**
 * The app's player on its own: no activity, no WebView, only the playback service and
 * a controller, the way the lock screen and Bluetooth reach it. Songs come from a local
 * server standing in for the portal.
 */
@RunWith(AndroidJUnit4::class)
class DevicePlaybackTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val states = Collections.synchronizedList(ArrayList<JSONObject>())
    private val notices = Collections.synchronizedList(ArrayList<String>())
    private lateinit var controller: MediaController

    private val server get() = Companion.server
    private val audio get() = Companion.audio

    private fun silence(seconds: Int): Buffer {
        val samples = 8000 * seconds
        val wav = java.nio.ByteBuffer.allocate(44 + samples * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        wav.put("RIFF".toByteArray()).putInt(36 + samples * 2).put("WAVE".toByteArray()).put("fmt ".toByteArray())
            .putInt(16).putShort(1).putShort(1).putInt(8000).putInt(16000).putShort(2).putShort(16)
            .put("data".toByteArray()).putInt(samples * 2)
        return Buffer().write(wav.array())
    }

    private fun song(id: String, title: String, uri: String?) = JSONObject()
        .put("id", id).put("title", title).put("author", "M83").put("uri", uri ?: JSONObject.NULL).put("source", "youtube")
        .put("durationMs", 1000).put("artworkUrl", JSONObject.NULL).put("isStream", false).put("requestedBy", JSONObject.NULL)
    private fun youtube(video: String, title: String) = song(video, title, "https://www.youtube.com/watch?v=$video")

    @Before fun start() {
        audio.clear()
        while (server.takeRequest(0, TimeUnit.MILLISECONDS) != null) Unit
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                if (path.startsWith("/api/guilds/1/audio/")) {
                    val video = path.substringAfterLast('/')
                    audio.add(video)
                    return when (video) {
                        "shortaaaaaa", "matchedddd1" -> MockResponse.Builder().addHeader("Content-Type", "audio/wav").body(silence(1)).build()
                        "longbbbbbbb", "longccccccc" -> MockResponse.Builder().addHeader("Content-Type", "audio/wav").body(silence(30)).build()
                        else -> MockResponse.Builder().code(404).addHeader("Content-Type", "application/json")
                            .body("""{"error":{"code":"audio_unavailable","message":"This song can’t be streamed right now. Try another version."}}""").build()
                    }
                }
                if (path == "/api/guilds/1/search") {
                    return MockResponse.Builder().addHeader("Content-Type", "application/json")
                        // Slow enough to press Pause while the match is looked up.
                        .headersDelay(if (request.url.queryParameter("query") == "M83 Slow Lookup") 1_500 else 0, TimeUnit.MILLISECONDS)
                        .body(JSONObject().put("tracks", JSONArray().put(youtube("matchedddd1", "Matched"))).put("notice", JSONObject.NULL).toString()).build()
                }
                return MockResponse.Builder().code(404).build()
            }
        }
        // One server for the class. A service started earlier (by the app, or another test) keeps
        // the address it started with, so it's stopped first and starts again pointed here.
        if (PlaybackService.testBase == null) {
            server.start()
            PlaybackService.testBase = "http://127.0.0.1:${server.port}"
            context.stopService(android.content.Intent(context, PlaybackService::class.java))
            waitFor("an earlier player service to stop", 10_000) { PlaybackService.player == null }
        }
        controller = MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java)))
            .buildAsync().get(20, TimeUnit.SECONDS)
        instrumentation.runOnMainSync {
            val player = PlaybackService.player!!
            player.addListener { states.add(it) }
            player.addNoticeListener { message, _ -> notices.add(message) }
        }
    }

    @After fun stop() {
        instrumentation.runOnMainSync {
            PlaybackService.player?.handle(PlayerRequest.Stop)
            controller.release()
        }
    }

    private fun handle(request: PlayerRequest) {
        instrumentation.runOnMainSync { assertTrue(PlaybackService.player!!.handle(request).isSuccess) }
    }

    private fun load(vararg songs: JSONObject) = handle(PlayerRequest.Load(
        "1", NativeTrack.parse(songs.first()), songs.drop(1).map { NativeTrack.parse(it)!! }, emptyList(), 0, true, 100, Repeat.OFF))

    private fun currentTitle(): String? = states.lastOrNull()?.optJSONObject("current")?.optString("title")
    private fun waitFor(what: String, timeoutMs: Long = 20_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) { if (condition()) return; Thread.sleep(100) }
        throw AssertionError("Timed out waiting for $what; last state ${states.lastOrNull()}; notices $notices")
    }

    @Test fun songsMoveOnByThemselvesSkippingWhatCantPlay() {
        load(youtube("shortaaaaaa", "Short"), youtube("missingzzzz", "Missing"), song("spotify-1", "From Spotify", "https://open.spotify.com/track/1"))
        waitFor("the last song to finish and the player to go idle") {
            states.lastOrNull()?.optString("status") == "idle" && audio.contains("matchedddd1")
        }
        // Each song played in order; the missing one was skipped with the portal's reason, and the
        // one from another catalog showed while its YouTube match was looked up.
        assertEquals(listOf("Short", "Missing", "From Spotify", "Matched"), states.mapNotNull { it.optJSONObject("current")?.optString("title") }.distinct())
        assertEquals(listOf("“Missing”: This song can’t be streamed right now. Try another version. Skipping it."), notices)
        // The song from another catalog played through the YouTube match the portal's search found.
        val search = server.takeRequestsMatching { it.url.encodedPath == "/api/guilds/1/search" }
        assertEquals("M83 From Spotify", search.single().url.queryParameter("query"))
        assertEquals(listOf("shortaaaaaa", "missingzzzz", "matchedddd1"), audio.distinct())
    }

    @Test fun theLockScreenAndBluetoothControlsMoveThroughTheQueue() {
        load(youtube("longbbbbbbb", "First"), youtube("longccccccc", "Second"))
        waitFor("the first song to play") { currentTitle() == "First" && states.last().optString("status") == "playing" && !states.last().optBoolean("waiting") }
        instrumentation.runOnMainSync { controller.seekToNext() }
        waitFor("Next to reach the second song") { currentTitle() == "Second" }
        instrumentation.runOnMainSync { controller.pause() }
        waitFor("Pause") { states.last().optString("status") == "paused" }
        // Early in a song Previous goes back a song, and the current one waits next.
        instrumentation.runOnMainSync { controller.seekToPrevious() }
        waitFor("Previous to return to the first song") { currentTitle() == "First" }
        assertEquals(listOf("Second"), (0 until states.last().getJSONArray("queue").length()).map { states.last().getJSONArray("queue").getJSONObject(it).getString("title") })
    }

    companion object {
        val server = MockWebServer()
        val audio: MutableList<String> = Collections.synchronizedList(ArrayList<String>())

        @org.junit.AfterClass @JvmStatic fun close() {
            server.close()
            PlaybackService.testBase = null
        }
    }

    private fun result(request: PlayerRequest): Result<JSONObject> {
        var result: Result<JSONObject>? = null
        instrumentation.runOnMainSync { result = PlaybackService.player!!.handle(request) }
        return result!!
    }

    @Test fun subscribingAnswersWithoutTellingEveryone() {
        val before = states.size
        assertTrue(result(PlayerRequest.Subscribe()).isSuccess)
        Thread.sleep(300)
        assertEquals(before, states.size)
    }

    @Test fun pauseDuringALookupHoldsWhenTheMatchArrives() {
        load(song("spotify-2", "Slow Lookup", "https://open.spotify.com/track/2"))
        handle(PlayerRequest.Pause)
        waitFor("the match to load") { currentTitle() == "Matched" }
        Thread.sleep(1_000)
        assertEquals("paused", states.last().optString("status"))
        var wantsToPlay = true
        instrumentation.runOnMainSync { wantsToPlay = controller.playWhenReady }
        assertTrue("the match loaded paused", !wantsToPlay)
    }

    @Test fun backRestartsAPausedSongWithoutPlayingIt() {
        load(youtube("longbbbbbbb", "First"))
        waitFor("the song to play past three seconds", 20_000) {
            states.lastOrNull()?.let { it.optString("status") == "playing" && !it.optBoolean("waiting") } == true &&
                instrumentation.let { var at = 0L; it.runOnMainSync { at = controller.currentPosition }; at > 3_500 }
        }
        instrumentation.runOnMainSync { controller.pause() }
        waitFor("Pause") { states.last().optString("status") == "paused" }
        instrumentation.runOnMainSync { controller.seekToPrevious() }
        waitFor("Back to restart the song") { states.last().optLong("positionMs") < 1_000 }
        Thread.sleep(1_000)
        assertEquals("First", currentTitle())
        assertEquals("paused", states.last().optString("status"))
    }

    @Test fun playNowFromAnOlderQueueIsRefused() {
        load(youtube("longbbbbbbb", "First"), youtube("longccccccc", "Second"), youtube("shortaaaaaa", "Third"))
        var revision = 0L
        instrumentation.runOnMainSync { revision = PlaybackService.player!!.state().getLong("revision") }
        assertEquals("stale", result(PlayerRequest.SkipTo(1, revision - 1)).exceptionOrNull()?.message)
        assertEquals("First", PlaybackService.player!!.let { var title = ""; instrumentation.runOnMainSync { title = it.state().getJSONObject("current").getString("title") }; title })
        assertTrue(result(PlayerRequest.SkipTo(1, revision)).isSuccess)
        waitFor("Play now to reach the third song") { currentTitle() == "Third" }
    }

    @Test fun controllersCanNotChangeRepeatShuffleVolumeOrSpeedBehindTheQueue() {
        instrumentation.runOnMainSync {
            listOf(androidx.media3.common.Player.COMMAND_SET_REPEAT_MODE, androidx.media3.common.Player.COMMAND_SET_SHUFFLE_MODE,
                androidx.media3.common.Player.COMMAND_SET_VOLUME, androidx.media3.common.Player.COMMAND_SET_SPEED_AND_PITCH,
                androidx.media3.common.Player.COMMAND_SET_MEDIA_ITEM)
                .forEach { assertTrue("command $it", !controller.isCommandAvailable(it)) }
            assertTrue(controller.isCommandAvailable(androidx.media3.common.Player.COMMAND_SEEK_TO_NEXT))
        }
    }

    private fun MockWebServer.takeRequestsMatching(predicate: (RecordedRequest) -> Boolean): List<RecordedRequest> {
        val found = ArrayList<RecordedRequest>()
        while (true) { val request = takeRequest(0, TimeUnit.MILLISECONDS) ?: break; if (predicate(request)) found.add(request) }
        return found
    }
}
