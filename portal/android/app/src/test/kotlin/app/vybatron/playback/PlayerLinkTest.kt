package app.vybatron.playback

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The shared player's JSON, as the portal sends it. */
object Shared {
    fun id(name: String) = name.padEnd(12, 'x')
    fun entry(name: String): JSONObject = JSONObject().put("entryId", id(name)).put("track", song(name).playerTrack())
    fun player(generation: Long = 0, active: String? = null, current: JSONObject? = null, queue: List<JSONObject> = emptyList(), history: List<JSONObject> = emptyList(),
               playing: Boolean = false, at: Long = NOW, positionMs: Long = 0, updatedAt: Long = 1, revision: Long = 1): JSONObject = JSONObject()
        .put("guildId", "1").put("revision", revision).put("generation", generation).put("generationAt", 0).put("activeDeviceId", active ?: JSONObject.NULL)
        .put("playbackVersion", 0).put("current", current ?: JSONObject.NULL).put("queue", JSONArray(queue)).put("history", JSONArray(history))
        .put("playhead", JSONObject().put("positionMs", positionMs).put("at", at).put("playing", playing)).put("volume", 100).put("repeat", "off").put("updatedAt", updatedAt)
    fun view(player: JSONObject): JSONObject = JSONObject().put("player", player).put("devices", JSONArray())
    const val NOW = 1_000_000L
}

/** This device's player, reduced to its queue and whether it plays. */
class FakeLocal : LocalPlayer {
    val songs = DeviceQueue()
    var status = "idle"; var position = 0L; var volume = 100
    val requests = ArrayList<PlayerRequest>()
    var follows = 0
    private val listeners = ArrayList<(JSONObject) -> Unit>()

    override fun addListener(listener: (JSONObject) -> Unit) { listeners.add(listener) }
    override fun state(): JSONObject = JSONObject()
        .put("current", songs.current?.raw ?: JSONObject.NULL).put("queue", JSONArray(songs.queue.map { it.raw })).put("history", JSONArray(songs.history.map { it.raw }))
        .put("status", if (songs.current == null) "idle" else status).put("positionMs", position).put("at", Shared.NOW).put("waiting", false)
        .put("volume", volume).put("repeat", songs.repeat.wire)

    override fun handle(request: PlayerRequest): Result<JSONObject> {
        requests.add(request)
        when (request) {
            is PlayerRequest.Load -> { songs.load(request.current, request.queue, request.history, request.repeat); status = if (request.playing) "playing" else "paused"; position = request.positionMs; volume = request.volume }
            PlayerRequest.Play -> status = "playing"
            PlayerRequest.Pause -> status = "paused"
            PlayerRequest.Next -> { songs.advance(manual = true); status = "playing"; position = 0 }
            PlayerRequest.Stop -> songs.clear()
            is PlayerRequest.Seek -> position = request.positionMs
            is PlayerRequest.Volume -> volume = request.level
            is PlayerRequest.SetRepeat -> songs.repeat = request.repeat
            else -> Unit
        }
        emit()
        return Result.success(state())
    }

    override fun follow(queue: List<NativeTrack>, history: List<NativeTrack>) { follows++; songs.follow(queue, history); emit() }

    /** The song ends by itself. */
    fun end() { songs.advance(manual = false); position = 0; emit() }
    fun emit() { val state = state(); listeners.toList().forEach { it(state) } }
}

class FakeNet : PlayerLink.Net {
    data class Post(val csrf: String, val body: JSONObject, val done: (PlayerLink.Reply) -> Unit)
    val opened = ArrayList<String>()
    var closes = 0
    val posts = ArrayList<Post>()
    private var answered = 0

    override fun open(query: String) { opened.add(query) }
    override fun close() { closes++ }
    override fun post(csrfToken: String, body: JSONObject, done: (PlayerLink.Reply) -> Unit) { posts.add(Post(csrfToken, body, done)) }

    val waiting get() = posts.drop(answered)
    fun reply(reply: PlayerLink.Reply) { val post = posts[answered++]; post.done(reply) }
    fun answer(status: Int = 200, body: JSONObject? = JSONObject().put("ok", true)) = reply(PlayerLink.Reply.Answer(status, body))
    fun reports() = posts.map { it.body }.filter { it.getString("op") == "report" }
}

class FakeTimers : PlayerLink.Timers {
    class Timer(val ms: Long, val task: () -> Unit) { var cancelled = false }
    val timers = ArrayList<Timer>()
    override fun after(ms: Long, task: () -> Unit): () -> Unit { val timer = Timer(ms, task); timers.add(timer); return { timer.cancelled = true } }
    /** The timers waiting now, other than the 15-second position reports. */
    fun others() = timers.filter { !it.cancelled && it.ms != PlayerLink.REPORT_EVERY_MS }
    fun fire() { others().forEach { it.cancelled = true; it.task() } }
}

