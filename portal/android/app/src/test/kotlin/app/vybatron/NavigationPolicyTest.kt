package app.vybatron

import org.junit.Assert.assertEquals
import org.junit.Test

class NavigationPolicyTest {
    private val portal = PortalOrigin.parse("https://portal.example")!!
    private fun at(url: String) = NavigationPolicy.destination(url, portal)

    @Test fun portalPagesStay() {
        assertEquals(Destination.PORTAL, at("https://portal.example/"))
        assertEquals(Destination.PORTAL, at("https://portal.example/auth/discord/callback?code=x&state=y"))
    }

    @Test fun discordSignInStaysButIsNotThePortal() {
        assertEquals(Destination.SIGN_IN, at("https://discord.com/oauth2/authorize?client_id=1"))
        assertEquals(Destination.SIGN_IN, at("https://discord.com/login?redirect_to=%2Foauth2"))
        assertEquals(Destination.SIGN_IN, at("https://www.discord.com/login"))
        assertEquals(Destination.EXTERNAL, at("http://discord.com/login"))
        assertEquals(Destination.EXTERNAL, at("https://discord.com.evil.test/login"))
        assertEquals(Destination.EXTERNAL, at("https://cdn.discordapp.com/x.png"))
    }

    @Test fun otherLinksLeaveTheApp() {
        assertEquals(Destination.EXTERNAL, at("https://music.youtube.com/watch?v=abc"))
        assertEquals(Destination.EXTERNAL, at("http://portal.example/"))
        assertEquals(Destination.EXTERNAL, at("https://portal.example:8443/"))
        assertEquals(Destination.EXTERNAL, at("mailto:someone@example.com"))
    }

    @Test fun everythingElseIsBlocked() {
        listOf("intent://x#Intent;scheme=https;end", "file:///sdcard/x", "content://x/y", "javascript:alert(1)",
            "data:text/html,hi", "about:blank", "not a url")
            .forEach { assertEquals(it, Destination.BLOCKED, at(it)) }
    }
}
