package app.vybatron

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The native bridge exists on the portal and nowhere else. Needs a real portal
 * origin (`-Pvybatron.portalOrigin=...`) and network access, so CI skips it.
 */
@RunWith(AndroidJUnit4::class)
class BridgeScopeTest {
    private val origin = InstrumentationRegistry.getArguments().getString("portalOrigin").orEmpty()

    @Test fun bridgeAnswersOnThePortalOnly() {
        assumeTrue("No portal origin configured", origin.isNotEmpty())
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = webView(scenario)

            waitFor(web, "location.origin === ${JSONObject.quote(origin)} && document.readyState === 'complete'")
            assertEquals("\"object\"", eval(web, "typeof window.${PortalBridge.NAME}"))
            // No other native object is visible to the page.
            assertEquals("\"none\"", eval(web, "Object.keys(window).filter(k => /Android|Interface|Capacitor/.test(k)).join(',') || 'none'"))
            eval(web, """
                window.__reply = null;
                window.${PortalBridge.NAME}.onmessage = e => { window.__reply = e.data; };
                window.${PortalBridge.NAME}.postMessage(JSON.stringify({ id: 1, type: 'app.info' }));
            """.trimIndent())
            waitFor(web, "window.__reply !== null")
            val reply = JSONObject(JSONObject("{\"v\":${eval(web, "window.__reply")}}").getString("v"))
            assertEquals(true, reply.getBoolean("ok"))
            assertEquals("android", reply.getJSONObject("result").getString("platform"))

            // A binary message is refused, not a crash.
            eval(web, "window.__reply = null; window.${PortalBridge.NAME}.postMessage(new ArrayBuffer(1))")
            waitFor(web, "window.__reply !== null")
            val refused = JSONObject(JSONObject("{\"v\":${eval(web, "window.__reply")}}").getString("v"))
            assertEquals("bad_request", refused.getString("error"))

            // A top-level POST elsewhere never shows; the app returns to the portal.
            InstrumentationRegistry.getInstrumentation().runOnMainSync { web.postUrl("https://example.com/", ByteArray(0)) }
            Thread.sleep(3_000)
            waitFor(web, "location.origin === ${JSONObject.quote(origin)} && document.readyState === 'complete'")
            assertEquals("\"false\"", eval(web, "String(document.body.innerText.includes('Example Domain'))"))

            // Discord's sign-in loads in the app, without the bridge.
            eval(web, "location.href = 'https://discord.com/login'")
            waitFor(web, "location.hostname === 'discord.com' && document.readyState === 'complete'")
            assertEquals("\"undefined\"", eval(web, "typeof window.${PortalBridge.NAME}"))
            assertEquals("\"none\"", eval(web, "Object.keys(window).filter(k => /^vybatron|Android|Interface|Capacitor/.test(k)).join(',') || 'none'"))
        }
    }

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
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            web.evaluateJavascript(script) { result = it ?: "null"; done.countDown() }
        }
        check(done.await(10, TimeUnit.SECONDS)) { "Script timed out: $script" }
        return result
    }

    private fun waitFor(web: WebView, condition: String, timeoutMs: Long = 30_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (runCatching { eval(web, "!!($condition)") }.getOrNull() == "true") return
            Thread.sleep(250)
        }
        error("Timed out waiting for $condition (at ${eval(web, "location.href")})")
    }
}
