import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ── Script definitions ──────────────────────────────────────────────────

describe("root scripts", () => {
  const pkg = readJson(join(ROOT, "package.json"));

  test("build script builds shared, worker, then plugin in order", () => {
    expect(pkg.scripts.build).toBe(
      "bun run build:shared && bun run build:worker && bun run build:plugin",
    );
  });

  test("pack script builds then packs plugin", () => {
    expect(pkg.scripts.pack).toBe(
      "bun run build && bun run --filter @iina-watch-party/plugin pack",
    );
  });

  test("link script builds then links plugin", () => {
    expect(pkg.scripts.link).toBe(
      "bun run build && bun run --filter @iina-watch-party/plugin link",
    );
  });

  test("deploy script builds then deploys worker", () => {
    expect(pkg.scripts.deploy).toBe(
      "bun run build && bun run --filter @iina-watch-party/worker deploy",
    );
  });

  test("clean script removes all build artifacts", () => {
    expect(pkg.scripts.clean).toBe(
      "rm -rf packages/*/dist packages/plugin/build",
    );
  });
});

describe("plugin scripts", () => {
  const pkg = readJson(join(ROOT, "packages/plugin/package.json"));

  test("build delegates to build.ts", () => {
    expect(pkg.scripts.build).toBe("bun run scripts/build.ts");
  });

  test("link calls iina-plugin link", () => {
    expect(pkg.scripts.link).toBe("iina-plugin link build");
  });

  test("pack calls iina-plugin pack", () => {
    expect(pkg.scripts.pack).toBe("iina-plugin pack build");
  });
});

describe("worker scripts", () => {
  const pkg = readJson(join(ROOT, "packages/worker/package.json"));

  test("build runs wrangler dry-run", () => {
    expect(pkg.scripts.build).toBe("wrangler deploy --dry-run --outdir dist");
  });

  test("deploy runs wrangler deploy", () => {
    expect(pkg.scripts.deploy).toBe("wrangler deploy");
  });

  test("dev runs wrangler dev", () => {
    expect(pkg.scripts.dev).toBe("wrangler dev");
  });
});

// ── Build pipeline integration ──────────────────────────────────────────

describe("build pipeline", () => {
  const outDir = join(tmpdir(), `scripts-test-build-${Date.now()}`);

  afterAll(() => {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true });
  });

  test("plugin build produces valid output", async () => {
    const pluginDir = join(ROOT, "packages/plugin");
    const proc = Bun.spawn(
      ["bun", "run", join(pluginDir, "scripts/build.ts")],
      {
        cwd: pluginDir,
        env: { ...process.env, BUILD_OUT_DIR: outDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Build failed (exit ${exitCode}):\n${stderr}`);
    }
    expect(exitCode).toBe(0);
  });

  test("build output contains all required files", () => {
    const required = [
      "Info.json",
      "src/main.js",
      "ui/overlay/index.html",
      "ui/overlay/index.js",
      "ui/sidebar/index.html",
      "ui/sidebar/index.js",
      "prefs/index.html",
    ];
    for (const file of required) {
      expect(existsSync(join(outDir, file))).toBe(true);
    }
  });

  test("pack produces a .iinaplgz file", async () => {
    const pluginDir = join(ROOT, "packages/plugin");

    // Remove any existing pack output to avoid the overwrite prompt
    const existing = new Bun.Glob("*.iinaplgz").scanSync({ cwd: pluginDir });
    for (const f of existing) {
      rmSync(join(pluginDir, f));
    }

    // Build first
    const buildProc = Bun.spawn(["bun", "run", "build"], {
      cwd: pluginDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await buildProc.exited;

    const proc = Bun.spawn(["iina-plugin", "pack", "build"], {
      cwd: pluginDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Pack failed (exit ${exitCode}):\n${stderr}`);
    }

    // iina-plugin pack produces a .iinaplgz file in the plugin directory
    const files = new Bun.Glob("*.iinaplgz").scanSync({ cwd: pluginDir });
    const plugFiles = Array.from(files);
    expect(plugFiles.length).toBeGreaterThan(0);

    // Clean up
    for (const f of plugFiles) {
      rmSync(join(pluginDir, f));
    }
  });
});
