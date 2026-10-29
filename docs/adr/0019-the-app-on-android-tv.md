# ADR-0019: The app on Android TV, signed in from your phone

- Status: Proposed
- Date: 2026-10-29
- Amends: [ADR-0014](0014-android-app-with-on-device-youtube-music-account.md) (Android only, a
  phone app) and the portal's session lifetime

## Context

The owner wants the portal on a Google TV Streamer, with the visualizer, as one more device of the
shared player (ADR-0018). The Android app is a WebView over the live portal with native playback
(ADR-0016), and Android TV runs ordinary Android apps. Four things stand in the way:

- **The app doesn't install as a TV app.** Its manifest has no TV launcher entry or banner and
  assumes a touchscreen, so Google TV hides it.
- **Signing in with a remote.** Discord's sign-in page wants an email, a password and often a
  captcha or a second factor, typed with an on-screen keyboard.
- **Sign-ins end after 7 days.** A portal session lasts a fixed 7 days
  (`portal/server/src/config.js` `sessionMs`). That's tolerable on a phone and a chore on a TV.
- **The portal is built for touch and a pointer.** Many controls can't be reached with arrow keys,
  and focus isn't visible.

## Decision

### One APK for phones and TVs

The same app, built from `portal/android/`, installs on both. The manifest says touch and the
Leanback feature are optional, adds the `LEANBACK_LAUNCHER` entry and a 320×180 banner. On a TV
(`UiModeManager` reports `UI_MODE_TYPE_TELEVISION`), `app.info` reports `form: "tv"`, and both the
page and the playback service's own connection (`PlayerLink`) register the device as kind `tv`
instead of `android`. Playback, the playback service and its connection are otherwise the phone's
(ADR-0018). Everything else in ADR-0014 and ADR-0016
stands.

### Signing in on another device

A TV signs in by showing a code that the listener approves on a device that is already signed in,
like signing in to a streaming app. Discord sign-in stays available on the TV for anyone who wants
it.

