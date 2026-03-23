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

    // Next heartbeat within threshold — no correction
    engine.state.positionMs = 15500;
    const nextEffects = engine.apply({
      kind: "remote-heartbeat",
      positionMs: 16000,
      paused: false,
      speed: 1,
      nowMs: T + 5000,
    });
    expect(hasEffect(nextEffects, "seek")).toBe(false);
  });
});