class PlayerLinkTest {
    private val me = "m".repeat(22)
    private val session = LinkSession("csrf-1", me, "Android app", "1")
    private val local = FakeLocal()
    private val net = FakeNet()
    private val timers = FakeTimers()
    private val link = PlayerLink(local, net, timers, { Shared.NOW }, { Shared.NOW })
    private var updated = 1L

    private fun stream(player: JSONObject) = link.onEvent("player", Shared.view(player.put("updatedAt", ++updated)).toString())
    private fun command(action: String, generation: Long, value: Any? = null) =
        link.onEvent("command", JSONObject().put("action", action).put("generation", generation).apply { if (value != null) put("value", value) }.toString())
    private fun titles(list: List<NativeTrack>) = list.map { it.title }

    /** Connected, then made the active device under [generation] with A playing and [queue] waiting. */
    private fun playing(generation: Long = 2, queue: List<String> = listOf("b")) {
        link.start(session)
        stream(Shared.player(generation = generation - 1, current = Shared.entry("a"), queue = queue.map(Shared::entry)))
        stream(Shared.player(generation = generation, active = me, current = Shared.entry("a"), queue = queue.map(Shared::entry), playing = true))
    }

    @Test fun connectsWithThePagesSessionAsTheAndroidApp() {
        link.start(session)
        assertEquals(listOf("device=$me&kind=android&name=Android+app&protocol=1"), net.opened)
        // The same session again (the page reloaded) keeps the stream it has.
        link.start(session)
        assertEquals(1, net.opened.size)
        link.onEvent("rotate", "{}")
        assertEquals(2, net.opened.size)
        // A dropped stream comes back after a pause that grows.
        link.onEnded(null); assertEquals(listOf(1_000L), timers.others().map { it.ms })
        timers.fire(); assertEquals(3, net.opened.size)
        link.onEnded(503); assertEquals(2_000L, timers.others().single().ms)
    }

    @Test fun reportsAreNumberedFromOneInEachGeneration() {
        playing()
        val load = local.requests.filterIsInstance<PlayerRequest.Load>().single()
        assertEquals("A", load.current?.title); assertEquals(listOf("B"), titles(load.queue)); assertTrue(load.playing)
        val first = net.reports().single()
        assertEquals(2, first.getInt("generation")); assertEquals(1, first.getInt("seq")); assertEquals(me, first.getString("deviceId"))
        assertEquals(Shared.id("a"), first.getJSONObject("playhead").getString("entryId")); assertTrue(first.getJSONObject("playhead").getBoolean("playing"))
        assertEquals("csrf-1", net.posts.single().csrf)
        net.answer()

        // A song that ends moves on to the next by itself, and says so.
        local.end()
        val advance = net.reports().last()
        assertEquals(2, advance.getInt("seq"))
        assertEquals(Shared.id("a"), advance.getJSONObject("advance").getString("from")); assertEquals(Shared.id("b"), advance.getJSONObject("advance").getString("to"))
        assertEquals("b", advance.getJSONObject("advance").getJSONObject("track").getString("id"))
        assertFalse(advance.getJSONObject("advance").getJSONObject("track").has("requestedBy"))
        net.answer()

        // Made the active device again: a new generation, numbered from 1 again.
        stream(Shared.player(generation = 5, active = me, current = Shared.entry("b"), playing = true))
        net.answer()
        val renewed = net.reports().last()
        assertEquals(5 to 1, renewed.getInt("generation") to renewed.getInt("seq"))
    }

    @Test fun reportsWaitInOrderWhileOffline() {
        playing()
        net.reply(PlayerLink.Reply.Unreachable)
        // Paused meanwhile: the newer position replaces the one not yet delivered; volume follows it.
        command("pause", 2)
        command("volume", 2, 30)
        assertEquals(1, net.posts.size)
        timers.fire()
        val again = net.waiting.single().body
        assertEquals(1, again.getInt("seq")); assertFalse(again.getJSONObject("playhead").getBoolean("playing"))
        net.answer()
        assertEquals(2, net.waiting.single().body.getInt("seq")); assertEquals(30, net.waiting.single().body.getInt("volume"))
    }

    @Test fun followsTheStoresQueueAndKeepsTheSongPlaying() {
        playing(queue = listOf("b", "c"))
        net.answer()
        // Another device removed B.
        stream(Shared.player(generation = 2, active = me, current = Shared.entry("a"), queue = listOf(Shared.entry("c")), playing = true, revision = 2))
        assertEquals(1, local.follows)
        assertEquals("A", local.songs.current?.title); assertEquals(listOf("C"), titles(local.songs.queue)); assertEquals("playing", local.status)
        assertEquals(1, local.requests.filterIsInstance<PlayerRequest.Load>().size)
        // Play now on another device: the store's song plays here, without a report of a song change.
        stream(Shared.player(generation = 2, active = me, current = Shared.entry("c"), history = listOf(Shared.entry("a")), playing = true, revision = 3))
        assertEquals("C", local.songs.current?.title)
        assertTrue(net.reports().none { it.has("advance") })
    }

