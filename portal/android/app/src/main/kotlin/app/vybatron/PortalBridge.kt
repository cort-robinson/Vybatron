package app.vybatron

import org.json.JSONObject

/**
 * The portal's only way into native code: `window.vybatronNative`, which Android
 * creates for the portal origin's top frame and no other page or frame.
 *
 * Each request is `{"id": n, "type": "..."}` and gets one reply,
 * `{"id": n, "ok": true, "result": {...}}` or `{"id": n, "ok": false, "error": "..."}`.
 * Only named operations exist; there is no general request.
 */
object PortalBridge {
    const val NAME = "vybatronNative"

    data class AppInfo(val version: String, val build: Int)

    fun respond(message: String?, info: AppInfo): String {
        val request = runCatching { JSONObject(message ?: "") }.getOrNull()
            ?: return failure(null, "bad_request")
        val id = request.opt("id")
        return when (request.optString("type")) {
            "app.info" -> JSONObject()
                .put("id", id)
                .put("ok", true)
                .put("result", JSONObject().put("platform", "android").put("version", info.version).put("build", info.build))
                .toString()
            else -> failure(id, "unknown_type")
        }
    }

    private fun failure(id: Any?, error: String) =
        JSONObject().put("id", id ?: JSONObject.NULL).put("ok", false).put("error", error).toString()
}
