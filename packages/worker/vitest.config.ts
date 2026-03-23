import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        // Disabled: SQLite-backed DOs produce WAL journal files that break
        // the isolated storage stack frame cleanup. Each test uses unique
        // room codes to avoid cross-test interference.
        isolatedStorage: false,
        singleWorker: true,
      },
    },
  },
});
