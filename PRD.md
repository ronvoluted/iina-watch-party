# IINA Watch Party Plugin - Product Requirements Document

## 1. Executive summary

Build a lightweight watch-party plugin for the IINA macOS video player that keeps two trusted users in sync while watching the same local media file. The plugin will not stream media, manage accounts, or store personal data. It will synchronize playback intent and playback state over a Cloudflare-backed real-time channel.

## 2. Problem statement

Two people often want to watch the same local video together while apart. Today they can manually count down and try to stay aligned, but this breaks on play, pause, seek, playback speed changes, buffering, reconnects, and file mismatches.

The product should let one user create a room, share a single invite string, and keep the second user aligned with minimal friction.

## 3. Product goals

1. Make a two-person watch party start quickly.
   - Create or join in under 30 seconds once the backend is configured.
2. Keep both viewers perceptually in sync during normal playback.
   - Play, pause, seek, speed, reconnect, and drift correction should feel reliable.
3. Keep the security model lightweight but real.
   - No accounts, no cookies, no media upload, but still use TLS, room secrets, short room lifetime, and validation.
4. Keep the implementation simple enough for a robust v1.
   - Avoid unnecessary platform complexity and reduce hidden coupling between IINA and backend behavior.
5. Make the system debuggable.
   - Structured logs, deterministic protocol messages, and isolated sync logic tests are first-class requirements.

## 4. Non-goals for v1

- Media streaming or transcoding
- More than two active participants in one room
- Accounts, profiles, friends lists, or persistent social features
- Cross-player support beyond IINA
- Rich text chat or global-entry room joining in the MVP
- Deep-link protocol handlers such as `watchparty://` in the MVP
- Long-term secret persistence across app restarts

## 5. Users and assumptions

- Two users who know and trust each other
- Both users already have the media file locally
- Minor file differences may exist and must be detected and surfaced
- Users are on macOS using the current documented IINA plugin API
- The backend may be self-hosted by the plugin author or by the user deploying the Worker

## 6. Product scope

### 6.1 MVP scope

The MVP must include:

- Create room from a loaded IINA player window
- Join room from a loaded IINA player window
- Single invite string copy/paste UX
- Real-time sync for play, pause, seek, and playback speed changes
- Initial sync on connect and re-sync on reconnect
- Heartbeat-based drift correction using a host-authoritative model
- File mismatch warning based on exchanged metadata
- Leave flow and window-close cleanup
- Reconnection with exponential backoff
- Sidebar UI for create, join, connection state, invite copy, warnings, and leave
- Preferences page for backend URL, display name, and drift threshold
- Worker plus Durable Object backend
- Structured logs on both client and server
- Automated tests for shared sync logic and backend integration
- Build, link, pack, and deploy scripts
- README with setup and usage instructions

### 6.2 Post-MVP scope

These are intentionally deferred until after the MVP is stable:

- Global-entry room joining when no player window is open
- Optional sidebar text chat
- Alternate invite formats such as custom URL schemes
- Short-lived WebSocket tickets instead of first-message auth
- Persistent secret storage as an opt-in preference

## 7. Success metrics

- A user can create a room and share an invite from the sidebar in a single flow.
- A second user can paste the invite and join without manually entering separate code and secret values.
- Play, pause, seek, and speed changes apply to the peer reliably in manual end-to-end testing.
- Reconnect succeeds without forcing users to recreate the room in common transient network failures.
- File mismatch is surfaced clearly when media duration differs beyond tolerance.
- Automated tests cover protocol validation, sync state transitions, echo suppression behavior, Worker routing, Durable Object connection lifecycle, and room expiry behavior.

## 8. Verified platform notes and constraints

The implementation must follow these current platform notes:

1. IINA manifest naming
   - Use `globalEntry` as the current manifest key for a global entry point.
   - Note: the current IINA Global Entry tutorial page still shows the older `global` example, so the implementation must treat the current Development Guide and the actual scaffold output as source of truth.

