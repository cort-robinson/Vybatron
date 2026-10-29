package app.vybatron

import android.graphics.Bitmap
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Back asks the page first (ADR-0019), in the real activity and WebView. A page on the portal origin
 * (served from a string in place of its start page, so no server or network is needed) answers the app's `app.back` the way the
 * portal does: handled, not handled, or not at all. When it isn't handled, or no answer comes within
 * the timeout, the app's own Back runs, which here goes back in the WebView's history.
 */
@RunWith(AndroidJUnit4::class)
class BackBridgeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val origin = PortalOrigin.parse(BuildConfig.PORTAL_ORIGIN)!!.value

    private val page = """
        <!doctype html><meta name="viewport" content="width=device-width">
        <body style="background:#0d0f14;color:#f5f4f8;font:32px sans-serif;padding:48px"><h1>Back bridge</h1><p id="log"></p>
        <script>
          window.mode = 'handled'; window.asked = []; window.ready = false;
          const port = window.${PortalBridge.NAME};
          const log = text => { document.getElementById('log').textContent = text; };
          port.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.event === 'app.back') {
              window.asked.push(message.back); log('Back ' + message.back + ': ' + window.mode);
              if (window.mode !== 'silent') port.postMessage(JSON.stringify({ id: 100 + message.back, type: 'app.back', back: message.back, handled: window.mode === 'handled' }));
              return;
            }
            if (message.id === 1 && message.ok) window.ready = true;
          });
          port.postMessage(JSON.stringify({ id: 1, type: 'app.info' }));
        </script>
    """.trimIndent()

    @Test fun backAsksThePageFirstAndFallsBackWhenItDeclinesOrIsSilent() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = webView(scenario)
            // The page is served in place of the portal origin's own start page, through the app's
            // WebViewClient for everything else, so the bridge and Back see the real origin.
            scenario.onActivity { activity ->
                val app = web.webViewClient
                web.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = app.shouldOverrideUrlLoading(view, request)
                    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) = app.onPageStarted(view, url, favicon)
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                        if (request.isForMainFrame && request.url.toString().startsWith("$origin/")) WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(page.toByteArray()))
                        else app.shouldInterceptRequest(view, request)
                }
                (web.parent as ViewGroup).let { root -> (0 until root.childCount).map(root::getChildAt).filter { it !== web }.forEach { it.visibility = View.GONE } }
                web.loadUrl("$origin/")
                activity.window.decorView.requestFocus()
            }
            // Three pages in the WebView's history, each a real navigation (Back skips entries a
            // script pushed without a user's tap).
            waitFor(web, "window.ready === true")
            for (path in listOf("two", "three")) {
                instrumentation.runOnMainSync { web.loadUrl("$origin/$path") }
                waitFor(web, "location.pathname === '/$path' && window.ready === true")
            }

            // Handled by the page: nothing else happens.
            back()
            waitFor(web, "window.asked.length === 1")
            Thread.sleep(BackRelay.TIMEOUT_MS * 2)
            assertEquals("\"/three\"", eval(web, "location.pathname"))
            scenario.onActivity { assertFalse(it.isFinishing) }

            // Declined: the app goes back in the WebView's history.
            eval(web, "window.mode = 'declined'")
            back()
            waitFor(web, "location.pathname === '/two' && window.ready === true", timeoutMs = 10_000)

            // No answer: the app waits the timeout, then goes back.
            eval(web, "window.mode = 'silent'")
            val start = System.nanoTime()
            back()
            waitFor(web, "location.pathname === '/'", timeoutMs = 10_000)
            val waited = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start)
            assertTrue("Fell back after $waited ms", waited >= BackRelay.TIMEOUT_MS - 50)
            scenario.onActivity { assertFalse(it.isFinishing) }
        }
    }

    private fun back() = instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)

    private fun webView(scenario: ActivityScenario<MainActivity>): WebView {
        var found: WebView? = null
        scenario.onActivity { activity -> found = find(activity.window.decorView) }
        return requireNotNull(found) { "No WebView on screen" }
    }

    private fun find(view: View): WebView? = when (view) {
        is WebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { find(view.getChildAt(it)) }
        else -> null
    }

    private fun eval(web: WebView, script: String): String {
        var result = "null"
        val done = CountDownLatch(1)
        instrumentation.runOnMainSync { web.evaluateJavascript(script) { result = it ?: "null"; done.countDown() } }
        check(done.await(10, TimeUnit.SECONDS)) { "Script timed out: $script" }
        return result
    }

    private fun waitFor(web: WebView, condition: String, timeoutMs: Long = 15_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (runCatching { eval(web, "!!($condition)") }.getOrNull() == "true") return
            Thread.sleep(50)
        }
        error("Timed out waiting for $condition (at ${eval(web, "location.href")})")
    }
}
