package app.vybatron.playback

import android.app.PendingIntent
import android.content.Intent
import android.webkit.CookieManager
import androidx.annotation.OptIn
import androidx.annotation.VisibleForTesting
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import app.vybatron.BuildConfig
import app.vybatron.MainActivity
import app.vybatron.PortalOrigin

/**
 * Keeps this device's player alive with the screen off and the app closed, and gives
 * it the lock-screen, notification and Bluetooth controls. Other apps may play, pause
 * and skip; they can't give it songs to play.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private var connection: PortalConnection? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        val base = testBase ?: PortalOrigin.parse(BuildConfig.PORTAL_ORIGIN)?.value ?: return
        val cookies = { CookieManager.getInstance().getCookie("$base/") }
        val device = DevicePlayer(this, base, cookies)
        // This device's own connection to the shared player, so it stays reachable with its page closed.
        val portal = PortalConnection(base, cookies, "Vybatron-Android/${BuildConfig.VERSION_NAME}")
        val shared = PlayerLink(device, portal, { ms, task ->
            val run = Runnable(task)
            handler.postDelayed(run, ms)
            ({ handler.removeCallbacks(run) })
        }, portal::serverNow)
        portal.link = shared
        connection = portal
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        session = MediaSession.Builder(this, device.player)
            .setSessionActivity(open)
            .setCallback(object : MediaSession.Callback {
                override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
                    val commands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
                        .removeAll(Player.COMMAND_SET_MEDIA_ITEM, Player.COMMAND_CHANGE_MEDIA_ITEMS)
                        .build()
                    return MediaSession.ConnectionResult.AcceptedResultBuilder(session).setAvailablePlayerCommands(commands).build()
                }
            })
            .build()
        player = device
        link = shared
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    // Swiping the app away stops the service unless music is playing.
    override fun onTaskRemoved(rootIntent: Intent?) {
        if (player?.isPlaying != true) stopSelf()
    }

    override fun onDestroy() {
        link?.close()
        link = null
        connection?.release()
        connection = null
        session?.release()
        session = null
        player?.release()
        player = null
        super.onDestroy()
    }

    companion object {
        /** The running service's player, once a controller has started it. */
        var player: DevicePlayer? = null
            private set

        /** The running service's connection to the shared player (ADR-0018). */
        var link: PlayerLink? = null
            private set

        /** Tests play from a local server instead of the portal. */
        @VisibleForTesting
        var testBase: String? = null
    }
}