2. IINA webviews and WebSocket transport
   - Overlay and sidebar webviews communicate with plugin scripts via `postMessage` and `onMessage`.
   - Webviews can use standard browser APIs such as `fetch` and `WebSocket`, but cannot call IINA APIs directly.
   - `iina.ws` creates local `ws://` WebSocket servers and does not support `wss://`, so it must not be used as the outbound transport to the backend.

3. IINA playback API details
   - `core.seek(seconds, exact)` is the relative seek API.
   - `core.seekTo(seconds)` is the absolute seek API and does not take an `exact` flag.
   - Global entry can create player instances and message main entries, but it is not required in v1.

4. Bun workspaces
   - Declare workspaces in the root `package.json`.
   - Use Bun for install, scripts, bundling, and pure TypeScript test execution where appropriate.

5. Cloudflare Durable Objects
   - Use SQLite-backed Durable Objects for new classes.
   - Durable Objects are the source of truth for room state and auth state.
   - Keep the server event-driven so WebSocket hibernation remains effective.
   - Use alarms for idle cleanup and absolute expiry, not long-lived timers.

6. Cloudflare Worker testing
   - Use the Workers Vitest integration for Worker and Durable Object runtime tests.
   - Keep Bun-based tests for pure TypeScript modules that do not need the Workers runtime.

7. Rate limiting
   - Prefer Cloudflare's rate-limiting bindings if available in the deployment environment.
   - If anonymous usage forces an IP-based fallback, document the tradeoff and keep limits conservative.

8. Deployment limits and pricing
   - Do not bake exact Cloudflare free-tier request or duration numbers into the product design.
   - Verify pricing and limits at deployment time.

## 9. Product and architecture decisions

### 9.1 Repository layout

Use a single repository with Bun workspaces declared in the root `package.json`.

Suggested layout:

```text
/
  package.json
  bun.lock
  tsconfig.base.json
  eslint.config.js
  .prettierrc
  /packages
    /plugin
    /worker
    /shared
```

Workspace responsibilities:

- `packages/plugin`: IINA plugin source, webviews, manifest, build scripts
- `packages/worker`: Cloudflare Worker, Durable Object, Wrangler config, Worker tests
- `packages/shared`: Protocol types, runtime validation, sync state machine, shared utilities

### 9.2 Plugin architecture

The plugin will use:

- Main entry: required in v1
- Overlay webview: required, invisible, non-interactive, owns the outbound browser WebSocket connection
- Sidebar webview: required for room management UI
- Preferences page: required
- Global entry: deferred to post-MVP

The plugin must keep the networking and sync state logic outside the webviews as much as possible. The overlay is a transport bridge, not the place for playback logic.

### 9.3 Manifest and permissions

The manifest must be generated for the current scaffold and verified during Phase 0.

Rules:

- Use `globalEntry` only if and when the post-MVP global flow is implemented.
- Use `sidebarTab`, `preferencesPage`, and `preferenceDefaults`.
- Restrict `allowedDomains` to the configured backend domain(s), including local development hosts as needed.
- Minimize permissions.

Expected baseline permissions to validate against the current scaffold and docs:

- `show-osd`
- `network-request`
- `video-overlay`

Add `file-system` only if the final mismatch heuristic or file metadata collection actually requires it.

Do not assume undocumented or stale permission names such as `control-player`, `observe-events`, `show-sidebar`, or `add-menu-item` unless the current scaffold or docs explicitly confirm them.

### 9.4 Backend architecture

The backend consists of:

- A Worker HTTP router for room creation and WebSocket upgrades
- One Durable Object instance per room code
- SQLite-backed Durable Object storage as the authoritative store for room metadata

Important design decision:

- Remove Workers KV from the room critical path.

Why:

- The room code already deterministically names the Durable Object.
- Durable Object storage is strongly consistent and colocated with the room instance.
- A `roomCode -> doId` KV mapping is redundant and introduces eventual-consistency risk immediately after room creation.

