/**
 * Pure sync state machine with authority rules and echo suppression.
 *
 * - Host-authoritative: guest corrects drift toward host via heartbeats.
 * - Echo suppression: applying a remote command locally adds a short
 *   suppression window so the resulting local player event is not re-sent.
 * - No side effects: all time is injected via `nowMs`, caller executes effects.
 */

import type { Role } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SyncConfig {
  /** Drift threshold in ms before guest corrects toward host. */
  driftThresholdMs: number;
  /** Duration in ms to suppress local echo after applying a remote command. */
  suppressionWindowMs: number;
  /** Minimum ms between corrective seeks to prevent seek spam. */
  correctionCooldownMs: number;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  driftThresholdMs: 2000,
  suppressionWindowMs: 500,
  correctionCooldownMs: 5000,
};

// ---------------------------------------------------------------------------
// Player state snapshot
// ---------------------------------------------------------------------------

export interface PlayerState {
  positionMs: number;
  paused: boolean;
  speed: number;
  buffering: boolean;
  seeking: boolean;
}

// ---------------------------------------------------------------------------
// Actions (input to the engine)
// ---------------------------------------------------------------------------

export type SyncAction =
  | { kind: "local-play"; positionMs: number; nowMs: number }
  | { kind: "local-pause"; positionMs: number; nowMs: number }
  | { kind: "local-seek"; positionMs: number; nowMs: number }
  | { kind: "local-speed"; speed: number; nowMs: number }
  | { kind: "local-buffering"; buffering: boolean; nowMs: number }
  | { kind: "local-seeking"; seeking: boolean; nowMs: number }
  | { kind: "remote-play"; positionMs: number; nowMs: number }
  | { kind: "remote-pause"; positionMs: number; nowMs: number }
  | { kind: "remote-seek"; positionMs: number; nowMs: number }
  | { kind: "remote-speed"; speed: number; nowMs: number }
  | {
      kind: "remote-state";
      positionMs: number;
      paused: boolean;
      speed: number;
      buffering?: boolean;
      nowMs: number;
    }
  | {
      kind: "remote-heartbeat";
      positionMs: number;
      paused: boolean;
      speed: number;
      buffering?: boolean;
      seeking?: boolean;
      nowMs: number;
    };

// ---------------------------------------------------------------------------
// Effects (output from the engine — caller executes these)
// ---------------------------------------------------------------------------

export type SyncEffect =
  | { type: "seek"; positionMs: number }
  | { type: "set-paused"; paused: boolean }
  | { type: "set-speed"; speed: number }
  | { type: "send-play"; positionMs: number }
  | { type: "send-pause"; positionMs: number }
  | { type: "send-seek"; positionMs: number; cause: "user" | "drift-correction" }
  | { type: "send-speed"; speed: number };

// ---------------------------------------------------------------------------
// Suppression internals
// ---------------------------------------------------------------------------

type SuppressibleAction = "play" | "pause" | "seek" | "speed";

