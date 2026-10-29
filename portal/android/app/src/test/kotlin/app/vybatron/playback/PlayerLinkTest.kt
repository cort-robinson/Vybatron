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
               playing: Boolean = false, at: Long = NOW, positionMs: Long = 0, updatedAt: Long = 1, revision: Long = 1, repeat: String = "off"): JSONObject = JSONObject()
        .put("guildId", "1").put("revision", revision).put("generation", generation).put("generationAt", 0).put("activeDeviceId", active ?: JSONObject.NULL)
        .put("playbackVersion", 0).put("current", current ?: JSONObject.NULL).put("queue", JSONArray(queue)).put("history", JSONArray(history))
        .put("playhead", JSONObject().put("positionMs", positionMs).put("at", at).put("playing", playing)).put("volume", 100).put("repeat", repeat).put("updatedAt", updatedAt)
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
    private fun playing(generation: Long = 2, queue: List<String> = listOf("b"), repeat: String = "off") {
        link.start(session)
        stream(Shared.player(generation = generation - 1, current = Shared.entry("a"), queue = queue.map(Shared::entry), repeat = repeat))
        stream(Shared.player(generation = generation, active = me, current = Shared.entry("a"), queue = queue.map(Shared::entry), playing = true, repeat = repeat))
    }

    @Test fun connectsAsATvOnATv() {
        val tv = PlayerLink(FakeLocal(), net, timers, { Shared.NOW }, { Shared.NOW }, kind = app.vybatron.DeviceForm.TV.kind)
        tv.start(LinkSession("csrf-1", me, "TV", "1"))
        assertEquals(listOf("device=$me&kind=tv&name=TV&protocol=1"), net.opened)
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

    @Test fun reportsWaitInOrderWhileOfflineAndASentOneNeverChanges() {
        playing()
        net.reply(PlayerLink.Reply.Unreachable)
        // Paused meanwhile. The store may have applied the report it never answered, so the pause
        // is a report of its own, not a change to that one under the same number.
        command("pause", 2)
        command("volume", 2, 30)
        assertEquals(1, net.posts.size)
        timers.fire()
        val again = net.waiting.single().body
        assertEquals(1, again.getInt("seq")); assertTrue(again.getJSONObject("playhead").getBoolean("playing"))
        net.answer()
        val paused = net.waiting.single().body
        assertEquals(2, paused.getInt("seq")); assertFalse(paused.getJSONObject("playhead").getBoolean("playing"))
        net.answer()
        assertEquals(3, net.waiting.single().body.getInt("seq")); assertEquals(30, net.waiting.single().body.getInt("volume"))
    }

    @Test fun aNewSessionStartsOverWithNothingFromTheOldOne() {
        playing()
        net.answer()
        local.end()
        val inFlight = net.posts.size
        // The listener signed in again: a new token, the same device.
        link.start(session.copy(csrfToken = "csrf-2"))
        assertEquals(null, link.generation)
        // The old session's answer arrives late and changes nothing; nothing old is sent with the new token.
        net.answer(200, Shared.view(Shared.player(generation = 2, active = me, current = Shared.entry("b"), updatedAt = 40)))
        local.handle(PlayerRequest.Pause); local.handle(PlayerRequest.Play)
        assertEquals(inFlight, net.posts.size)
        // The new session's player: this device is still listed as playing it, and B plays here,
        // which this session hasn't reported. It becomes the player's under a new generation.
        stream(Shared.player(generation = 2, active = me, current = Shared.entry("a"), queue = listOf(Shared.entry("b")), playing = true))
        val activate = net.waiting.single()
        assertEquals("activate", activate.body.getString("op")); assertEquals("csrf-2", activate.csrf)
        net.answer(200, Shared.view(Shared.player(generation = 3, active = me, current = Shared.entry("a"), queue = listOf(Shared.entry("b")), playing = true, updatedAt = 60)))
        val adopted = net.waiting.single()
        assertEquals("csrf-2", adopted.csrf)
        assertEquals(3 to 1, adopted.body.getInt("generation") to adopted.body.getInt("seq"))
        assertEquals(Shared.id("b"), adopted.body.getJSONObject("advance").getString("to"))
        assertTrue(local.requests.filterIsInstance<PlayerRequest.Load>().size == 1)
    }

    @Test fun aSongRoundAgainOnRepeatIsTheStoresFreshEntry() {
        playing(repeat = "queue")
        assertEquals(Repeat.QUEUE, local.songs.repeat)
        // Offline for a whole round: A, then B, then A again.
        net.reply(PlayerLink.Reply.Unreachable)
        local.end(); local.end()
        assertEquals("A", local.songs.current?.title)
        timers.fire()
        net.answer()
        val toB = net.waiting.single().body.getJSONObject("advance")
        assertEquals(Shared.id("a") to Shared.id("b"), toB.getString("from") to toB.getString("to"))
        // The store moved A to history and queued it again as a fresh entry.
        val fresh = JSONObject().put("entryId", Shared.id("a2")).put("track", song("a").playerTrack())
        net.answer(200, Shared.view(Shared.player(generation = 2, active = me, current = Shared.entry("b"), queue = listOf(fresh), history = listOf(Shared.entry("a")),
            playing = true, repeat = "queue", updatedAt = 50)))
        while (net.waiting.isNotEmpty() && !net.waiting.first().body.has("advance")) net.answer()
        val toA = net.waiting.single().body.getJSONObject("advance")
        // Not the old entry, which is in history and would mean going back.
        assertEquals(Shared.id("b") to Shared.id("a2"), toA.getString("from") to toA.getString("to"))
        net.answer(200, Shared.view(Shared.player(generation = 2, active = me, current = fresh, queue = listOf(Shared.entry("b").put("entryId", Shared.id("b2"))),
            history = listOf(Shared.entry("b"), Shared.entry("a")), playing = true, repeat = "queue", updatedAt = 60)))
        // In step with the store again: A plays on, and what follows is the store's.
        assertEquals("A", local.songs.current?.title)
        assertEquals(listOf(Shared.id("b2")), local.songs.queue.map { it.entryId })
        assertEquals(1, local.requests.filterIsInstance<PlayerRequest.Load>().size)
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
        assertEquals(1, net.posts.size)
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

    private fun loads() = local.requests.filterIsInstance<PlayerRequest.Load>().size
    /** Answers the reports waiting ahead of the next song change, and returns that change. */
    private fun nextAdvance(): JSONObject {
        while (net.waiting.isNotEmpty() && !net.waiting.first().body.has("advance")) net.answer()
        return net.waiting.first().body.getJSONObject("advance")
    }
    private fun pair(advance: JSONObject) = advance.optString("from") to (if (advance.isNull("to")) null else advance.getString("to"))

    @Test fun stopLetsTheStoresSongGoAndNothingRestarts() {
        playing()
        net.answer()
        link.handle(PlayerRequest.Stop)
        assertEquals(Shared.id("a") to null, pair(nextAdvance()))
        net.answer(200, Shared.view(Shared.player(generation = 2, active = me, history = listOf(Shared.entry("a")), queue = listOf(Shared.entry("b")), updatedAt = 50)))
        assertEquals(null, local.songs.current)
        assertEquals(1, loads())
    }

    @Test fun theLastSongEndingLetsTheStoresSongGoAndNothingRestarts() {
        playing(queue = emptyList())
        net.answer()
        local.end()
        assertEquals(null, local.songs.current)
        assertEquals(Shared.id("a") to null, pair(nextAdvance()))
        net.answer(200, Shared.view(Shared.player(generation = 2, active = me, history = listOf(Shared.entry("a")), updatedAt = 50)))
        assertEquals(null, local.songs.current)
        assertEquals(1, loads())
    }

    @Test fun reconnectingToFindThePagePlayingTakesOverUnderAFreshGeneration() {
        link.start(session)
        stream(Shared.player(generation = 1, current = Shared.entry("a"), queue = listOf(Shared.entry("b"))))
        link.onEnded(null)
        // Meanwhile the page made this device the active one (generation 2) and loaded the app itself.
        local.handle(PlayerRequest.Load("1", Entry(Shared.id("a"), song("a").playerTrack()).native(), listOf(Entry(Shared.id("b"), song("b").playerTrack()).native()!!),
            emptyList(), 0, true, 100, Repeat.OFF))
        timers.fire()
        stream(Shared.player(generation = 2, active = me, current = Shared.entry("a"), queue = listOf(Shared.entry("b")), playing = true))
        assertEquals("activate", net.waiting.single().body.getString("op"))
        net.answer(200, Shared.view(Shared.player(generation = 3, active = me, current = Shared.entry("a"), queue = listOf(Shared.entry("b")), playing = true, updatedAt = 50)))
        val first = net.waiting.single().body
        assertEquals(3 to 1, first.getInt("generation") to first.getInt("seq"))
        // The music the page started plays on, not reloaded from the store.
        assertEquals(1, loads())
    }

    @Test fun twoRoundsOnRepeatOfflineReachTheStoreInOrder() {
        playing(repeat = "queue")
        net.reply(PlayerLink.Reply.Unreachable)
        // Offline: A, B, A again, B again.
        local.end(); local.end(); local.end()
        assertEquals("B", local.songs.current?.title)
        timers.fire()
        assertEquals(Shared.id("a") to Shared.id("b"), pair(nextAdvance()))
        val a2 = JSONObject().put("entryId", Shared.id("a2")).put("track", song("a").playerTrack())
        val b2 = JSONObject().put("entryId", Shared.id("b2")).put("track", song("b").playerTrack())
        val a3 = JSONObject().put("entryId", Shared.id("a3")).put("track", song("a").playerTrack())
        net.answer(200, Shared.view(Shared.player(generation = 2, active = me, current = Shared.entry("b"), queue = listOf(a2), history = listOf(Shared.entry("a")),
            playing = true, repeat = "queue", updatedAt = 50)))
        assertEquals(Shared.id("b") to Shared.id("a2"), pair(nextAdvance()))
        net.answer(200, Shared.view(Shared.player(generation = 2, active = me, current = a2, queue = listOf(b2), history = listOf(Shared.entry("b"), Shared.entry("a")),
            playing = true, repeat = "queue", updatedAt = 60)))
        assertEquals(Shared.id("a2") to Shared.id("b2"), pair(nextAdvance()))
        net.answer(200, Shared.view(Shared.player(generation = 2, active = me, current = b2, queue = listOf(a3), history = listOf(a2, Shared.entry("b"), Shared.entry("a")),
            playing = true, repeat = "queue", updatedAt = 70)))
        // In step: B plays on as the store's current song, with the store's queue after it.
        assertEquals("B", local.songs.current?.title)
        assertEquals(listOf(Shared.id("a3")), local.songs.queue.map { it.entryId })
        assertEquals(1, loads())
        assertTrue(net.reports().none { it.has("advance") && it.getJSONObject("advance").optString("to") == Shared.id("a") })
    }
}