Workers KV may be added later for optional analytics, rate-limit counters, or non-critical lookup caches, but it is not required for room creation or joining.

### 9.5 Auth and secret handling

The security model remains lightweight but is more explicit than the original brief.

Requirements:

- Room codes are short, human-friendly, and not sufficient on their own.
- A secret is generated at room creation and must be shared out of band.
- The Durable Object stores a hash of the secret, not the raw secret.
- The client keeps the raw secret in memory only for the session.
- Do not store the secret in Keychain by default in v1.
- Use WSS for the browser WebSocket connection.
- Do not put the room secret into the WebSocket query string.

Chosen v1 auth design:

- The browser WebSocket connects to `/ws/:code` without the secret in the URL.
- The first client message must be an `auth` message containing the room secret and session metadata.
- The Durable Object starts an unauthenticated timeout when the socket is accepted and closes the connection if auth does not arrive promptly.

Future option, post-MVP:

- Exchange the room secret for a short-lived WebSocket ticket over HTTPS before opening the socket.

### 9.6 Participant model and connection replacement

The room supports at most two active participants.

However, the backend must not blindly reject a reconnecting user as a third connection. Instead:

- Each client has a stable in-memory `sessionId` for the life of the room session.
- If a new authenticated socket arrives with the same `sessionId` as an existing participant, the Durable Object must replace the stale socket.
- A truly third participant must be rejected.

### 9.7 Sync authority model

The room creator is the host.

The host is authoritative for:

- Initial sync when the second user joins
- Re-sync after reconnect
- Drift correction target state

Both participants still send explicit user intents such as play, pause, seek, and speed changes. The authority rule exists to prevent symmetric drift-correction loops and reconnect tug-of-war.

### 9.8 Observability

Structured logs are required on both sides.

Minimum fields:

- room code suffix or redacted room identifier
- sessionId
- participant role
- message type
- connection state transition
- local action vs remote action
- reason codes for reconnect, reject, warning, or expiry

This is not optional. Real-time sync bugs are otherwise too hard to debug.

## 10. User experience

### 10.1 Create room flow

1. User opens a file in IINA.
2. User opens the plugin sidebar.
3. User clicks `Create Room`.
4. Plugin calls `POST /api/rooms`.
5. Backend returns room code, secret, websocket URL, expiry time, and a combined invite string.
6. Plugin opens the overlay WebSocket bridge.
7. Plugin authenticates as host.
8. Sidebar shows:
   - connected or waiting state
   - room code
   - combined invite string
   - `Copy Invite` button
   - peer status
   - `Leave` button

### 10.2 Join room flow

1. User opens a file in IINA.
2. User opens the plugin sidebar.
3. User pastes the invite string into a single field.
4. Plugin parses room code and secret.
5. Plugin opens the overlay WebSocket bridge.
6. Plugin authenticates as guest.
7. On success, sidebar shows connected state and waits for initial sync.
8. If parsing, connection, or auth fails, show both sidebar feedback and OSD feedback.

### 10.3 Invite format

v1 requires a single copy-paste invite format.

Recommended format:

```text
ABCDEF:base64url_secret_here
```

Requirements:

- The create flow must include a `Copy Invite` action.
- The join UI must accept the combined invite string.
- The join UI may optionally accept separate code and secret fields as a fallback, but the combined string is the primary UX.

### 10.4 Leave flow

When the user clicks `Leave` or closes the player window:

- Close the WebSocket cleanly with a normal close code.
- Send a `goodbye` message if possible before closing.
- Clear room state, peer state, invite secret, reconnect counters, and suppression state.
- Update sidebar and menu state.
- Show peer-left feedback to the other participant.

## 11. Protocol v1

All protocol messages use a common envelope.

### 11.1 Common envelope

```ts
{
  type: string,
  protocolVersion: 1,
  sessionId: string,
  messageId: string,
  tsMs: number
}
```

Rules:

- `protocolVersion` is required on every message.
- `tsMs` uses integer milliseconds.
- `messageId` is unique per sender and used for dedupe and debugging.
- `sessionId` identifies the logical participant session and is stable across reconnects.

### 11.2 Messages

#### `auth`

Sent first by the client after WebSocket open.

```ts
{
  type: "auth",
  protocolVersion: 1,
  sessionId,
  messageId,
  tsMs,
  secret: string,
  displayName?: string,
  desiredRole?: "host" | "guest",
  file: {
    name?: string,
    durationMs?: number,
    sizeBytes?: number
  }
}
```

#### `auth-ok`

Sent by the server after successful auth.

```ts
{
  type: "auth-ok",
  protocolVersion: 1,
  sessionId: "server",
  messageId,
  tsMs,
  role: "host" | "guest",
  roomCode: string,
  expiresAtMs: number,
  peerPresent: boolean
}
```

#### `auth-error`

Sent by the server before close when auth fails.

```ts
{
  type: "auth-error",
  protocolVersion: 1,
  sessionId: "server",
  messageId,
  tsMs,
  code: string,
  message: string
}
```

#### `presence`

Server-emitted presence update.

```ts
{
  type: "presence",
  protocolVersion: 1,
  sessionId: "server",
  messageId,
  tsMs,
  event: "peer-joined" | "peer-left" | "peer-replaced",
  role: "host" | "guest"
}
```

#### `state`

Full playback snapshot. Host authoritative.

```ts
{
  type: "state",
  protocolVersion: 1,
  sessionId,
  messageId,
  tsMs,
  reason: "initial" | "reconnect" | "manual",
  positionMs: number,
  paused: boolean,
  speed: number,
  buffering?: boolean
}
```

#### `play`

```ts
{
  type: "play",
  protocolVersion: 1,
  sessionId,
  messageId,
  tsMs,
  positionMs: number
}
```

#### `pause`

```ts
{
  type: "pause",
  protocolVersion: 1,
  sessionId,
  messageId,
  tsMs,
  positionMs: number
}
```

#### `seek`

```ts
{
  type: "seek",
  protocolVersion: 1,
  sessionId,
  messageId,
  tsMs,
  positionMs: number,
  cause: "user" | "drift-correction"
}
```

#### `speed`

```ts
{
  type: "speed",
  protocolVersion: 1,
  sessionId,
  messageId,
  tsMs,
  speed: number
}
```

#### `heartbeat`

```ts
{
  type: "heartbeat",
  protocolVersion: 1,
  sessionId,
  messageId,
  tsMs,
  positionMs: number,
  paused: boolean,
  speed: number,
  buffering?: boolean,
  seeking?: boolean
}
```

#### `warning`

```ts
{
  type: "warning",
  protocolVersion: 1,
  sessionId,
  messageId,
  tsMs,
  code: "file-mismatch" | "peer-buffering" | "room-expiring",
  message: string
}
```

#### `goodbye`

```ts
{
  type: "goodbye",
  protocolVersion: 1,
  sessionId,
  messageId,
  tsMs,
  reason: string
}
```

#### `error`

```ts
{
  type: "error",
  protocolVersion: 1,
  sessionId,
  messageId,
  tsMs,
  code: string,
  message: string
}
```

### 11.3 Validation

The shared package must define both:

- TypeScript discriminated unions for all protocol messages
- Runtime validation functions for unknown JSON input

Validation rules:

- Reject unknown message types.
- Reject messages larger than 8 KB.
- Reject non-JSON payloads.
- Reject missing or malformed envelope fields.
- Reject invalid numeric values such as negative positions, non-finite numbers, or unsupported playback speeds.

## 12. Functional requirements

### FR-1 Room creation

- `POST /api/rooms` creates a room.
- Room code length is 6 characters.
- Use a human-friendly alphabet that excludes ambiguous characters.
- Room creation initializes the Durable Object atomically and retries on code collision.
- Response includes room code, raw secret, websocket URL, expiry timestamp, and combined invite string.

