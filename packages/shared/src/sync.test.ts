import { describe, expect, test } from "bun:test";
import { SyncEngine, DEFAULT_SYNC_CONFIG, type SyncEffect } from "./sync.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T = 1000; // base time for tests

function hasEffect(effects: SyncEffect[], type: string): boolean {
  return effects.some((e) => e.type === type);
}

function findEffect<T extends SyncEffect["type"]>(
  effects: SyncEffect[],
  type: T,
): Extract<SyncEffect, { type: T }> | undefined {
  return effects.find((e) => e.type === type) as Extract<SyncEffect, { type: T }> | undefined;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("SyncEngine construction", () => {
  test("initializes with default config", () => {
    const engine = new SyncEngine("host");
    expect(engine.role).toBe("host");
    expect(engine.config).toEqual(DEFAULT_SYNC_CONFIG);
    expect(engine.state).toEqual({
      positionMs: 0,
      paused: true,
      speed: 1,
      buffering: false,
      seeking: false,
    });
  });

  test("accepts partial config override", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 500 });
    expect(engine.config.driftThresholdMs).toBe(500);
    expect(engine.config.suppressionWindowMs).toBe(DEFAULT_SYNC_CONFIG.suppressionWindowMs);
  });
});

// ---------------------------------------------------------------------------
// Local events → send effects
// ---------------------------------------------------------------------------

