package app.vybatron.playback

import org.json.JSONObject
import java.net.URLEncoder
import kotlin.math.abs

/** This device's own player, as the link drives it: DevicePlayer, or a stand-in in tests. */
interface LocalPlayer {
    fun state(): JSONObject
    fun handle(request: PlayerRequest): Result<JSONObject>
    /** Replaces the waiting and played songs; the song playing now plays on. */
    fun follow(queue: List<NativeTrack>, history: List<NativeTrack>)
    fun addListener(listener: (JSONObject) -> Unit)
}

/**
 * The playback service's own way to the shared player (ADR-0018), so the app stays a
 * reachable device with its page closed: the listener stream, which brings the player
 * and controls relayed to this device, and the reports this device sends while it is
 * the active one. Main thread only; [Net] does the networking and calls back on it.
 *
 * While the player's active device is this one, under a generation it saw begin, this
 * device plays the store's songs and reports every song change, play, pause, seek,
 * volume and repeat, numbered from 1 in that generation. A newer generation, or a
 * report refused as `replaced`, stops it at once. If the portal refuses the session,
 * the stream closes and reports wait, and the song in progress keeps playing, until
 * the page hands over a session again.
 */
class PlayerLink(
    private val local: LocalPlayer,
    private val net: Net,
    private val timers: Timers,
    /** The portal's clock now, in ms (this device's clock corrected by the measured offset). */
    private val serverNow: () -> Long,
    private val localNow: () -> Long = System::currentTimeMillis,
) {
    interface Net {
        /** Opens the listener stream with [query], replacing any open one. */
        fun open(query: String)
        fun close()
        /** POSTs [body] to `/api/me/player`, answering on the main thread. */
        fun post(csrfToken: String, body: JSONObject, done: (Reply) -> Unit)
    }

    sealed interface Reply {
        data class Answer(val status: Int, val body: JSONObject?) : Reply
        /** No answer: offline, timed out, or cut off. */
        data object Unreachable : Reply
    }

    fun interface Timers {
        /** Runs [task] on the main thread after [ms]; the result cancels it. */
        fun after(ms: Long, task: () -> Unit): () -> Unit
    }

    private data class Head(val entryId: String?, val positionMs: Long, val at: Long, val playing: Boolean)
    private data class Owned(val generation: Long, var seq: Long)
    private class Report(val generation: Long, val seq: Long, val advance: JSONObject?, var playhead: Head?, val volume: Int?, val repeat: Repeat?) {
        val playheadOnly get() = advance == null && volume == null && repeat == null && playhead != null
    }

    var session: LinkSession? = null; private set
    /** Whether the portal refused the session; nothing is sent until the page hands over another. */
    var refused = false; private set
    /** The newest player seen. */
    var player: SharedPlayer? = null; private set
    private var owned: Owned? = null
    private var sawPlayer = false
    private var stopping = false
    private var streamAttempt = 0
    private var reconnect: (() -> Unit)? = null
    private val outbox = ArrayDeque<Report>()
    private var sending: Report? = null
    private var retry: (() -> Unit)? = null
    private var retryAttempt = 0
    private var ticker: (() -> Unit)? = null
    private var closed = false
    // What the store has been told, or is about to be.
    private var lastEntry: String? = null
    private var lastVolume = 100
    private var lastRepeat = Repeat.OFF
    private var lastHead: Head? = null

    init {
        local.addListener(::onLocal)
    }

    /** The generation this device plays under, while it is the active device. */
    val generation: Long? get() = owned?.generation

    /** Takes the page's session and connects with it, or reconnects after a refusal. */
    fun start(next: LinkSession) {
        if (closed) return
        val previous = session
        session = next
        if (previous != null && previous.deviceId != next.deviceId) { if (owned != null) halt(); player = null; sawPlayer = false }
        val reopen = refused || previous == null || previous.deviceId != next.deviceId || previous.csrfToken != next.csrfToken
        refused = false
        if (reopen) { streamAttempt = 0; connect() }
        flush()
    }

    fun close() {
        closed = true
        reconnect?.invoke(); retry?.invoke(); ticker?.invoke()
        net.close()
    }

    /** Requests from the page: Stop lets go of the shared player's song, the rest go to the player. */
    fun handle(request: PlayerRequest): Result<JSONObject> {
        if (request is PlayerRequest.Subscribe) request.session?.let(::start)
        if (request == PlayerRequest.Stop && session != null && !refused) { stop(); return Result.success(local.state()) }
        return local.handle(request)
    }

    /**
     * Stop: the current song is let go and nothing plays. Only the active device can let
     * go of a song, so this device becomes it first when another device plays.
     */
    fun stop() {
        val me = session
        if (owned != null || me == null || refused) { local.handle(PlayerRequest.Stop); return }
        stopping = true
        val body = JSONObject().put("op", "activate").put("deviceId", me.deviceId)
        (player?.guildId ?: me.guildId)?.let { body.put("guildId", it) }
        // Activated, the player that comes back (or arrives first on the stream) begins stopped.
        net.post(me.csrfToken, body) { reply -> answered(reply); stopping = false }
    }

    // The listener stream.

    fun onEvent(name: String, data: String) {
        if (closed) return
        when (name) {
            "player" -> {
                val view = runCatching { JSONObject(data) }.getOrNull() ?: return
                val next = SharedPlayer.parse(view.opt("player")) ?: return
                streamAttempt = 0
                receive(next, fromStream = true)
            }
            "command" -> {
                val command = RelayedCommand.parse(data) ?: return
                val own = owned ?: return
                if (command.generation != own.generation) return
                carryOut(command.request)
            }
            // The portal retires a stream after a while and says so first: the next one opens at once.
            "rotate" -> connect()
        }
    }

    /** The stream ended: [status] is the portal's refusal, or null when it closed or the network failed. */
    fun onEnded(status: Int?) {
        if (closed || refused || session == null) return
        if (status == 401 || status == 403) { refuse(); return }
        reconnect?.invoke()
        val wait = minOf(30_000L, 1_000L shl minOf(streamAttempt++, 5))
        reconnect = timers.after(wait) { reconnect = null; if (!refused && !closed) connect() }
    }

    private fun connect() {
        val me = session ?: return
        reconnect?.invoke(); reconnect = null
        val name = URLEncoder.encode(me.name, "UTF-8")
        net.open("device=${me.deviceId}&kind=android&name=$name&protocol=1")
    }

    private fun refuse() {
        refused = true
        reconnect?.invoke(); reconnect = null
        retry?.invoke(); retry = null
        net.close()
    }

    // The player.

    private fun receive(next: SharedPlayer, fromStream: Boolean) {
        val known = player
        if (known != null && next.updatedAt < known.updatedAt) return
        val first = fromStream && !sawPlayer
        if (fromStream) sawPlayer = true
        player = next
        val me = session?.deviceId ?: return
        val own = owned
        val mine = next.activeDeviceId == me
        if (own != null) {
            if (mine && next.generation == own.generation) { follow(next); return }
            // Another device plays now: stop at once. (Made the active one again, it starts over below.)
            if (!mine || next.generation < own.generation) { halt(); return }
        }
        if (!mine) return
        // A first look that finds this device the active one while nothing plays here (the app
        // was closed and opened again) lets go, so the player waits paused where it was.
        if (first && own == null && !stopping && local.state().opt("current").let { it == null || it == JSONObject.NULL }) {
            deactivate(next.generation)
            return
        }
        begin(next)
    }

    /** This device starts playing the player as its active device, under [next]'s generation. */
    private fun begin(next: SharedPlayer) {
        owned = Owned(next.generation, 0)
        outbox.clear(); retry?.invoke(); retry = null; retryAttempt = 0
        lastHead = null; lastVolume = next.volume; lastRepeat = next.repeat
        startTicker()
        if (stopping) {
            stopping = false
            val from = next.current?.entryId
            lastEntry = null
            if (from != null) report(advance = advance(from, null, null))
            local.handle(PlayerRequest.Stop)
            return
        }
        load(next, next.playing)
    }

    private fun load(next: SharedPlayer, playing: Boolean) {
        val guild = next.guildId ?: session?.guildId
        val current = next.current?.native()
        lastEntry = if (current != null) next.current.entryId else null
        if (guild == null) { local.handle(PlayerRequest.Stop); return }
        local.handle(PlayerRequest.Load(guild, current, next.queue.mapNotNull { it.native() }, next.history.mapNotNull { it.native() },
            next.positionAt(serverNow()), playing && current != null, lastVolume, lastRepeat))
    }

    /** The store changed while this device plays it: an edit from any device, or a report's answer. */
    private fun follow(next: SharedPlayer) {
        // This device's own song changes come first; the store catches up with them.
        if (outbox.any { it.advance != null }) return
        val state = local.state()
        val current = NativeTrack.parse(state.opt("current"))
        val storeEntry = next.current?.entryId
        if (storeEntry != (current?.entryId)) {
            if (storeEntry == null) { lastEntry = null; local.handle(PlayerRequest.Stop) }
            else load(next, state.optString("status") == "playing" || next.playing)
            return
        }
        if (current == null) return
        val queue = tracks(state, "queue")
        val history = tracks(state, "history")
        if (queue.map { it.entryId } != next.queue.map { it.entryId } || history.map { it.entryId } != next.history.map { it.entryId }) {
            local.follow(next.queue.mapNotNull { it.native() }, next.history.mapNotNull { it.native() })
        }
    }

    /** Another device plays now: stop at once. */
    private fun halt() {
        owned = null
        outbox.clear(); retry?.invoke(); retry = null
        ticker?.invoke(); ticker = null
        lastEntry = null; lastHead = null
        local.handle(PlayerRequest.Stop)
    }

    private fun deactivate(generation: Long) {
        val me = session ?: return
        net.post(me.csrfToken, JSONObject().put("op", "deactivate").put("deviceId", me.deviceId).put("generation", generation)) { answered(it) }
    }

    private fun carryOut(request: PlayerRequest.Control) {
        val state = local.state()
        val idle = state.opt("current").let { it == null || it == JSONObject.NULL }
        // Play with nothing loaded starts the first waiting song.
        if (request == PlayerRequest.Play && idle) { local.handle(PlayerRequest.Next); return }
        local.handle(request)
    }

    // Reports.

    /** Every change this device's player makes while it is the active device is reported. */
    fun onLocal(state: JSONObject) {
        if (owned == null || closed) return
        val current = NativeTrack.parse(state.opt("current"))
        val entry = current?.entryId
        // A song without an entry wasn't handed over by the store; it isn't the shared player's.
        if (current == null || entry != null) {
            if (entry != lastEntry) {
                val from = lastEntry
                lastEntry = entry
                lastHead = null
                report(advance = advance(from, entry, current?.playerTrack()))
            }
        }
        val volume = state.optInt("volume", lastVolume)
        if (volume != lastVolume) { lastVolume = volume; report(volume = volume) }
        val repeat = Repeat.of(state.optString("repeat")) ?: lastRepeat
        if (repeat != lastRepeat) { lastRepeat = repeat; report(repeat = repeat) }
        sync(state, force = false)
    }

    /** The playhead, reported whenever it moves other than by playing on: play, pause, seek, a new song. */
    private fun sync(state: JSONObject, force: Boolean) {
        if (owned == null || state.optBoolean("waiting")) return
        val entry = NativeTrack.parse(state.opt("current"))?.entryId
        val playing = state.optString("status") == "playing" && entry != null
        val offset = serverNow() - localNow()
        val head = Head(entry, state.optLong("positionMs").coerceIn(0, SharedPlayer.MAX_POSITION), state.optLong("at", localNow()) + offset, playing)
        val last = lastHead
        val expected = if (last == null) 0 else last.positionMs + if (last.playing) head.at - last.at else 0
        if (!force && last != null && last.entryId == head.entryId && last.playing == playing && abs(expected - head.positionMs) < 1_500) return
        lastHead = head
        report(playhead = head)
    }

    private fun startTicker() {
        ticker?.invoke()
        ticker = timers.after(REPORT_EVERY_MS) {
            ticker = null
            if (owned == null) return@after
            val state = local.state()
            if (state.optString("status") == "playing") sync(state, force = true)
            startTicker()
        }
    }

    private fun advance(from: String?, to: String?, track: JSONObject?): JSONObject =
        JSONObject().put("from", from ?: JSONObject.NULL).put("to", to ?: JSONObject.NULL).apply { if (to != null && track != null) put("track", track) }

    private fun report(advance: JSONObject? = null, playhead: Head? = null, volume: Int? = null, repeat: Repeat? = null) {
        val own = owned ?: return
        val last = outbox.lastOrNull()
        // A newer position replaces one still waiting to go.
        if (playhead != null && advance == null && volume == null && repeat == null && last != null && last !== sending && last.playheadOnly) {
            last.playhead = playhead
            return
        }
        outbox.addLast(Report(own.generation, ++own.seq, advance, playhead, volume, repeat))
        flush()
    }

    /** Reports go one at a time, in order; one that can't be delivered now goes again with the same number. */
    private fun flush() {
        if (sending != null || refused || closed || retry != null) return
        val me = session ?: return
        while (outbox.isNotEmpty() && outbox.first().generation != owned?.generation) outbox.removeFirst()
        val item = outbox.firstOrNull() ?: return
        sending = item
        val body = JSONObject().put("op", "report").put("deviceId", me.deviceId).put("generation", item.generation).put("seq", item.seq)
        item.advance?.let { body.put("advance", it) }
        item.playhead?.let { body.put("playhead", JSONObject().put("entryId", it.entryId ?: JSONObject.NULL).put("positionMs", it.positionMs).put("at", it.at).put("playing", it.playing)) }
        item.volume?.let { body.put("volume", it) }
        item.repeat?.let { body.put("repeat", it.wire) }
        net.post(me.csrfToken, body) { reply -> delivered(item, reply) }
    }

    private fun delivered(item: Report, reply: Reply) {
        sending = null
        if (closed) return
        // From a generation this device no longer plays under: nothing to do with it.
        if (item.generation != owned?.generation) { flush(); return }
        val status = (reply as? Reply.Answer)?.status ?: 0
        val code = (reply as? Reply.Answer)?.body?.optJSONObject("error")?.optString("code")
        when {
            status in 200..299 -> {
                outbox.remove(item); retryAttempt = 0
                answered(reply)
            }
            status == 409 && code == "replaced" -> {
                outbox.clear()
                answered(reply)
                // Still holding on (the player it came with was older): stop anyway.
                if (owned?.generation == item.generation) halt()
            }
            refusedSession(status, code) -> { refuse(); return }
            status in 400..499 && status != 408 && status != 429 -> outbox.remove(item)
            else -> {
                retry = timers.after(minOf(30_000L, 1_000L shl minOf(retryAttempt++, 5))) { retry = null; flush() }
                return
            }
        }
        flush()
    }

    /** Takes the player a reply carries, if any; false when the request didn't go through. */
    private fun answered(reply: Reply): Boolean {
        val answer = reply as? Reply.Answer ?: return false
        if (refusedSession(answer.status, answer.body?.optJSONObject("error")?.optString("code"))) { refuse(); return false }
        SharedPlayer.parse(answer.body?.opt("player"))?.let { receive(it, fromStream = false) }
        return answer.status in 200..299
    }

    private fun refusedSession(status: Int, code: String?) = status == 401 || (status == 403 && code == "forbidden")

    private fun tracks(state: JSONObject, key: String): List<NativeTrack> {
        val array = state.optJSONArray(key) ?: return emptyList()
        return (0 until array.length()).mapNotNull { NativeTrack.parse(array.opt(it)) }
    }

    companion object {
        /** The active device reports where it is this often while it plays (ADR-0018). */
        const val REPORT_EVERY_MS = 15_000L
    }
}