### FR-2 Room joining

- Joining uses the combined invite string.
- The plugin must parse and validate invite format before attempting connection.
- Guest connects to `/ws/:code` and authenticates with `auth` as the first message.

### FR-3 Overlay transport bridge

The overlay bridge is responsible for:

- opening the browser WebSocket
- forwarding plugin-to-socket outbound messages
- forwarding socket-to-plugin inbound messages
- reporting `open`, `close`, `error`, and reconnect state
- reconnecting with exponential backoff on unexpected disconnects

Bridge message names must be explicit and stable:

- `ws-connect`
- `ws-disconnect`
- `ws-send`
- `ws-open`
- `ws-message`
- `ws-closed`
- `ws-error`
- `ws-reconnecting`

### FR-4 Sidebar UI

The sidebar must support these states:

- disconnected
- connecting
- connected-waiting-for-peer
- connected-with-peer
- reconnecting
- error

The sidebar must support:

- Create Room
- Join Room
- single invite input
- Copy Invite
- Leave
- peer status
- warning display

### FR-5 Initial sync

- When a guest successfully authenticates, the host must send a full `state` snapshot.
- The guest must apply the host snapshot before normal sync processing continues.
- On reconnect, the host must send a `state` snapshot again.

### FR-6 Local intent emission

The plugin must emit protocol messages for user-initiated:

- play
- pause
- seek
- speed change

Do not use `mpv.time-pos.changed` as a seek detector.
Use seek-related events plus state transitions that are verified in Phase 0.

### FR-7 Remote action application and echo suppression

When remote commands are applied locally, the plugin must prevent feedback loops.

Requirements:

- Echo suppression must be implemented in shared sync logic, not as scattered ad hoc guards.
- The implementation may use a short suppression window plus action-type tracking.
- Suppression must cover play, pause, seek, speed, and full state application.
- Tests must prove that remote actions do not re-emit equivalent local protocol messages.

### FR-8 Drift correction

- While connected and actively playing, each client sends a heartbeat every 5 seconds.
- The guest compares its position against the host position.
- If drift exceeds the configured threshold, the guest corrects toward the host.
- Do not correct while paused, buffering, or actively seeking.
- Do not spam corrective seeks.
- Small drift below threshold should be ignored.

### FR-9 Playback speed sync

- Playback speed changes must be synced explicitly.
- Heartbeats must include speed so drift logic can reason correctly about divergence.
- If speed mismatch exists, apply speed sync before drift correction seeks whenever possible.

### FR-10 File mismatch warning

- Exchange file metadata early, preferably during `auth`.
- Minimum heuristic: filename and duration.
- If duration differs beyond tolerance, show a warning in both the sidebar and OSD.
- Do not block playback solely because of a mismatch warning.

### FR-11 Buffering and loading behavior

- Do not treat buffering as a user pause.
- While buffering, suppress non-user sync actions that would create misleading state changes.
- If one peer buffers and the other does not, show a warning and allow the host-authoritative correction path to recover state after buffering ends.
- If a new file is loaded mid-session, the plugin must either leave the room automatically or require an explicit re-sync decision. v1 should auto-leave with clear messaging.

### FR-12 Reconnection

- Unexpected disconnects trigger exponential backoff reconnects: 1s, 2s, 4s, 8s, then capped at 30s.
- Total reconnect attempts are bounded.
- On reconnect success, the client reauthenticates and the host resends full state.
- UI must clearly indicate reconnecting vs permanently failed.

### FR-13 Leave and cleanup

- Explicit leave resets all room state.
- Window close triggers the same cleanup path.
- Secret must be erased from in-memory room state on leave.
- Scheduled reconnects must be cancelled on leave.

### FR-14 Observability

- The plugin must use structured logging via `iina.console`.
- The Worker and Durable Object must emit structured JSON logs.
- Manual test instructions must include how to inspect both sides.