describe("local events", () => {
  test("local-play updates state and emits send-play", () => {
    const engine = new SyncEngine("host");
    const effects = engine.apply({ kind: "local-play", positionMs: 5000, nowMs: T });
    expect(engine.state.paused).toBe(false);
    expect(engine.state.positionMs).toBe(5000);
    expect(effects).toEqual([{ type: "send-play", positionMs: 5000 }]);
  });

  test("local-pause updates state and emits send-pause", () => {
    const engine = new SyncEngine("host");
    engine.state.paused = false;
    const effects = engine.apply({ kind: "local-pause", positionMs: 3000, nowMs: T });
    expect(engine.state.paused).toBe(true);
    expect(engine.state.positionMs).toBe(3000);
    expect(effects).toEqual([{ type: "send-pause", positionMs: 3000 }]);
  });

  test("local-seek updates state and emits send-seek with user cause", () => {
    const engine = new SyncEngine("host");
    const effects = engine.apply({ kind: "local-seek", positionMs: 10000, nowMs: T });
    expect(engine.state.positionMs).toBe(10000);
    expect(effects).toEqual([{ type: "send-seek", positionMs: 10000, cause: "user" }]);
  });

  test("local-speed updates state and emits send-speed", () => {
    const engine = new SyncEngine("host");
    const effects = engine.apply({ kind: "local-speed", speed: 2, nowMs: T });
    expect(engine.state.speed).toBe(2);
    expect(effects).toEqual([{ type: "send-speed", speed: 2 }]);
  });

  test("local-buffering updates state with no effects", () => {
    const engine = new SyncEngine("guest");
    const effects = engine.apply({ kind: "local-buffering", buffering: true, nowMs: T });
    expect(engine.state.buffering).toBe(true);
    expect(effects).toEqual([]);
  });

  test("local-seeking updates state with no effects", () => {
    const engine = new SyncEngine("guest");
    const effects = engine.apply({ kind: "local-seeking", seeking: true, nowMs: T });
    expect(engine.state.seeking).toBe(true);
    expect(effects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Remote commands → player effects
// ---------------------------------------------------------------------------

describe("remote commands", () => {
  test("remote-play emits set-paused and seek", () => {
    const engine = new SyncEngine("guest");
    const effects = engine.apply({ kind: "remote-play", positionMs: 8000, nowMs: T });
    expect(engine.state.paused).toBe(false);
    expect(engine.state.positionMs).toBe(8000);
    expect(effects).toEqual([
      { type: "set-paused", paused: false },
      { type: "seek", positionMs: 8000 },
    ]);
  });

  test("remote-pause emits set-paused and seek", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = false;
    const effects = engine.apply({ kind: "remote-pause", positionMs: 4000, nowMs: T });
    expect(engine.state.paused).toBe(true);
    expect(engine.state.positionMs).toBe(4000);
    expect(effects).toEqual([
      { type: "set-paused", paused: true },
      { type: "seek", positionMs: 4000 },
    ]);
  });

  test("remote-seek emits seek", () => {
    const engine = new SyncEngine("guest");
    const effects = engine.apply({ kind: "remote-seek", positionMs: 15000, nowMs: T });
    expect(engine.state.positionMs).toBe(15000);
    expect(effects).toEqual([{ type: "seek", positionMs: 15000 }]);
  });

  test("remote-speed emits set-speed", () => {
    const engine = new SyncEngine("guest");
    const effects = engine.apply({ kind: "remote-speed", speed: 1.5, nowMs: T });
    expect(engine.state.speed).toBe(1.5);
    expect(effects).toEqual([{ type: "set-speed", speed: 1.5 }]);
  });

  test("remote-state applies full state snapshot", () => {
    const engine = new SyncEngine("guest");
    const effects = engine.apply({
      kind: "remote-state",
      positionMs: 20000,
      paused: false,
      speed: 1.25,
      nowMs: T,
    });
    expect(engine.state.positionMs).toBe(20000);
    expect(engine.state.paused).toBe(false);
    expect(engine.state.speed).toBe(1.25);
    expect(effects).toEqual([
      { type: "seek", positionMs: 20000 },
      { type: "set-paused", paused: false },
      { type: "set-speed", speed: 1.25 },
    ]);
  });

  test("remote-state sets buffering from payload", () => {
    const engine = new SyncEngine("guest");
    engine.apply({
      kind: "remote-state",
      positionMs: 0,
      paused: true,
      speed: 1,
      buffering: true,
      nowMs: T,
    });
    expect(engine.state.buffering).toBe(true);
  });

  test("remote-state defaults buffering to false", () => {
    const engine = new SyncEngine("guest");
    engine.state.buffering = true;
    engine.apply({
      kind: "remote-state",
      positionMs: 0,
      paused: true,
      speed: 1,
      nowMs: T,
    });
    expect(engine.state.buffering).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Echo suppression
// ---------------------------------------------------------------------------

describe("echo suppression", () => {
  test("remote-play suppresses subsequent local play echo", () => {
    const engine = new SyncEngine("guest");
    engine.apply({ kind: "remote-play", positionMs: 5000, nowMs: T });

    // Local play event triggered by the player applying the remote command
    const effects = engine.apply({ kind: "local-play", positionMs: 5000, nowMs: T + 10 });
    expect(effects).toEqual([]); // suppressed — no send-play
    expect(engine.state.paused).toBe(false); // state still updated
  });

  test("remote-pause suppresses subsequent local pause echo", () => {
    const engine = new SyncEngine("guest");
    engine.apply({ kind: "remote-pause", positionMs: 3000, nowMs: T });

    const effects = engine.apply({ kind: "local-pause", positionMs: 3000, nowMs: T + 10 });
    expect(effects).toEqual([]);
  });

  test("remote-seek suppresses subsequent local seek echo", () => {
    const engine = new SyncEngine("guest");
    engine.apply({ kind: "remote-seek", positionMs: 9000, nowMs: T });

    const effects = engine.apply({ kind: "local-seek", positionMs: 9000, nowMs: T + 10 });
    expect(effects).toEqual([]);
  });

  test("remote-speed suppresses subsequent local speed echo", () => {
    const engine = new SyncEngine("guest");
    engine.apply({ kind: "remote-speed", speed: 2, nowMs: T });

    const effects = engine.apply({ kind: "local-speed", speed: 2, nowMs: T + 10 });
    expect(effects).toEqual([]);
  });

  test("suppression expires after window", () => {
    const engine = new SyncEngine("guest", { suppressionWindowMs: 100 });
    engine.apply({ kind: "remote-play", positionMs: 5000, nowMs: T });

    // After suppression window expires, local event should produce send effect
    const effects = engine.apply({ kind: "local-play", positionMs: 5000, nowMs: T + 150 });
    expect(effects).toEqual([{ type: "send-play", positionMs: 5000 }]);
  });

  test("suppression is consumed on first matching local event", () => {
    const engine = new SyncEngine("guest");
    engine.apply({ kind: "remote-seek", positionMs: 1000, nowMs: T });

    // First local seek is suppressed
    const e1 = engine.apply({ kind: "local-seek", positionMs: 1000, nowMs: T + 10 });
    expect(e1).toEqual([]);

    // Second local seek is NOT suppressed (entry was consumed)
    const e2 = engine.apply({ kind: "local-seek", positionMs: 2000, nowMs: T + 20 });
    expect(e2).toEqual([{ type: "send-seek", positionMs: 2000, cause: "user" }]);
  });

  test("remote-play suppresses both play and seek echoes", () => {
    const engine = new SyncEngine("guest");
    engine.apply({ kind: "remote-play", positionMs: 7000, nowMs: T });

    // Player fires both seek and play events
    const seekEffects = engine.apply({ kind: "local-seek", positionMs: 7000, nowMs: T + 5 });
    const playEffects = engine.apply({ kind: "local-play", positionMs: 7000, nowMs: T + 10 });
    expect(seekEffects).toEqual([]);
    expect(playEffects).toEqual([]);
  });

  test("remote-state suppresses play/pause, seek, and speed echoes", () => {
    const engine = new SyncEngine("guest");
    engine.apply({
      kind: "remote-state",
      positionMs: 10000,
      paused: false,
      speed: 1.5,
      nowMs: T,
    });

    const seekEffects = engine.apply({ kind: "local-seek", positionMs: 10000, nowMs: T + 5 });
    const playEffects = engine.apply({ kind: "local-play", positionMs: 10000, nowMs: T + 10 });
    const speedEffects = engine.apply({ kind: "local-speed", speed: 1.5, nowMs: T + 15 });
    expect(seekEffects).toEqual([]);
    expect(playEffects).toEqual([]);
    expect(speedEffects).toEqual([]);
  });

  test("remote-state with paused=true suppresses pause echo", () => {
    const engine = new SyncEngine("guest");
    engine.apply({
      kind: "remote-state",
      positionMs: 5000,
      paused: true,
      speed: 1,
      nowMs: T,
    });

    const pauseEffects = engine.apply({ kind: "local-pause", positionMs: 5000, nowMs: T + 5 });
    expect(pauseEffects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Authority: drift correction (guest only)
// ---------------------------------------------------------------------------

describe("drift correction", () => {
  test("guest corrects drift when above threshold", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 13000,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    expect(hasEffect(effects, "seek")).toBe(true);
    expect(findEffect(effects, "seek")?.positionMs).toBe(13000);
    expect(engine.state.positionMs).toBe(13000);
  });

  test("guest ignores drift below threshold", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 11000,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    expect(hasEffect(effects, "seek")).toBe(false);
    expect(engine.state.positionMs).toBe(10000); // unchanged
  });

  test("host ignores heartbeat entirely", () => {
    const engine = new SyncEngine("host");
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 50000,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    expect(effects).toEqual([]);
    expect(engine.state.positionMs).toBe(10000); // unchanged
  });

  test("guest skips drift correction when locally paused", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = true;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 50000,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    expect(hasEffect(effects, "seek")).toBe(false);
  });

  test("guest skips drift correction when locally buffering", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.buffering = true;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 50000,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    expect(hasEffect(effects, "seek")).toBe(false);
  });

  test("guest skips drift correction when locally seeking", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.seeking = true;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 50000,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    expect(hasEffect(effects, "seek")).toBe(false);
  });

  test("guest skips drift correction when host is paused", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 50000,
      paused: true,
      speed: 1,
      nowMs: T,
    });

    expect(hasEffect(effects, "seek")).toBe(false);
  });

  test("guest skips drift correction when host is buffering", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 50000,
      paused: false,
      speed: 1,
      buffering: true,
      nowMs: T,
    });

    expect(hasEffect(effects, "seek")).toBe(false);
  });

  test("guest skips drift correction when host is seeking", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 50000,
      paused: false,
      speed: 1,
      seeking: true,
      nowMs: T,
    });

    expect(hasEffect(effects, "seek")).toBe(false);
  });

  test("drift correction suppresses the resulting local seek echo", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    engine.apply({
      kind: "remote-heartbeat",
      positionMs: 15000,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    const seekEffects = engine.apply({ kind: "local-seek", positionMs: 15000, nowMs: T + 10 });
    expect(seekEffects).toEqual([]); // suppressed
  });
});

