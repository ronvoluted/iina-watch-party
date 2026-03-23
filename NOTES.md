# Agent Notes

## Phase 0: Scaffold complete

- Monorepo: Bun workspaces with packages/{shared,worker,plugin}
- shared: exports PROTOCOL_VERSION=1, MAX_MESSAGE_SIZE_BYTES=8192, ROOM_CODE_LENGTH=6
- worker: wrangler.toml with SQLite-backed Room DO, vitest config with @cloudflare/vitest-pool-workers
- plugin: Info.json manifest verified against scaffold — no globalEntry, permissions=[show-osd, network-request, video-overlay], allowedDomains restricted to localhost
- Plugin structure: src/main.ts, ui/overlay/, ui/sidebar/, prefs/, scripts/prepare-build.ts
- eslint configured with argsIgnorePattern "^_" for unused vars
- 22 scaffold tests in tests/scaffold.test.ts

## Decisions

- Worker env param prefixed `_env` until Phase 2 needs it
- Room DO `fetch()` takes no params (stub) — will need `request: Request` in Phase 2
- Plugin build: bun build for TS→JS, cp for static assets, prepare-build.ts creates build dir structure
- Worker build deferred to wrangler (dry-run for CI, dev/deploy for runtime)
