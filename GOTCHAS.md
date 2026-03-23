# Gotchas & Operator Notes

Operational knowledge for deploying, running, and debugging IINA Watch Party.

## Deployment

### Plugin `allowedDomains` is localhost-only

`packages/plugin/Info.json` restricts network access to `localhost:*` and `127.0.0.1:*`. You **must** add your Worker's domain before deploying to users — the plugin silently fails to connect otherwise.

### `backendUrl` defaults to empty

The plugin preference `backendUrl` ships as `""`. Users must set it manually in IINA's plugin preferences. There is no validation or helpful error if it stays empty.

### Cloudflare Durable Object migration tag

`wrangler.toml` declares a `v1` migration with `new_sqlite_classes = ["Room"]`. If you rename the DO class or add a new one, you need a new migration tag — Cloudflare will reject deploys that modify an existing tag.

## Limits & Thresholds

All values are hardcoded constants. Changing them requires a code change and redeploy.

| Constant | Value | Location |
|----------|-------|----------|
| Room TTL | 24 hours | `worker/src/room.ts` |
| Auth timeout | 10 s | `worker/src/room.ts` |
| Max participants per room | 2 | `worker/src/room.ts` |
| Max message size | 8 KB | `worker/src/room.ts`, `shared/src/constants.ts` |
| Room code length | 6 chars | `shared/src/constants.ts` |
| Heartbeat interval | 5 s | `plugin/src/main.ts` |
| Drift threshold (default) | 2000 ms | `plugin/Info.json` (user-configurable) |
| Drift correction cooldown | 5000 ms | `shared/src/sync.ts` |
| Echo suppression window | 500 ms | `shared/src/sync.ts` |
| File duration tolerance | 5 s | `worker/src/room.ts`, `shared/src/file-mismatch.ts` |
| WS rate limit burst | 20 tokens | `worker/src/room.ts` |
| WS rate limit refill | 10 tokens/s | `worker/src/room.ts` |
| HTTP rate limit (room creation) | 10 req / 60 s per IP | `worker/src/index.ts` |
| IP rate limiter prune interval | every 100 requests | `worker/src/index.ts` |
| Max reconnect attempts | 10 | `plugin/ui/overlay/index.js` |
| Reconnect base delay | 1 s | `plugin/ui/overlay/index.js` |
| Reconnect max delay | 30 s | `plugin/ui/overlay/index.js` |

## Rate Limiting

### IP rate limiter is per-isolate

`IpRateLimiter` uses an in-memory `Map`. Each Cloudflare Worker isolate has its own instance, so the effective limit is per-isolate, not globally per-IP. Under high load with multiple isolates, a single IP can exceed the intended 10-requests-per-minute cap.

### WebSocket rate limit disconnects

Exceeding the message rate (20 burst / 10 per second) closes the socket with code `4003`. The client does not auto-retry on rate-limit disconnects — the user must rejoin.

## WebSocket Close Codes

| Code | Meaning |
|------|---------|
| `4000` | Connection replaced (reconnect with same session) |
| `4001` | Not authenticated |
| `4002` | Room expired |
| `4003` | Rate limited or missing credentials |
| `4004` | Room not found |
| `4005` | Room full |

## Sync Engine

### Host-authoritative model

Only the guest corrects drift. The host's playback state is the source of truth. If the host has a laggy connection, both users experience degraded sync.

### Correction cooldown prevents rapid seeks

After a corrective seek, the engine waits 5000 ms before correcting again. Rapid position changes during this window are not corrected until the cooldown expires.

### Echo suppression is time-based

When a remote command is applied locally, a 500 ms suppression window prevents the resulting local player event from being re-sent. If the local player takes longer than 500 ms to fire the event (e.g., slow seek on large files), the echo may leak through.

### Buffering pauses drift correction

While `mpv.paused-for-cache` is true, the sync engine skips drift correction. A long buffer stall will accumulate drift that is only corrected after buffering ends.

## Reconnection

- Exponential backoff: 1 s, 2 s, 4 s, 8 s, 16 s, 30 s, 30 s, 30 s, 30 s, 30 s (10 attempts max).
- After 10 failures, the client gives up permanently. There is no manual reconnect — the user must leave and rejoin.
- Reconnecting with the same `sessionId` restores the original role (host/guest) and replaces the old socket.

## Room Lifecycle

- Rooms expire 24 hours after creation. There is no renewal mechanism.
- Room codes are 6 alphanumeric characters. On collision (unlikely), the worker retries up to 5 times.
- Secrets are SHA-256 hashed before storage — the plaintext is never persisted. Losing the invite string means the room is inaccessible.

## Testing

### Vitest + Cloudflare Workers pool quirks

Worker tests use `@cloudflare/vitest-pool-workers`. SQLite-backed Durable Objects require:
- `isolatedStorage: false` (SQLite WAL files break test isolation)
- `singleWorker: true`
- Unique room codes per test to avoid cross-test interference

### Plugin tests mock IINA globals

Plugin tests define mock `iina`, `core`, `mpv`, `http`, `overlay`, `sidebar`, `preferences`, and `console` globals. If the IINA plugin API changes, these mocks must be updated manually.
