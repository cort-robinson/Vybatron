# ADR-0015: The Android shell is a plain WebView, not Capacitor

- Status: Accepted
- Date: 2026-10-28
- Amends: [ADR-0014](0014-android-app-with-on-device-youtube-music-account.md) ("A Capacitor shell
  over the live portal" and the bridge allowlist)

## Context

ADR-0014 chose a Capacitor shell that loads the live portal, with the bridge limited to our own
plugins, and said it would be amended if Capacitor couldn't be restricted that way. Reading
Capacitor 8.6's Android source before building it showed:

- **Its built-ins can't be left out.** `Bridge.registerAllPlugins` always registers
  `CapacitorCookies`, `WebView`, `CapacitorHttp` and `SystemBars`. A plugin of ours with the same
  name replaces the entry, but only after the built-in has loaded.
- **Loading them already widens the app.** `CapacitorCookies` and `CapacitorHttp` call
  `addJavascriptInterface` when they load, which exposes their objects to every page and frame,
  Discord's included, and `CapacitorCookies` makes the WebView's cookies the process-wide default
  cookie handler, so any native HTTP request carries the portal session.
- **Old WebViews fall back further.** Without `WEB_MESSAGE_LISTENER` its bridge itself falls back
  to `addJavascriptInterface`, and without `DOCUMENT_START_SCRIPT` it proxies the portal's HTML
  through its own HTTP client to inject a script.

All of it can be undone after startup (remove the interfaces, reset the cookie handler, reload,
refuse old WebViews), but that depends on Capacitor's internals in every upgrade. With the portal
loaded live and our own plugins written in Kotlin, Capacitor's remaining value is plumbing we can
write in a few dozen lines.

## Decision

The app is a plain Android `WebView` in one activity (`portal/android/`). Everything else in
ADR-0014 stands.

- **One bridge, one origin.** The portal reaches native code only through `window.vybatronNative`,
  created with `WebViewCompat.addWebMessageListener` for the portal origin. Android gives it to
  that origin's frames only, and the listener also checks for the top frame and the origin. No
  `addJavascriptInterface` anywhere.
- **No fallback.** Without `WEB_MESSAGE_LISTENER` the app says the WebView needs updating instead
  of loading the portal.
- **Named operations.** Each message is `{id, type}` and gets one reply. Step 1 has only
  `app.info`; the playback, account and library operations of ADR-0014 arrive as named types.
- **Navigation.** Top-level pages from the portal origin and `https://discord.com` load in the
  app; Discord's pages never get the bridge. Other `http`, `https` and `mailto` links open in the
  phone's browser or mail app. Everything else (`intent:`, `file:`, `javascript:`) is ignored.
- **Storage.** No file or content access, no mixed content, no backups or device transfers of app
  data, no third-party cookies.

The checks ADR-0014 asked of step 1 are a JVM test of the origin and navigation rules and an
instrumented test (`BridgeScopeTest`) that finds the bridge on the live portal and not on
Discord's login page, and no other native object on either.

## Consequences

- Capacitor's CSP question goes away: `addWebMessageListener` injects an object, not a script,
  so the portal's CSP is untouched.
- Android System WebView releases older than the Web Message Listener (from 2020) can't run the
  app.
- The JavaScript side of the bridge (request ids, promises, timeouts) is ours to write, in
  `portal/web`, when the first operation the portal needs lands.
