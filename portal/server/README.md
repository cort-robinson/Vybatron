# Vybatron portal HTTP service

This independent Node 24.11+ package has **no runtime dependencies**. It serves
the compiled UI, performs confidential Discord OAuth, stores encrypted device
sessions, and forwards contract API calls to the bot. It imports no bot modules,
Lavalink clients, or MusicLibrary code. It never writes music data.

From the repository root, start it with:

```sh
node portal/server/src/index.js
```

Or run `npm start --prefix portal/server`. Tests run with
`npm test --prefix portal/server`; `node --test portal/server/test/server.test.js`
also works from the repository root. No fixture account or bypass login exists.
The tests use actual loopback HTTP Discord/bridge peers and real OAuth/session
handlers, not a production authentication override. All polling tests have
deadlines and teardown that closes streams, sockets, transports, and servers.
The final combined API/bot regression imports the root's isolated bot fixture;
run `npm ci` at the repository root first to provide its Discord.js dependencies.
The portal production runtime remains independent of those bot modules/packages.

## Required integration

| Environment | Meaning |
| --- | --- |
| `PORTAL_ORIGIN` | Exact public HTTPS origin, without trailing slash/path/query. Callback is exactly `${PORTAL_ORIGIN}/auth/discord/callback`. |
| `DISCORD_CLIENT_ID` | Registered Discord application ID. |
| `DISCORD_CLIENT_SECRET` | Provisioned client secret, at least 32 characters. |
| `PORTAL_SESSION_SECRET` | Independent random secret of at least 32 characters. Encrypts auth storage. |
| `PORTAL_BRIDGE_TOKEN` | Independent random shared bridge secret of at least 32 characters. Sent only as a bearer header. |
| `PORTAL_BOT_URL` | Exact private bridge origin, for example `http://bot:3010`. |
| `PORTAL_HOST` | Default `127.0.0.1`; root can use `0.0.0.0` inside a private container with a host-loopback publication. |
| `PORTAL_PORT` | Default `3001`. |
| `PORTAL_WEB_DIST` | Default `portal/web/dist`, resolved relative to this package regardless of working directory. |
| `PORTAL_DATA_DIR` | Default `portal/server/data`; production should mount a separate persistent private volume here. |
| `NODE_ENV` | Set to `production` to require public HTTPS and prohibit test transports/timing overrides. |

Only one portal instance may own an auth directory. `sessions.enc` is an atomic,
AES-256-GCM authenticated encrypted file, mode 0600 in a 0700 directory on Unix.
On Windows, secure the directory ACL as part of host provisioning. Device cookies
contain random opaque tokens; storage contains only their SHA-256 lookup hashes,
Discord account IDs, CSRF secrets, and fixed expiration timestamps. OAuth tokens
are used to verify identity and are never persisted. Changing the session secret
requires deliberately replacing/archiving the encrypted auth file and signing in
again; the service refuses to decrypt corrupt or differently keyed storage.
Back up encrypted auth storage independently of the bot music library.

