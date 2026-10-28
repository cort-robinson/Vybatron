package app.vybatron

import java.net.URI

/** Where a top-level navigation goes. Frames inside a page aren't decided here. */
enum class Destination {
    /** The portal itself: the only pages that can reach native code. */
    PORTAL,

    /** Discord's sign-in, which must finish inside this WebView to set the portal's cookie. */
    SIGN_IN,

    /** Any other web or mail link: handed to the phone's browser or mail app. */
    EXTERNAL,

    /** Everything else (`intent:`, `file:`, `javascript:` and the like): ignored. */
    BLOCKED,
}

object NavigationPolicy {
    // Discord's OAuth pages redirect between its login, verification and
    // authorization pages, so the whole host stays here. Pages from it never get
    // the native bridge, which answers the portal origin only.
    private val signInHosts = setOf("discord.com", "www.discord.com")

    fun destination(url: String, portal: PortalOrigin): Destination {
        val uri = runCatching { URI(url) }.getOrNull() ?: return Destination.BLOCKED
        return when (uri.scheme?.lowercase()) {
            "https" -> when {
                portal.matches(url) -> Destination.PORTAL
                uri.host?.lowercase() in signInHosts -> Destination.SIGN_IN
                else -> Destination.EXTERNAL
            }
            "http", "mailto" -> Destination.EXTERNAL
            else -> Destination.BLOCKED
        }
    }
}
