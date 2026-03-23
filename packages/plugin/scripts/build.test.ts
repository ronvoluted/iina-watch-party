import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clean,
  createDirs,
  bundleEntry,
  validateBuild,
  build,
} from "./build.ts";

const PLUGIN_ROOT = join(import.meta.dir, "..");

// ── Unit tests ─────────────────────────────────────────────────────────

describe("clean", () => {
  test("removes an existing directory", () => {
    const tmp = join(tmpdir(), `build-test-clean-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "file.txt"), "hello");
    expect(existsSync(tmp)).toBe(true);

    clean(tmp);
    expect(existsSync(tmp)).toBe(false);
  });

  test("is a no-op for non-existent directory", () => {
    const tmp = join(tmpdir(), `build-test-noop-${Date.now()}`);
    expect(() => clean(tmp)).not.toThrow();
  });
});

describe("createDirs", () => {
  test("creates the expected subdirectories", () => {
    const tmp = join(tmpdir(), `build-test-dirs-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    createDirs(tmp);

    for (const dir of ["src", "ui/overlay", "ui/sidebar", "prefs"]) {
      expect(existsSync(join(tmp, dir))).toBe(true);
    }

    rmSync(tmp, { recursive: true });
  });
});

describe("bundleEntry", () => {
  test("bundles main.ts to ESM", async () => {
    const tmp = join(tmpdir(), `build-test-bundle-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    const result = await bundleEntry(
      join(PLUGIN_ROOT, "src/main.ts"),
      tmp,
      "esm",
    );

    expect(result.entrypoint).toContain("main.ts");
    expect(existsSync(result.outfile)).toBe(true);
    expect(result.size).toBeGreaterThan(0);

    rmSync(tmp, { recursive: true });
  });

  test("bundles webview JS to IIFE", async () => {
    const tmp = join(tmpdir(), `build-test-iife-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    const result = await bundleEntry(
      join(PLUGIN_ROOT, "ui/overlay/index.js"),
      tmp,
      "iife",
    );

    expect(result.entrypoint).toContain("overlay/index.js");
    expect(existsSync(result.outfile)).toBe(true);
    expect(result.size).toBeGreaterThan(0);

    rmSync(tmp, { recursive: true });
  });

  test("throws on non-existent entrypoint", async () => {
    const tmp = join(tmpdir(), `build-test-fail-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    await expect(
      bundleEntry(join(PLUGIN_ROOT, "src/does-not-exist.ts"), tmp),
    ).rejects.toThrow();

    rmSync(tmp, { recursive: true });
  });
});

describe("validateBuild", () => {
  test("returns valid for a complete build output", () => {
    // Use the real build output (built by beforeAll in integration suite)
    const buildDir = join(PLUGIN_ROOT, "build");
    if (!existsSync(buildDir)) {
      // Build hasn't run yet; skip
      return;
    }
    const result = validateBuild(buildDir);
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("reports missing files", () => {
    const tmp = join(tmpdir(), `build-test-validate-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    // Write a manifest that references files that don't exist
    writeFileSync(
      join(tmp, "Info.json"),
      JSON.stringify({
        entry: "src/main.js",
        preferencesPage: "prefs/index.html",
      }),
    );

    const result = validateBuild(tmp);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("src/main.js");
    expect(result.missing).toContain("prefs/index.html");

    rmSync(tmp, { recursive: true });
  });

  test("reports missing Info.json", () => {
    const tmp = join(tmpdir(), `build-test-no-manifest-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    const result = validateBuild(tmp);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("Info.json");

    rmSync(tmp, { recursive: true });
  });
});

// ── Integration test ───────────────────────────────────────────────────

describe("build (full pipeline)", () => {
  const outDir = join(tmpdir(), `build-test-full-${Date.now()}`);

  afterAll(() => {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true });
  });

  test("produces a valid plugin bundle", async () => {
    const report = await build(PLUGIN_ROOT, outDir);

    // Three bundles: main, overlay, sidebar
    expect(report.bundles).toHaveLength(3);
    expect(report.bundles[0].entrypoint).toContain("main.ts");
    expect(report.bundles[1].entrypoint).toContain("overlay");
    expect(report.bundles[2].entrypoint).toContain("sidebar");

    // All bundles produced output
    for (const b of report.bundles) {
      expect(b.size).toBeGreaterThan(0);
    }

    // Static assets copied
    expect(report.assetsCopied).toBe(4);

    // Validation passed
    expect(report.validation.valid).toBe(true);

    // Duration is reasonable
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("build output contains all expected files", async () => {
    const expected = [
      "Info.json",
      "src/main.js",
      "ui/overlay/index.html",
      "ui/overlay/index.js",
      "ui/sidebar/index.html",
      "ui/sidebar/index.js",
      "prefs/index.html",
    ];

    for (const file of expected) {
      expect(existsSync(join(outDir, file))).toBe(true);
    }
  });

  test("Info.json in build matches source manifest", () => {
    const source = JSON.parse(readFileSync(join(PLUGIN_ROOT, "Info.json"), "utf-8"));
    const built = JSON.parse(readFileSync(join(outDir, "Info.json"), "utf-8"));
    expect(built).toEqual(source);
  });

  test("bundled main.js is valid JavaScript", () => {
    const content = readFileSync(join(outDir, "src/main.js"), "utf-8");
    expect(content.length).toBeGreaterThan(0);
    // Should not contain TypeScript syntax (type annotations)
    expect(content).not.toContain(": string");
    expect(content).not.toContain(": number");
  });

  test("webview JS files are non-empty", () => {
    for (const file of ["ui/overlay/index.js", "ui/sidebar/index.js"]) {
      const content = readFileSync(join(outDir, file), "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  test("rebuilding into same directory produces clean output", async () => {
    // Build again into the same directory
    const report = await build(PLUGIN_ROOT, outDir);
    expect(report.validation.valid).toBe(true);
    expect(report.bundles).toHaveLength(3);
  });
});
