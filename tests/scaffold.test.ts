import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("monorepo scaffold", () => {
  test("root package.json declares workspaces", () => {
    const pkg = readJson(join(ROOT, "package.json"));
    expect(pkg.workspaces).toEqual([
      "packages/shared",
      "packages/worker",
      "packages/plugin",
    ]);
  });

  test("root package.json has build, test, lint, typecheck, and clean scripts", () => {
    const pkg = readJson(join(ROOT, "package.json"));
    for (const script of ["build", "test", "lint", "typecheck", "clean"]) {
      expect(pkg.scripts[script]).toBeDefined();
    }
  });

  test("tsconfig.base.json exists with strict mode", () => {
    const tsconfig = readJson(join(ROOT, "tsconfig.base.json"));
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.target).toBe("ESNext");
  });

  test(".prettierrc exists", () => {
    expect(existsSync(join(ROOT, ".prettierrc"))).toBe(true);
  });

  test("eslint.config.js exists", () => {
    expect(existsSync(join(ROOT, "eslint.config.js"))).toBe(true);
  });
});

describe("packages/shared", () => {
  const dir = join(ROOT, "packages/shared");

  test("package.json has correct name and exports", () => {
    const pkg = readJson(join(dir, "package.json"));
    expect(pkg.name).toBe("@iina-watch-party/shared");
    expect(pkg.exports["."]).toBeDefined();
    expect(pkg.scripts.build).toBeDefined();
    expect(pkg.scripts.test).toBeDefined();
  });

  test("tsconfig.json extends base and enables declaration", () => {
    const tsconfig = readJson(join(dir, "tsconfig.json"));
    expect(tsconfig.extends).toContain("tsconfig.base.json");
    expect(tsconfig.compilerOptions.declaration).toBe(true);
  });

  test("src/index.ts exists and exports PROTOCOL_VERSION", async () => {
    const mod = await import(join(dir, "src/index.ts"));
    expect(mod.PROTOCOL_VERSION).toBe(1);
    expect(mod.MAX_MESSAGE_SIZE_BYTES).toBe(8192);
    expect(mod.ROOM_CODE_LENGTH).toBe(6);
  });
});

describe("packages/worker", () => {
  const dir = join(ROOT, "packages/worker");

  test("package.json has correct name and dependencies", () => {
    const pkg = readJson(join(dir, "package.json"));
    expect(pkg.name).toBe("@iina-watch-party/worker");
    expect(pkg.dependencies["@iina-watch-party/shared"]).toBe("workspace:*");
    expect(pkg.devDependencies["wrangler"]).toBeDefined();
    expect(pkg.devDependencies["@cloudflare/vitest-pool-workers"]).toBeDefined();
  });

  test("wrangler.toml exists with durable object binding", () => {
    const content = readFileSync(join(dir, "wrangler.toml"), "utf-8");
    expect(content).toContain('name = "ROOM"');
    expect(content).toContain('class_name = "Room"');
    expect(content).toContain("new_sqlite_classes");
  });

  test("vitest.config.ts exists", () => {
    expect(existsSync(join(dir, "vitest.config.ts"))).toBe(true);
  });

  test("src/index.ts exists", () => {
    expect(existsSync(join(dir, "src/index.ts"))).toBe(true);
  });

  test("src/room.ts exists", () => {
    expect(existsSync(join(dir, "src/room.ts"))).toBe(true);
  });
});

describe("packages/plugin", () => {
  const dir = join(ROOT, "packages/plugin");

  test("package.json has correct name and build scripts", () => {
    const pkg = readJson(join(dir, "package.json"));
    expect(pkg.name).toBe("@iina-watch-party/plugin");
    expect(pkg.dependencies["@iina-watch-party/shared"]).toBe("workspace:*");
    expect(pkg.scripts.build).toBeDefined();
    expect(pkg.scripts.link).toBeDefined();
    expect(pkg.scripts.pack).toBeDefined();
  });

  test("Info.json is a valid IINA manifest", () => {
    const manifest = readJson(join(dir, "Info.json"));
    expect(manifest.name).toBe("Watch Party");
    expect(manifest.identifier).toBeDefined();
    expect(manifest.entry).toBe("src/main.js");
    expect(manifest.permissions).toContain("show-osd");
    expect(manifest.permissions).toContain("network-request");
    expect(manifest.permissions).toContain("video-overlay");
    expect(manifest.sidebarTab).toBeDefined();
    expect(manifest.preferencesPage).toBeDefined();
    expect(manifest.preferenceDefaults).toBeDefined();
  });

  test("Info.json does not include globalEntry in v1", () => {
    const manifest = readJson(join(dir, "Info.json"));
    expect(manifest.globalEntry).toBeUndefined();
  });

  test("Info.json allowedDomains does not use wildcard *", () => {
    const manifest = readJson(join(dir, "Info.json"));
    expect(manifest.allowedDomains).not.toContain("*");
  });

  test("main entry src/main.ts exists", () => {
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
  });

  test("overlay webview files exist", () => {
    expect(existsSync(join(dir, "ui/overlay/index.html"))).toBe(true);
    expect(existsSync(join(dir, "ui/overlay/index.js"))).toBe(true);
  });

  test("sidebar webview files exist", () => {
    expect(existsSync(join(dir, "ui/sidebar/index.html"))).toBe(true);
    expect(existsSync(join(dir, "ui/sidebar/index.js"))).toBe(true);
  });

  test("preferences page exists", () => {
    expect(existsSync(join(dir, "prefs/index.html"))).toBe(true);
  });

  test("prepare-build script exists", () => {
    expect(existsSync(join(dir, "scripts/prepare-build.ts"))).toBe(true);
  });
});
