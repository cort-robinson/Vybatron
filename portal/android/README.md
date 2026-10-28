# Vybatron for Android

The portal in an Android app: one activity with a WebView that loads the live portal, and native
code the portal can reach through `window.vybatronNative` and nowhere else. Design:
[ADR-0014](../../docs/adr/0014-android-app-with-on-device-youtube-music-account.md) and
[ADR-0016](../../docs/adr/0016-android-shell-is-a-plain-webview.md).

| File | Purpose |
| --- | --- |
| `MainActivity.kt` | The WebView, its settings, navigation and the bridge registration |
| `PortalOrigin.kt` | The one trusted origin, parsed and compared |
| `NavigationPolicy.kt` | Which top-level pages stay in the app, open outside, or are ignored |
| `PortalBridge.kt` | The bridge's message format and its named operations |
| `playback/PlaybackService.kt` | The media session: playback with the screen off and the app closed, and the lock-screen, notification and Bluetooth controls |
| `playback/DevicePlayer.kt` | ExoPlayer and this device's queue: plays the portal's audio route, moves on by itself, looks up songs from other catalogs, retries or skips songs that fail |
| `playback/DeviceQueue.kt` | The queue rules, the same as `portal/web/src/playback.ts` |
| `playback/PlayerRequest.kt` | The player operations the portal may ask for |

## Playing on this device

In the app, the portal's "this device" player hands its songs to the app
(`portal/web/src/native.ts`): `player.load`, `player.setQueue` (refused as `stale` when the songs
moved on since the page last saw them), `player.control` and `player.subscribe`. The app answers
each with its state and sends `player.state` and `player.notice` events as it plays. A queue the
page saved reaches the app only when it's played, so nothing appears on the lock screen before.

`DevicePlaybackTest` checks the player without the app's screen or the page: songs in a row, a
failing song skipped with the portal's reason, a song from another catalog played through its
search match, and Next and Previous from a media controller. It plays from a local server, so it
needs only an emulator.

## Build

JDK 21 and the Android SDK (platform 37.2). The portal origin is a build setting and never
committed; a debug build without one opens a placeholder, and a release build refuses to build.

```sh
cd portal/android
./gradlew testDebugUnitTest lintDebug assembleDebug
./gradlew assembleDebug -Pvybatron.portalOrigin=https://<portal host>   # or VYBATRON_PORTAL_ORIGIN
```

`BridgeScopeTest` runs on a device or emulator against the real portal and Discord's login page,
and is skipped when no origin is set. `connectedDebugAndroidTest` runs on every attached device,
so set `ANDROID_SERIAL` to the emulator's serial first:

```sh
ANDROID_SERIAL=emulator-5554 ./gradlew connectedDebugAndroidTest -Pvybatron.portalOrigin=https://<portal host>
```

Signed release builds and their publication come with the release workflow (ADR-0014, step 1).
