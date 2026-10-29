package app.vybatron

import app.vybatron.playback.PlayerRequest
import org.json.JSONArray
import org.json.JSONObject

/**
 * The portal's only way into native code: `window.vybatronNative`, which Android
 * creates for the portal origin's top frame and no other page or frame.
 *
 * Each request is `{"id": n, "type": "..."}` and gets one reply,
 * `{"id": n, "ok": true, "result": {...}}` or `{"id": n, "ok": false, "error": "..."}`.
 * Native code also sends events, `{"event": "...", ...}`, with no id.
 * Only named operations exist; there is no general request.
 */
object PortalBridge {
    const val NAME = "vybatronNative"
    val FEATURES = listOf("player.shared")

    data class AppInfo(val version: String, val build: Int)

    /** Carries out a player request and answers with the player's state, or an error code. */
    fun interface Player {
        fun handle(request: PlayerRequest): Result<JSONObject>
    }

    fun respond(message: String?, info: AppInfo, player: Player? = null): String {
        val request = runCatching { JSONObject(message ?: "") }.getOrNull()
            ?: return failure(null, "bad_request")
        val id = request.opt("id")
        val type = request.optString("type")
        if (type == "app.info") {
            // `player.shared`: the playback service keeps its own connection to the shared player and
            // reports for this device (ADR-0018), so the page only shows it and sends edits and controls.
            return success(id, JSONObject().put("platform", "android").put("version", info.version).put("build", info.build)
                .put("features", JSONArray(FEATURES)))
        }
        if (!type.startsWith("player.")) return failure(id, "unknown_type")
        val parsed = PlayerRequest.parse(type, request) ?: return failure(id, "bad_request")
        val handler = player ?: return failure(id, "unavailable")
        return handler.handle(parsed).fold({ success(id, it) }, { failure(id, it.message ?: "failed") })
    }

    fun event(name: String, body: JSONObject): String = JSONObject(body.toString()).put("event", name).toString()

    private fun success(id: Any?, result: JSONObject) =
        JSONObject().put("id", id ?: JSONObject.NULL).put("ok", true).put("result", result).toString()

    private fun failure(id: Any?, error: String) =
        JSONObject().put("id", id ?: JSONObject.NULL).put("ok", false).put("error", error).toString()
}