### FR-15 Packaging and distribution

The plugin package must support:

- build into a valid `.iinaplugin` directory
- live development via `iina-plugin link`
- distributable archive via `iina-plugin pack`

## 13. Non-functional requirements

### 13.1 Reliability

- The room must recover from common transient disconnects without user intervention.
- The system must behave deterministically under duplicate messages, reconnects, and stale socket replacement.

### 13.2 Performance

- Protocol messages are tiny and infrequent.
- The backend must avoid unnecessary storage writes on every heartbeat.
- The Durable Object must stay hibernation-friendly by avoiding unnecessary timers.

### 13.3 Security

- WSS only for backend transport
- No room secret in WebSocket query string
- Secret stored hashed server-side
- Max message size 8 KB
- Message validation on both sides
- Max two active participants
- Rate limit room creation and repeated join attempts

### 13.4 Privacy

- No user accounts
- No cookies
- No media upload
- No persistent personal identifiers beyond ephemeral room metadata
- Logs must avoid full raw secrets and full invite strings

### 13.5 Compatibility

- Target the current documented IINA plugin API and verify exact scaffold behavior during Phase 0.
- Use the current Wrangler and Workers tooling supported by Cloudflare docs at implementation time.

## 14. API surface

### 14.1 Worker routes

#### `POST /api/rooms`

Creates a room and initializes the Durable Object.

Response:

```json
{
  "roomCode": "ABCDEF",
  "secret": "raw_secret",
  "invite": "ABCDEF:raw_secret",
  "wsUrl": "wss://example.com/ws/ABCDEF",
  "expiresAtMs": 0
}
```

#### `GET /api/rooms/:code`

Optional existence and metadata check for join UX. This route is useful but not required for the core protocol.

Possible response:

```json
{
  "exists": true,
  "expiresAtMs": 0
}
```

#### `GET /ws/:code`

WebSocket upgrade to the room Durable Object. The client authenticates in the first message.

### 14.2 Durable Object stored state

Minimum stored fields:

- roomCode
- secretHash
- createdAtMs
- expiresAtMs
- hostSessionId
- lastKnownHostState
- optional participant metadata needed across hibernation

Avoid storing fast-changing heartbeat history unless it becomes necessary.

## 15. Testing strategy

### 15.1 Shared and plugin sync logic

Use Bun-driven tests for pure TypeScript logic in `packages/shared`.

Must test:

- protocol validation
- state machine transitions
- invite parsing
- echo suppression
- drift correction decision rules
- reconnect state transitions
- file mismatch detection rules

### 15.2 Worker and Durable Object tests

Use Workers Vitest integration for runtime-accurate tests.

Must test:

- `POST /api/rooms`
- invalid routes and methods
- WebSocket upgrade path
- unauthenticated timeout
- wrong secret rejection
- third participant rejection
- stale connection replacement
- message relay
- malformed message rejection
- idle alarm cleanup
- absolute expiry behavior

### 15.3 Manual end-to-end testing

Manual testing must verify:

- create and join flow
- play sync
- pause sync
- seek sync
- speed sync
- reconnect after transient disconnect
- leave and peer-left behavior
- file mismatch warning
- buffering warning and recovery

## Agent loop notes

Read NOTES.md, which will contain progress notes left behind by your previous loop iteration.

## Tasks

16. Delivery plan and ordered implementation phases

### Phase 0 - ambiguity spike and scaffolding

Goals:

- [x] verify current IINA scaffold output
- [x] verify manifest keys and permission names
- [x] verify exact mpv and IINA events needed for pause, seek, buffering, and file-load handling
- [x] scaffold repo and build scripts

- [x] Exit criteria Phase 0:
  - monorepo exists
  - current scaffold behavior documented
  - event and permission decisions written down

### Phase 1 - shared protocol and sync brain

Goals:

- [x] define protocol types and validation
- [x] build invite parsing
- [x] implement pure sync state machine with authority rules and suppression logic
- [x] add unit tests

