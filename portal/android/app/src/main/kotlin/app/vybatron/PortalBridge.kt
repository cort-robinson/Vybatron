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
 * Native code also sends events, `{"event": "...", ...}`, with no id. One event asks the page
 * something: `app.back`, which the page answers with the request `app.back` ([BackRelay]).
 * Only named operations exist; there is no general request.
 */
object PortalBridge {
    const val NAME = "vybatronNative"
    val FEATURES = listOf("player.shared")

    /** [form]: `phone` or `tv`, from [DeviceForm]. */
    data class AppInfo(val version: String, val build: Int, val form: String = DeviceForm.PHONE.form)

    /** Carries out a player request and answers with the player's state, or an error code. */
    fun interface Player {
        fun handle(request: PlayerRequest): Result<JSONObject>
    }

    /** Takes the page's answer to the app's `app.back` event ([BackRelay]). */
    fun interface Back {
        fun answer(back: Int, handled: Boolean)
    }

    fun respond(message: String?, info: AppInfo, player: Player? = null, back: Back? = null): String {
        val request = runCatching { JSONObject(message ?: "") }.getOrNull()
            ?: return failure(null, "bad_request")
        val id = request.opt("id")
        val type = request.optString("type")
        if (type == "app.info") {
            // `player.shared`: the playback service keeps its own connection to the shared player and
            // reports for this device (ADR-0018), so the page only shows it and sends edits and controls.
            // `form`: whether this is a phone or a TV (ADR-0019), which picks the page's layout and device kind.
            return success(id, JSONObject().put("platform", "android").put("version", info.version).put("build", info.build)
                .put("form", info.form)
                .put("features", JSONArray(FEATURES)))
        }
        if (type == "app.back") {
            // The page's answer to the app's Back (ADR-0019): `back` names the question, `handled` says
            // whether the page closed something of its own. A late or unknown answer is still accepted;
            // the app ignores it.
            val number = request.opt("back")
            val handled = request.opt("handled")
            if (number !is Int || handled !is Boolean) return failure(id, "bad_request")
            val relay = back ?: return failure(id, "unavailable")
            relay.answer(number, handled)
            return success(id, JSONObject())
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
