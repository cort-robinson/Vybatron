package app.vybatron.playback

/** Repeat as the portal names it. */
enum class Repeat(val wire: String) {
    OFF("off"), TRACK("track"), QUEUE("queue");

    companion object {
        fun of(wire: String?): Repeat? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * This device's songs: the one playing, those waiting, and those already played (for
 * Back). The same rules as the portal's own device player (portal/web/src/playback.ts),
 * kept here so the queue moves on with the screen off and the app closed.
 */
class DeviceQueue {
    var current: NativeTrack? = null; private set
    var queue: List<NativeTrack> = emptyList(); private set
    var history: List<NativeTrack> = emptyList(); private set
    var repeat: Repeat = Repeat.OFF

    /** Bumped by every change to the songs, so an edit made against an older list is refused. */
    var revision: Long = 0; private set

    sealed interface Step {
        /** Play this song from the start. */
        data class Play(val track: NativeTrack) : Step
        /** Start the current song again. */
        data object Restart : Step
        /** Nothing is left: playback ends. */
        data object Stop : Step
        /** Nothing to do. */
        data object None : Step
    }

    fun load(current: NativeTrack?, queue: List<NativeTrack>, history: List<NativeTrack>, repeat: Repeat) {
        this.current = current
        this.queue = queue.take(MAX_QUEUE)
        this.history = history.take(MAX_HISTORY)
        this.repeat = repeat
        changed()
    }

    /** Replaces the waiting songs, unless they changed since the page last saw them. */
    fun setQueue(queue: List<NativeTrack>, basedOn: Long): Boolean {
        if (basedOn != revision) return false
        this.queue = queue.take(MAX_QUEUE)
        changed()
        return true
    }

    /** A song that had no YouTube video replaced by its closest match. */
    fun resolve(track: NativeTrack) {
        current = track
        changed()
    }

    /**
     * Moves on from the current song: when it ends (`manual` false) or on Skip.
     * `drop` retires a song that can't play, so repeat never retries it forever.
     */
    fun advance(manual: Boolean, drop: Boolean = false): Step {
        val playing = current
        if (!manual && repeat == Repeat.TRACK && playing != null) return Step.Restart
        val waiting = queue.toMutableList()
        if (repeat == Repeat.QUEUE && playing != null && !drop) waiting.add(playing)
        val next = waiting.removeFirstOrNull() ?: run { clear(); return Step.Stop }
        history = remember(drop)
        current = next
        queue = waiting
        changed()
        return Step.Play(next)
    }

    /** Early in a song Back goes to the previous one; later it restarts this one. */
    fun back(positionMs: Long): Step {
        val previous = history.firstOrNull()
        val playing = current
        if (previous == null || (playing != null && positionMs > RESTART_AFTER_MS)) return if (playing != null) Step.Restart else Step.None
        // The current song waits at the front of the queue, so Skip returns to it.
        queue = if (playing != null) (listOf(playing) + queue).take(MAX_QUEUE) else queue
        history = history.drop(1)
        current = previous
        changed()
        return Step.Play(previous)
    }

    /** Jumps to a waiting song (0-based); the ones before it are dropped. */
    fun skipTo(index: Int): Step {
        if (index !in queue.indices) return Step.None
        val next = queue[index]
        history = remember(false)
        current = next
        queue = queue.drop(index + 1)
        changed()
        return Step.Play(next)
    }

    fun clear() {
        current = null
        queue = emptyList()
        history = emptyList()
        changed()
    }

    private fun remember(drop: Boolean): List<NativeTrack> {
        val playing = current
        return if (playing != null && !drop) (listOf(playing) + history).take(MAX_HISTORY) else history
    }

    private fun changed() { revision++ }

    companion object {
        const val MAX_QUEUE = 500
        const val MAX_HISTORY = 100
        const val RESTART_AFTER_MS = 3_000L
    }
}