1. **Start.** The TV calls `POST /auth/device/start`. The portal creates a pending sign-in with:
   - a **user code** of 8 letters from an unambiguous 20-letter alphabet (`BCDFGHJKLMNPQRSTVWXZ`),
     shown as `XXXX-XXXX`;
   - a **device token**, random, kept only in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie on the
     TV (as Discord's OAuth state is today);
   - a 10-minute expiry. At most 64 are pending at once; starts are rate-limited per address like
     Discord sign-in starts.

   Pending sign-ins live in the portal server's memory, like Discord's OAuth state. A restart
   loses them, and the TV starts a new one with a new code when its poll is refused. The portal
   runs as one process (ADR-0010); running several would need shared, atomic storage for them,
   which this decision doesn't provide.
2. **Show.** The TV shows the code, the address `<portal>/link`, and a QR code for
   `<portal>/link?code=XXXX-XXXX`.
3. **Approve.** On the phone, `/link` (signed in) shows the code and asks "Sign in the TV showing
   this code as you?", with a warning to approve only a code on a screen in front of you. The
   listener types the code, or confirms the one from the QR code matches the TV's.
   `POST /auth/device/approve` has the session, `Origin` and CSRF checks of every portal change.
   Approvals are limited to 10 tries per session per 10 minutes, so codes can't be guessed. A wrong
   or expired code says so without telling which. An approval records the approving listener in
   the pending sign-in once and can't be changed: a second approval of the same code is refused.
4. **Finish.** The TV polls `POST /auth/device/poll` every 5 seconds with its cookie. Once approved,
   the poll claims the pending sign-in, removing it in the same step with no wait in between, so a
   second poll at the same moment finds nothing. Only then does the portal check the approving
   listener with the bot, as Discord sign-in does (`/v1/bootstrap`), create a new session for that
   listener and set the session cookie on the TV. A pending sign-in is also deleted on expiry or
   denial.

`start` and `poll` set or use a cookie before anyone is signed in, so they can't use the session's
CSRF token. Both require the exact portal `Origin` header (not just the same site) and a JSON
`Content-Type`, which a foreign page can't send without a CORS preflight the portal refuses.

The new session is a session like any other. It's independent of the approving phone's: signing
out one doesn't sign out the other. Server membership is still checked on every request
(ADR-0011), so a listener who leaves the server loses access on the TV too.

**Code phishing** is the known risk of this flow: someone could show a listener their own code and
ask them to approve it. The approval page's warning, the code's 10-minute life and the fact that it
names what is being signed in are the mitigations. The approval is always a deliberate step on a
signed-in device; nothing approves itself.

### Longer sign-ins

Sessions renew while they are used, for every kind of device:

- A session expires after **30 days without use**, and in any case **90 days after sign-in**.
- Using a session renews it at most once a day: the portal moves its expiry and resends the cookie
  with the new lifetime. The session store is written only on those renewals.
- **Stored sessions.** Each record keeps its sign-in time, so the 90-day limit can't move. The
  store's loader accepts today's records, which expire 7 days after sign-in, and renewed ones,
  whose expiry is at most 30 days after their last renewal and at most 90 days after sign-in.
  A record outside those bounds is dropped, not a reason to refuse to start.
- **The app's own requests renew too.** The Android playback service's requests can renew a
  session, so its connection applies the `Set-Cookie` it receives to the WebView's cookie store;
  otherwise the server's expiry would move while the phone kept the old cookie. A test covers a
  renewal during background playback.
- Sign-out, signing in again in the same browser, and the store's existing limits work as today.

A stolen cookie stays useful for longer than 7 days. It is `HttpOnly`, `Secure` and `__Host-`, the
same as today, and membership is checked on every request. That is accepted for not signing in
weekly on the TV.

### The portal with a remote

On a TV, the portal switches to a layout for a remote, chosen by `app.info` `form: "tv"` (and,
for testing, a query flag):

- **The home is now playing.** The full-screen player with the visualizer is the first screen.
  Up, down and OK reach the controls (play, pause, previous, next, seek, Play on, the queue), and
  they hide again after a few seconds without input.
- **Arrow keys move focus.** The portal moves focus to the nearest focusable control in the
  pressed direction, within the open view, menu or dialog. Focus is always visible.
- **Controls that use arrows keep them while being edited.** A slider (seek, volume) or a text field
  is focused like any control. OK starts editing it: the arrows then change its value or move the
  caret, and OK or Back stops editing and gives the arrows back to focus movement. This is checked
  in the Android TV WebView, not only in a desktop browser.
- **Back** closes the open menu or dialog, then goes back a view, then leaves the app. Today the
  app's Back handling knows the WebView's history and a few player layers, not every menu, so the
  page gets a Back step of its own: the app asks the page first (a named bridge operation, as
  ADR-0016 requires) and falls back to its current handling when the page has nothing to close.
  Tests cover Back from a menu, a dialog, a view and the home.
- Typing (search) uses the TV's on-screen keyboard.

The visualizer runs at the frame rate chosen in Settings (ADR-0015, #125), 30 a second by default.

### Order

1. Sessions that renew, and signing in with a code (portal server and web).
2. The TV build: manifest, banner, `form: "tv"`, kind `tv`, the code sign-in screen.
3. The portal with a remote: focus navigation and the now-playing home.

Each is its own PR. A new APK release follows, with the owner's approval.

## Consequences

- **New sign-in routes.** `/auth/device/*` and `/link` are new security-sensitive surface, tested
  like Discord sign-in: expiry, single use, cookie binding, rate limits, CSRF, and that one
  listener's approval can never sign in a TV as anyone else.
- **Sessions last longer.** Up to 90 days instead of 7. Signing out on the device ends one sooner;
  signing a device out from another device is not part of this decision.
- **Two layouts to keep working.** Changes to the player now have a TV layout to check. The
  Playwright suite gains TV specs (arrow-key focus, Back, the now-playing home) using the query
  flag.
- **Older TVs.** WebView and WebGL performance on TV devices varies. The frame-rate setting is the
  lever. Butterchurn is checked on an Android TV emulator before release, and on the Streamer by
  the owner.
