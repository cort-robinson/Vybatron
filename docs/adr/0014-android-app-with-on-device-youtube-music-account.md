# ADR-0014: An Android app, with each listener's YouTube Music account kept on their phone

- Status: Accepted; the shell is amended by [ADR-0016](0016-android-shell-is-a-plain-webview.md)
  (a plain WebView, not Capacitor)
- Date: 2026-10-28

## Context

The portal already plays songs on the listener's own device: a private queue, moved to and from
the Discord session like casting, with audio decoded by our Lavalink plugin and served by the
portal (`src/portal/audio.js`, `portal/web/src/playback.ts`). What it can't be is a YouTube Music
client in its own right. Two things stand in the way:

- **Personal YouTube Music.** Home feed, likes, playlists, history, artist and album pages need the
  listener's own signed-in session. YouTube's official Data API has no YouTube Music catalog or
  library, so a client signs InnerTube requests (YouTube's internal API) with the account's
  cookies, the way YouTube Music's web player does. A web page can't read google.com cookies, and
  holding every listener's Google session on our home server is not acceptable: those cookies are
  the whole Google account, not just YouTube.
- **Playing in the background.** A PWA on a phone loses audio when the screen is off or the app is
  in the background, unreliably and differently per browser.

A native app removes both. It owns its own WebViews, so it can show Google's real sign-in page,
keep the resulting cookies on the phone, and sign requests itself; and it can play through the
platform's media session. Open-source Android YouTube Music clients (for example BitChord) do
exactly this. Their license (GPLv3) is not ours (MIT), so only ideas and published measurements
are taken from them, not code.

Most listeners are on Android. iPhone distribution of a YouTube client (no App Store; 90-day
TestFlight builds or yearly re-signing) is a separate, ongoing cost.

## Decision

**Android only.** No iOS app. The web portal stays the client for everything else.

**A Capacitor shell over the live portal.** The app is a Capacitor Android project that loads the
deployed portal origin, not a bundled copy of `portal/web`:

- Portal changes ship through the normal Deploy; the APK changes only when native code does.
- The page's origin is the portal origin, so Discord sign-in, the `__Host-` session cookie,
  same-origin checks and the CSP work unchanged.
- The origin is a build setting, never committed (the repository is public).
- The shell navigates only within the portal origin and Discord's OAuth pages. Every other link
  opens in the system browser. Native plugins answer only the portal origin.
- The bridge exposes only the three plugins below. Capacitor's built-in HTTP and cookie plugins
  are disabled or refused, because native HTTP skips the CSP and shares the WebView's cookies.
  Step 1 proves it with negative checks from the portal page and from Discord's pages. If
  Capacitor can't be restricted this way, this ADR is amended before anything ships.

Native Kotlin with its own UI was the alternative. It was rejected because it means a second UI
to keep in step with the portal.

**Three native plugins, in Kotlin.**

1. **Playback.** A Media3 `MediaSessionService` plays the portal's existing audio route
   (`/api/guilds/:guild/audio/:videoId`) with the portal session cookie. On the phone it owns this
   device's playing list, position, repeat and the transport (play, pause, next, previous, seek),
   because the WebView can be destroyed while music plays. The web layer edits that list and shows
   its state, and reconciles with it when the page is recreated; its queue rules (`playback.ts`)
   decide what goes in the list, not when a track advances. Step 1 proves several tracks playing in
   a row, and the notification and Bluetooth controls, with the app's activity gone. This gives
   background playback, lock-screen, notification and Bluetooth controls, and later gapless
   playback or crossfade. Discord sessions keep their controls in the portal page.
2. **YouTube Music account.** Sign-in runs Google's own login page in its own WebView storage: an
   isolated WebView profile, or a separate process with its own WebView data directory where
   profiles aren't supported. A plain second WebView is not enough, since it shares the portal's
   cookie store. When the page lands on music.youtube.com and the listener confirms the account
   and channel, the plugin keeps the cookies and the page's account identifiers, encrypted with
   the Android Keystore, and then clears that login storage. It is cleared on cancel too, and kept
   out of backups. Signed requests carry the cookie from the encrypted copy, never from a WebView
   cookie store. Sign-out deletes the copy. The cookie never reaches JavaScript, the portal, or
   the bot.
3. **YouTube Music library.** Reads, signed on the phone and sent from the phone to YouTube Music:
   home feed, liked songs, playlists, history, search, artist, album and playlist pages. Results
   reach the web layer as tracks with YouTube video IDs, titles, artists, artwork and durations.
   The plugin exposes named operations only, never a general signed request, so a fault in the
   portal page can at most read the library, not act as the account.

**YouTube Music is read for the library only; playback doesn't change.** A song from the
listener's library plays like any YouTube song today: in Discord through Lavalink, or on the
phone through the portal's audio route. Nothing about Lavalink as the only playback engine
([ADR-0001](0001-lavalink-sole-audio-engine.md)) changes, and the bot never receives the listener's YouTube Music session.

**What leaves the phone.** Only what the listener acts on: a song they queue, play, favorite or
add to a mix is sent to the bot as it would be from a search result. Their YouTube Music library
is not uploaded, stored or used by autoplay.

**Writes come later, one at a time.** Like, add to playlist, and importing YouTube Music likes into
Vybatron favorites are each added only behind a confirmation the plugin shows natively.

**Distribution.** CI builds a signed release APK. Android releases have their own version and
tags (`android-vX.Y.Z`), are prepared with `promote` like any release, and are published as GitHub
Releases. Listeners install and update with Obtainium. Protecting those tags like `v*` is a
ruleset change for the owner. The signing key is a GitHub secret with an
offline backup: losing it means every listener must uninstall to update.

**Order.**

1. The shell and native playback, with the APK build. On its own this fixes background playback.
2. YouTube Music sign-in and the read-only library views, shown only in the app.
3. Writes, each separately.

## Consequences

- **Each listener's own Google account carries the risk.** If YouTube flags unusual use, it is
  their account, not the bot's. The app says so before sign-in. Their library requests come from
  their phone's address, not the server's, so they don't add to the bot's YouTube traffic.
- **Sign-in can break.** Google refuses logins it recognizes as an embedded WebView. The sign-in
  WebView presents a normal mobile browser user agent, which Google can stop accepting at any
  time. When it does, signing in fails and everything else keeps working.
- **InnerTube changes without notice.** The library parsers are tested against captured real
  responses, kept with personal data removed. A view whose response can't be parsed is hidden
  rather than shown broken.
- **Age-restricted songs still don't play.** They need the listener's account at playback, which
  this decision rules out. Playing on the phone with the listener's own account would take its
  own ADR.
- **To check first, in step 1:** that Capacitor's bridge script runs under the portal's CSP
  (`script-src 'self'`) without loosening it, and that the audio route accepts Media3's requests.
  If the CSP blocks the bridge, the fix is an amendment here, not a weaker CSP.
- **New things to maintain:** an Android project (`portal/android/`), Kotlin tests in CI, an
  Android release flow, and a signing key. Adding the CI build and the signing secret both need
  the owner's approval (`.github/workflows/` is a hold path; secrets are production settings).
- **iOS listeners keep the web portal,** with today's background-playback limits.
