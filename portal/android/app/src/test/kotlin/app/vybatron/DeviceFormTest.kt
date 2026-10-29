package app.vybatron

import android.content.res.Configuration
import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceFormTest {
    @Test fun aTelevisionIsATv() {
        assertEquals(DeviceForm.TV, DeviceForm.of(Configuration.UI_MODE_TYPE_TELEVISION))
        assertEquals("tv", DeviceForm.TV.form)
        assertEquals("tv", DeviceForm.TV.kind)
    }

    @Test fun everythingElseIsAPhone() {
        listOf(
            Configuration.UI_MODE_TYPE_UNDEFINED, Configuration.UI_MODE_TYPE_NORMAL, Configuration.UI_MODE_TYPE_DESK,
            Configuration.UI_MODE_TYPE_CAR, Configuration.UI_MODE_TYPE_APPLIANCE, Configuration.UI_MODE_TYPE_WATCH,
            Configuration.UI_MODE_TYPE_VR_HEADSET,
        ).forEach { assertEquals("mode $it", DeviceForm.PHONE, DeviceForm.of(it)) }
        assertEquals("phone", DeviceForm.PHONE.form)
        assertEquals("android", DeviceForm.PHONE.kind)
    }

    @Test fun readsOnlyTheTypeBits() {
        // A night-mode bit alongside the type doesn't change what the device is.
        assertEquals(DeviceForm.TV, DeviceForm.of(Configuration.UI_MODE_TYPE_TELEVISION or Configuration.UI_MODE_NIGHT_YES))
    }
}
