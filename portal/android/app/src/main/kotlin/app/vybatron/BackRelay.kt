package app.vybatron

import org.json.JSONObject

/**
 * Back asks the page first (ADR-0019). The app knows the WebView's history and a few player layers,
 * not every menu and dialog, so on Back it sends the page the event `app.back` (`{"event": "app.back",
 * "back": n}`) and the page answers with the request `app.back` (`{"back": n, "handled": true|false}`).
 * When the page handled it, that's all. When it didn't, doesn't answer within [timeoutMs], or there
 * is no portal page to ask, the app does its own Back ([press]'s `fallback`).
 *
 * One question at a time: Back pressed again while the page is still deciding is dropped. All of it
 * runs on the main thread; [schedule] runs a task after a delay and returns how to cancel it.
 */
class BackRelay(
    private val schedule: (Long, () -> Unit) -> () -> Unit,
    private val timeoutMs: Long = TIMEOUT_MS,
) {
    private class Question(val back: Int, val fallback: () -> Unit, val cancel: () -> Unit)

    private var page: ((String) -> Unit)? = null
    private var next = 1
    private var waiting: Question? = null

    /** The portal page that can answer, or null while there is none (another page is loading). */
    fun attach(send: ((String) -> Unit)?) {
        page = send
    }

    fun press(fallback: () -> Unit) {
        if (waiting != null) return
        val send = page ?: return fallback()
        val back = next++
        waiting = Question(back, fallback, schedule(timeoutMs) { settle(back, false) })
        runCatching { send(PortalBridge.event("app.back", JSONObject().put("back", back))) }
            .onFailure { settle(back, false) }
    }

    /** The page's answer. Returns false for one that isn't for the question waiting (late or unknown). */
    fun answer(back: Int, handled: Boolean): Boolean = settle(back, handled)

    /** Forgets a question without acting on it, when the activity goes away. */
    fun close() {
        waiting?.cancel?.invoke()
        waiting = null
        page = null
    }

    private fun settle(back: Int, handled: Boolean): Boolean {
        val question = waiting?.takeIf { it.back == back } ?: return false
        waiting = null
        question.cancel()
        if (!handled) question.fallback()
        return true
    }

    companion object {
        /** Long enough for a busy page to answer, short enough that Back still feels immediate. */
        const val TIMEOUT_MS = 500L
    }
}