// ---------------------------------------------------------------------------
// Authority: speed correction via heartbeat
// ---------------------------------------------------------------------------

describe("speed correction via heartbeat", () => {
  test("guest corrects speed mismatch from heartbeat", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = false;
    engine.state.speed = 1;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 10000,
      paused: false,
      speed: 1.5,
      nowMs: T,
    });

    expect(findEffect(effects, "set-speed")?.speed).toBe(1.5);
    expect(engine.state.speed).toBe(1.5);
  });

  test("speed correction suppresses local speed echo", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = false;
    engine.state.speed = 1;

    engine.apply({
      kind: "remote-heartbeat",
      positionMs: 0,
      paused: false,
      speed: 2,
      nowMs: T,
    });

    const effects = engine.apply({ kind: "local-speed", speed: 2, nowMs: T + 10 });
    expect(effects).toEqual([]);
  });

  test("speed correction happens even when paused (drift is skipped)", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = true;
    engine.state.speed = 1;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 50000,
      paused: false,
      speed: 2,
      nowMs: T,
    });

    // Speed is corrected
    expect(findEffect(effects, "set-speed")?.speed).toBe(2);
    // Drift is NOT corrected (locally paused)
    expect(hasEffect(effects, "seek")).toBe(false);
  });

  test("no speed effect when speeds match", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = false;
    engine.state.speed = 1;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 10500,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    expect(hasEffect(effects, "set-speed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: realistic sequences
// ---------------------------------------------------------------------------

describe("realistic sequences", () => {
  test("guest joins → receives initial state → applies without echo loop", () => {
    const engine = new SyncEngine("guest");

    // Host sends initial state snapshot
    const stateEffects = engine.apply({
      kind: "remote-state",
      positionMs: 30000,
      paused: false,
      speed: 1,
      nowMs: T,
    });
    expect(stateEffects).toHaveLength(3); // seek, set-paused, set-speed

    // Player fires local events as it applies the state
    const e1 = engine.apply({ kind: "local-seek", positionMs: 30000, nowMs: T + 5 });
    const e2 = engine.apply({ kind: "local-play", positionMs: 30000, nowMs: T + 10 });
    const e3 = engine.apply({ kind: "local-speed", speed: 1, nowMs: T + 15 });

    // All echoes suppressed — nothing sent back to host
    expect(e1).toEqual([]);
    expect(e2).toEqual([]);
    expect(e3).toEqual([]);
  });

  test("user seek on guest → send to host → no suppression (genuine action)", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = false;
    engine.state.positionMs = 5000;
    engine.lastUpdateMs = T;

    // User manually seeks
    const effects = engine.apply({ kind: "local-seek", positionMs: 60000, nowMs: T });
    expect(effects).toEqual([{ type: "send-seek", positionMs: 60000, cause: "user" }]);
  });

  test("host pause → guest receives → applies → echo suppressed → then guest pauses independently", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = false;

    // Receive remote pause from host
    engine.apply({ kind: "remote-pause", positionMs: 10000, nowMs: T });

    // Echo from player applying pause
    const echo = engine.apply({ kind: "local-pause", positionMs: 10000, nowMs: T + 5 });
    expect(echo).toEqual([]); // suppressed

    // Later, guest manually unpauses, then pauses again (genuine action)
    engine.apply({ kind: "local-play", positionMs: 10000, nowMs: T + 1000 });
    const genuinePause = engine.apply({ kind: "local-pause", positionMs: 11000, nowMs: T + 2000 });
    expect(genuinePause).toEqual([{ type: "send-pause", positionMs: 11000 }]);
  });

  test("drift correction followed by normal playback", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    // Host heartbeat shows drift
    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 15000,
      paused: false,
      speed: 1,
      nowMs: T,
    });
    expect(hasEffect(effects, "seek")).toBe(true);

    // Echo from corrective seek
    const echo = engine.apply({ kind: "local-seek", positionMs: 15000, nowMs: T + 10 });
    expect(echo).toEqual([]);

    // Next heartbeat: position estimation accounts for elapsed time.
    // At T+5000, estimated = 15000 + 5000*1 = 20000, host at 20500 → drift 500 < 2000
    const nextEffects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 20500,
      paused: false,
      speed: 1,
      nowMs: T + 5000,
    });
    expect(hasEffect(nextEffects, "seek")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// activeSuppressions getter
// ---------------------------------------------------------------------------

describe("activeSuppressions", () => {
  test("returns active suppression entries after remote command", () => {
    const engine = new SyncEngine("guest", { suppressionWindowMs: 200 });
    engine.apply({ kind: "remote-seek", positionMs: 5000, nowMs: T });

    const active = engine.activeSuppressions;
    expect(active).toHaveLength(1);
    expect(active[0].action).toBe("seek");
    expect(active[0].expiresAtMs).toBe(T + 200);
  });

  test("returns empty after suppressions are consumed", () => {
    const engine = new SyncEngine("guest", { suppressionWindowMs: 200 });
    engine.apply({ kind: "remote-seek", positionMs: 5000, nowMs: T });
    engine.apply({ kind: "local-seek", positionMs: 5000, nowMs: T + 10 });

    expect(engine.activeSuppressions).toHaveLength(0);
  });

  test("expired suppressions are pruned on next apply", () => {
    const engine = new SyncEngine("guest", { suppressionWindowMs: 100 });
    engine.apply({ kind: "remote-seek", positionMs: 5000, nowMs: T });
    expect(engine.activeSuppressions).toHaveLength(1);

    // Trigger pruning by applying any action after expiry
    engine.apply({ kind: "local-buffering", buffering: false, nowMs: T + 200 });
    expect(engine.activeSuppressions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Drift correction boundary
// ---------------------------------------------------------------------------

describe("drift correction boundary", () => {
  test("drift at exactly threshold does not correct (uses >)", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 12000, // exactly 2000ms drift
      paused: false,
      speed: 1,
      nowMs: T,
    });

    expect(hasEffect(effects, "seek")).toBe(false);
  });

  test("drift at threshold + 1 corrects", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 12001,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    expect(hasEffect(effects, "seek")).toBe(true);
    expect(findEffect(effects, "seek")?.positionMs).toBe(12001);
  });

  test("negative drift (guest ahead of host) also corrects", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.positionMs = 20000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 15000, // guest is 5s ahead
      paused: false,
      speed: 1,
      nowMs: T,
    });

    expect(hasEffect(effects, "seek")).toBe(true);
    expect(findEffect(effects, "seek")?.positionMs).toBe(15000);
  });
});

