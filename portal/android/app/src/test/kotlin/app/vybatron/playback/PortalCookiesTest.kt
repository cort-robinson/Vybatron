package app.vybatron.playback

import com.sun.net.httpserver.HttpServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.URL

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

    // An audio request the player gave up on (404, 503) carries its headers in the error.
    @Test fun aFailedAudioResponseFromThePortalStillRenewsTheCookie() {
        val jar = FakeJar()
        val cookies = PortalCookies(base, jar)
        val failed = mapOf(null to listOf("HTTP/1.1 503 Service Unavailable"), "Set-Cookie" to listOf(renewed))
        cookies.renewFrom("$base/api/guilds/1/audio/aaaaaaaaaaa", failed)
        assertEquals(listOf("$base/" to renewed), jar.set)
        // Never from anywhere else, by host, scheme or port.
        for (other in listOf("https://evil.example.test/x", "http://portal.example.test/x", "https://portal.example.test:8443/x", "not a url")) cookies.renewFrom(other, failed)
        assertEquals(1, jar.set.size)
    }

    // The warm-up asks for one byte of the next song; its answer can be the day's renewal, even an error.
    @Test fun aWarmUpSavesTheRenewedCookieWhateverThePortalAnswers() {
        for ((status, accepted) in listOf(206 to true, 503 to false, 404 to false)) {
            val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
            server.createContext("/") { exchange ->
                exchange.responseHeaders.add("Set-Cookie", renewed)
                val body = if (status == 206) byteArrayOf(1) else "{}".toByteArray()
                exchange.sendResponseHeaders(status, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            }
            server.start()
            try {
                val origin = "http://127.0.0.1:${server.address.port}"
                val jar = FakeJar()
                val connection = URL("$origin/api/guilds/1/audio/aaaaaaaaaaa").openConnection() as HttpURLConnection
                assertEquals(accepted, warmUp(connection, PortalCookies(origin, jar)))
                assertEquals("status $status", listOf("$origin/" to renewed), jar.set)
                assertEquals(1, jar.flushes)
            } finally {
                server.stop(0)
            }
        }
    }
}
