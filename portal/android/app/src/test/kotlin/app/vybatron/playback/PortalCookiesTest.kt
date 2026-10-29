package app.vybatron.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A session the portal renews during background playback keeps its new lifetime in the WebView (ADR-0019). */
class PortalCookiesTest {
    private val base = "https://portal.example.test"
    private val renewed = "__Host-vybertron_session=abc; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax"

    private class FakeJar : PortalCookies.Jar {
        val set = ArrayList<Pair<String, String>>()
        var flushes = 0
        override fun get(url: String): String? = if (url == "https://portal.example.test/") "__Host-vybertron_session=abc" else null
        override fun set(url: String, value: String) { set.add(url to value) }
        override fun flush() { flushes++ }
    }

    @Test fun aRenewedSessionCookieIsStoredForThePortalOriginAndFlushed() {
        val jar = FakeJar()
        // HttpURLConnection's headerFields: the status line under a null name, names as sent.
        PortalCookies(base, jar).renew(mapOf(null to listOf("HTTP/1.1 200 OK"), "set-cookie" to listOf(renewed), "Content-Type" to listOf("text/event-stream")))
        assertEquals(listOf("$base/" to renewed), jar.set)
        assertEquals(1, jar.flushes)
    }

    @Test fun everySetCookieOfAReplyIsAppliedWhateverItsNameCase() {
        val cleared = "__Host-vybertron_device_sign_in=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"
        assertEquals(listOf(renewed, cleared), PortalCookies.setCookies(mapOf("Set-Cookie" to listOf(renewed), "SET-COOKIE" to listOf(cleared))))
    }

    @Test fun aReplyWithoutCookiesChangesNothingAndDoesNotFlush() {
        val jar = FakeJar()
        val cookies = PortalCookies(base, jar)
        cookies.renew(null)
        cookies.renew(mapOf("Content-Type" to listOf("application/json")))
        cookies.renew(mapOf("Set-Cookie" to listOf("", "  ", "a=b\r\nInjected: yes", "x".repeat(5000))))
        assertTrue(jar.set.isEmpty())
        assertEquals(0, jar.flushes)
    }

    @Test fun requestsSendThePortalCookieOnly() {
        assertEquals("__Host-vybertron_session=abc", PortalCookies(base, FakeJar()).header())
        assertEquals(null, PortalCookies("https://elsewhere.example.test", FakeJar()).header())
    }
}
