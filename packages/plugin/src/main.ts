/**
 * Watch Party — IINA plugin main entry point.
 *
 * Manages connection state, room lifecycle, and communication with the overlay
 * (transport bridge) and sidebar (UI) webviews.
 */

import { parseInvite, PROTOCOL_VERSION, SyncEngine, type SyncEffect } from "@iina-watch-party/shared";

const { overlay, sidebar, console: log, core, preferences, osd } = iina;

log.log("Watch Party plugin loaded");

overlay.loadFile("ui/overlay/index.html");
sidebar.loadFile("ui/sidebar/index.html");

// ── Types ──────────────────────────────────────────────────────────

type ConnectionState = "idle" | "connecting" | "authenticating" | "connected";
type Role = "host" | "guest";

interface RoomContext {
  backendUrl: string;
  wsUrl: string;
  roomCode: string;
  secret: string;
  role: Role;
  invite: string;
}

interface FileMetadata {
  durationMs: number;
  title: string;
}

// ── State ──────────────────────────────────────────────────────────

let connState: ConnectionState = "idle";
let room: RoomContext | null = null;
let syncEngine: SyncEngine | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let msgSeq = 0;

const HEARTBEAT_INTERVAL_MS = 5000;

// ── Preferences ────────────────────────────────────────────────────

function getBackendUrl(): string {
  const url = preferences.get("backendUrl") as string | undefined;
  return url && url.trim() !== "" ? url.trim() : "";
}

function getDisplayName(): string {
  const name = preferences.get("displayName") as string | undefined;
  return name && name.trim() !== "" ? name.trim() : "Anonymous";
}

// ── File metadata ──────────────────────────────────────────────────

function getFileMetadata(): FileMetadata {
  return {
    durationMs: Math.round((core.status.duration ?? 0) * 1000),
    title: core.status.title ?? "",
  };
}

function isFileLoaded(): boolean {
  return !core.status.idle;
}

// ── Helpers ────────────────────────────────────────────────────────

function setSidebarView(view: "idle" | "connecting" | "connected" | "error") {
  sidebar.postMessage("sb-state", { view });
}

function transition(next: ConnectionState) {
  log.log(`State: ${connState} → ${next}`);
  connState = next;
}

function nextMessageId(): string {
  return `m-${++msgSeq}`;
}

function makeEnvelope(type: string) {
  return {
    type,
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    messageId: nextMessageId(),
    tsMs: Date.now(),
  };
}

function sendProtocol(msg: Record<string, unknown>) {
  overlay.postMessage("ws-send", { data: JSON.stringify(msg) });
}

function toWsUrl(backendUrl: string, roomCode: string): string {
  return backendUrl.replace(/^http/, "ws") + `/ws/${roomCode}`;
}

function getPositionMs(): number {
  return Math.round((core.status.position ?? 0) * 1000);
}

