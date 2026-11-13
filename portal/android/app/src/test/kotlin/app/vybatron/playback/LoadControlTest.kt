package app.vybatron.playback

import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.exoplayer.analytics.PlayerId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

@UnstableApi
class LoadControlTest {
    @Test fun theLastMinutePlayedStaysBufferedForSeeksBack() {
        val control = DevicePlayer.audioLoadControl()
        assertEquals(Util.msToUs(DevicePlayer.BACK_BUFFER_MS.toLong()), control.getBackBufferDurationUs(PlayerId.UNSET))
        assertFalse(control.retainBackBufferFromKeyframe(PlayerId.UNSET))
    }
}
