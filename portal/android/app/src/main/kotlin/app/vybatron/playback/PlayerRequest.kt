package app.vybatron.playback

import org.json.JSONArray
import org.json.JSONObject

/** What the portal can ask this device's player to do. Anything else is refused. */
sealed interface PlayerRequest {
    /** Start receiving `player.state` events; answered with the state now. */
    data object Subscribe : PlayerRequest

    /** Replace everything with these songs, starting at `positionMs` in `current`. */
    data class Load(
        val guildId: String,
        val current: NativeTrack?,
        val queue: List<NativeTrack>,
        val history: List<NativeTrack>,
        val positionMs: Long,
        val playing: Boolean,
        val volume: Int,
        val repeat: Repeat,
    ) : PlayerRequest

    /** Replace the waiting songs, if they're still the ones at `revision`. */
    data class SetQueue(val queue: List<NativeTrack>, val revision: Long) : PlayerRequest

    sealed interface Control : PlayerRequest
    data object Play : Control
    data object Pause : Control
    data object Next : Control
    data object Previous : Control
    data object Stop : Control
    data class Seek(val positionMs: Long) : Control
    data class SkipTo(val index: Int) : Control
    data class Volume(val level: Int) : Control
    data class SetRepeat(val repeat: Repeat) : Control

    companion object {
        private val guildPattern = Regex("^\\d{1,20}$")

        fun parse(type: String, request: JSONObject): PlayerRequest? = when (type) {
            "player.subscribe" -> Subscribe
            "player.load" -> load(request)
            "player.setQueue" -> {
                val queue = tracks(request.opt("queue"), DeviceQueue.MAX_QUEUE)
                val revision = request.opt("revision")
                if (queue != null && revision is Number) SetQueue(queue, revision.toLong()) else null
            }
            "player.control" -> control(request)
            else -> null
        }

        private fun load(request: JSONObject): Load? {
            val guildId = request.opt("guildId") as? String ?: return null
            if (!guildPattern.matches(guildId)) return null
            val currentValue = request.opt("current")
            val current = if (currentValue == null || currentValue == JSONObject.NULL) null else NativeTrack.parse(currentValue) ?: return null
            val queue = tracks(request.opt("queue"), DeviceQueue.MAX_QUEUE) ?: return null
            val history = tracks(request.opt("history"), DeviceQueue.MAX_HISTORY) ?: return null
            val position = milliseconds(request.opt("positionMs")) ?: return null
            val playing = request.opt("playing") as? Boolean ?: return null
            val volume = level(request.opt("volume")) ?: return null
            val repeat = Repeat.of(request.opt("repeat") as? String) ?: return null
            return Load(guildId, current, queue, history, position, playing, volume, repeat)
        }

        private fun control(request: JSONObject): Control? = when (request.opt("action")) {
            "play" -> Play
            "pause" -> Pause
            "next" -> Next
            "previous" -> Previous
            "stop" -> Stop
            "seek" -> milliseconds(request.opt("positionMs"))?.let(::Seek)
            "skipTo" -> (request.opt("index") as? Number)?.toDouble()
                ?.takeIf { it == Math.floor(it) && it >= 0 && it < DeviceQueue.MAX_QUEUE }?.let { SkipTo(it.toInt()) }
            "volume" -> level(request.opt("level"))?.let(::Volume)
            "repeat" -> Repeat.of(request.opt("mode") as? String)?.let(::SetRepeat)
            else -> null
        }

        private fun tracks(value: Any?, limit: Int): List<NativeTrack>? {
            val array = value as? JSONArray ?: return null
            if (array.length() > limit) return null
            return (0 until array.length()).map { NativeTrack.parse(array.opt(it)) ?: return null }
        }

        private fun milliseconds(value: Any?): Long? =
            (value as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 && it <= 86_400_000.0 }?.toLong()

        private fun level(value: Any?): Int? =
            (value as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 && it <= 100 }?.toInt()
    }
}
