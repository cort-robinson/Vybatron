package app.vybatron.playback

import java.net.HttpURLConnection
import java.net.URI

/**
 * The WebView's cookies for the portal, as the app's own requests (the playback service's
 * connection and its audio) use them. The portal renews a session on use and sends its
 * cookie again with the new lifetime (ADR-0019); [renew] stores what a portal response set,
 * for the portal origin [base] only, so the WebView's cookie keeps the session's expiry.
 */
class PortalCookies(private val base: String, private val jar: Jar) {
    /** The WebView's CookieManager, or a stand-in in tests. */
    interface Jar {
        fun get(url: String): String?
        fun set(url: String, value: String)
        fun flush()
    }

    fun header(): String? = jar.get("$base/")

    /** Applies a portal response's `Set-Cookie` headers. Only call it with the portal's responses. */
    fun renew(headers: Map<out String?, List<String>>?) {
        val values = setCookies(headers)
        if (values.isEmpty()) return
        values.forEach { jar.set("$base/", it) }
        jar.flush()
    }

    /** Applies the `Set-Cookie` headers of a response from [url], if [url] is on the portal origin. */
    fun renewFrom(url: String, headers: Map<out String?, List<String>>?) {
        if (sameOrigin(url)) renew(headers)
    }

    private fun sameOrigin(url: String): Boolean {
        val target = runCatching { URI(url) }.getOrNull() ?: return false
        val origin = URI(base)
        return target.scheme.equals(origin.scheme, true) && target.host.equals(origin.host, true) && target.port == origin.port
    }

    companion object {
        /** The `Set-Cookie` values of a response, by any header-name case, without empty or multi-line ones. */
        fun setCookies(headers: Map<out String?, List<String>>?): List<String> =
            headers.orEmpty().entries
                .filter { (name, _) -> name.equals("Set-Cookie", ignoreCase = true) }
                .flatMap { it.value }
                .filter { value -> value.isNotBlank() && value.length <= MAX_LENGTH && value.none { it == '\r' || it == '\n' || it == '\u0000' } }

        private const val MAX_LENGTH = 4096
    }
}

/**
 * Asks the portal for the first byte of a song, so the bot starts fetching it. Any answer,
 * an error too, can carry a renewed session cookie. Returns whether the portal accepted it.
 */
internal fun warmUp(connection: HttpURLConnection, cookies: PortalCookies): Boolean {
    try {
        connection.setRequestProperty("Range", "bytes=0-0")
        val code = connection.responseCode
        cookies.renew(connection.headerFields)
        if (code >= 400) return false
        connection.inputStream.use { it.read() }
        return true
    } catch (_: java.io.IOException) {
        return false
    } finally {
        connection.disconnect()
    }
}