function executeEffects(effects: SyncEffect[]) {
  for (const effect of effects) {
    switch (effect.type) {
      case "seek":
        core.seekTo(effect.positionMs / 1000);
        break;
      case "set-paused":
        if (effect.paused) core.pause();
        else core.resume();
        break;
      case "set-speed":
        core.setSpeed(effect.speed);
        break;
      case "send-play":
        sendProtocol({ ...makeEnvelope("play"), positionMs: effect.positionMs });
        break;
      case "send-pause":
        sendProtocol({ ...makeEnvelope("pause"), positionMs: effect.positionMs });
        break;
      case "send-seek":
        sendProtocol({
          ...makeEnvelope("seek"),
          positionMs: effect.positionMs,
          cause: effect.cause,
        });
        break;
      case "send-speed":
        sendProtocol({ ...makeEnvelope("speed"), speed: effect.speed });
        break;
    }
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (connState !== "connected") return;
    sendProtocol({
      ...makeEnvelope("heartbeat"),
      positionMs: getPositionMs(),
      paused: core.status.paused ?? false,
      speed: core.status.speed ?? 1,
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function initSync(role: Role) {
  const driftThresholdMs = (preferences.get("driftThresholdMs") as number) ?? 2000;
  syncEngine = new SyncEngine(role, { driftThresholdMs });
  startHeartbeat();
}

function resetState() {
  transition("idle");
  room = null;
  syncEngine = null;
  stopHeartbeat();
  setSidebarView("idle");
  sidebar.postMessage("sb-status", { text: "Not connected" });
}

function disconnect() {
  if (room && connState === "connected") {
    sendProtocol({ ...makeEnvelope("goodbye"), reason: "user-leave" });
  }
  overlay.postMessage("ws-disconnect", {});
  resetState();
}

// ── Sidebar: create room ───────────────────────────────────────────

sidebar.onMessage("create-room", (_data: unknown) => {
  if (connState !== "idle") return;

  if (!isFileLoaded()) {
    sidebar.postMessage("sb-error", { text: "Please open a video file first." });
    osd.show("Watch Party: Open a file before creating a room");
    return;
  }

  const backendUrl = getBackendUrl();
  if (!backendUrl) {
    sidebar.postMessage("sb-error", {
      text: "Backend URL not configured. Set it in plugin preferences.",
    });
    return;
  }

  log.log("Creating room…");
  transition("connecting");
  setSidebarView("connecting");
  sidebar.postMessage("sb-connecting-text", { text: "Creating room…" });

  overlay.postMessage("http-fetch", {
    url: `${backendUrl}/api/rooms`,
    method: "POST",
  });
});

overlay.onMessage("http-response", (data: unknown) => {
  if (connState !== "connecting") return;

  const d = data as {
    ok?: boolean;
    status?: number;
    body?: Record<string, unknown>;
    error?: string;
  } | null;

  if (!d || !d.ok || d.error) {
    log.log(`Create room failed: ${d?.error ?? `HTTP ${d?.status}`}`);
    resetState();
    sidebar.postMessage("sb-error", { text: d?.error ?? "Failed to create room" });
    osd.show("Watch Party: Failed to create room");
    return;
  }

  const body = d.body;
  const roomCode = body?.roomCode as string | undefined;
  const secret = body?.secret as string | undefined;
  const wsUrl = body?.wsUrl as string | undefined;
  const invite = body?.invite as string | undefined;

  if (!roomCode || !secret || !wsUrl) {
    log.log("Create room: invalid server response");
    resetState();
    sidebar.postMessage("sb-error", { text: "Invalid server response" });
    return;
  }

  room = {
    backendUrl: getBackendUrl(),
    wsUrl,
    roomCode,
    secret,
    role: "host",
    invite: invite ?? `${roomCode}:${secret}`,
  };

  log.log(`Room created: ${room.roomCode}, connecting WebSocket…`);
  overlay.postMessage("ws-connect", { url: room.wsUrl });
});

// ── Sidebar: join room ─────────────────────────────────────────────

sidebar.onMessage("join-room", (data: unknown) => {
  if (connState !== "idle") return;

  const d = data as { invite?: string } | null;
  const raw = d?.invite?.trim();
  if (!raw) {
    sidebar.postMessage("sb-error", { text: "Please enter an invite code." });
    return;
  }

  if (!isFileLoaded()) {
    sidebar.postMessage("sb-error", { text: "Please open a video file first." });
    osd.show("Watch Party: Open a file before joining a room");
    return;
  }

  const result = parseInvite(raw);
  if (!result.ok) {
    log.log(`Invalid invite: ${result.error}`);
    sidebar.postMessage("sb-error", { text: result.error });
    osd.show("Watch Party: Invalid invite code");
    return;
  }

  const backendUrl = getBackendUrl();
  if (!backendUrl) {
    sidebar.postMessage("sb-error", {
      text: "Backend URL not configured. Set it in plugin preferences.",
    });
    return;
  }

  const { roomCode, secret } = result.invite;
  const wsUrl = toWsUrl(backendUrl, roomCode);

  log.log(`Joining room ${roomCode}…`);
  transition("connecting");
  setSidebarView("connecting");
  sidebar.postMessage("sb-connecting-text", { text: "Joining room…" });

  room = {
    backendUrl,
    wsUrl,
    roomCode,
    secret,
    role: "guest",
    invite: raw,
  };

  overlay.postMessage("ws-connect", { url: wsUrl });
});

// ── Sidebar: leave / copy ──────────────────────────────────────────

sidebar.onMessage("leave-room", (_data: unknown) => {
  log.log("Leaving room…");
  disconnect();
});

sidebar.onMessage("copy-invite", (_data: unknown) => {
  if (room) {
    sidebar.postMessage("sb-copy-text", { text: room.invite });
    osd.show("Invite copied to clipboard");
  }
});

// ── Overlay: WebSocket lifecycle ───────────────────────────────────

overlay.onMessage("ws-open", (_data: unknown) => {
  if (!room) return;

  log.log("WebSocket connected, authenticating…");
  transition("authenticating");
  sidebar.postMessage("sb-connecting-text", { text: "Authenticating…" });

  const file = getFileMetadata();
  sendProtocol({
    ...makeEnvelope("auth"),
    secret: room.secret,
    displayName: getDisplayName(),
    desiredRole: room.role,
    file,
  });
});

overlay.onMessage("ws-message", (data: unknown) => {
  const d = data as { data?: string } | null;
  if (!d?.data) return;

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(d.data);
  } catch {
    log.log("Received invalid JSON from server");
    return;
  }

  handleServerMessage(msg);
});

overlay.onMessage("ws-closed", (data: unknown) => {
  const d = data as { code?: number; reason?: string } | null;
  log.log(`WebSocket closed: code=${d?.code} reason=${d?.reason}`);

  if (connState === "connecting" || connState === "authenticating") {
    resetState();
    sidebar.postMessage("sb-error", { text: "Connection failed" });
  } else if (connState === "connected") {
    sidebar.postMessage("sb-status", { text: "Connection lost" });
  }
});

overlay.onMessage("ws-error", (_data: unknown) => {
  log.log("WebSocket error");
});

overlay.onMessage("ws-reconnecting", (data: unknown) => {
  const d = data as { attempt?: number; delayMs?: number } | null;
  log.log(`Reconnecting: attempt=${d?.attempt} delay=${d?.delayMs}ms`);

  if (connState === "connected") {
    transition("connecting");
    setSidebarView("connecting");
  }
  sidebar.postMessage("sb-connecting-text", {
    text: `Reconnecting (attempt ${d?.attempt ?? "?"})…`,
  });
});

// ── Protocol message dispatch ──────────────────────────────────────

function handleServerMessage(msg: Record<string, unknown>) {
  switch (msg.type) {
    case "auth-ok":
      onAuthOk(msg);
      break;
    case "auth-error":
      onAuthError(msg);
      break;
    case "presence":
      onPresence(msg);
      break;
    case "warning":
      onWarning(msg);
      break;
    case "error":
      onServerError(msg);
      break;
    case "play":
      onRemotePlayback(msg);
      break;
    case "pause":
      onRemotePlayback(msg);
      break;
    case "seek":
      onRemotePlayback(msg);
      break;
    case "speed":
      onRemotePlayback(msg);
      break;
    case "state":
      onRemotePlayback(msg);
      break;
    case "heartbeat":
      onRemotePlayback(msg);
      break;
    default:
      log.log(`Unhandled message type: ${String(msg.type)}`);
      break;
  }
}

function onAuthOk(msg: Record<string, unknown>) {
  if (connState !== "authenticating" || !room) return;

  const role = msg.role as Role;
  const roomCode = msg.roomCode as string | undefined;
  const peerPresent = msg.peerPresent as boolean;

  room.role = role;
  if (roomCode) room.roomCode = roomCode;

  initSync(role);

  log.log(`Authenticated as ${role} in room ${room.roomCode}`);
  transition("connected");
  setSidebarView("connected");

  sidebar.postMessage("sb-room", {
    code: room.roomCode,
    invite: room.role === "host" ? room.invite : "",
  });

  sidebar.postMessage("sb-peer", {
    present: peerPresent ?? false,
    name: peerPresent ? "Peer connected" : undefined,
  });

  sidebar.postMessage("sb-status", { text: "Connected" });
  osd.show(`Watch Party: Connected to room ${room.roomCode}`);
}

function onAuthError(msg: Record<string, unknown>) {
  log.log(`Auth error: ${String(msg.message)}`);
  overlay.postMessage("ws-disconnect", {});
  room = null;
  transition("idle");
  sidebar.postMessage("sb-error", {
    text: (msg.message as string) ?? "Authentication failed",
  });
}

function onPresence(msg: Record<string, unknown>) {
  const event = msg.event as string;
  log.log(`Presence: ${event} (${String(msg.role)})`);

  if (event === "peer-joined" || event === "peer-replaced") {
    sidebar.postMessage("sb-peer", { present: true, name: "Peer connected" });
  } else if (event === "peer-left") {
    sidebar.postMessage("sb-peer", { present: false });
  }
}

function onWarning(msg: Record<string, unknown>) {
  log.log(`Warning: ${String(msg.code)} — ${String(msg.message)}`);
  sidebar.postMessage("sb-warning", { text: msg.message as string });
}

function onServerError(msg: Record<string, unknown>) {
  log.log(`Server error: ${String(msg.code)} — ${String(msg.message)}`);
  sidebar.postMessage("sb-error", {
    text: (msg.message as string) ?? "Server error",
  });
}

function onRemotePlayback(msg: Record<string, unknown>) {
  if (!syncEngine || connState !== "connected") return;
  const nowMs = Date.now();
  const type = msg.type as string;

  let action;
  switch (type) {
    case "play":
      action = { kind: "remote-play" as const, positionMs: msg.positionMs as number, nowMs };
      break;
    case "pause":
      action = { kind: "remote-pause" as const, positionMs: msg.positionMs as number, nowMs };
      break;
    case "seek":
      action = { kind: "remote-seek" as const, positionMs: msg.positionMs as number, nowMs };
      break;
    case "speed":
      action = { kind: "remote-speed" as const, speed: msg.speed as number, nowMs };
      break;
    case "state":
      action = {
        kind: "remote-state" as const,
        positionMs: msg.positionMs as number,
        paused: msg.paused as boolean,
        speed: msg.speed as number,
        nowMs,
      };
      break;
    case "heartbeat":
      action = {
        kind: "remote-heartbeat" as const,
        positionMs: msg.positionMs as number,
        paused: msg.paused as boolean,
        speed: msg.speed as number,
        buffering: msg.buffering as boolean | undefined,
        seeking: msg.seeking as boolean | undefined,
        nowMs,
      };
      break;
    default:
      return;
  }

  const effects = syncEngine.apply(action);
  executeEffects(effects);
}

// ── IINA player event listeners ─────────────────────────────────────

iina.event.on("iina.pause", () => {
  if (!syncEngine || connState !== "connected") return;
  const positionMs = getPositionMs();
  const nowMs = Date.now();
  const effects = core.status.paused
    ? syncEngine.apply({ kind: "local-pause", positionMs, nowMs })
    : syncEngine.apply({ kind: "local-play", positionMs, nowMs });
  executeEffects(effects);
});

iina.event.on("iina.seek", () => {
  if (!syncEngine || connState !== "connected") return;
  const positionMs = getPositionMs();
  const nowMs = Date.now();
  const effects = syncEngine.apply({ kind: "local-seek", positionMs, nowMs });
  executeEffects(effects);
});

iina.event.on("iina.speed", () => {
  if (!syncEngine || connState !== "connected") return;
  const speed = core.status.speed ?? 1;
  const nowMs = Date.now();
  const effects = syncEngine.apply({ kind: "local-speed", speed, nowMs });
  executeEffects(effects);
});