// ---------------------------------------------------------------------------
// Local buffering/seeking toggle
// ---------------------------------------------------------------------------

describe("local buffering and seeking toggles", () => {
  test("local-buffering toggles false", () => {
    const engine = new SyncEngine("guest");
    engine.state.buffering = true;
    const effects = engine.apply({ kind: "local-buffering", buffering: false, nowMs: T });
    expect(engine.state.buffering).toBe(false);
    expect(effects).toEqual([]);
  });

  test("local-seeking toggles false", () => {
    const engine = new SyncEngine("guest");
    engine.state.seeking = true;
    const effects = engine.apply({ kind: "local-seeking", seeking: false, nowMs: T });
    expect(engine.state.seeking).toBe(false);
    expect(effects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Remote-state suppression with paused states
// ---------------------------------------------------------------------------

describe("remote-state suppression details", () => {
  test("remote-state with paused=false adds play suppression (not pause)", () => {
    const engine = new SyncEngine("guest");
    engine.apply({
      kind: "remote-state",
      positionMs: 5000,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    // play is suppressed
    const playEffects = engine.apply({ kind: "local-play", positionMs: 5000, nowMs: T + 5 });
    expect(playEffects).toEqual([]);

    // pause is NOT suppressed (no pause suppression was added)
    const pauseEffects = engine.apply({ kind: "local-pause", positionMs: 5000, nowMs: T + 10 });
    expect(pauseEffects).toEqual([{ type: "send-pause", positionMs: 5000 }]);
  });

  test("remote-state with paused=true adds pause suppression (not play)", () => {
    const engine = new SyncEngine("guest");
    engine.apply({
      kind: "remote-state",
      positionMs: 5000,
      paused: true,
      speed: 1,
      nowMs: T,
    });

    // pause is suppressed
    const pauseEffects = engine.apply({ kind: "local-pause", positionMs: 5000, nowMs: T + 5 });
    expect(pauseEffects).toEqual([]);

    // play is NOT suppressed
    const playEffects = engine.apply({ kind: "local-play", positionMs: 5000, nowMs: T + 10 });
    expect(playEffects).toEqual([{ type: "send-play", positionMs: 5000 }]);
  });
});

// ---------------------------------------------------------------------------
// Multiple suppression stacking
// ---------------------------------------------------------------------------

describe("suppression stacking", () => {
  test("multiple remote seeks stack independent suppressions", () => {
    const engine = new SyncEngine("guest");
    engine.apply({ kind: "remote-seek", positionMs: 1000, nowMs: T });
    engine.apply({ kind: "remote-seek", positionMs: 2000, nowMs: T + 10 });

    expect(engine.activeSuppressions.filter((s) => s.action === "seek")).toHaveLength(2);

    // First local seek consumes one
    engine.apply({ kind: "local-seek", positionMs: 2000, nowMs: T + 20 });
    expect(engine.activeSuppressions.filter((s) => s.action === "seek")).toHaveLength(1);

    // Second local seek consumes the other
    engine.apply({ kind: "local-seek", positionMs: 2500, nowMs: T + 30 });
    expect(engine.activeSuppressions.filter((s) => s.action === "seek")).toHaveLength(0);

    // Third local seek is not suppressed
    const effects = engine.apply({ kind: "local-seek", positionMs: 3000, nowMs: T + 40 });
    expect(effects).toEqual([{ type: "send-seek", positionMs: 3000, cause: "user" }]);
  });
});

// ---------------------------------------------------------------------------
// Constructor edge cases
// ---------------------------------------------------------------------------

describe("SyncEngine constructor edge cases", () => {
  test("full config override replaces all defaults", () => {
    const engine = new SyncEngine("guest", {
      driftThresholdMs: 500,
      suppressionWindowMs: 100,
      correctionCooldownMs: 3000,
    });
    expect(engine.config).toEqual({
      driftThresholdMs: 500,
      suppressionWindowMs: 100,
      correctionCooldownMs: 3000,
    });
  });

  test("empty config override uses all defaults", () => {
    const engine = new SyncEngine("host", {});
    expect(engine.config).toEqual(DEFAULT_SYNC_CONFIG);
  });
});

// ---------------------------------------------------------------------------
// Host role behavior
// ---------------------------------------------------------------------------

describe("host role behavior", () => {
  test("host local events emit send effects same as guest", () => {
    const engine = new SyncEngine("host");
    const playEffects = engine.apply({ kind: "local-play", positionMs: 100, nowMs: T });
    expect(playEffects).toEqual([{ type: "send-play", positionMs: 100 }]);

    const pauseEffects = engine.apply({ kind: "local-pause", positionMs: 200, nowMs: T + 10 });
    expect(pauseEffects).toEqual([{ type: "send-pause", positionMs: 200 }]);
  });

  test("host receives remote commands and applies them", () => {
    const engine = new SyncEngine("host");
    const effects = engine.apply({ kind: "remote-play", positionMs: 5000, nowMs: T });
    expect(effects).toEqual([
      { type: "set-paused", paused: false },
      { type: "seek", positionMs: 5000 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Position estimation
// ---------------------------------------------------------------------------

describe("position estimation", () => {
  test("estimates position based on elapsed time and speed", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    // 3 seconds later at 1x speed
    expect(engine.estimatePosition(T + 3000)).toBe(13000);
  });

  test("accounts for playback speed", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = false;
    engine.state.speed = 2;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    // 3 seconds later at 2x speed → 6000ms of playback
    expect(engine.estimatePosition(T + 3000)).toBe(16000);
  });

  test("returns raw position when paused", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = true;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    expect(engine.estimatePosition(T + 5000)).toBe(10000);
  });

  test("returns raw position when buffering", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = false;
    engine.state.buffering = true;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    expect(engine.estimatePosition(T + 5000)).toBe(10000);
  });

  test("returns raw position when seeking", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = false;
    engine.state.seeking = true;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    expect(engine.estimatePosition(T + 5000)).toBe(10000);
  });

  test("drift uses estimated position instead of stale position", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    // 5 seconds later: estimated = 10000 + 5000*1 = 15000
    // Host at 15500 → drift = 500 < 2000 → no correction
    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 15500,
      paused: false,
      speed: 1,
      nowMs: T + 5000,
    });

    expect(hasEffect(effects, "seek")).toBe(false);
  });

  test("drift corrects when estimated position diverges from host", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    // 5 seconds later: estimated = 10000 + 5000*1 = 15000
    // Host at 18000 → drift = 3000 > 2000 → correction
    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 18000,
      paused: false,
      speed: 1,
      nowMs: T + 5000,
    });

    expect(hasEffect(effects, "seek")).toBe(true);
    expect(findEffect(effects, "seek")?.positionMs).toBe(18000);
  });

  test("estimation with fractional speed", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = false;
    engine.state.speed = 0.5;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    // 4 seconds at 0.5x → 2000ms of playback
    expect(engine.estimatePosition(T + 4000)).toBe(12000);
  });
});

// ---------------------------------------------------------------------------
// Correction cooldown
// ---------------------------------------------------------------------------

describe("correction cooldown", () => {
  test("second correction within cooldown is skipped", () => {
    const engine = new SyncEngine("guest", {
      driftThresholdMs: 2000,
      correctionCooldownMs: 5000,
    });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    // First correction triggers
    const e1 = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 15000,
      paused: false,
      speed: 1,
      nowMs: T,
    });
    expect(hasEffect(e1, "seek")).toBe(true);

    // 3 seconds later (within 5s cooldown), large drift still skipped
    engine.state.positionMs = 15000;
    engine.lastUpdateMs = T + 3000;
    const e2 = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 25000,
      paused: false,
      speed: 1,
      nowMs: T + 3000,
    });
    expect(hasEffect(e2, "seek")).toBe(false);
  });

  test("correction after cooldown expires triggers normally", () => {
    const engine = new SyncEngine("guest", {
      driftThresholdMs: 2000,
      correctionCooldownMs: 5000,
    });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    // First correction
    engine.apply({
      kind: "remote-heartbeat",
      positionMs: 15000,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    // 5 seconds later (cooldown expired), correction triggers
    engine.state.positionMs = 15000;
    engine.lastUpdateMs = T + 5000;
    const e2 = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 20000,
      paused: false,
      speed: 1,
      nowMs: T + 5000,
    });
    expect(hasEffect(e2, "seek")).toBe(true);
    expect(findEffect(e2, "seek")?.positionMs).toBe(20000);
  });

  test("cooldown does not affect speed correction", () => {
    const engine = new SyncEngine("guest", {
      driftThresholdMs: 2000,
      correctionCooldownMs: 5000,
    });
    engine.state.paused = false;
    engine.state.speed = 1;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    // Trigger a correction to start cooldown
    engine.apply({
      kind: "remote-heartbeat",
      positionMs: 15000,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    // During cooldown, speed mismatch still corrected
    engine.state.speed = 1;
    const e2 = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 15100,
      paused: false,
      speed: 2,
      nowMs: T + 1000,
    });
    expect(findEffect(e2, "set-speed")?.speed).toBe(2);
    // But seek is skipped due to cooldown
    expect(hasEffect(e2, "seek")).toBe(false);
  });

  test("first correction always works (no initial cooldown)", () => {
    const engine = new SyncEngine("guest", {
      driftThresholdMs: 2000,
      correctionCooldownMs: 10000,
    });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 15000,
      paused: false,
      speed: 1,
      nowMs: T,
    });
    expect(hasEffect(effects, "seek")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Position tracking via actions
// ---------------------------------------------------------------------------

describe("position tracking", () => {
  test("local-play updates lastUpdateMs", () => {
    const engine = new SyncEngine("guest");
    engine.apply({ kind: "local-play", positionMs: 5000, nowMs: T });
    expect(engine.lastUpdateMs).toBe(T);
    expect(engine.state.positionMs).toBe(5000);
  });

  test("local-pause updates lastUpdateMs", () => {
    const engine = new SyncEngine("guest");
    engine.apply({ kind: "local-pause", positionMs: 3000, nowMs: T });
    expect(engine.lastUpdateMs).toBe(T);
  });

  test("local-seek updates lastUpdateMs", () => {
    const engine = new SyncEngine("guest");
    engine.apply({ kind: "local-seek", positionMs: 9000, nowMs: T });
    expect(engine.lastUpdateMs).toBe(T);
  });

  test("remote-play updates lastUpdateMs", () => {
    const engine = new SyncEngine("guest");
    engine.apply({ kind: "remote-play", positionMs: 8000, nowMs: T });
    expect(engine.lastUpdateMs).toBe(T);
  });

  test("remote-state updates lastUpdateMs", () => {
    const engine = new SyncEngine("guest");
    engine.apply({
      kind: "remote-state",
      positionMs: 20000,
      paused: false,
      speed: 1,
      nowMs: T,
    });
    expect(engine.lastUpdateMs).toBe(T);
  });

  test("drift correction updates lastUpdateMs", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    engine.apply({
      kind: "remote-heartbeat",
      positionMs: 15000,
      paused: false,
      speed: 1,
      nowMs: T + 100,
    });

    expect(engine.lastUpdateMs).toBe(T + 100);
    expect(engine.state.positionMs).toBe(15000);
  });
});

