package app.vybatron

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Back asks the page first, and falls back to the app's own Back (ADR-0019). */
class BackRelayTest {
    // A clock the test moves by hand: each scheduled task runs when its time comes.
    private var now = 0L
    private val tasks = mutableListOf<Pair<Long, () -> Unit>>()
    private val relay = BackRelay({ ms, task ->
        val entry = (now + ms) to task
        tasks.add(entry)
        ({ tasks.remove(entry) })
    })
    private val sent = mutableListOf<JSONObject>()
    private var fallbacks = 0
    private val fallback: () -> Unit = { fallbacks++ }

    private fun advance(ms: Long) {
        now += ms
        tasks.filter { it.first <= now }.forEach { tasks.remove(it); it.second() }
    }

    @Test fun withNoPageTheAppDoesItsOwnBackAtOnce() {
        relay.press(fallback)
        assertEquals(1, fallbacks)
        assertTrue(tasks.isEmpty())
    }

    @Test fun asksThePageAndStopsWhenItHandledBack() {
        relay.attach { sent.add(JSONObject(it)) }
        relay.press(fallback)
        assertEquals(1, sent.size)
        assertEquals("app.back", sent[0].getString("event"))
        val back = sent[0].getInt("back")
        assertFalse(sent[0].has("id"))
        assertEquals(0, fallbacks)

        assertTrue(relay.answer(back, true))
        assertEquals(0, fallbacks)
        // The timeout was cancelled: nothing happens later.
        advance(BackRelay.TIMEOUT_MS * 2)
        assertEquals(0, fallbacks)
    }

    @Test fun fallsBackWhenThePageHasNothingToClose() {
        relay.attach { sent.add(JSONObject(it)) }
        relay.press(fallback)
        assertTrue(relay.answer(sent[0].getInt("back"), false))
        assertEquals(1, fallbacks)
        advance(BackRelay.TIMEOUT_MS * 2)
        assertEquals(1, fallbacks)
    }

    @Test fun fallsBackWhenThePageDoesNotAnswerInTime() {
        relay.attach { sent.add(JSONObject(it)) }
        relay.press(fallback)
        advance(BackRelay.TIMEOUT_MS - 1)
        assertEquals(0, fallbacks)
        advance(1)
        assertEquals(1, fallbacks)
        // A late answer changes nothing.
        assertFalse(relay.answer(sent[0].getInt("back"), false))
        assertFalse(relay.answer(sent[0].getInt("back"), true))
        assertEquals(1, fallbacks)
    }

    @Test fun oneQuestionAtATimeAndEachHasItsOwnNumber() {
        relay.attach { sent.add(JSONObject(it)) }
        relay.press(fallback)
        // Pressed again while the page decides: dropped.
        relay.press(fallback)
        assertEquals(1, sent.size)
        // An answer to some other question is ignored.
        assertFalse(relay.answer(sent[0].getInt("back") + 1, false))
        assertEquals(0, fallbacks)
        relay.answer(sent[0].getInt("back"), true)

        relay.press(fallback)
        assertEquals(2, sent.size)
        assertTrue(sent[1].getInt("back") != sent[0].getInt("back"))
        relay.answer(sent[1].getInt("back"), false)
        assertEquals(1, fallbacks)
    }

    @Test fun aPageThatCannotBeReachedFallsBack() {
        relay.attach { error("The page is gone") }
        relay.press(fallback)
        assertEquals(1, fallbacks)
        assertTrue(tasks.isEmpty())
        // Once the page is detached (another page loading), Back is the app's at once.
        relay.attach(null)
        relay.press(fallback)
        assertEquals(2, fallbacks)
    }

    @Test fun closingForgetsTheQuestionWithoutActing() {
        relay.attach { sent.add(JSONObject(it)) }
        relay.press(fallback)
        relay.close()
        advance(BackRelay.TIMEOUT_MS * 2)
        assertEquals(0, fallbacks)
        assertFalse(relay.answer(sent[0].getInt("back"), false))
    }
}
