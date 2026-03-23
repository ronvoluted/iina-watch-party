import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const gotchas = readFileSync(join(ROOT, "GOTCHAS.md"), "utf-8");

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function readSource(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf-8");
}

describe("GOTCHAS.md", () => {
  test("exists at project root", () => {
    expect(existsSync(join(ROOT, "GOTCHAS.md"))).toBe(true);
  });

  test("has a title", () => {
    expect(gotchas).toMatch(/^# Gotchas & Operator Notes/);
  });

  test("documents all WebSocket close codes from room.ts", () => {
    const roomSrc = readSource("packages/worker/src/room.ts");
    const closeCodes = [...roomSrc.matchAll(/\b(400[0-5])\b/g)].map((m) => m[1]);
    const uniqueCodes = [...new Set(closeCodes)];
    for (const code of uniqueCodes) {
      expect(gotchas).toContain(code);
    }
  });

  test("documents rate limit values matching source", () => {
    const roomSrc = readSource("packages/worker/src/room.ts");

    const burstMatch = roomSrc.match(/WS_RATE_LIMIT_BURST\s*=\s*(\d+)/);
    const refillMatch = roomSrc.match(/WS_RATE_LIMIT_REFILL\s*=\s*(\d+)/);
    expect(burstMatch).not.toBeNull();
    expect(refillMatch).not.toBeNull();

    expect(gotchas).toContain(burstMatch![1]);
    expect(gotchas).toContain(`${refillMatch![1]} tokens/s`);
  });

  test("documents room TTL", () => {
    expect(gotchas).toMatch(/24 hours/);
  });

  test("documents auth timeout", () => {
    expect(gotchas).toMatch(/10 s/);
  });

  test("documents max participants", () => {
    expect(gotchas).toContain("2");
  });

  test("documents reconnection limits matching overlay source", () => {
    const overlaySrc = readSource("packages/plugin/ui/overlay/index.js");

    const maxAttempts = overlaySrc.match(/MAX_RECONNECT_ATTEMPTS\s*=\s*(\d+)/);
    const baseDelay = overlaySrc.match(/BASE_DELAY_MS\s*=\s*(\d+)/);
    const maxDelay = overlaySrc.match(/MAX_RECONNECT_DELAY_MS\s*=\s*(\d+)/);

    expect(maxAttempts).not.toBeNull();
    expect(baseDelay).not.toBeNull();
    expect(maxDelay).not.toBeNull();

    expect(gotchas).toContain(`${maxAttempts![1]}`);
    expect(gotchas).toContain("1 s");
    expect(gotchas).toContain("30 s");
  });

  test("documents plugin allowedDomains gotcha", () => {
    const info = readJson(join(ROOT, "packages/plugin/Info.json"));
    expect(info.allowedDomains).toContain("localhost:*");
    expect(gotchas).toMatch(/allowedDomains/i);
    expect(gotchas).toMatch(/localhost/);
  });

  test("documents backendUrl default gotcha", () => {
    const info = readJson(join(ROOT, "packages/plugin/Info.json"));
    expect(info.preferenceDefaults.backendUrl).toBe("");
    expect(gotchas).toMatch(/backendUrl/);
    expect(gotchas).toMatch(/empty/);
  });

  test("documents sync engine behavior", () => {
    expect(gotchas).toMatch(/host.authoritative/i);
    expect(gotchas).toMatch(/echo suppression/i);
    expect(gotchas).toMatch(/cooldown/i);
    expect(gotchas).toMatch(/buffering/i);
  });

  test("documents echo suppression window matching source", () => {
    const syncSrc = readSource("packages/shared/src/sync.ts");
    const windowMatch = syncSrc.match(/suppressionWindowMs:\s*(\d+)/);
    expect(windowMatch).not.toBeNull();
    expect(gotchas).toContain(`${windowMatch![1]} ms`);
  });

  test("documents correction cooldown matching source", () => {
    const syncSrc = readSource("packages/shared/src/sync.ts");
    const cooldownMatch = syncSrc.match(/correctionCooldownMs:\s*(\d+)/);
    expect(cooldownMatch).not.toBeNull();
    expect(gotchas).toContain(`${cooldownMatch![1]}`);
  });

  test("documents heartbeat interval", () => {
    const mainSrc = readSource("packages/plugin/src/main.ts");
    const hbMatch = mainSrc.match(/HEARTBEAT_INTERVAL_MS\s*=\s*(\d+)/);
    expect(hbMatch).not.toBeNull();
    expect(gotchas).toContain("5 s");
  });

  test("documents testing quirks", () => {
    expect(gotchas).toMatch(/isolatedStorage/);
    expect(gotchas).toMatch(/singleWorker/);
    expect(gotchas).toMatch(/mock.*IINA/i);
  });

  test("has required sections", () => {
    const requiredSections = [
      "Deployment",
      "Limits & Thresholds",
      "Rate Limiting",
      "WebSocket Close Codes",
      "Sync Engine",
      "Reconnection",
      "Room Lifecycle",
      "Testing",
    ];
    for (const section of requiredSections) {
      expect(gotchas).toContain(section);
    }
  });
});