// ---------------------------------------------------------------------------
// Buffering behavior (FR-11)
// ---------------------------------------------------------------------------

describe("buffering behavior", () => {
  test("local-buffering updates state", () => {
    const engine = new SyncEngine("guest");
    engine.apply({ kind: "local-buffering", buffering: true, nowMs: T });
    expect(engine.state.buffering).toBe(true);

    engine.apply({ kind: "local-buffering", buffering: false, nowMs: T + 1000 });
    expect(engine.state.buffering).toBe(false);
  });

  test("local-play is suppressed while buffering (not sent to peer)", () => {
    const engine = new SyncEngine("host");
    engine.state.buffering = true;
    const effects = engine.apply({ kind: "local-play", positionMs: 5000, nowMs: T });
    expect(engine.state.paused).toBe(false);
    expect(hasEffect(effects, "send-play")).toBe(false);
  });

  test("local-pause is suppressed while buffering (not sent to peer)", () => {
    const engine = new SyncEngine("host");
    engine.state.paused = false;
    engine.state.buffering = true;
    const effects = engine.apply({ kind: "local-pause", positionMs: 5000, nowMs: T });
    expect(engine.state.paused).toBe(true);
    expect(hasEffect(effects, "send-pause")).toBe(false);
  });

  test("local-play is sent when not buffering", () => {
    const engine = new SyncEngine("host");
    engine.state.buffering = false;
    const effects = engine.apply({ kind: "local-play", positionMs: 5000, nowMs: T });
    expect(hasEffect(effects, "send-play")).toBe(true);
  });

  test("local-pause is sent when not buffering", () => {
    const engine = new SyncEngine("host");
    engine.state.paused = false;
    engine.state.buffering = false;
    const effects = engine.apply({ kind: "local-pause", positionMs: 5000, nowMs: T });
    expect(hasEffect(effects, "send-pause")).toBe(true);
  });

  test("drift correction is skipped while local player is buffering", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.buffering = true;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 20000,
      paused: false,
      speed: 1,
      nowMs: T,
    });
    expect(hasEffect(effects, "seek")).toBe(false);
  });

  test("drift correction is skipped while remote peer is buffering", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.buffering = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 20000,
      paused: false,
      speed: 1,
      buffering: true,
      nowMs: T,
    });
    expect(hasEffect(effects, "seek")).toBe(false);
  });

  test("drift correction resumes after buffering ends", () => {
    const engine = new SyncEngine("guest", { driftThresholdMs: 2000 });
    engine.state.paused = false;
    engine.state.buffering = true;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    // While buffering — no correction
    engine.apply({
      kind: "remote-heartbeat",
      positionMs: 20000,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    // Buffering ends
    engine.apply({ kind: "local-buffering", buffering: false, nowMs: T + 1000 });
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T + 1000;

    // Now correction should apply
    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 20000,
      paused: false,
      speed: 1,
      nowMs: T + 1000,
    });
    expect(hasEffect(effects, "seek")).toBe(true);
    expect(findEffect(effects, "seek")?.positionMs).toBe(20000);
  });
});

