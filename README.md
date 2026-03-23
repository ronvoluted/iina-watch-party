# IINA Watch Party

Synchronized video playback for two [IINA](https://iina.io) users over a real-time WebSocket channel. No media streaming — only playback state (play, pause, seek, speed, position) is synced.

## Architecture

A Bun monorepo with three packages:

```
packages/
├── shared/   # Protocol types, validation, sync engine
├── worker/   # Cloudflare Worker + Durable Objects backend
└── plugin/   # IINA macOS plugin (client)
```

### Backend

A Cloudflare Worker routes HTTP and WebSocket traffic. Each room is a Durable Object instance keyed by room code.

- `POST /api/rooms` — creates a room, returns room code and WebSocket URL
- `GET /api/rooms/:code` — room existence check
- `GET /ws/:code` — WebSocket upgrade; client authenticates via first message

Room state (expiry, host session) lives in the Durable Object's SQLite storage. Rooms expire after 24 hours via alarm. The worker serves CORS headers (`Access-Control-Allow-Origin: *`) on all responses because the plugin's fetch runs in a WKWebView browser context.

### Plugin

The plugin has three components defined in `Info.json`:

- **Main entry** (`src/main.ts`) — orchestrates connection state, room lifecycle, sync engine, and player event listeners. Runs in IINA's JavaScriptCore context (no browser APIs).
- **Sidebar webview** (`ui/sidebar/`) — renders the room management UI (create, join, leave, copy room code, peer status, warnings). Also hosts the **WebSocket transport bridge** and **HTTP fetch bridge**, since the sidebar is the only webview with a reliable bidirectional `postMessage`/`onMessage` channel to the main entry.
- **Overlay webview** (`ui/overlay/`) — loaded but currently unused. IINA's overlay webview does not reliably relay messages back to the main entry, so all network transport was moved to the sidebar.
- **Preferences page** (`prefs/index.html`) — backend URL, display name, drift threshold. Saves eagerly on keystroke to avoid data loss when switching IINA settings tabs.

#### Message flow

```
IINA Player Events                  Cloudflare
  (pause, seek, speed)              Worker + DO
        │                               ▲
        ▼                               │
   ┌─────────┐  postMessage/onMessage  ┌─────────────┐
   │  Main   │◄───────────────────────►│  Sidebar    │
   │ (JSC)   │                         │  (WKWebView)│
   └─────────┘                         └─────────────┘
        │                               │         │
        │  sync engine                  │ WS      │ fetch
        │  echo suppression             │ bridge  │ bridge
        ▼                               ▼         ▼
   local player                     wss://...   https://...
   commands                         (room)      (room create)
```

All webview loading and `onMessage` handler registration happens inside `iina.event.on("iina.window-loaded", ...)` — IINA requires a player window to exist before webviews can be initialised.

### Shared

Pure TypeScript with no runtime dependencies:

- **Protocol types** — discriminated unions for all message types with a common envelope (`type`, `protocolVersion`, `sessionId`, `messageId`, `tsMs`)
- **Runtime validation** — validates unknown JSON input, rejects malformed/oversized messages
- **Sync engine** — pure state machine that takes actions (local/remote play, pause, seek, speed, heartbeat) and returns effect descriptors (seek, set-paused, send-play, etc.) with no side effects
- **Room code parsing** — parses and validates 6-character room codes
- **File mismatch** — compares duration metadata to surface warnings

## Sync model

The room creator is the **host**; the joiner is the **guest**. The host is authoritative for initial sync, reconnect sync, and drift correction target.

Both participants send explicit intents (play, pause, seek, speed). The authority rule prevents symmetric drift-correction loops. The guest compares its position against host heartbeats every 5 seconds and corrects if drift exceeds the configured threshold (default 2s).

Echo suppression uses a 500ms time window to prevent feedback loops when applying remote commands locally.

## Features

- **Host-authoritative sync** with automatic drift correction (default threshold: 2s)
- **Echo suppression** prevents feedback loops when applying remote commands
- **File mismatch detection** warns when filenames or durations differ
- **Automatic reconnection** with exponential backoff (up to 10 attempts)
- **Session replacement** — reconnecting with the same session ID replaces the stale socket
- **Room expiry** after 24 hours
- **Rate limiting** on room creation (IP-based) and WebSocket messages (token bucket)
- **Structured logging** across plugin and worker
- **File-change auto-leave** — loading a different file mid-session disconnects cleanly

## Prerequisites

- [Bun](https://bun.sh) runtime
- [IINA](https://iina.io) with plugin support (macOS)
- [Cloudflare](https://cloudflare.com) account (for deployment)

## Setup

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Link plugin to IINA for development
bun run link

# Deploy worker to Cloudflare
bun run deploy
```

After deploying, set the `backendUrl` preference in IINA's plugin settings to your Worker URL. The plugin ships with `*.workers.dev:*` in `allowedDomains`, so any Cloudflare Worker subdomain works out of the box. If you use a custom domain, add it to `allowedDomains` in `packages/plugin/Info.json` and rebuild.

## Scripts

| Command | Description |
|---------|-------------|
| `bun run build` | Build all packages |
| `bun run build:shared` | Build shared package |
| `bun run build:worker` | Build worker package |
| `bun run build:plugin` | Build plugin package |
| `bun run test` | Run all tests |
| `bun run test:shared` | Run shared package tests |
| `bun run test:worker` | Run worker package tests |
| `bun run test:plugin` | Run plugin package tests |
| `bun run test:root` | Run root-level scaffold tests |
| `bun run lint` | Run ESLint |
| `bun run typecheck` | TypeScript type checking |
| `bun run clean` | Remove all build artifacts |
| `bun run link` | Build and link plugin to IINA |
| `bun run pack` | Build and package plugin as .zip |
| `bun run deploy` | Build and deploy worker to Cloudflare |

## Protocol

Rooms are identified by a 6-character room code. Two roles exist: **host** (creates the room) and **guest** (joins).

**Messages:** `auth`, `auth-ok`, `auth-error`, `play`, `pause`, `seek`, `speed`, `state`, `heartbeat`, `presence`, `warning`, `error`, `goodbye`

The sync engine is a pure state machine in `packages/shared/src/sync.ts` — no side effects, just state transitions and effect descriptors.

## Configuration

Plugin preferences (configurable in IINA):

| Preference | Default | Description |
|------------|---------|-------------|
| `backendUrl` | `""` | Worker deployment URL |
| `displayName` | `""` | Display name shown to peer |
| `driftThresholdMs` | `2000` | Position drift before corrective seek (ms) |

See [GOTCHAS.md](GOTCHAS.md) for operational notes, limits, and known quirks.
