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

**How it works:** Each IINA plugin connects via WebSocket to a Cloudflare Durable Object representing a room. The host's playback state is authoritative — the guest's player corrects drift based on periodic heartbeats.

## Features

- **Host-authoritative sync** with automatic drift correction (default threshold: 2s)
- **Echo suppression** prevents feedback loops when applying remote commands
- **File mismatch detection** warns when media durations differ
- **Automatic reconnection** with exponential backoff
- **Room expiry** after 24 hours
- **Rate limiting** on room creation and WebSocket messages
- **Structured logging** across plugin and worker

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
```

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

Rooms are identified by an invite string (`roomCode:secret`). Two roles exist: **host** (creates the room) and **guest** (joins).

**Messages:** `auth`, `play`, `pause`, `seek`, `speed`, `heartbeat`, `presence`, `warning`, `error`, `goodbye`

The sync engine is a pure state machine in `packages/shared/src/sync.ts` — no side effects, just state transitions and effect descriptors.

## Configuration

Plugin preferences (configurable in IINA):

| Preference | Default | Description |
|------------|---------|-------------|
| `backendUrl` | `""` | Worker deployment URL |
| `displayName` | `""` | Display name shown to peer |
| `driftThresholdMs` | `2000` | Position drift before corrective seek (ms) |
