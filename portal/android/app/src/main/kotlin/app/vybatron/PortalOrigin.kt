package app.vybatron

import java.net.URI

/** The one origin this app trusts: `https://host` or `https://host:port`, nothing else. */
@JvmInline
value class PortalOrigin private constructor(val value: String) {
    val startUrl: String get() = "$value/"

    fun matches(url: String): Boolean = of(url) == value

    companion object {
        /** The origin a build was configured with, or null when it isn't a bare HTTPS origin. */
        fun parse(configured: String): PortalOrigin? {
            val uri = runCatching { URI(configured) }.getOrNull() ?: return null
            val bare = uri.rawPath.isNullOrEmpty() && uri.rawQuery == null && uri.rawFragment == null && uri.rawUserInfo == null
            if (!bare) return null
            return of(configured)?.let(::PortalOrigin)
        }

        /** The origin of an HTTPS URL, lowercased, with the default port left out. */
        internal fun of(url: String): String? {
            val uri = runCatching { URI(url) }.getOrNull() ?: return null
            if (!uri.scheme.equals("https", ignoreCase = true)) return null
            val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
            val port = uri.port.takeIf { it != -1 && it != 443 }
            return if (port == null) "https://$host" else "https://$host:$port"
        }
    }
}
