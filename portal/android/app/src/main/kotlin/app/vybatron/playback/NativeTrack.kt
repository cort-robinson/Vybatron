package app.vybatron.playback

import org.json.JSONObject
import java.net.URI

/**
 * A song as the portal describes it (`Track` in portal/web/src/types.ts). The original
 * object travels back to the page unchanged; only what playback needs is read from it.
 */
class NativeTrack private constructor(val raw: JSONObject) {
    val id: String = raw.getString("id")
    val title: String = raw.getString("title")
    val author: String = raw.optString("author")
    val uri: String? = raw.optString("uri").takeIf { raw.opt("uri") is String && it.isNotEmpty() }
    val durationMs: Long = raw.optLong("durationMs").coerceAtLeast(0)
    val artworkUrl: String? = raw.optString("artworkUrl").takeIf { raw.opt("artworkUrl") is String && it.isNotEmpty() }
    /** The shared player's entry this song is (ADR-0018), when the store handed it over. */
    val entryId: String? = (raw.opt("entryId") as? String)?.takeIf { ENTRY.matches(it) }

    /** The YouTube video whose audio this device can play, if the song names one. */
    val videoId: String? get() = youtubeId(uri)

    /** Songs on this device are the listener's own: no requester, no autoplay provenance. */
    fun own(): NativeTrack = NativeTrack(JSONObject(raw.toString()).apply { put("requestedBy", JSONObject.NULL); remove("suggested") })

    /** The same song as the store's entry [id] (a match found for it keeps its place). */
    fun withEntry(id: String?): NativeTrack = NativeTrack(JSONObject(raw.toString()).apply { if (id == null) remove("entryId") else put("entryId", id) })

    /** The song as the shared player keeps it (`PlayerTrack`): no requester, autoplay mark or entry. */
    fun playerTrack(): JSONObject = JSONObject().also { track -> PLAYER_FIELDS.forEach { key -> if (raw.has(key)) track.put(key, raw.get(key)) } }

    companion object {
        fun parse(value: Any?): NativeTrack? {
            val obj = value as? JSONObject ?: return null
            val id = obj.opt("id"); val title = obj.opt("title")
            if (id !is String || id.isEmpty() || id.length > 200 || title !is String) return null
            return NativeTrack(JSONObject(obj.toString()))
        }

        private val videoPattern = Regex("^[\\w-]{11}$")
        private val ENTRY = Regex("^[A-Za-z0-9_-]{12}$")
        private val PLAYER_FIELDS = listOf("id", "title", "author", "uri", "source", "durationMs", "artworkUrl", "isStream")

        /** The same rule as portal/web/src/youtube.ts. */
        fun youtubeId(uri: String?): String? {
            if (uri.isNullOrEmpty()) return null
            val url = runCatching { URI(uri) }.getOrNull() ?: return null
            val host = url.host?.lowercase()?.replace(Regex("^(www|m|music)\\."), "") ?: return null
            val id = when {
                host == "youtube.com" && url.rawPath == "/watch" -> url.rawQuery?.split('&')
                    ?.firstOrNull { it.startsWith("v=") }?.removePrefix("v=")
                host == "youtu.be" -> url.rawPath?.removePrefix("/")
                else -> null
            }
            return id?.takeIf { videoPattern.matches(it) }
        }
    }
}
