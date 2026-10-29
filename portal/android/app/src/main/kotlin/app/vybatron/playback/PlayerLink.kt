package app.vybatron.playback

import org.json.JSONObject
import java.net.URLEncoder
import java.security.SecureRandom
import java.util.Base64
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
 * the page hands over a session again. A different session starts over: nothing from
 * the previous one is sent with it.
 *
 * The page hears [status]: whether the stream is live (`linked`) and the generation this
 * device plays under. While the stream isn't live the page passes relayed controls on.
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
        // Once sent, a report is never changed: the store may have applied it even if no answer came.
        var attempted = false
        val playheadOnly get() = advance == null && volume == null && repeat == null && playhead != null
    }

    var session: LinkSession? = null; private set
    /** Whether the portal refused the session; nothing is sent until the page hands over another. */
    var refused = false; private set
    /** The newest player seen. */
    var player: SharedPlayer? = null; private set
    /** Whether the listener stream is live: it has brought a player since it opened. */
    var linked = false
        private set(value) { field = value; announce() }
    private var owned: Owned? = null
        set(value) { field = value; announce() }
    // Bumped with each new session: answers to requests made under an older one are dropped.
    private var epoch = 0
    private var sawPlayer = false
    private var stopping = false
    // Taking over music this device plays without the store knowing (a new session, or the page played it).
    private var adopting = false
    // While this device asks to become the active one: players of this generation or older don't start it.
    private var activatingAbove: Long? = null
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
    // A song that came round again on repeat: this device holds it under its old entry, the store
    // under a fresh one, which [alias] names once the store has caught up.
    private var wrapped: String? = null
    private val alias = HashMap<String, String>()
    private val statusListeners = ArrayList<(JSONObject) -> Unit>()
    private var announced: String? = null

    init {
        local.addListener(::onLocal)
        announced = status().toString()
    }

    /** The generation this device plays under, while it is the active device. */
    val generation: Long? get() = owned?.generation

    fun status(): JSONObject = JSONObject().put("linked", linked).put("generation", owned?.generation ?: JSONObject.NULL)

    fun addStatusListener(listener: (JSONObject) -> Unit) { statusListeners.add(listener) }
    fun removeStatusListener(listener: (JSONObject) -> Unit) { statusListeners.remove(listener) }

    private fun announce() {
        val now = status()
        if (now.toString() == announced) return
        announced = now.toString()
        statusListeners.toList().forEach { it(now) }
    }

    /** Takes the page's session and connects with it, or reconnects after a refusal. */
    fun start(next: LinkSession) {
        if (closed) return
        val previous = session
        val replaced = previous != null && (previous.deviceId != next.deviceId || previous.csrfToken != next.csrfToken)
        session = next
        if (replaced) reset()
        val reopen = refused || previous == null || replaced
        refused = false
        if (reopen) { streamAttempt = 0; connect() }
        flush()
    }

    /** A different session: its ownership, numbering and waiting reports aren't this one's. The music plays on. */
    private fun reset() {
        epoch++
        owned = null
        outbox.clear(); sending = null
        retry?.invoke(); retry = null; retryAttempt = 0
        ticker?.invoke(); ticker = null
        lastEntry = null; lastHead = null; wrapped = null; alias.clear()
        player = null; sawPlayer = false; stopping = false; adopting = false; activatingAbove = null
    }

    fun close() {
        closed = true
        reconnect?.invoke(); retry?.invoke(); ticker?.invoke()
        net.close()
        linked = false
    }

    /** Requests from the page: its session, and Stop while linked; the rest go to the player. */
    fun handle(request: PlayerRequest): Result<JSONObject> {
        if (request is PlayerRequest.Subscribe) {
            request.session?.let(::start)
            return local.handle(request).map { it.put("link", status()) }
        }
        if (request == PlayerRequest.Stop && linked) { stop(); return Result.success(local.state()) }
        return local.handle(request)
    }

    /**
     * Stop: the current song is let go and nothing plays. Only the active device can let
     * go of a song, so this device becomes it first when another device plays.
     */
    fun stop() {
        val me = session
        if (owned != null || me == null || !linked) { local.handle(PlayerRequest.Stop); return }
        stopping = true
        // Activated, the player that comes back (or arrives first on the stream) begins stopped.
        activate { stopping = false }
    }

    private fun activate(after: () -> Unit) {
        val me = session ?: return
        val body = JSONObject().put("op", "activate").put("deviceId", me.deviceId)
        (player?.guildId ?: me.guildId)?.let { body.put("guildId", it) }
        activatingAbove = player?.generation ?: -1
        send(body) { reply -> answered(reply); activatingAbove = null; after() }
    }

    private fun send(body: JSONObject, done: (Reply) -> Unit) {
        val me = session ?: return
        val at = epoch
        net.post(me.csrfToken, body) { reply -> if (at == epoch && !closed) done(reply) }
    }

    // The listener stream.

    fun onEvent(name: String, data: String) {
        if (closed) return
        when (name) {
            "player" -> {
                val view = runCatching { JSONObject(data) }.getOrNull() ?: return
                val next = SharedPlayer.parse(view.opt("player")) ?: return
                streamAttempt = 0
                linked = true
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
        linked = false
        if (status == 401 || status == 403) { refuse(); return }
        reconnect?.invoke()
        val wait = minOf(30_000L, 1_000L shl minOf(streamAttempt++, 5))
        reconnect = timers.after(wait) { reconnect = null; if (!refused && !closed) connect() }
    }

    private fun connect() {
        val me = session ?: return
        reconnect?.invoke(); reconnect = null
        linked = false
        val name = URLEncoder.encode(me.name, "UTF-8")
        net.open("device=${me.deviceId}&kind=android&name=$name&protocol=1")
    }

    private fun refuse() {
        refused = true
        reconnect?.invoke(); reconnect = null
        retry?.invoke(); retry = null
        net.close()
        linked = false
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
        if (first && own == null && !stopping && !adopting) {
            val idle = local.state().opt("current").let { it == null || it == JSONObject.NULL }
            // Nothing plays here (the app was closed and opened again): let go, so the player waits
            // paused where it was. Music plays here that this session hasn't reported (the page played
            // it, or a new sign-in): it becomes the player's under a new generation of this session's.
            if (idle) deactivate(next.generation) else { adopting = true; activate { adopting = false } }
            return
        }
        activatingAbove?.let { if (next.generation <= it) return }
        begin(next)
    }

    /** This device starts playing the player as its active device, under [next]'s generation. */
    private fun begin(next: SharedPlayer) {
        outbox.clear(); retry?.invoke(); retry = null; retryAttempt = 0
        lastHead = null; lastVolume = next.volume; lastRepeat = next.repeat; wrapped = null; alias.clear()
        owned = Owned(next.generation, 0)
        startTicker()
        if (stopping) {
            stopping = false
            val from = next.current?.entryId
            lastEntry = null
            if (from != null) report(advance = advance(from, null, null))
            local.handle(PlayerRequest.Stop)
            return
        }
        if (adopting) {
            // What plays here is reported as it is: its song, place, volume and repeat. The queue follows the store's.
            adopting = false
            lastEntry = next.current?.entryId
            onLocal(local.state())
            return
        }
        load(next, next.playing)
    }

    private fun load(next: SharedPlayer, playing: Boolean) {
        val guild = next.guildId ?: session?.guildId
        val current = next.current?.native()
        lastEntry = if (current != null) next.current.entryId else null
        alias.clear(); wrapped = null
        if (guild == null) { local.handle(PlayerRequest.Stop); return }
        local.handle(PlayerRequest.Load(guild, current, next.queue.mapNotNull { it.native() }, next.history.mapNotNull { it.native() },
            next.positionAt(serverNow()), playing && current != null, lastVolume, lastRepeat))
    }

    private fun entryOf(track: NativeTrack?): String? = track?.entryId?.let { alias[it] ?: it }

    /** The store changed while this device plays it: an edit from any device, or a report's answer. */
    private fun follow(next: SharedPlayer) {
        // This device's own song changes come first; the store catches up with them.
        if (outbox.any { it.advance != null }) return
        if (wrapped != null) { resolveWrap(next); return }
        val state = local.state()
        val current = NativeTrack.parse(state.opt("current"))
        val storeEntry = next.current?.entryId
        if (storeEntry != entryOf(current)) {
            if (storeEntry == null) { lastEntry = null; local.handle(PlayerRequest.Stop) }
            else load(next, state.optString("status") == "playing" || next.playing)
            return
        }
        if (current == null) return
        val queue = tracks(state, "queue")
        val history = tracks(state, "history")
        if (queue.map(::entryOf) != next.queue.map { it.entryId } || history.map(::entryOf) != next.history.map { it.entryId }) {
            local.follow(next.queue.mapNotNull { it.native() }, next.history.mapNotNull { it.native() })
        }
    }

    /**
     * A song that came round again on repeat goes to the store as the store's fresh entry for
     * it in the queue, once the store has the song changes before it: by its old entry, which
     * is in history, the store would take it for going back.
     */
    private fun resolveWrap(next: SharedPlayer) {
        val held = wrapped ?: return
        val state = local.state()
        val current = NativeTrack.parse(state.opt("current"))
        if (current?.entryId != held) { wrapped = null; return }
        val fresh = next.queue.firstOrNull { it.track.optString("id") == current.id }?.entryId ?: newEntryId()
        alias[held] = fresh
        wrapped = null
        val from = lastEntry
        lastEntry = fresh
        lastHead = null
        report(advance = advance(from, fresh, current.playerTrack()))
        sync(state, force = false)
    }

    /** Another device plays now: stop at once. */
    private fun halt() {
        owned = null
        outbox.clear(); retry?.invoke(); retry = null
        ticker?.invoke(); ticker = null
        lastEntry = null; lastHead = null; wrapped = null; alias.clear()
        local.handle(PlayerRequest.Stop)
    }

    private fun deactivate(generation: Long) {
        val me = session ?: return
        send(JSONObject().put("op", "deactivate").put("deviceId", me.deviceId).put("generation", generation)) { answered(it) }
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
        val raw = current?.entryId
        val entry = entryOf(current)
        // A song without an entry wasn't handed over by the store; it isn't the shared player's.
        if ((current == null || raw != null) && entry != lastEntry && raw != wrapped) {
            if (raw != null && tracks(state, "history").any { it.entryId == raw }) {
                // Round again on repeat: the store calls this song by a fresh entry, known once it has caught up.
                wrapped = raw
                lastHead = null
                player?.let { if (outbox.none { item -> item.advance != null }) resolveWrap(it) }
                return
            }
            wrapped = null
            val from = lastEntry
            lastEntry = entry
            lastHead = null
            report(advance = advance(from, entry, current?.playerTrack()))
        }
        val volume = state.optInt("volume", lastVolume)
        if (volume != lastVolume) { lastVolume = volume; report(volume = volume) }
        val repeat = Repeat.of(state.optString("repeat")) ?: lastRepeat
        if (repeat != lastRepeat) { lastRepeat = repeat; report(repeat = repeat) }
        if (wrapped == null) sync(state, force = false)
    }

    /** The playhead, reported whenever it moves other than by playing on: play, pause, seek, a new song. */
    private fun sync(state: JSONObject, force: Boolean) {
        if (owned == null || state.optBoolean("waiting")) return
        val entry = entryOf(NativeTrack.parse(state.opt("current")))
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
            if (state.optString("status") == "playing" && wrapped == null) sync(state, force = true)
            startTicker()
        }
    }

    private fun advance(from: String?, to: String?, track: JSONObject?): JSONObject =
        JSONObject().put("from", from ?: JSONObject.NULL).put("to", to ?: JSONObject.NULL).apply { if (to != null && track != null) put("track", track) }

    private fun report(advance: JSONObject? = null, playhead: Head? = null, volume: Int? = null, repeat: Repeat? = null) {
        val own = owned ?: return
        val last = outbox.lastOrNull()
        // A newer position replaces one not yet sent.
        if (playhead != null && advance == null && volume == null && repeat == null && last != null && !last.attempted && last.playheadOnly) {
            last.playhead = playhead
            return
        }
        outbox.addLast(Report(own.generation, ++own.seq, advance, playhead, volume, repeat))
        flush()
    }

    /** Reports go one at a time, in order; one that can't be delivered now goes again unchanged, with the same number. */
    private fun flush() {
        if (sending != null || refused || closed || retry != null) return
        val me = session ?: return
        while (outbox.isNotEmpty() && outbox.first().generation != owned?.generation) outbox.removeFirst()
        val item = outbox.firstOrNull() ?: return
        sending = item
        item.attempted = true
        val body = JSONObject().put("op", "report").put("deviceId", me.deviceId).put("generation", item.generation).put("seq", item.seq)
        item.advance?.let { body.put("advance", it) }
        item.playhead?.let { body.put("playhead", JSONObject().put("entryId", it.entryId ?: JSONObject.NULL).put("positionMs", it.positionMs).put("at", it.at).put("playing", it.playing)) }
        item.volume?.let { body.put("volume", it) }
        item.repeat?.let { body.put("repeat", it.wire) }
        send(body) { reply -> delivered(item, reply) }
    }

    private fun delivered(item: Report, reply: Reply) {
        sending = null
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
        private val random = SecureRandom()

        /** A new entry ID in the store's format (12 base64url characters). */
        fun newEntryId(): String = ByteArray(9).also(random::nextBytes).let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
    }
}