interface SuppressionEntry {
  action: SuppressibleAction;
  expiresAtMs: number;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class SyncEngine {
  readonly role: Role;
  readonly config: SyncConfig;
  state: PlayerState;
  private suppressions: SuppressionEntry[] = [];
  /** Timestamp (ms) when positionMs was last set. Used for drift estimation. */
  lastUpdateMs: number = 0;
  /** Timestamp (ms) of the last corrective seek. Used for cooldown. */
  lastCorrectionMs: number = Number.NEGATIVE_INFINITY;

  constructor(role: Role, config: Partial<SyncConfig> = {}) {
    this.role = role;
    this.config = { ...DEFAULT_SYNC_CONFIG, ...config };
    this.state = {
      positionMs: 0,
      paused: true,
      speed: 1,
      buffering: false,
      seeking: false,
    };
  }

  /** Feed an action into the engine; returns effects the caller must execute. */
  apply(action: SyncAction): SyncEffect[] {
    this.pruneSuppressions(action.nowMs);

    switch (action.kind) {
      case "local-play":
        return this.onLocalPlay(action);
      case "local-pause":
        return this.onLocalPause(action);
      case "local-seek":
        return this.onLocalSeek(action);
      case "local-speed":
        return this.onLocalSpeed(action);
      case "local-buffering":
        this.state.buffering = action.buffering;
        return [];
      case "local-seeking":
        this.state.seeking = action.seeking;
        return [];
      case "remote-play":
        return this.onRemotePlay(action);
      case "remote-pause":
        return this.onRemotePause(action);
      case "remote-seek":
        return this.onRemoteSeek(action);
      case "remote-speed":
        return this.onRemoteSpeed(action);
      case "remote-state":
        return this.onRemoteState(action);
      case "remote-heartbeat":
        return this.onRemoteHeartbeat(action);
    }
  }

  /** Returns a snapshot of active (non-expired) suppressions. For testing. */
  get activeSuppressions(): ReadonlyArray<{ action: SuppressibleAction; expiresAtMs: number }> {
    return this.suppressions;
  }

  // -------------------------------------------------------------------------
  // Suppression helpers
  // -------------------------------------------------------------------------

  private addSuppression(action: SuppressibleAction, nowMs: number): void {
    this.suppressions.push({
      action,
      expiresAtMs: nowMs + this.config.suppressionWindowMs,
    });
  }

  /** Consume one matching suppression entry. Returns true if suppressed. */
  private consumeSuppression(action: SuppressibleAction, nowMs: number): boolean {
    const idx = this.suppressions.findIndex(
      (s) => s.action === action && s.expiresAtMs > nowMs,
    );
    if (idx !== -1) {
      this.suppressions.splice(idx, 1);
      return true;
    }
    return false;
  }

  private pruneSuppressions(nowMs: number): void {
    this.suppressions = this.suppressions.filter((s) => s.expiresAtMs > nowMs);
  }

  // -------------------------------------------------------------------------
  // Position tracking
  // -------------------------------------------------------------------------

  /** Estimate current playback position based on elapsed time and speed. */
  estimatePosition(nowMs: number): number {
    if (this.state.paused || this.state.buffering || this.state.seeking) {
      return this.state.positionMs;
    }
    const elapsed = Math.max(0, nowMs - this.lastUpdateMs);
    return this.state.positionMs + elapsed * this.state.speed;
  }

  private updatePosition(positionMs: number, nowMs: number): void {
    this.state.positionMs = positionMs;
    this.lastUpdateMs = nowMs;
  }

  // -------------------------------------------------------------------------
  // Local event handlers
  // -------------------------------------------------------------------------

  private onLocalPlay(a: { positionMs: number; nowMs: number }): SyncEffect[] {
    this.state.paused = false;
    this.updatePosition(a.positionMs, a.nowMs);
    if (this.consumeSuppression("play", a.nowMs)) return [];
    return [{ type: "send-play", positionMs: a.positionMs }];
  }

  private onLocalPause(a: { positionMs: number; nowMs: number }): SyncEffect[] {
    this.state.paused = true;
    this.updatePosition(a.positionMs, a.nowMs);
    if (this.consumeSuppression("pause", a.nowMs)) return [];
    return [{ type: "send-pause", positionMs: a.positionMs }];
  }

  private onLocalSeek(a: { positionMs: number; nowMs: number }): SyncEffect[] {
    this.updatePosition(a.positionMs, a.nowMs);
    if (this.consumeSuppression("seek", a.nowMs)) return [];
    return [{ type: "send-seek", positionMs: a.positionMs, cause: "user" }];
  }

  private onLocalSpeed(a: { speed: number; nowMs: number }): SyncEffect[] {
    this.state.speed = a.speed;
    if (this.consumeSuppression("speed", a.nowMs)) return [];
    return [{ type: "send-speed", speed: a.speed }];
  }

  // -------------------------------------------------------------------------
  // Remote command handlers
  // -------------------------------------------------------------------------

  private onRemotePlay(a: { positionMs: number; nowMs: number }): SyncEffect[] {
    this.state.paused = false;
    this.updatePosition(a.positionMs, a.nowMs);
    this.addSuppression("play", a.nowMs);
    this.addSuppression("seek", a.nowMs);
    return [
      { type: "set-paused", paused: false },
      { type: "seek", positionMs: a.positionMs },
    ];
  }

  private onRemotePause(a: { positionMs: number; nowMs: number }): SyncEffect[] {
    this.state.paused = true;
    this.updatePosition(a.positionMs, a.nowMs);
    this.addSuppression("pause", a.nowMs);
    this.addSuppression("seek", a.nowMs);
    return [
      { type: "set-paused", paused: true },
      { type: "seek", positionMs: a.positionMs },
    ];
  }

  private onRemoteSeek(a: { positionMs: number; nowMs: number }): SyncEffect[] {
    this.updatePosition(a.positionMs, a.nowMs);
    this.addSuppression("seek", a.nowMs);
    return [{ type: "seek", positionMs: a.positionMs }];
  }

  private onRemoteSpeed(a: { speed: number; nowMs: number }): SyncEffect[] {
    this.state.speed = a.speed;
    this.addSuppression("speed", a.nowMs);
    return [{ type: "set-speed", speed: a.speed }];
  }

  private onRemoteState(a: {
    positionMs: number;
    paused: boolean;
    speed: number;
    buffering?: boolean;
    nowMs: number;
  }): SyncEffect[] {
    this.updatePosition(a.positionMs, a.nowMs);
    this.state.paused = a.paused;
    this.state.speed = a.speed;
    this.state.buffering = a.buffering ?? false;

    this.addSuppression("seek", a.nowMs);
    this.addSuppression(a.paused ? "pause" : "play", a.nowMs);
    this.addSuppression("speed", a.nowMs);

    return [
      { type: "seek", positionMs: a.positionMs },
      { type: "set-paused", paused: a.paused },
      { type: "set-speed", speed: a.speed },
    ];
  }

  // -------------------------------------------------------------------------
  // Heartbeat / drift correction (guest only)
  // -------------------------------------------------------------------------

  private onRemoteHeartbeat(a: {
    positionMs: number;
    paused: boolean;
    speed: number;
    buffering?: boolean;
    seeking?: boolean;
    nowMs: number;
  }): SyncEffect[] {
    if (this.role !== "guest") return [];

    const effects: SyncEffect[] = [];

    // Speed mismatch: correct speed first
    if (this.state.speed !== a.speed) {
      this.state.speed = a.speed;
      effects.push({ type: "set-speed", speed: a.speed });
      this.addSuppression("speed", a.nowMs);
    }

    // Skip drift correction when either side is paused, buffering, or seeking
    if (this.state.paused || this.state.buffering || this.state.seeking) return effects;
    if (a.paused || a.buffering || a.seeking) return effects;

    // Cooldown: skip if we corrected recently to prevent seek spam
    if (a.nowMs - this.lastCorrectionMs < this.config.correctionCooldownMs) return effects;

    // Estimate guest position based on elapsed time and playback speed
    const estimatedPos = this.estimatePosition(a.nowMs);
    const drift = Math.abs(estimatedPos - a.positionMs);
    if (drift > this.config.driftThresholdMs) {
      this.updatePosition(a.positionMs, a.nowMs);
      this.lastCorrectionMs = a.nowMs;
      effects.push({ type: "seek", positionMs: a.positionMs });
      this.addSuppression("seek", a.nowMs);
    }

    return effects;
  }
}
