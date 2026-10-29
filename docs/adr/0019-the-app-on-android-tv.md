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
(`UiModeManager` reports `UI_MODE_TYPE_TELEVISION`), `app.info` reports `form: "tv"`, and the page
registers as a shared-player device of kind `tv` instead of `android`. Playback, the playback
service and its connection are the phone's (ADR-0018). Everything else in ADR-0014 and ADR-0016
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
2. **Show.** The TV shows the code, the address `<portal>/link`, and a QR code for
   `<portal>/link?code=XXXX-XXXX`.
3. **Approve.** On the phone, `/link` (signed in) shows the code and asks "Sign in the TV showing
   this code as you?", with a warning to approve only a code on a screen in front of you. The
   listener types the code, or confirms the one from the QR code matches the TV's.
   `POST /auth/device/approve` has the session, `Origin` and CSRF checks of every portal change.
   Approvals are limited to 10 tries per session per 10 minutes, so codes can't be guessed. A wrong
   or expired code says so without telling which.
4. **Finish.** The TV polls `POST /auth/device/poll` every 5 seconds with its cookie. Once approved,
   the portal checks the approving listener with the bot, as Discord sign-in does
   (`/v1/bootstrap`), creates a new session for that listener and sets the session cookie on the
   TV. The pending sign-in is deleted on first use, expiry or denial.

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
- **Back** closes the open menu or dialog, then goes back a view, then leaves the app, using the
  app's existing Back handling.
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
