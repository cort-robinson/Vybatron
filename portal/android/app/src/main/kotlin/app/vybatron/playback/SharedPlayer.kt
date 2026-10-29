package app.vybatron.playback

import org.json.JSONArray
import org.json.JSONObject

/** What the page hands the playback service so it can reach the shared player by itself (ADR-0018). */
data class LinkSession(val csrfToken: String, val deviceId: String, val name: String, val guildId: String?)

/** One of the shared player's songs: the store's entry ID and the song. */
data class Entry(val entryId: String, val track: JSONObject) {
    /** The song as this device's queue holds it, carrying its entry. */
    fun native(): NativeTrack? = NativeTrack.parse(JSONObject(track.toString()).put("entryId", entryId).put("requestedBy", JSONObject.NULL))
}

/**
 * The listener's shared player as the portal sends it (`Player` in docs/portal-contract.md),
 * reduced to what this device needs to play it and report.
 */
data class SharedPlayer(
    val guildId: String?,
    val revision: Long,
    val generation: Long,
    val activeDeviceId: String?,
    val current: Entry?,
    val queue: List<Entry>,
    val history: List<Entry>,
    val positionMs: Long,
    val at: Long,
    val playing: Boolean,
    val volume: Int,
    val repeat: Repeat,
    val updatedAt: Long,
) {
    /** Where the playhead is at server time [now], as the page's `playheadAt` works it out. */
    fun positionAt(now: Long): Long {
        val moved = if (playing && activeDeviceId != null) positionMs + (now - at).coerceAtLeast(0) else positionMs
        val duration = current?.track?.optLong("durationMs") ?: 0
        return (if (duration > 0) minOf(moved, duration) else moved).coerceIn(0, MAX_POSITION)
    }

    companion object {
        const val MAX_POSITION = 86_400_000L
        private val entryPattern = Regex("^[A-Za-z0-9_-]{12}$")
        private val guildPattern = Regex("^\\d{1,20}$")

        fun parse(value: Any?): SharedPlayer? {
            val player = value as? JSONObject ?: return null
            val playhead = player.opt("playhead") as? JSONObject ?: return null
            val current = player.opt("current").let { if (it == null || it == JSONObject.NULL) null else entry(it) ?: return null }
            return SharedPlayer(
                guildId = (player.opt("guildId") as? String)?.takeIf { guildPattern.matches(it) },
                revision = count(player.opt("revision")) ?: return null,
                generation = count(player.opt("generation")) ?: return null,
                activeDeviceId = player.opt("activeDeviceId") as? String,
                current = current,
                queue = entries(player.opt("queue"), DeviceQueue.MAX_QUEUE) ?: return null,
                history = entries(player.opt("history"), DeviceQueue.MAX_HISTORY) ?: return null,
                positionMs = count(playhead.opt("positionMs"))?.coerceAtMost(MAX_POSITION) ?: return null,
                at = count(playhead.opt("at")) ?: return null,
                playing = playhead.opt("playing") as? Boolean ?: return null,
                volume = (count(player.opt("volume")) ?: 100).toInt().coerceIn(0, 100),
                repeat = Repeat.of(player.opt("repeat") as? String) ?: Repeat.OFF,
                updatedAt = count(player.opt("updatedAt")) ?: return null,
            )
        }

        private fun count(value: Any?): Long? =
            (value as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 && it == Math.floor(it) && it <= 9.007199254740991E15 }?.toLong()

        private fun entry(value: Any?): Entry? {
            val entry = value as? JSONObject ?: return null
            val id = entry.opt("entryId") as? String ?: return null
            val track = entry.opt("track") as? JSONObject ?: return null
            if (!entryPattern.matches(id) || NativeTrack.parse(track) == null) return null
            return Entry(id, track)
        }

        private fun entries(value: Any?, limit: Int): List<Entry>? {
            val array = value as? JSONArray ?: return null
            return (0 until minOf(array.length(), limit)).map { entry(array.opt(it)) ?: return null }
        }
    }
}

/** A control the portal relays to this device while it plays (`event:command`). */
data class RelayedCommand(val request: PlayerRequest.Control, val generation: Long) {
    companion object {
        fun parse(data: String): RelayedCommand? {
            val command = runCatching { JSONObject(data) }.getOrNull() ?: return null
            val generation = (command.opt("generation") as? Number)?.toLong() ?: return null
            val value = command.opt("value")
            val request: PlayerRequest.Control = when (command.opt("action")) {
                "play" -> PlayerRequest.Play
                "pause" -> PlayerRequest.Pause
                "next" -> PlayerRequest.Next
                "previous" -> PlayerRequest.Previous
                "seek" -> (value as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 && it <= SharedPlayer.MAX_POSITION }
                    ?.let { PlayerRequest.Seek(it.toLong()) } ?: return null
                "volume" -> (value as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 && it <= 100 }
                    ?.let { PlayerRequest.Volume(it.toInt()) } ?: return null
                "repeat" -> Repeat.of(value as? String)?.let(PlayerRequest::SetRepeat) ?: return null
                else -> return null
            }
            return RelayedCommand(request, generation)
        }
    }
}

/** Server-sent events, one line at a time (the format of the portal's streams). */
class EventStreamParser(private val maxChars: Int = 4 * 1024 * 1024) {
    data class Event(val name: String, val data: String)

    private var name = ""
    private val data = StringBuilder()
    private var hasData = false
    private var tooLong = false

    /** Reads one line, without its line ending; the blank line that ends an event returns it. */
    fun line(line: String): Event? {
        if (line.isEmpty()) {
            val event = if (hasData && !tooLong) Event(name.ifEmpty { "message" }, data.toString()) else null
            name = ""; data.setLength(0); hasData = false; tooLong = false
            return event
        }
        // A comment: heartbeats and the greeting.
        if (line.startsWith(":")) return null
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.substring(0, colon)
        val value = if (colon < 0) "" else line.substring(colon + 1).removePrefix(" ")
        when (field) {
            "event" -> name = value
            "data" -> {
                if (hasData) data.append('\n')
                data.append(value)
                hasData = true
                // An event too large to hold is dropped whole; the next one replaces it.
                if (data.length > maxChars) { tooLong = true; data.setLength(0) }
            }
        }
        return null
    }
}