    @Test fun theStoreWaitsForThisDevicesOwnSongChanges() {
        playing(queue = listOf("b", "c"))
        net.answer()
        local.end()
        // A frame from before the advance reached the store changes nothing here.
        stream(Shared.player(generation = 2, active = me, current = Shared.entry("a"), queue = listOf(Shared.entry("b"), Shared.entry("c")), playing = true))
        assertEquals("B", local.songs.current?.title)
        assertEquals(1, local.requests.filterIsInstance<PlayerRequest.Load>().size)
    }

    @Test fun stopsAtOnceWhenAnotherDeviceTakesOver() {
        playing()
        net.answer()
        stream(Shared.player(generation = 3, active = "o".repeat(22), current = Shared.entry("a"), playing = true))
        assertEquals(null, local.songs.current)
        assertEquals(null, link.generation)
        // Nothing more is reported for this device.
        local.emit(); command("play", 3)
        assertEquals(1, net.reports().size)
    }

    @Test fun aReportRefusedAsReplacedStopsIt() {
        playing()
        net.answer(409, JSONObject().put("error", JSONObject().put("code", "replaced"))
            .put("player", Shared.player(generation = 4, active = "o".repeat(22), current = Shared.entry("a"), updatedAt = 99)))
        assertEquals(null, local.songs.current)
        assertEquals(null, link.generation)
    }

    @Test fun aRefusedSessionClosesTheStreamAndKeepsTheSongPlaying() {
        playing()
        net.answer(401, JSONObject().put("error", JSONObject().put("code", "unauthenticated")))
        assertTrue(link.refused); assertEquals(1, net.closes)
        assertEquals("A", local.songs.current?.title); assertEquals("playing", local.status)
        // Nothing is sent, and the stream stays closed, until the page hands over a new token.
        command("pause", 2); local.handle(PlayerRequest.Pause)
        link.onEnded(null)
        assertEquals(1, net.posts.size); assertTrue(timers.others().isEmpty())
        link.start(session.copy(csrfToken = "csrf-2"))
        assertEquals(2, net.opened.size)
        val resent = net.waiting.single()
        assertEquals("csrf-2", resent.csrf); assertEquals(1, resent.body.getInt("seq"))
    }

    @Test fun aStreamRefusedForTheSessionStaysClosed() {
        link.start(session)
        link.onEnded(401)
        assertTrue(link.refused); assertTrue(timers.others().isEmpty())
    }

    @Test fun carriesOutControlsRelayedForItsGeneration() {
        playing()
        net.answer()
        command("pause", 1)
        assertEquals("playing", local.status)
        command("pause", 2)
        assertEquals("paused", local.status)
        val paused = net.waiting.single().body
        assertFalse(paused.getJSONObject("playhead").getBoolean("playing")); assertEquals(2, paused.getInt("seq"))
        net.answer()
        command("repeat", 2, "track")
        assertEquals("track", net.waiting.single().body.getString("repeat"))
        net.answer()
        command("next", 2)
        assertEquals(Shared.id("b"), net.waiting.single().body.getJSONObject("advance").getString("to"))
    }

    @Test fun findingItselfActiveWithNothingPlayingLetsGo() {
        link.start(session)
        stream(Shared.player(generation = 5, active = me, current = Shared.entry("a"), playing = true))
        assertTrue(local.requests.none { it is PlayerRequest.Load })
        val deactivate = net.posts.single().body
        assertEquals("deactivate", deactivate.getString("op")); assertEquals(5, deactivate.getInt("generation"))
    }

    @Test fun stopFromThePageMakesThisDeviceActiveAndLetsTheSongGo() {
        link.start(session)
        stream(Shared.player(generation = 1, active = "o".repeat(22), current = Shared.entry("a"), queue = listOf(Shared.entry("b")), playing = true))
        link.handle(PlayerRequest.Stop)
        assertEquals("activate", net.posts.single().body.getString("op"))
        net.answer(200, Shared.view(Shared.player(generation = 2, active = me, current = Shared.entry("a"), queue = listOf(Shared.entry("b")), updatedAt = 50)))
        assertTrue(local.requests.none { it is PlayerRequest.Load })
        val stop = net.reports().single()
        assertEquals(Shared.id("a"), stop.getJSONObject("advance").getString("from")); assertEquals(JSONObject.NULL, stop.getJSONObject("advance").get("to"))
        assertEquals(2, stop.getInt("generation")); assertEquals(1, stop.getInt("seq"))
    }
}