// ---------------------------------------------------------------------------
// Peer-buffering warnings (FR-11)
// ---------------------------------------------------------------------------

describe("peer-buffering warnings", () => {
  test("guest emits warn-peer-buffering when peer starts buffering", () => {
    const engine = new SyncEngine("guest");
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 10000,
      paused: false,
      speed: 1,
      buffering: true,
      nowMs: T,
    });

    const warn = effects.find((e) => e.type === "warn-peer-buffering") as
      | Extract<SyncEffect, { type: "warn-peer-buffering" }>
      | undefined;
    expect(warn).toBeDefined();
    expect(warn!.active).toBe(true);
    expect(engine.peerBuffering).toBe(true);
  });

  test("guest emits warn-peer-buffering active=false when peer stops buffering", () => {
    const engine = new SyncEngine("guest");
    engine.peerBuffering = true;
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 10000,
      paused: false,
      speed: 1,
      buffering: false,
      nowMs: T,
    });

    const warn = effects.find((e) => e.type === "warn-peer-buffering") as
      | Extract<SyncEffect, { type: "warn-peer-buffering" }>
      | undefined;
    expect(warn).toBeDefined();
    expect(warn!.active).toBe(false);
    expect(engine.peerBuffering).toBe(false);
  });

  test("no warning when peer buffering state unchanged", () => {
    const engine = new SyncEngine("guest");
    engine.peerBuffering = false;
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 10000,
      paused: false,
      speed: 1,
      buffering: false,
      nowMs: T,
    });

    expect(effects.find((e) => e.type === "warn-peer-buffering")).toBeUndefined();
  });

  test("host also tracks peer-buffering warnings", () => {
    const engine = new SyncEngine("host");

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 10000,
      paused: false,
      speed: 1,
      buffering: true,
      nowMs: T,
    });

    const warn = effects.find((e) => e.type === "warn-peer-buffering") as
      | Extract<SyncEffect, { type: "warn-peer-buffering" }>
      | undefined;
    expect(warn).toBeDefined();
    expect(warn!.active).toBe(true);
  });

  test("host does not perform drift correction even with peer buffering warning", () => {
    const engine = new SyncEngine("host");
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 20000,
      paused: false,
      speed: 1,
      buffering: true,
      nowMs: T,
    });

    // Host emits the warning but never seeks
    expect(effects.find((e) => e.type === "warn-peer-buffering")).toBeDefined();
    expect(hasEffect(effects, "seek")).toBe(false);
  });

  test("peer-buffering defaults to false when heartbeat omits buffering field", () => {
    const engine = new SyncEngine("guest");
    engine.peerBuffering = true;
    engine.state.paused = false;
    engine.state.positionMs = 10000;
    engine.lastUpdateMs = T;

    const effects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 10000,
      paused: false,
      speed: 1,
      nowMs: T,
    });

    // buffering is undefined → treated as false → transition from true to false
    const warn = effects.find((e) => e.type === "warn-peer-buffering") as
      | Extract<SyncEffect, { type: "warn-peer-buffering" }>
      | undefined;
    expect(warn).toBeDefined();
    expect(warn!.active).toBe(false);
  });
});