- [x] Exit criteria Phase 1:
  - protocol frozen for MVP
  - sync rules testable without IINA or Cloudflare runtime

### Phase 2 - backend core

Goals:

- [x] implement Worker router
- [x] implement room creation
- [x] implement Durable Object auth, relay, presence, replacement, and expiry
- [x] add Worker runtime tests

- [x] Exit criteria Phase 2:
  - create room works
  - join and relay works
  - replacement and expiry work

### Phase 3 - plugin shell

Goals:

- [x] implement plugin build pipeline
- [x] create overlay bridge
- [x] create sidebar and preferences shell
- [x] wire basic connection state

- [x] Exit criteria Phase 3:
  - plugin loads in IINA
  - sidebar renders
  - overlay bridge can connect and exchange test messages

### Phase 4 - MVP happy path

Goals:

- [x] implement create room flow
- [x] implement join flow
- [x] implement play, pause, seek, and speed sync
- [x] implement leave flow
- [x] implement initial sync

- [x] Exit criteria Phase 4:
  - two users can complete a watch party on the happy path

### Phase 5 - hardening

Goals:

- [x] implement reconnection
- [x] implement drift correction
- [x] implement file mismatch warning
- [x] implement buffering and file-change behavior
- [x] improve errors and logs
- [x] add rate limiting

- [x] Exit criteria Phase 5:
  - reconnects and warnings behave correctly
  - logs are useful enough for debugging

### Phase 6 - packaging, docs, and manual validation

Goals:

- [x] finalize build, pack, link, and deploy scripts
- [x] write README
- [x] run manual end-to-end test matrix
- [x] document gotchas and operator notes

- [x] Exit criteria Phase 6:
  - plugin is packageable and installable
  - backend is deployable
  - README is complete

### Post-MVP phase

Goals:

- global entry join flow
- optional sidebar chat
- alternate invite formats or ticket-based auth

## 17. Acceptance criteria

A release candidate is acceptable when all of the following are true:

1. Two users with matching local media can create and join a room using a single invite string.
2. Play, pause, seek, and speed changes propagate correctly between peers in manual testing.
3. Reconnect restores sync without recreating the room in common transient failure cases.
4. File mismatch is surfaced clearly.
5. Explicit leave and window-close cleanup both work.
6. The backend rejects invalid auth, malformed messages, oversized messages, and a true third participant.
7. Shared logic tests and Worker runtime tests pass.
8. The plugin can be linked for development and packed for distribution.
9. The README explains setup, deployment, and troubleshooting.

## 18. Reference notes

These references were used to align this PRD with the current documented APIs at the time of writing:

- IINA Development Guide: https://docs.iina.io/pages/dev-guide.html
- IINA Web Views: https://docs.iina.io/pages/webviews.html
- IINA Overlay API: https://docs.iina.io/interfaces/IINA.API.Overlay.html
- IINA WebSocket API: https://docs.iina.io/interfaces/IINA.API.WebSocket.html
- IINA Core API: https://docs.iina.io/interfaces/IINA.API.Core
- IINA Global Entry Point: https://docs.iina.io/pages/global-entry.html
- Cloudflare Durable Objects overview: https://developers.cloudflare.com/durable-objects/
- Cloudflare Durable Objects WebSockets: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Cloudflare Workers testing overview: https://developers.cloudflare.com/workers/testing/
- Cloudflare Workers Vitest integration: https://developers.cloudflare.com/workers/testing/vitest-integration/
- Cloudflare rate limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

## Agent loop updates

Use conventional commit messages, e.g. `feat(scope): Add blah blah blah`

Update a NOTES.md each time you finish a task with any learnings/future intent you think will be particularly pertinent for future. If there's nothing useful, feel free not to add anything. You will use it as a way to 'communicate across time' throughout the project, as each task will be a complete restart for the agent context. Use whatever encoding/language is most communicative for yourself as an agent. It doesn't even need to be English or even human-readable.
