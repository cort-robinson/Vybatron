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
| `BackRelay.kt` | Back: asks the page first, then falls back to the app's own Back |
| `playback/PlaybackService.kt` | The media session: playback with the screen off and the app closed, and the lock-screen, notification and Bluetooth controls |
| `playback/DevicePlayer.kt` | ExoPlayer and this device's queue: plays the portal's audio route, moves on by itself, looks up songs from other catalogs, retries or skips songs that fail |
| `playback/DeviceQueue.kt` | The queue rules, the same as `portal/web/src/playback.ts` |
| `playback/PlayerRequest.kt` | The player operations the portal may ask for |
| `playback/PlayerLink.kt` | This device in the shared player (ADR-0018): follows the store, carries out relayed controls and reports while it is the active device |
| `playback/PortalConnection.kt` | The service's own listener stream and player requests, to the portal origin only |
| `playback/SharedPlayer.kt` | The shared player, relayed commands and the event-stream format as the portal sends them |

## Playing on this device

In the app, the portal's "this device" player hands its songs to the app
(`portal/web/src/native.ts`): `player.load`, `player.setQueue` (refused as `stale` when the songs
moved on since the page last saw them), `player.control` and `player.subscribe`. The app answers
each with its state and sends `player.state` and `player.notice` events as it plays. A queue the
page saved reaches the app only when it's played, so nothing appears on the lock screen before.

## The shared player

`app.info` lists the feature `player.shared`: the playback service keeps its own connection to the
listener's shared player (ADR-0018) while it runs, page or no page. The page hands it the session's
CSRF token, this device's ID and name, and its server in `player.subscribe` (`session`) whenever it
loads. The service opens `/api/me/events` with the WebView's session cookie, as audio does, and
sends `/api/me/player` requests with the portal as `Origin` and the token. While the player's
active device is this one, under a generation it saw begin, it plays the store's songs, follows
edits to the queue, carries out relayed controls, and reports song changes, play, pause, seek, the
position every 15 s, volume and repeat. A newer generation stops it at once. If the portal refuses
the session, the stream closes and reports wait, the song keeps playing, until the page hands over
a session again. The page then only shows the player and sends edits and controls, and asks the
app to `player.control` `stop` to let go of a song. `player.subscribe` answers with `link`
(`{linked, generation}`) and the app sends `player.link` when it changes: until the service's stream
is live the page drives the app as before, and lets go the moment it links; while the service plays
under a generation but its stream is down, the page passes on the controls relayed to it. A new
session (a new token) starts over: nothing queued under the old one is sent. Pages keep driving an app without the feature
(0.2.0) the old way.

`DevicePlaybackTest` checks the player without the app's screen or the page: songs in a row, a
failing song skipped with the portal's reason, a song from another catalog played through its
search match, and Next and Previous from a media controller. It plays from a local server, so it
needs only an emulator. `SharedPlayerServiceTest` checks the service with no page: a local
listener stream makes it the active device and relays a pause, which it carries out and reports.

## Back

Back asks the page first (ADR-0019, `BackRelay.kt`): the app sends the portal page the event
`app.back` (`{"event": "app.back", "back": n}`), and the page answers with the request `app.back`
(`{"back": n, "handled": true|false}`) after it stops editing a field, closes its top menu or dialog,
or, on a TV, goes back a view. When the page didn't handle it, doesn't answer within 500 ms, or no
portal page is showing, the app does its own Back: the WebView's history, then the system's.
`BackBridgeTest` checks the three cases in the real activity, with a page on the portal origin
loaded from a string, so it needs only an emulator.

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

## Releases

Android releases are versioned apart from the bot, as `android-vX.Y.Z` tags, and need the owner's
approval like any release (`promote`).

1. A `chore(android): release X.Y.Z` PR raises `versionName` to `X.Y.Z` and `versionCode` by one in
   `app/build.gradle.kts`.
2. After it merges, the tag `android-vX.Y.Z` on its merge commit starts the Android release workflow
   (`.github/workflows/android-release.yml`). It builds from that commit, checks the APK is signed
   with the release key (certificate SHA-256 `3dd2d55f…32cb`), and publishes
   `vybatron-X.Y.Z.apk` and its checksum as a GitHub Release that isn't marked latest.

The workflow signs with the secrets `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD` (key
alias `vybatron`) and builds for the variable `VYBATRON_PORTAL_ORIGIN`. The keystore's owner keeps
an offline backup: Android only installs an update signed with the same key.

### Installing with Obtainium

Add the app from this repository's GitHub URL, with **Filter release titles by regular expression**
set to `^Vybatron for Android` so the bot's releases are ignored. Obtainium then offers each new
Android release as an update.
