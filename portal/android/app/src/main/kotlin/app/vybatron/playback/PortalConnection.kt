package app.vybatron.playback

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * The playback service's requests to the portal, for [PlayerLink]: the listener stream on
 * a thread of its own, and player requests one at a time on another. Everything goes to
 * the portal origin [base] only, with the WebView's session cookie for it (as audio
 * does), and every POST carries the portal as `Origin` and the session's CSRF token.
 * A renewed session's cookie from any of these replies goes back to the WebView.
 * Callbacks arrive on the main thread.
 */
class PortalConnection(private val base: String, private val cookies: PortalCookies, private val userAgent: String) : PlayerLink.Net {
    private val main = Handler(Looper.getMainLooper())
    private val posts = Executors.newSingleThreadExecutor()
    // Each stream supersedes the one before; a superseded stream's events and end are dropped.
    @Volatile private var stream = 0
    private var reader: Thread? = null
    @Volatile private var open: HttpURLConnection? = null
    // How far the portal's clock is ahead of this device's, from the shortest round trip.
    @Volatile private var offset = 0L

    lateinit var link: PlayerLink

    fun serverNow(): Long = System.currentTimeMillis() + offset

    override fun open(query: String) {
        val ticket = closeStream()
        val thread = Thread({ read(ticket, "$base/api/me/events?$query") }, "vybatron-listener")
        thread.isDaemon = true
        reader = thread
        thread.start()
    }

    override fun close() {
        closeStream()
    }

    fun release() {
        closeStream()
        posts.shutdownNow()
    }

    private fun closeStream(): Int {
        val ticket = ++stream
        open?.disconnect()
        open = null
        reader?.interrupt()
        reader = null
        return ticket
    }

    private fun read(ticket: Int, url: String) {
        var status: Int? = null
        try {
            syncClock()
            if (ticket != stream) return
            val connection = connect(url).apply {
                readTimeout = STREAM_READ_TIMEOUT_MS
                setRequestProperty("Accept", "text/event-stream")
            }
            open = connection
            if (ticket != stream) { connection.disconnect(); return }
            val code = connection.responseCode
            cookies.renew(connection.headerFields)
            if (code != 200) { status = code; connection.disconnect(); return }
            val parser = EventStreamParser()
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { lines ->
                while (ticket == stream) {
                    val line = lines.readLine() ?: break
                    val event = parser.line(line) ?: continue
                    main.post { if (ticket == stream) link.onEvent(event.name, event.data) }
                }
            }
        } catch (_: IOException) {
            // Offline, timed out without a heartbeat, or closed by a newer stream.
        } catch (_: InterruptedException) {
        } finally {
            val code = status
            main.post { if (ticket == stream) { open = null; link.onEnded(code) } }
        }
    }

    override fun post(csrfToken: String, body: JSONObject, done: (PlayerLink.Reply) -> Unit) {
        val text = body.toString()
        runCatching {
            posts.execute {
                val reply = runCatching {
                    val connection = connect("$base/api/me/player").apply {
                        requestMethod = "POST"
                        doOutput = true
                        setRequestProperty("Content-Type", "application/json")
                        setRequestProperty("Origin", base)
                        setRequestProperty("X-CSRF-Token", csrfToken)
                    }
                    try {
                        connection.outputStream.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                        val code = connection.responseCode
                        cookies.renew(connection.headerFields)
                        val stream = if (code >= 400) connection.errorStream else connection.inputStream
                        val answer = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
                        PlayerLink.Reply.Answer(code, answer?.let { runCatching { JSONObject(it) }.getOrNull() })
                    } finally {
                        connection.disconnect()
                    }
                }.getOrElse { PlayerLink.Reply.Unreachable }
                main.post { done(reply) }
            }
        }.onFailure { main.post { done(PlayerLink.Reply.Unreachable) } }
    }

    /** The portal's clock, from a few round trips; the shortest one wins. */
    private fun syncClock() {
        var best: Pair<Long, Long>? = null
        repeat(3) {
            runCatching {
                val sent = System.currentTimeMillis()
                val connection = connect("$base/api/me/time")
                try {
                    val code = connection.responseCode
                    cookies.renew(connection.headerFields)
                    if (code != 200) return@runCatching
                    val now = JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).getLong("now")
                    val rtt = System.currentTimeMillis() - sent
                    if (best == null || rtt < best!!.first) best = rtt to now - (sent + rtt / 2)
                } finally {
                    connection.disconnect()
                }
            }
        }
        best?.let { offset = it.second }
    }

    private fun connect(url: String): HttpURLConnection {
        check(url.startsWith("$base/")) { "Only the portal is asked" }
        return (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 15_000
            instanceFollowRedirects = false
            useCaches = false
            setRequestProperty("User-Agent", userAgent)
            // Uncompressed, so each event arrives as soon as it is sent.
            setRequestProperty("Accept-Encoding", "identity")
            cookies.header()?.let { setRequestProperty("Cookie", it) }
        }
    }

    companion object {
        // The portal sends a heartbeat every 10 s; three missed ones mean the stream is gone.
        private const val STREAM_READ_TIMEOUT_MS = 30_000
    }
}
