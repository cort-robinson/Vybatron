package app.vybatron

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.io.ByteArrayInputStream
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import android.content.ComponentName
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import app.vybatron.playback.DevicePlayer
import app.vybatron.playback.PlaybackService
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * The portal in a WebView, and nothing else: no bundled copy of the site and no
 * second UI. Native code is reachable only from the portal origin (ADR-0016).
 */
class MainActivity : ComponentActivity() {
    private var webView: WebView? = null
    private var failure: View? = null

    // This device's player lives in PlaybackService; connecting a controller starts it.
    private var controller: ListenableFuture<MediaController>? = null
    private var device: DevicePlayer? = null
    // Requests that arrive before the service is up wait here, in order.
    private val waiting = ArrayList<Pair<String?, JavaScriptReplyProxy>>()
    // The page that last spoke to the player hears its events.
    private var events: JavaScriptReplyProxy? = null
    private val onState: (JSONObject) -> Unit = { events?.postMessage(PortalBridge.event("player.state", JSONObject().put("state", it))) }
    private val onNotice: (String, String) -> Unit = { message, kind ->
        events?.postMessage(PortalBridge.event("player.notice", JSONObject().put("message", message).put("kind", kind)))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The portal is always dark, so the system bars use light icons whatever the phone's theme.
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))

        val portal = PortalOrigin.parse(BuildConfig.PORTAL_ORIGIN)
        when {
            portal == null -> return showMessage(getString(R.string.not_configured))
            // Without it the bridge can't be limited to one origin, so there is no fallback.
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ->
                return showMessage(getString(R.string.webview_too_old))
        }

        connectPlayer()
        val root = FrameLayout(this).apply { setBackgroundColor(getColor(R.color.portal_background)) }
        val view = createWebView(portal!!)
        root.addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        failure = failureView { failure?.visibility = View.GONE; view.reload() }.also {
            it.visibility = View.GONE
            root.addView(it, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        setContentView(root)
        // The page sits between the system bars and above the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { target, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            target.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        webView = view

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (view.canGoBack()) { view.goBack(); return }
                // Let the system handle it (Android 12+ only backgrounds the app), then take Back again.
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        })

        if (savedInstanceState == null || view.restoreState(savedInstanceState) == null) view.loadUrl(portal.startUrl)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(portal: PortalOrigin): WebView {
        val view = WebView(this)
        view.setBackgroundColor(getColor(R.color.portal_background))
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            // The portal starts the next song by itself when one ends, as in a browser tab.
            mediaPlaybackRequiresUserGesture = false
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, false)
        }

        val info = PortalBridge.AppInfo(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE)
        // onCreate already refused to start without it; checked here too, where the call is.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(view, PortalBridge.NAME, setOf(portal.value)) { _, message, origin, isMainFrame, reply ->
                // Android already limits the object to these frames; checked again so a mistake can't widen it.
                if (!isMainFrame || !portal.matches(origin.toString())) return@addWebMessageListener
                // A binary message has no text to read; reading it would throw.
                val text = if (message.type == WebMessageCompat.TYPE_STRING) message.data else null
                if (device == null && isPlayerRequest(text)) waiting.add(text to reply) else answer(text, reply, info)
            }
        }

        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Frames load as their page decides; only top-level pages are routed.
                if (!request.isForMainFrame) return false
                return when (NavigationPolicy.destination(request.url.toString(), portal)) {
                    Destination.PORTAL, Destination.SIGN_IN -> false
                    Destination.EXTERNAL -> { openOutside(request.url); true }
                    Destination.BLOCKED -> true
                }
            }

            // Android doesn't ask shouldOverrideUrlLoading about POSTs, so a top-level page
            // that isn't allowed is refused here, before anything from it can show.
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (!request.isForMainFrame || NavigationPolicy.destination(request.url.toString(), portal).staysInApp) return null
                return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }

            // A redirect that keeps a POST reaches neither check above; every page that
            // starts is checked again, and one that isn't allowed is left for the portal.
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                // Only web pages; WebView's own error and blank pages are left alone.
                val web = url.startsWith("https:", ignoreCase = true) || url.startsWith("http:", ignoreCase = true)
                if (web && !NavigationPolicy.destination(url, portal).staysInApp) {
                    view.stopLoading()
                    view.loadUrl(portal.startUrl)
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) failure?.visibility = View.VISIBLE
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The page is gone; start over with a fresh WebView rather than crash the app.
                webView = null
                (view.parent as? FrameLayout)?.removeView(view)
                view.destroy()
                recreate()
                return true
            }
        }
        return view
    }

    private fun connectPlayer() {
        val future = MediaController.Builder(this, SessionToken(this, ComponentName(this, PlaybackService::class.java))).buildAsync()
        controller = future
        future.addListener({
            if (controller !== future || runCatching { future.get() }.isFailure) return@addListener
            val player = PlaybackService.player ?: return@addListener
            device = player
            player.addListener(onState)
            player.addNoticeListener(onNotice)
            val info = PortalBridge.AppInfo(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE)
            waiting.toList().also { waiting.clear() }.forEach { (text, reply) -> answer(text, reply, info) }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun answer(text: String?, reply: JavaScriptReplyProxy, info: PortalBridge.AppInfo) {
        val player = device
        if (player != null && isPlayerRequest(text)) events = reply
        reply.postMessage(PortalBridge.respond(text, info, player?.let { PortalBridge.Player(it::handle) }))
    }

    private fun isPlayerRequest(text: String?) =
        runCatching { JSONObject(text ?: "").optString("type").startsWith("player.") }.getOrDefault(false)

    private fun openOutside(url: Uri) {
        val intent = Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE)
        try { startActivity(intent) } catch (_: ActivityNotFoundException) { /* Nothing can open it. */ }
    }

    private fun failureView(onRetry: () -> Unit): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setBackgroundColor(getColor(R.color.portal_background))
        val padding = (24 * resources.displayMetrics.density).toInt()
        setPadding(padding, padding, padding, padding)
        addView(TextView(context).apply {
            text = getString(R.string.unreachable)
            setTextColor(getColor(R.color.portal_text))
            gravity = Gravity.CENTER
            textSize = 16f
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        addView(Button(context).apply { text = getString(R.string.retry); setOnClickListener { onRetry() } },
            LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = padding })
    }

    private fun showMessage(text: String) {
        setContentView(TextView(this).apply {
            this.text = text
            gravity = Gravity.CENTER
            textSize = 16f
            setTextColor(getColor(R.color.portal_text))
            setBackgroundColor(getColor(R.color.portal_background))
            val padding = (24 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, padding)
        })
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.saveState(outState)
    }

    // No WebView.onPause(): music playing on this device keeps going with the app in the background.

    override fun onDestroy() {
        device?.removeListener(onState)
        device?.removeNoticeListener(onNotice)
        device = null
        events = null
        controller?.let(MediaController::releaseFuture)
        controller = null
        webView?.destroy()
        webView = null
        super.onDestroy()
    }
}