Discord OAuth requests only `identify`, never bot installation or email scopes.
The server exchanges the code using its client secret, exact callback, and a
single-use, ten-minute state bound to a separate Secure/HttpOnly cookie. The
[official confidential authorization-code flow](https://docs.discord.com/developers/topics/oauth2#authorization-code-grant)
documents client-secret authentication and state; this implementation does not
assume undocumented PKCE support for this application. Root must verify any
future PKCE change against the actually provisioned Discord application before
enabling it. Every successful sign-in rotates the supplied device session and
CSRF secret. Cookies are always `__Host-` prefixed, Secure, HttpOnly, SameSite=Lax,
Path=/, with a fixed seven-day lifetime. No token or session ID is put in a URL.
Use HTTPS during browser integration; secure-cookie forwarding through a local
Vite proxy must be verified. The production callback must point to the service's
`/auth/discord/callback`, not a SPA route.

The bot must implement all `docs/portal-contract.md` `/v1` endpoints and freshly
authorize each request using the session-derived `actorId`. Every public API
request and every SSE poll makes a new bridge call; no authorization snapshot is
cached. Bot bootstrap viewer ID must equal the verified session account ID.
The portal injects actor IDs, ignores browser authorization headers, and rejects
unknown query/body/options fields. It forwards contract names **skipto(position)**
and **replay(index)**; the bot adapter must translate existing slash command
names where those differ. The contract's `settings musicchannel(channel)` must
be available on the bridge. `settings djrole` accepts an omitted/null role to
clear it. Migrated favorite overflow indices remain usable without truncation.

`expectedRevision` is required for clear, remove, move, shuffle, skip, skipto,
seek, playnext, replay, mix save, favorite add, and session resume/discard. The
bot must compare revisions inside its existing mutation lane. `clear` removes
only upcoming queue entries. `favorite add` accepts an optional one-based
`position` (1..500); omission saves the current track. No browser track objects
are accepted. Search and play/playnext queries are limited to 200 characters.
Seek uses the bot's 4..12-character mm:ss/hh:mm:ss field: numeric components,
seconds at most 59, and minutes at most 59 when hours are present. The bot still
checks track seekability/duration. Ordinary play additions and urgent stop may
omit the revision. Browser POSTs must carry exact `Origin: ${PORTAL_ORIGIN}` and
`X-CSRF-Token` from bootstrap. Logout has no body and remains available when the
bot is offline. Logout destroys only this device and closes its open streams.
The device token is revalidated after the command body is read and immediately
before bridge dispatch, and again after the bridge responds. Logout, session
rotation or expiry during an incomplete upload therefore prevents dispatch.
An operation already dispatched before revocation may finish in the bot.

SSE sends `event:snapshot`, heartbeat comments, and a safe `event:error` before
closing after permission/session/bridge loss. Pages that ask for `?protocol=2`
get `event:unchanged` (the fresh read's revision and ordering stamp only) when
a read would show them nothing new, and every stream announces the end of its
lifetime with `event:rotate`. See `docs/portal-instant-controls.md` (*Live updates*). On any disconnect/error, the UI
must disable mutations, discard the live-state authority, and refresh before
reenabling actions. A reconnect makes a fresh bridge request. The portal never
retries or queues a mutation. A timed-out command may already have executed in
the bot: show its uncertainty and refresh; do not automatically resend it.

**PWA integration:** the web service worker must bypass `/api`, `/auth`, and
`/health` for every method, never cache an authenticated response, and never
queue/replay POSTs. Service worker script responses use `no-store`; all private
HTTP/SSE/auth/error responses also use `no-store`. The service CSP forbids audio
playback/media requests, third-party scripts, framing, and cross-origin API
connections. UI imagery may use HTTPS/data images; fonts/scripts must be local.
Serve externally hosted artwork only under the bot's safe projection policy.

Root owns Dockerfiles, Compose, resource limits, UI build, OAuth provisioning,
Funnel configuration, and deployment. Publish only the portal to host loopback;
the bridge remains private. Do not log full request URLs (the OAuth callback
contains a temporary code/state), headers, cookies, environment values, or
upstream bodies in a reverse proxy. This service logs only a fixed startup line
or a fixed startup-failure message.

## Resource and failure behavior

- 128 inbound sockets, 32 ordinary request handlers, four isolated authenticated
  command-body readers, and two reserved Stop handlers (38 handler slots total).
  The single commands URL is classified only after origin/CSRF/session checks
  and a bounded JSON read. When all body readers are occupied, a newly verified
  request evicts the oldest incomplete upload with 429 before it can dispatch.
  This prevents slow uploads from locking priority discovery. Completed ordinary
  commands still require ordinary handler capacity; only validated Stop uses
  reserved handlers. No rejected/evicted command is queued or replayed.
- Eight active upstream requests total: seven ordinary requests and one reserved
  Stop request. OAuth, searches, SSE polls and ordinary commands cannot use that
  reserved slot. An additional concurrent Stop gets 429; no unbounded priority
  queue exists. Fixed upstream origins retain at most four idle sockets each.
- 16 KiB command bodies, 16 KiB headers, 4 KiB URLs, 4 MiB upstream JSON,
  1 MiB SSE snapshots, 16 MiB static assets, 4 MiB encrypted auth storage.
- 4,096 device sessions, 256 OAuth transactions, 2,048 keys in each of the
  independent anonymous and authenticated rate-limit maps. Capacity
  failures return 429 without evicting a live authenticated device.
- 32 SSE streams total, 2 per device. The bot change feed (one held long poll on
  its own socket, outside the upstream pool) wakes same-guild streams for a fresh
  read; while it is healthy each stream also polls every ten seconds to observe
  Discord-side revocation, otherwise every three seconds after the previous
  poll/write finishes. No overlapping polls or snapshot replay buffers. Heartbeat every ten seconds; slow consumers close after five seconds
  without drain; streams rotate after a maximum thirty-minute lifetime. A wake
  that the stream's last read already covers (bot change cursor) is skipped.
  Streams and JSON replies except bootstrap are compressed when accepted.
- 10-second request/body-read/ordinary-upstream deadline; commands have a bounded
  90-second upstream deadline for the bot's bounded imports. The command socket
  timeout also permits that deadline; body-read limits remain ten seconds.
  Headers/keepalive have five-second deadlines. Disconnect cancels the upstream
  request; shutdown closes all streams and transports. Loss of the portal never
  stops Discord audio.
- Per-device 120 ordinary API requests/minute, 30 ordinary commands/minute, and
  an independent 30 Stops/minute. Authenticated logout has its own 30/minute
  device budget. Valid callbacks use single-use ten-minute browser-bound state,
  the 256 pending-state bound and ordinary handler/upstream capacity; anonymous
  rate quotas cannot consume their budget. Unknown/expired/replayed state fails
  before Discord exchange. Anonymous starts have a 20/minute socket-peer limit;
  anonymous routes share a separate aggregate 1,200/minute peer limit and a
  separate bounded limiter map. Forwarded client-IP headers are ignored. Funnel
  shares the anonymous start quota across visitors, so new starts may get 429
  until its window resets; pending valid callbacks, signed-in APIs and logout
  remain independent. This is a deliberate aggregate bound, not a client-IP claim.
- Static serving rejects dot segments, malformed/recursive encoding, hidden files,
  non-web extensions, directories, and resolved paths outside the build root.
  Missing extensionless UI routes get the SPA; `/api` and `/auth` never do.
- `/api/**` responses carry `Server-Timing` (`portal`, `bridge`, and the bot's
  `bot`/`discord`) with fixed names and durations only. A missing or malformed bot
  timing header is dropped. See *Measuring latency* in `portal/web/README.md`.
- `/health` exposes only readiness booleans, with 503 when bridge/static/auth
  readiness is missing. Upstream error details are replaced by safe fixed text;
  HTTP 400/401/403/404/409/429/503 meanings are preserved.

The HTTP suite includes the independent review's three actual-HTTP security
reproductions as passing regression expectations: a partial command is never
forwarded after logout/rotation/expiry; Stop reaches the bridge with every
ordinary upstream/inbound slot occupied (including slow uploads); exhausted
anonymous start/aggregate quotas do not block valid callbacks or device logout.
The combined regression saturates both the portal and real bot HTTP bridge,
executes the hardened Stop lane, releases a pending lookup, and proves that the
cancelled addition cannot enqueue, reconnect or restore the discarded checkpoint.
Run just those with
`node --test --test-name-pattern="Security regression" portal/server/test/server.test.js`.
The historical `.artifacts/portal-security-review/api_repro.mjs` asserts the old
faulty behavior and is intentionally not a passing post-fix regression suite.

The full HTTP suite also proves OAuth state/fixation/rotation/expiry, encrypted restart,
device-specific logout, actor isolation, exact origin/CSRF, contract forwarding,
fresh permission checks, revision conflicts, no write replay, bounded requests,
timeouts/malformed upstream replies, SSE heartbeat/loss/disconnect/backpressure/
connection/payload bounds, traversal/junction defense, and production test refusal.
Live Discord registration, actual bot adapter policy, real UI/PWA behavior, and
public HTTPS/SSE/mobile/load behavior remain root integration/release gates.

Favorite play/removal, historical replay and confirmed mix deletion require the
selected public item identity or mix version from the library response. These
bounded command-specific tokens are forwarded with the server-owned actor ID;
the bot resolves and checks the authoritative reference at execution time.
Changed selections return 409, with no automatic mutation replay.
