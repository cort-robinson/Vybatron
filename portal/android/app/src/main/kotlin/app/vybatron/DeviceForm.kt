package app.vybatron

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration

/**
 * What this device is (ADR-0019): a TV when Android says its UI mode is a television,
 * otherwise a phone (tablets and everything else included). One APK serves both; the page
 * reads it from `app.info`, and the playback service registers with the matching kind.
 */
enum class DeviceForm(
    /** The `form` that `app.info` reports. */
    val form: String,
    /** The device kind the shared player knows this device by (ADR-0018). */
    val kind: String,
) {
    PHONE("phone", "android"),
    TV("tv", "tv");

    companion object {
        /** The form for a [Configuration.UI_MODE_TYPE_MASK] value from [UiModeManager.getCurrentModeType]. */
        fun of(modeType: Int): DeviceForm =
            if (modeType and Configuration.UI_MODE_TYPE_MASK == Configuration.UI_MODE_TYPE_TELEVISION) TV else PHONE

        fun of(context: Context): DeviceForm =
            of(context.getSystemService(UiModeManager::class.java)?.currentModeType ?: Configuration.UI_MODE_TYPE_NORMAL)
    }
}
