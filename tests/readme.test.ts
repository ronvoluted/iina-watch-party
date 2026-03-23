import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf-8");

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("README", () => {
  test("exists at project root", () => {
    expect(existsSync(join(ROOT, "README.md"))).toBe(true);
  });

  test("has a title", () => {
    expect(readme).toMatch(/^# IINA Watch Party/);
  });

  test("documents all root scripts from package.json", () => {
    const pkg = readJson(join(ROOT, "package.json"));
    const scriptNames = Object.keys(pkg.scripts);
    for (const name of scriptNames) {
      expect(readme).toContain(`bun run ${name}`);
    }
  });

  test("documents all three packages", () => {
    for (const pkg of ["shared", "worker", "plugin"]) {
      expect(readme).toMatch(new RegExp(pkg));
    }
  });

  test("documents plugin preferences from Info.json", () => {
    const info = readJson(join(ROOT, "packages/plugin/Info.json"));
    const defaults = info.preferenceDefaults;
    for (const key of Object.keys(defaults)) {
      expect(readme).toContain(key);
    }
  });

  test("mentions prerequisites", () => {
    expect(readme).toContain("Bun");
    expect(readme).toContain("IINA");
    expect(readme).toContain("Cloudflare");
  });

  test("documents the protocol message types", () => {
    for (const msg of ["auth", "play", "pause", "seek", "speed", "heartbeat", "presence", "goodbye"]) {
      expect(readme).toContain(msg);
    }
  });
});
