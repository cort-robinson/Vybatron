package app.vybatron.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceQueueTest {
    private val a = song("a"); private val b = song("b"); private val c = song("c"); private val d = song("d")
    private fun ids(list: List<NativeTrack>) = list.map { it.id }
    private fun queue(current: NativeTrack?, vararg waiting: NativeTrack, history: List<NativeTrack> = emptyList(), repeat: Repeat = Repeat.OFF) =
        DeviceQueue().apply { load(current, waiting.toList(), history, repeat) }

    @Test fun endingASongPlaysTheNextAndRemembersIt() {
        val q = queue(a, b, c)
        assertEquals(DeviceQueue.Step.Play(b), q.advance(manual = false))
        assertEquals("b", q.current?.id); assertEquals(listOf("c"), ids(q.queue)); assertEquals(listOf("a"), ids(q.history))
    }

    @Test fun theLastSongEndingStopsAndForgetsEverything() {
        val q = queue(a, history = listOf(b))
        assertEquals(DeviceQueue.Step.Stop, q.advance(manual = false))
        assertNull(q.current); assertTrue(q.queue.isEmpty()); assertTrue(q.history.isEmpty())
    }

    @Test fun repeatTrackRestartsOnEndButSkipMovesOn() {
        val q = queue(a, b, repeat = Repeat.TRACK)
        assertEquals(DeviceQueue.Step.Restart, q.advance(manual = false))
        assertEquals("a", q.current?.id)
        assertEquals(DeviceQueue.Step.Play(b), q.advance(manual = true))
    }

    @Test fun repeatQueueSendsTheSongToTheBackUnlessItCouldntPlay() {
        val q = queue(a, b, repeat = Repeat.QUEUE)
        q.advance(manual = false)
        assertEquals(listOf("a"), ids(q.queue))
        q.advance(manual = true, drop = true)
        assertEquals("a", q.current?.id); assertTrue(q.queue.isEmpty()); assertEquals(listOf("a"), ids(q.history))
    }

    @Test fun backEarlyGoesToThePreviousSongAndKeepsThisOneNext() {
        val q = queue(b, c, history = listOf(a))
        assertEquals(DeviceQueue.Step.Play(a), q.back(positionMs = 2_000))
        assertEquals("a", q.current?.id); assertEquals(listOf("b", "c"), ids(q.queue)); assertTrue(q.history.isEmpty())
    }

    @Test fun backLateOrWithNothingBeforeRestarts() {
        assertEquals(DeviceQueue.Step.Restart, queue(b, history = listOf(a)).back(positionMs = 3_001))
        assertEquals(DeviceQueue.Step.Restart, queue(b).back(positionMs = 0))
        assertEquals(DeviceQueue.Step.None, queue(null).back(positionMs = 0))
    }

    @Test fun skipToDropsTheSongsBeforeIt() {
        val q = queue(a, b, c, d)
        assertEquals(DeviceQueue.Step.Play(c), q.skipTo(1))
        assertEquals(listOf("d"), ids(q.queue)); assertEquals(listOf("a"), ids(q.history))
        assertEquals(DeviceQueue.Step.None, q.skipTo(5))
    }

    @Test fun editsMadeAgainstAnOlderListAreRefused() {
        val q = queue(a, b, c)
        val seen = q.revision
        assertTrue(q.setQueue(listOf(c, b), seen))
        assertEquals(listOf("c", "b"), ids(q.queue))
        q.advance(manual = false)
        assertFalse(q.setQueue(listOf(b), seen + 1))
        assertEquals(listOf("b"), ids(q.queue))
    }

    @Test fun limitsMatchThePortal() {
        val many = (1..600).map { song("s$it") }
        val q = DeviceQueue().apply { load(a, many, many, Repeat.OFF) }
        assertEquals(500, q.queue.size); assertEquals(100, q.history.size)
        val back = DeviceQueue().apply { load(a, many.take(500), listOf(b), Repeat.OFF) }
        back.back(0)
        assertEquals(500, back.queue.size); assertEquals("a", back.queue.first().id)
    }
}
