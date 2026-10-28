package app.vybatron.playback

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import app.vybatron.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import java.lang.reflect.Proxy
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors

/**
 * This device's player: the queue (DeviceQueue) and ExoPlayer, which plays the portal's
 * audio route for one song at a time. It moves on by itself when a song ends, so the
 * music keeps going after the page is gone. Main thread only, except the lookups it
 * hands to its own worker.
 *
 * [base] is the portal origin the audio comes from; [cookies] gives the portal's
 * session cookie, which goes to that origin and nowhere else.
 */
@OptIn(UnstableApi::class)
class DevicePlayer(context: Context, private val base: String, private val cookies: () -> String?) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val songs = DeviceQueue()
    private var guildId: String? = null
    private var volume = 100
    // Each start supersedes the previous one, including its late lookup or retry.
    private var token = 0
    private var resolving = false
    // Where the current song starts once it loads; ExoPlayer's position after that.
    private var pendingStart = 0L
    // A song that failed in a way worth one more try, from where it stopped.
    private val retried = HashSet<String>()
    private val warmed = HashSet<String>()
    private val listeners = LinkedHashSet<(JSONObject) -> Unit>()
    private val notices = LinkedHashSet<(String, String) -> Unit>()

    private val exo: ExoPlayer = ExoPlayer.Builder(context)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
        .setHandleAudioBecomingNoisy(true)
        .setWakeMode(C.WAKE_MODE_NETWORK)
        .setMediaSourceFactory(DefaultMediaSourceFactory(ResolvingDataSource.Factory(http()) { spec ->
            if (sameOrigin(spec.uri.toString())) cookies()?.let { spec.withAdditionalHeaders(mapOf("Cookie" to it)) } ?: spec else spec
        }))
        .build()

    /** What the media session drives: Next and Previous move through this queue, not ExoPlayer's. */
    val player: Player = object : ForwardingPlayer(exo) {
        private val extra = Player.Commands.Builder().addAll(
            Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
        ).build()

        // Repeat, shuffle, volume and speed belong to this queue and the portal's settings; ExoPlayer's own would go unnoticed.
        private val blocked = intArrayOf(Player.COMMAND_SET_REPEAT_MODE, Player.COMMAND_SET_SHUFFLE_MODE, Player.COMMAND_SET_VOLUME,
            Player.COMMAND_SET_SPEED_AND_PITCH)
        private val wrapped = HashMap<Player.Listener, Player.Listener>()

        override fun getAvailableCommands(): Player.Commands =
            super.getAvailableCommands().buildUpon().addAll(extra).removeAll(*blocked).build()

        // ExoPlayer reports its own commands when they change, without Next and Previous, and the
        // session would pass that on to the lock screen. Each listener hears ours instead.
        // (A proxy, because every Listener method is a Java default method, which `by` won't forward.)
        override fun addListener(listener: Player.Listener) {
            val proxy = Proxy.newProxyInstance(Player.Listener::class.java.classLoader, arrayOf(Player.Listener::class.java)) { self, method, args ->
                when {
                    // Removal compares listeners, so the proxy answers for itself.
                    method.declaringClass == Any::class.java -> when (method.name) {
                        "equals" -> self === args?.getOrNull(0)
                        "hashCode" -> System.identityHashCode(self)
                        else -> "Forwarding($listener)"
                    }
                    // Matched by its parameter, which survives R8 renaming; no other callback takes only Commands.
                    method.parameterTypes.contentEquals(arrayOf(Player.Commands::class.java)) -> method.invoke(listener, availableCommands)
                    else -> method.invoke(listener, *(args ?: emptyArray()))
                }
            } as Player.Listener
            wrapped[listener] = proxy
            super.addListener(proxy)
        }

        override fun removeListener(listener: Player.Listener) {
            wrapped.remove(listener)?.let { super.removeListener(it) }
        }
        override fun isCommandAvailable(command: Int) = availableCommands.contains(command)
        override fun hasNextMediaItem() = songs.queue.isNotEmpty() || songs.repeat == Repeat.QUEUE
        override fun hasPreviousMediaItem() = songs.history.isNotEmpty()
        override fun seekToNext() = next()
        override fun seekToNextMediaItem() = next()
        override fun seekToPrevious() = previous()
        override fun seekToPreviousMediaItem() = previous()
        override fun play() { if (songs.current != null) this@DevicePlayer.play() }
        override fun stop() = this@DevicePlayer.stop()
    }

    init {
        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED && songs.current != null) advance(manual = false) else emit()
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isPlaying) warmNext()
                emit()
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = emit()
            override fun onPositionDiscontinuity(old: Player.PositionInfo, new: Player.PositionInfo, reason: Int) = emit()
            override fun onPlayerError(error: PlaybackException) = failed(error)
        })
    }

    fun addListener(listener: (JSONObject) -> Unit) { listeners.add(listener) }
    fun removeListener(listener: (JSONObject) -> Unit) { listeners.remove(listener) }
    fun addNoticeListener(listener: (String, String) -> Unit) { notices.add(listener) }
    fun removeNoticeListener(listener: (String, String) -> Unit) { notices.remove(listener) }

    /** Carries out one of the portal's requests and answers with the state that follows. */
    fun handle(request: PlayerRequest): Result<JSONObject> {
        when (request) {
            // Only the asking page needs the state; a broadcast would reach it before it knows what it's seeing.
            PlayerRequest.Subscribe -> return Result.success(state())
            is PlayerRequest.Load -> load(request)
            is PlayerRequest.SetQueue -> if (!songs.setQueue(request.queue, request.revision)) return Result.failure(IllegalStateException("stale"))
            PlayerRequest.Play -> play()
            PlayerRequest.Pause -> exo.pause()
            PlayerRequest.Next -> next()
            PlayerRequest.Previous -> previous()
            PlayerRequest.Stop -> stop()
            is PlayerRequest.Seek -> seek(request.positionMs)
            is PlayerRequest.SkipTo -> {
                if (request.revision != songs.revision) return Result.failure(IllegalStateException("stale"))
                step(songs.skipTo(request.index), autoplay = true)
            }
            is PlayerRequest.Volume -> { volume = request.level; exo.volume = volume / 100f }
            is PlayerRequest.SetRepeat -> songs.repeat = request.repeat
        }
        emit()
        return Result.success(state())
    }

    fun state(): JSONObject {
        val current = songs.current
        val loaded = current != null && exo.currentMediaItem?.mediaId == current.id
        val status = when {
            current == null -> "idle"
            exo.playWhenReady -> "playing"
            else -> "paused"
        }
        val duration = if (loaded && exo.duration != C.TIME_UNSET) exo.duration else current?.durationMs ?: 0
        return JSONObject()
            .put("revision", songs.revision)
            .put("current", current?.raw ?: JSONObject.NULL)
            .put("queue", JSONArray(songs.queue.map { it.raw }))
            .put("history", JSONArray(songs.history.map { it.raw }))
            .put("status", status)
            .put("positionMs", if (loaded) exo.currentPosition.coerceAtLeast(0) else pendingStart)
            .put("at", System.currentTimeMillis())
            .put("waiting", status == "playing" && (resolving || !loaded || exo.playbackState == Player.STATE_BUFFERING))
            .put("durationMs", duration)
            .put("volume", volume)
            .put("repeat", songs.repeat.wire)
    }

    fun release() {
        token++
        worker.shutdownNow()
        exo.release()
        listeners.clear()
        notices.clear()
    }

    val isPlaying: Boolean get() = exo.playWhenReady && songs.current != null

    private fun load(request: PlayerRequest.Load) {
        guildId = request.guildId
        volume = request.volume
        exo.volume = volume / 100f
        songs.load(request.current?.own(), request.queue.map { it.own() }, request.history, request.repeat)
        retried.clear()
        val current = songs.current
        if (current == null) { halt(); return }
        start(current, request.positionMs, request.playing)
    }

    private fun play() {
        val current = songs.current ?: return
        if (exo.currentMediaItem?.mediaId == current.id && exo.playbackState != Player.STATE_IDLE) exo.play()
        else start(current, pendingStart, autoplay = true)
    }

    private fun seek(positionMs: Long) {
        val current = songs.current ?: return
        if (exo.currentMediaItem?.mediaId == current.id) exo.seekTo(positionMs)
        else start(current, positionMs, exo.playWhenReady)
    }

    private fun next() { if (songs.current != null) advance(manual = true) }

    private fun previous() {
        val position = if (songs.current != null && exo.currentMediaItem?.mediaId == songs.current?.id) exo.currentPosition else pendingStart
        when (val step = songs.back(position)) {
            // Restarting keeps a paused song paused, as in the portal's own player.
            DeviceQueue.Step.Restart -> exo.seekTo(0)
            else -> step(step, autoplay = true)
        }
        emit()
    }

    private fun stop() {
        songs.clear()
        halt()
        emit()
    }

    private fun advance(manual: Boolean, drop: Boolean = false) {
        step(songs.advance(manual, drop), autoplay = true)
        emit()
    }

    private fun step(step: DeviceQueue.Step, autoplay: Boolean) {
        when (step) {
            is DeviceQueue.Step.Play -> start(step.track, 0, autoplay)
            DeviceQueue.Step.Restart -> { exo.seekTo(0); exo.play() }
            DeviceQueue.Step.Stop -> halt()
            DeviceQueue.Step.None -> Unit
        }
    }

    private fun halt() {
        token++
        resolving = false
        pendingStart = 0
        exo.stop()
        exo.clearMediaItems()
    }

    /** Plays [track] from [startMs]; a song from another catalog plays through its closest YouTube match. */
    /**
     * Plays [track] from [startMs] if [autoplay]. Whether to play is kept in ExoPlayer's
     * playWhenReady from here on, so a Pause during a lookup or before a retry still holds.
     */
    private fun start(track: NativeTrack, startMs: Long, autoplay: Boolean) {
        val ticket = ++token
        pendingStart = startMs
        exo.playWhenReady = autoplay
        val videoId = track.videoId
        if (videoId != null) { resolving = false; prepare(track, videoId, startMs); return }
        resolving = true
        exo.stop()
        exo.clearMediaItems()
        val guild = guildId ?: return
        val query = "${track.author} ${track.title}"
        worker.execute {
            val match = runCatching { search(guild, query) }
            main.post {
                if (ticket != token) return@post
                resolving = false
                match.fold({ resolved ->
                    if (resolved == null) {
                        notice("“${track.title}” has no version this device can play. Skipping it.", "error")
                        advance(manual = true, drop = true)
                    } else {
                        songs.resolve(resolved)
                        prepare(resolved, resolved.videoId!!, startMs)
                        emit()
                    }
                }, {
                    exo.pause()
                    notice("Couldn’t find a version of “${track.title}” to play. Check your connection and try again.", "error")
                    emit()
                })
            }
        }
        emit()
    }

    private fun prepare(track: NativeTrack, videoId: String, startMs: Long) {
        val artwork = track.artworkUrl?.takeIf { it.startsWith("https://") || it.startsWith("http://") }
        val item = MediaItem.Builder()
            .setMediaId(track.id)
            .setUri(audioUrl(videoId))
            .setMediaMetadata(MediaMetadata.Builder()
                .setTitle(track.title).setArtist(track.author).setAlbumTitle("Vybatron")
                .setArtworkUri(artwork?.let(Uri::parse))
                .setDurationMs(track.durationMs.takeIf { it > 0 })
                .build())
            .build()
        exo.setMediaItem(item, startMs)
        exo.prepare()
    }

    /** Media errors carry the portal's answer: busy or briefly unreachable gets one quiet retry. */
    private fun failed(error: PlaybackException) {
        val current = songs.current ?: return
        var cause: Throwable? = error
        while (cause != null && cause !is HttpDataSource.InvalidResponseCodeException) cause = cause.cause
        val response = cause as? HttpDataSource.InvalidResponseCodeException
        val status = response?.responseCode ?: 0
        val key = current.videoId ?: current.id
        if (status in setOf(0, 206, 429, 503) && key !in retried) {
            retried.add(key)
            val ticket = token
            val position = exo.currentPosition.coerceAtLeast(0)
            main.postDelayed({ if (ticket == token && songs.current === current) start(current, position, exo.playWhenReady) }, 1_500)
            return
        }
        val message = response?.responseBody?.let { body ->
            runCatching { JSONObject(String(body)).getJSONObject("error").getString("message") }.getOrNull()
        } ?: "This song couldn’t load on this device."
        notice("“${current.title}”: $message Skipping it.", "error")
        advance(manual = true, drop = true)
    }

    /** The next song downloads into the bot's cache while this one plays, so the change is quick. */
    private fun warmNext() {
        val videoId = songs.queue.firstOrNull()?.videoId ?: return
        if (!warmed.add(videoId)) return
        val url = audioUrl(videoId)
        worker.execute {
            runCatching {
                val connection = open(url)
                connection.setRequestProperty("Range", "bytes=0-0")
                connection.inputStream.use { it.read() }
                connection.disconnect()
            }.onFailure { main.post { warmed.remove(videoId) } }
        }
    }

    private fun search(guild: String, query: String): NativeTrack? {
        val connection = open("$base/api/guilds/$guild/search?query=${URLEncoder.encode(query, "UTF-8")}")
        try {
            if (connection.responseCode != 200) error("search answered ${connection.responseCode}")
            val tracks = JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).getJSONArray("tracks")
            return (0 until tracks.length()).firstNotNullOfOrNull { index ->
                NativeTrack.parse(tracks.opt(index))?.takeIf { it.videoId != null }?.own()
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun open(url: String): HttpURLConnection {
        check(sameOrigin(url)) { "Only the portal is asked" }
        return (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 15_000
            instanceFollowRedirects = false
            setRequestProperty("User-Agent", USER_AGENT)
            cookies()?.let { setRequestProperty("Cookie", it) }
        }
    }

    private fun audioUrl(videoId: String) = "$base/api/guilds/$guildId/audio/$videoId"

    private fun sameOrigin(url: String): Boolean {
        val target = runCatching { URI(url) }.getOrNull() ?: return false
        val origin = URI(base)
        return target.scheme.equals(origin.scheme, true) && target.host.equals(origin.host, true) && target.port == origin.port
    }

    private fun http(): HttpDataSource.Factory = DefaultHttpDataSource.Factory()
        .setUserAgent(USER_AGENT)
        .setConnectTimeoutMs(15_000)
        .setReadTimeoutMs(30_000)
        .setAllowCrossProtocolRedirects(false)

    private fun notice(message: String, kind: String) = notices.toList().forEach { it(message, kind) }

    private fun emit() {
        if (listeners.isEmpty()) return
        val state = state()
        listeners.toList().forEach { it(state) }
    }

    companion object {
        private val USER_AGENT = "Vybatron-Android/${BuildConfig.VERSION_NAME}"
    }
}
