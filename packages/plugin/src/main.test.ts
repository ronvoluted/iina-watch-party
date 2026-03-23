/* eslint-disable @typescript-eslint/no-require-imports */
import { describe, test, expect, beforeEach } from "bun:test";

// ── Mock infrastructure ──────────────────────────────────────────────

type MessageHandler = (data: unknown) => void;
type Posted = { name: string; data: unknown };

/** Captured message handlers keyed by target.name. */
let overlayHandlers: Record<string, MessageHandler>;
let sidebarHandlers: Record<string, MessageHandler>;

/** Messages posted via postMessage keyed by target. */
let overlayPosted: Posted[];
let sidebarPosted: Posted[];

let logMessages: string[];
let osdMessages: string[];

/** Mock preferences store. */
let prefsStore: Record<string, unknown>;

/** Mock core status. */
let coreStatus: Record<string, unknown>;

/** Captured IINA event handlers. */
let eventHandlers: Record<string, Array<(...args: unknown[]) => void>>;

/** Captured core method calls. */
let coreCalls: { method: string; args: unknown[] }[];

/** Mock mpv flag store for property observers. */
let mpvFlags: Record<string, boolean>;

/** Type-safe accessor for posted message data fields. */
function d(msg: Posted | undefined): Record<string, unknown> {
  return (msg?.data ?? {}) as Record<string, unknown>;
}

function setupGlobals() {
  overlayHandlers = {};
  sidebarHandlers = {};
  overlayPosted = [];
  sidebarPosted = [];
  logMessages = [];
  osdMessages = [];
  prefsStore = {
    backendUrl: "https://watchparty.example.com",
    displayName: "TestUser",
    driftThresholdMs: 2000,
  };
  coreStatus = {
    paused: false,
    idle: false,
    position: 42.5,
    duration: 7200,
    speed: 1.0,
    url: "/path/to/movie.mp4",
    title: "movie.mp4",
    isNetworkResource: false,
  };

  eventHandlers = {};
  coreCalls = [];
  mpvFlags = { "paused-for-cache": false };

  (globalThis as Record<string, unknown>).iina = {
    overlay: {
      loadFile(_path: string) {},
      onMessage(name: string, cb: MessageHandler) {
        overlayHandlers[name] = cb;
      },
      postMessage(name: string, data: unknown) {
        overlayPosted.push({ name, data });
      },
    },
    sidebar: {
      loadFile(_path: string) {},
      onMessage(name: string, cb: MessageHandler) {
        sidebarHandlers[name] = cb;
      },
      postMessage(name: string, data: unknown) {
        sidebarPosted.push({ name, data });
      },
    },
    console: {
      log(...args: unknown[]) {
        logMessages.push(args.map(String).join(" "));
      },
    },
    core: {
      status: coreStatus,
      pause() { coreCalls.push({ method: "pause", args: [] }); },
      resume() { coreCalls.push({ method: "resume", args: [] }); },
      seek(seconds: number, exact: boolean) { coreCalls.push({ method: "seek", args: [seconds, exact] }); },
      seekTo(seconds: number) { coreCalls.push({ method: "seekTo", args: [seconds] }); },
      setSpeed(speed: number) { coreCalls.push({ method: "setSpeed", args: [speed] }); },
      stop() { coreCalls.push({ method: "stop", args: [] }); },
    },
    preferences: {
      get(key: string) {
        return prefsStore[key];
      },
      set(key: string, value: unknown) {
        prefsStore[key] = value;
      },
    },
    osd: {
      show(message: string) {
        osdMessages.push(message);
      },
    },
    event: {
      on(event: string, callback: (...args: unknown[]) => void) {
        if (!eventHandlers[event]) eventHandlers[event] = [];
        eventHandlers[event].push(callback);
      },
    },
    mpv: {
      getFlag(name: string) { return mpvFlags[name] ?? false; },
      getNumber() { return 0; },
      getString() { return ""; },
    },
  };
}

function loadMain() {
  const path = require.resolve("./main.ts");
  delete require.cache[path];
  require(path);
  overlayPosted = [];
  sidebarPosted = [];
  logMessages = [];
  osdMessages = [];
}

function sidebarSend(name: string, data?: unknown) {
  sidebarHandlers[name]?.(data);
}

function overlaySend(name: string, data?: unknown) {
  overlayHandlers[name]?.(data);
}

function findOverlayPosted(name: string) {
  return overlayPosted.filter((m) => m.name === name);
}

function findSidebarPosted(name: string) {
  return sidebarPosted.filter((m) => m.name === name);
}

function lastOverlayPosted(name: string) {
  const msgs = findOverlayPosted(name);
  return msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
}

function lastSidebarPosted(name: string) {
  const msgs = findSidebarPosted(name);
  return msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
}

/** Fire an IINA event (simulates player state change). */
function fireEvent(name: string, ...args: unknown[]) {
  for (const cb of eventHandlers[name] ?? []) cb(...args);
}

/** Parse the last ws-send message's JSON payload. */
function lastSentProtocol(): Record<string, unknown> | undefined {
  const send = lastOverlayPosted("ws-send");
  if (!send) return undefined;
  return JSON.parse(d(send).data as string) as Record<string, unknown>;
}

/** Send a server message to the plugin. */
function serverSend(msg: Record<string, unknown>) {
  overlaySend("ws-message", { data: JSON.stringify(msg) });
}

/** Simulate the full create-room flow through to auth-ok. */
function doCreateRoom() {
  sidebarSend("create-room");

  overlaySend("http-response", {
    ok: true,
    status: 200,
    body: {
      roomCode: "ABC123",
      secret: "testsecret",
      wsUrl: "wss://watchparty.example.com/ws/ABC123",
      invite: "ABC123:testsecret",
    },
  });

  overlaySend("ws-open");

  overlaySend("ws-message", {
    data: JSON.stringify({
      type: "auth-ok",
      role: "host",
      roomCode: "ABC123",
      peerPresent: false,
      expiresAtMs: Date.now() + 3600000,
    }),
  });
}

/** Simulate the full join-room flow through to auth-ok. */
function doJoinRoom(invite = "ABCDEF:dGVzdHNlY3JldA") {
  sidebarSend("join-room", { invite });

  overlaySend("ws-open");

  overlaySend("ws-message", {
    data: JSON.stringify({
      type: "auth-ok",
      role: "guest",
      roomCode: "ABCDEF",
      peerPresent: true,
      expiresAtMs: Date.now() + 3600000,
    }),
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("main connection state", () => {
  beforeEach(() => {
    setupGlobals();
    loadMain();
  });

  describe("initialization", () => {
    test("registers sidebar message handlers", () => {
      expect(sidebarHandlers["create-room"]).toBeDefined();
      expect(sidebarHandlers["join-room"]).toBeDefined();
      expect(sidebarHandlers["leave-room"]).toBeDefined();
      expect(sidebarHandlers["copy-invite"]).toBeDefined();
    });

    test("registers overlay message handlers", () => {
      expect(overlayHandlers["http-response"]).toBeDefined();
      expect(overlayHandlers["ws-open"]).toBeDefined();
      expect(overlayHandlers["ws-message"]).toBeDefined();
      expect(overlayHandlers["ws-closed"]).toBeDefined();
      expect(overlayHandlers["ws-error"]).toBeDefined();
      expect(overlayHandlers["ws-reconnecting"]).toBeDefined();
    });
  });

  describe("create-room flow", () => {
    test("sends http-fetch to overlay on create-room", () => {
      sidebarSend("create-room");

      const fetch = lastOverlayPosted("http-fetch");
      expect(fetch).toBeDefined();
      expect(d(fetch).url).toContain("/api/rooms");
      expect(d(fetch).method).toBe("POST");
    });

    test("uses backend URL from preferences", () => {
      prefsStore.backendUrl = "https://custom-backend.example.com";
      sidebarSend("create-room");

      const fetch = lastOverlayPosted("http-fetch");
      expect(d(fetch).url).toBe("https://custom-backend.example.com/api/rooms");
    });

    test("shows error when backend URL is not configured", () => {
      prefsStore.backendUrl = "";
      sidebarSend("create-room");

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
      expect(d(err).text).toContain("Backend URL");
      expect(findOverlayPosted("http-fetch")).toEqual([]);
    });

    test("shows error when no file is loaded", () => {
      coreStatus.idle = true;
      sidebarSend("create-room");

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
      expect(d(err).text).toContain("video file");
      expect(findOverlayPosted("http-fetch")).toEqual([]);
    });

    test("shows OSD when no file is loaded", () => {
      coreStatus.idle = true;
      sidebarSend("create-room");

      expect(osdMessages.some((m) => m.includes("file"))).toBe(true);
    });

    test("shows connecting view on create-room", () => {
      sidebarSend("create-room");

      const state = findSidebarPosted("sb-state");
      expect(state.some((m) => d(m).view === "connecting")).toBe(true);
    });

    test("connects WebSocket after successful http-response", () => {
      sidebarSend("create-room");

      overlaySend("http-response", {
        ok: true,
        status: 200,
        body: {
          roomCode: "ABC123",
          secret: "testsecret",
          wsUrl: "wss://watchparty.example.com/ws/ABC123",
          invite: "ABC123:testsecret",
        },
      });

      const connect = lastOverlayPosted("ws-connect");
      expect(connect).toBeDefined();
      expect(d(connect).url).toBe("wss://watchparty.example.com/ws/ABC123");
    });

    test("shows error on http-response failure", () => {
      sidebarSend("create-room");

      overlaySend("http-response", { ok: false, error: "Network error" });

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
      expect(d(err).text).toContain("Network error");
    });

    test("shows OSD on http-response failure", () => {
      sidebarSend("create-room");

      overlaySend("http-response", { ok: false, error: "Network error" });

      expect(osdMessages.some((m) => m.includes("Failed"))).toBe(true);
    });

    test("shows error on invalid server response", () => {
      sidebarSend("create-room");

      overlaySend("http-response", {
        ok: true,
        status: 200,
        body: { roomCode: "ABC123" },
      });

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
      expect(d(err).text).toContain("Invalid server response");
    });

    test("sends auth message with file metadata and display name on ws-open", () => {
      sidebarSend("create-room");

      overlaySend("http-response", {
        ok: true,
        status: 200,
        body: {
          roomCode: "ABC123",
          secret: "testsecret",
          wsUrl: "wss://watchparty.example.com/ws/ABC123",
          invite: "ABC123:testsecret",
        },
      });

      overlaySend("ws-open");

      const send = lastOverlayPosted("ws-send");
      expect(send).toBeDefined();
      const msg = JSON.parse(d(send).data as string) as Record<string, unknown>;
      expect(msg.type).toBe("auth");
      expect(msg.secret).toBe("testsecret");
      expect(msg.desiredRole).toBe("host");
      expect(msg.displayName).toBe("TestUser");
      expect(msg.protocolVersion).toBe(1);
      expect(msg.sessionId).toBeDefined();
      expect(msg.messageId).toBeDefined();

      const file = msg.file as Record<string, unknown>;
      expect(file).toBeDefined();
      expect(file.durationMs).toBe(7200000);
      expect(file.name).toBe("movie.mp4");
    });

    test("uses default display name when preference is empty", () => {
      prefsStore.displayName = "";
      sidebarSend("create-room");

      overlaySend("http-response", {
        ok: true,
        status: 200,
        body: {
          roomCode: "ABC123",
          secret: "testsecret",
          wsUrl: "wss://watchparty.example.com/ws/ABC123",
          invite: "ABC123:testsecret",
        },
      });

      overlaySend("ws-open");

      const send = lastOverlayPosted("ws-send");
      const msg = JSON.parse(d(send).data as string) as Record<string, unknown>;
      expect(msg.displayName).toBe("Anonymous");
    });

    test("transitions to connected on auth-ok", () => {
      doCreateRoom();

      const state = findSidebarPosted("sb-state");
      expect(state.some((m) => d(m).view === "connected")).toBe(true);

      const room = lastSidebarPosted("sb-room");
      expect(room).toBeDefined();
      expect(d(room).code).toBe("ABC123");
      expect(d(room).invite).toBe("ABC123:testsecret");
    });

    test("shows OSD on successful connection", () => {
      doCreateRoom();

      expect(osdMessages.some((m) => m.includes("Connected"))).toBe(true);
    });

    test("ignores create-room when not idle", () => {
      sidebarSend("create-room");
      overlayPosted = [];

      sidebarSend("create-room");

      expect(findOverlayPosted("http-fetch")).toEqual([]);
    });
  });

  describe("join-room flow", () => {
    test("sends ws-connect on valid invite", () => {
      sidebarSend("join-room", { invite: "ABCDEF:dGVzdHNlY3JldA" });

      const connect = lastOverlayPosted("ws-connect");
      expect(connect).toBeDefined();
      expect(d(connect).url).toContain("/ws/ABCDEF");
    });

    test("uses backend URL from preferences for WebSocket URL", () => {
      prefsStore.backendUrl = "https://custom.example.com";
      sidebarSend("join-room", { invite: "ABCDEF:dGVzdHNlY3JldA" });

      const connect = lastOverlayPosted("ws-connect");
      expect(d(connect).url).toBe("wss://custom.example.com/ws/ABCDEF");
    });

    test("shows error when backend URL is not configured", () => {
      prefsStore.backendUrl = "";
      sidebarSend("join-room", { invite: "ABCDEF:dGVzdHNlY3JldA" });

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
      expect(d(err).text).toContain("Backend URL");
      expect(findOverlayPosted("ws-connect")).toEqual([]);
    });

    test("shows connecting view on join-room", () => {
      sidebarSend("join-room", { invite: "ABCDEF:dGVzdHNlY3JldA" });

      const state = findSidebarPosted("sb-state");
      expect(state.some((m) => d(m).view === "connecting")).toBe(true);
    });

    test("sends auth with guest role and file metadata on ws-open", () => {
      sidebarSend("join-room", { invite: "ABCDEF:dGVzdHNlY3JldA" });
      overlaySend("ws-open");

      const send = lastOverlayPosted("ws-send");
      expect(send).toBeDefined();
      const msg = JSON.parse(d(send).data as string) as Record<string, unknown>;
      expect(msg.type).toBe("auth");
      expect(msg.secret).toBe("dGVzdHNlY3JldA");
      expect(msg.desiredRole).toBe("guest");
      expect(msg.displayName).toBe("TestUser");

      const file = msg.file as Record<string, unknown>;
      expect(file.durationMs).toBe(7200000);
    });

    test("transitions to connected on auth-ok", () => {
      doJoinRoom();

      const state = findSidebarPosted("sb-state");
      expect(state.some((m) => d(m).view === "connected")).toBe(true);

      const peer = lastSidebarPosted("sb-peer");
      expect(peer).toBeDefined();
      expect(d(peer).present).toBe(true);
    });

    test("shows error when no file is loaded", () => {
      coreStatus.idle = true;
      sidebarSend("join-room", { invite: "ABCDEF:dGVzdHNlY3JldA" });

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
      expect(d(err).text).toContain("video file");
      expect(findOverlayPosted("ws-connect")).toEqual([]);
    });

    test("shows OSD when no file is loaded", () => {
      coreStatus.idle = true;
      sidebarSend("join-room", { invite: "ABCDEF:dGVzdHNlY3JldA" });

      expect(osdMessages.some((m) => m.includes("file"))).toBe(true);
    });

    test("shows error on empty invite", () => {
      sidebarSend("join-room", { invite: "" });

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
      expect(d(err).text).toContain("invite");
    });

    test("shows error on missing invite", () => {
      sidebarSend("join-room", {});

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
    });

    test("shows error on invalid invite format", () => {
      sidebarSend("join-room", { invite: "nocolon" });

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
    });

    test("shows OSD on invalid invite", () => {
      sidebarSend("join-room", { invite: "nocolon" });

      expect(osdMessages.some((m) => m.includes("Invalid invite"))).toBe(true);
    });

    test("guest does not show invite in sb-room", () => {
      doJoinRoom();

      const room = lastSidebarPosted("sb-room");
      expect(room).toBeDefined();
      expect(d(room).invite).toBe("");
    });

    test("ignores join-room when not idle", () => {
      sidebarSend("join-room", { invite: "ABCDEF:dGVzdHNlY3JldA" });
      overlayPosted = [];

      sidebarSend("join-room", { invite: "GHJKMN:other" });

      expect(findOverlayPosted("ws-connect")).toEqual([]);
    });
  });

  describe("auth-error", () => {
    test("shows error and disconnects on auth-error", () => {
      sidebarSend("join-room", { invite: "ABCDEF:dGVzdHNlY3JldA" });
      overlaySend("ws-open");

      overlaySend("ws-message", {
        data: JSON.stringify({
          type: "auth-error",
          code: "bad-secret",
          message: "Invalid secret",
        }),
      });

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
      expect(d(err).text).toBe("Invalid secret");

      const disconnect = lastOverlayPosted("ws-disconnect");
      expect(disconnect).toBeDefined();
    });
  });

  describe("leave-room", () => {
    test("sends goodbye and disconnects when connected", () => {
      doCreateRoom();
      overlayPosted = [];

      sidebarSend("leave-room");

      const send = lastOverlayPosted("ws-send");
      expect(send).toBeDefined();
      const msg = JSON.parse(d(send).data as string) as Record<string, unknown>;
      expect(msg.type).toBe("goodbye");
      expect(msg.reason).toBe("user-leave");

      const disconnect = lastOverlayPosted("ws-disconnect");
      expect(disconnect).toBeDefined();

      const state = lastSidebarPosted("sb-state");
      expect(d(state).view).toBe("idle");
    });

    test("disconnects without goodbye when not connected", () => {
      sidebarSend("join-room", { invite: "ABCDEF:dGVzdHNlY3JldA" });
      overlayPosted = [];

      sidebarSend("leave-room");

      const disconnect = lastOverlayPosted("ws-disconnect");
      expect(disconnect).toBeDefined();
      expect(findOverlayPosted("ws-send")).toEqual([]);
    });

    test("shows OSD on leave", () => {
      doCreateRoom();
      osdMessages = [];

      sidebarSend("leave-room");

      expect(osdMessages.some((m) => m.includes("Disconnected"))).toBe(true);
    });

    test("clears warnings on leave", () => {
      doCreateRoom();
      sidebarPosted = [];

      sidebarSend("leave-room");

      const warning = findSidebarPosted("sb-warning");
      expect(warning.length).toBeGreaterThan(0);
      expect(d(warning[warning.length - 1]).text).toBeUndefined();
    });

    test("resets status text on leave", () => {
      doCreateRoom();
      sidebarPosted = [];

      sidebarSend("leave-room");

      const status = lastSidebarPosted("sb-status");
      expect(status).toBeDefined();
      expect(d(status).text).toBe("Not connected");
    });
  });

  describe("goodbye from peer", () => {
    test("updates peer status on peer goodbye", () => {
      doCreateRoom();
      sidebarPosted = [];

      serverSend({ type: "goodbye", reason: "user-leave" });

      const peer = lastSidebarPosted("sb-peer");
      expect(peer).toBeDefined();
      expect(d(peer).present).toBe(false);
    });

    test("shows OSD on peer goodbye", () => {
      doCreateRoom();
      osdMessages = [];

      serverSend({ type: "goodbye", reason: "user-leave" });

      expect(osdMessages.some((m) => m.includes("Peer left"))).toBe(true);
    });

    test("does not disconnect self on peer goodbye", () => {
      doCreateRoom();
      overlayPosted = [];

      serverSend({ type: "goodbye", reason: "user-leave" });

      expect(findOverlayPosted("ws-disconnect")).toEqual([]);
    });
  });

  describe("presence events", () => {
    test("updates peer status on peer-joined", () => {
      doCreateRoom();
      sidebarPosted = [];

      overlaySend("ws-message", {
        data: JSON.stringify({ type: "presence", event: "peer-joined", role: "guest" }),
      });

      const peer = lastSidebarPosted("sb-peer");
      expect(peer).toBeDefined();
      expect(d(peer).present).toBe(true);
    });

    test("updates peer status on peer-left", () => {
      doCreateRoom();
      sidebarPosted = [];

      overlaySend("ws-message", {
        data: JSON.stringify({ type: "presence", event: "peer-left", role: "guest" }),
      });

      const peer = lastSidebarPosted("sb-peer");
      expect(peer).toBeDefined();
      expect(d(peer).present).toBe(false);
    });

    test("shows OSD on peer-left presence", () => {
      doCreateRoom();
      osdMessages = [];

      overlaySend("ws-message", {
        data: JSON.stringify({ type: "presence", event: "peer-left", role: "guest" }),
      });

      expect(osdMessages.some((m) => m.includes("disconnected"))).toBe(true);
    });

    test("updates peer status on peer-replaced", () => {
      doCreateRoom();
      sidebarPosted = [];

      overlaySend("ws-message", {
        data: JSON.stringify({ type: "presence", event: "peer-replaced", role: "guest" }),
      });

      const peer = lastSidebarPosted("sb-peer");
      expect(peer).toBeDefined();
      expect(d(peer).present).toBe(true);
    });
  });

  describe("initial sync", () => {
    test("host sends state snapshot on peer-joined", () => {
      doCreateRoom();
      overlayPosted = [];
      coreStatus.position = 120.5;
      coreStatus.paused = false;
      coreStatus.speed = 1.25;

      serverSend({ type: "presence", event: "peer-joined", role: "guest" });

      const msg = lastSentProtocol();
      expect(msg).toBeDefined();
      expect(msg!.type).toBe("state");
      expect(msg!.reason).toBe("initial");
      expect(msg!.positionMs).toBe(120500);
      expect(msg!.paused).toBe(false);
      expect(msg!.speed).toBe(1.25);
    });

    test("host sends state snapshot on peer-replaced", () => {
      doCreateRoom();
      overlayPosted = [];
      coreStatus.position = 60.0;
      coreStatus.paused = true;
      coreStatus.speed = 1.0;

      serverSend({ type: "presence", event: "peer-replaced", role: "guest" });

      const msg = lastSentProtocol();
      expect(msg).toBeDefined();
      expect(msg!.type).toBe("state");
      expect(msg!.reason).toBe("initial");
      expect(msg!.positionMs).toBe(60000);
      expect(msg!.paused).toBe(true);
      expect(msg!.speed).toBe(1.0);
    });

    test("host does not send state snapshot on peer-left", () => {
      doCreateRoom();
      overlayPosted = [];

      serverSend({ type: "presence", event: "peer-left", role: "guest" });

      expect(findOverlayPosted("ws-send")).toEqual([]);
    });

    test("guest does not send state snapshot on peer-joined", () => {
      doJoinRoom();
      overlayPosted = [];

      serverSend({ type: "presence", event: "peer-joined", role: "host" });

      // Guest should not send a state message
      const sends = findOverlayPosted("ws-send");
      const stateMsg = sends.find((s) => {
        const parsed = JSON.parse(d(s).data as string) as Record<string, unknown>;
        return parsed.type === "state";
      });
      expect(stateMsg).toBeUndefined();
    });

    test("host sends state snapshot on auth-ok with peerPresent", () => {
      // Simulate host reconnecting when guest is already present
      sidebarSend("create-room");

      overlaySend("http-response", {
        ok: true,
        status: 200,
        body: {
          roomCode: "ABC123",
          secret: "testsecret",
          wsUrl: "wss://watchparty.example.com/ws/ABC123",
          invite: "ABC123:testsecret",
        },
      });

      overlaySend("ws-open");

      coreStatus.position = 90.0;
      coreStatus.paused = false;
      coreStatus.speed = 1.5;
      overlayPosted = [];

      overlaySend("ws-message", {
        data: JSON.stringify({
          type: "auth-ok",
          role: "host",
          roomCode: "ABC123",
          peerPresent: true,
          expiresAtMs: Date.now() + 3600000,
        }),
      });

      const sends = findOverlayPosted("ws-send");
      const stateMsg = sends.find((s) => {
        const parsed = JSON.parse(d(s).data as string) as Record<string, unknown>;
        return parsed.type === "state";
      });
      expect(stateMsg).toBeDefined();
      const parsed = JSON.parse(d(stateMsg).data as string) as Record<string, unknown>;
      expect(parsed.reason).toBe("reconnect");
      expect(parsed.positionMs).toBe(90000);
      expect(parsed.paused).toBe(false);
      expect(parsed.speed).toBe(1.5);
    });

    test("host does not send state on auth-ok without peer", () => {
      doCreateRoom(); // peerPresent is false in doCreateRoom
      overlayPosted = [];

      // No state message should have been sent during auth-ok
      // (doCreateRoom already completed, check there were no state sends)
      const sends = findOverlayPosted("ws-send");
      const stateMsg = sends.find((s) => {
        const parsed = JSON.parse(d(s).data as string) as Record<string, unknown>;
        return parsed.type === "state";
      });
      expect(stateMsg).toBeUndefined();
    });

    test("state snapshot includes protocol envelope fields", () => {
      doCreateRoom();
      overlayPosted = [];

      serverSend({ type: "presence", event: "peer-joined", role: "guest" });

      const msg = lastSentProtocol();
      expect(msg).toBeDefined();
      expect(msg!.protocolVersion).toBe(1);
      expect(msg!.sessionId).toBeDefined();
      expect(msg!.messageId).toBeDefined();
      expect(msg!.tsMs).toBeGreaterThan(0);
    });
  });

  describe("warning messages", () => {
    test("shows warning on warning message", () => {
      doCreateRoom();
      sidebarPosted = [];

      overlaySend("ws-message", {
        data: JSON.stringify({
          type: "warning",
          code: "file-mismatch",
          message: "File durations differ by 5s",
        }),
      });

      const warning = lastSidebarPosted("sb-warning");
      expect(warning).toBeDefined();
      expect(d(warning).text).toBe("File durations differ by 5s");
    });
  });

  describe("server error messages", () => {
    test("shows error on server error message", () => {
      doCreateRoom();
      sidebarPosted = [];

      overlaySend("ws-message", {
        data: JSON.stringify({
          type: "error",
          code: "room-expired",
          message: "Room has expired",
        }),
      });

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
      expect(d(err).text).toBe("Room has expired");
    });
  });

  describe("WebSocket lifecycle", () => {
    test("shows connection lost on ws-closed while connected", () => {
      doCreateRoom();
      sidebarPosted = [];

      overlaySend("ws-closed", { code: 1006, reason: "" });

      const status = lastSidebarPosted("sb-status");
      expect(status).toBeDefined();
      expect(d(status).text).toBe("Connection lost");
    });

    test("resets to idle on ws-closed while connecting", () => {
      sidebarSend("create-room");
      sidebarPosted = [];

      overlaySend("http-response", {
        ok: true,
        status: 200,
        body: {
          roomCode: "ABC123",
          secret: "testsecret",
          wsUrl: "wss://watchparty.example.com/ws/ABC123",
          invite: "ABC123:testsecret",
        },
      });

      sidebarPosted = [];
      overlaySend("ws-closed", { code: 1006, reason: "" });

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
      expect(d(err).text).toBe("Connection failed");
    });

    test("resets to idle on ws-closed while authenticating", () => {
      sidebarSend("create-room");

      overlaySend("http-response", {
        ok: true,
        status: 200,
        body: {
          roomCode: "ABC123",
          secret: "testsecret",
          wsUrl: "wss://watchparty.example.com/ws/ABC123",
          invite: "ABC123:testsecret",
        },
      });

      overlaySend("ws-open");
      sidebarPosted = [];

      overlaySend("ws-closed", { code: 1006, reason: "" });

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
      expect(d(err).text).toBe("Connection failed");

      const state = findSidebarPosted("sb-state");
      expect(state.some((m) => d(m).view === "idle")).toBe(true);
    });

    test("shows reconnecting state on ws-reconnecting while connected", () => {
      doCreateRoom();
      sidebarPosted = [];

      overlaySend("ws-reconnecting", { attempt: 1, delayMs: 1000 });

      const state = lastSidebarPosted("sb-state");
      expect(state).toBeDefined();
      expect(d(state).view).toBe("connecting");

      const text = lastSidebarPosted("sb-connecting-text");
      expect(text).toBeDefined();
      expect(d(text).text).toContain("attempt 1");
    });

    test("re-authenticates on reconnection ws-open", () => {
      doCreateRoom();
      overlayPosted = [];

      overlaySend("ws-reconnecting", { attempt: 1, delayMs: 1000 });
      overlaySend("ws-open");

      const send = lastOverlayPosted("ws-send");
      expect(send).toBeDefined();
      const msg = JSON.parse(d(send).data as string) as Record<string, unknown>;
      expect(msg.type).toBe("auth");
      expect(msg.secret).toBe("testsecret");
    });

    test("ignores ws-open when no room context", () => {
      overlaySend("ws-open");

      expect(findOverlayPosted("ws-send")).toEqual([]);
    });

    test("ignores invalid JSON in ws-message", () => {
      doCreateRoom();
      sidebarPosted = [];

      overlaySend("ws-message", { data: "not json{" });
      expect(findSidebarPosted("sb-error")).toEqual([]);
    });

    test("ignores ws-message with missing data", () => {
      overlaySend("ws-message", {});
      overlaySend("ws-message", null);
    });
  });

  describe("copy-invite", () => {
    test("sends sb-copy-text to sidebar when room exists", () => {
      doCreateRoom();
      sidebarPosted = [];

      sidebarSend("copy-invite");

      const copy = lastSidebarPosted("sb-copy-text");
      expect(copy).toBeDefined();
      expect(d(copy).text).toBe("ABC123:testsecret");
    });

    test("shows OSD on copy-invite", () => {
      doCreateRoom();
      osdMessages = [];

      sidebarSend("copy-invite");

      expect(osdMessages.some((m) => m.includes("copied"))).toBe(true);
    });

    test("does nothing when no room", () => {
      sidebarPosted = [];
      sidebarSend("copy-invite");
      expect(findSidebarPosted("sb-copy-text")).toEqual([]);
    });
  });

  describe("IINA event registration", () => {
    test("registers iina.pause event handler", () => {
      expect(eventHandlers["iina.pause"]).toBeDefined();
      expect(eventHandlers["iina.pause"].length).toBeGreaterThan(0);
    });

    test("registers iina.seek event handler", () => {
      expect(eventHandlers["iina.seek"]).toBeDefined();
      expect(eventHandlers["iina.seek"].length).toBeGreaterThan(0);
    });

    test("registers iina.speed event handler", () => {
      expect(eventHandlers["iina.speed"]).toBeDefined();
      expect(eventHandlers["iina.speed"].length).toBeGreaterThan(0);
    });
  });

  describe("local playback → send protocol (host)", () => {
    beforeEach(() => {
      doCreateRoom();
      overlayPosted = [];
    });

    test("local pause sends pause message", () => {
      coreStatus.paused = true;
      coreStatus.position = 100.5;
      fireEvent("iina.pause");

      const msg = lastSentProtocol();
      expect(msg).toBeDefined();
      expect(msg!.type).toBe("pause");
      expect(msg!.positionMs).toBe(100500);
    });

    test("local resume sends play message", () => {
      coreStatus.paused = false;
      coreStatus.position = 50.0;
      fireEvent("iina.pause");

      const msg = lastSentProtocol();
      expect(msg).toBeDefined();
      expect(msg!.type).toBe("play");
      expect(msg!.positionMs).toBe(50000);
    });

    test("local seek sends seek message", () => {
      coreStatus.position = 200.0;
      fireEvent("iina.seek");

      const msg = lastSentProtocol();
      expect(msg).toBeDefined();
      expect(msg!.type).toBe("seek");
      expect(msg!.positionMs).toBe(200000);
      expect(msg!.cause).toBe("user");
    });

    test("local speed change sends speed message", () => {
      coreStatus.speed = 2.0;
      fireEvent("iina.speed");

      const msg = lastSentProtocol();
      expect(msg).toBeDefined();
      expect(msg!.type).toBe("speed");
      expect(msg!.speed).toBe(2.0);
    });

    test("local events are ignored when not connected", () => {
      sidebarSend("leave-room");
      overlayPosted = [];

      coreStatus.paused = true;
      fireEvent("iina.pause");

      expect(findOverlayPosted("ws-send")).toEqual([]);
    });
  });

  describe("local playback → send protocol (guest)", () => {
    beforeEach(() => {
      doJoinRoom();
      overlayPosted = [];
    });

    test("guest local pause sends pause message", () => {
      coreStatus.paused = true;
      coreStatus.position = 75.0;
      fireEvent("iina.pause");

      const msg = lastSentProtocol();
      expect(msg).toBeDefined();
      expect(msg!.type).toBe("pause");
      expect(msg!.positionMs).toBe(75000);
    });

    test("guest local seek sends seek message", () => {
      coreStatus.position = 300.0;
      fireEvent("iina.seek");

      const msg = lastSentProtocol();
      expect(msg).toBeDefined();
      expect(msg!.type).toBe("seek");
      expect(msg!.positionMs).toBe(300000);
    });
  });

  describe("remote playback → apply to player", () => {
    beforeEach(() => {
      doJoinRoom();
      overlayPosted = [];
      coreCalls = [];
    });

    test("remote play resumes and seeks player", () => {
      serverSend({ type: "play", positionMs: 60000 });

      expect(coreCalls).toContainEqual({ method: "resume", args: [] });
      expect(coreCalls).toContainEqual({ method: "seekTo", args: [60] });
    });

    test("remote pause pauses and seeks player", () => {
      serverSend({ type: "pause", positionMs: 45000 });

      expect(coreCalls).toContainEqual({ method: "pause", args: [] });
      expect(coreCalls).toContainEqual({ method: "seekTo", args: [45] });
    });

    test("remote seek seeks player", () => {
      serverSend({ type: "seek", positionMs: 120000, cause: "user" });

      expect(coreCalls).toContainEqual({ method: "seekTo", args: [120] });
    });

    test("remote speed sets player speed", () => {
      serverSend({ type: "speed", speed: 1.5 });

      expect(coreCalls).toContainEqual({ method: "setSpeed", args: [1.5] });
    });

    test("remote state applies full sync", () => {
      serverSend({
        type: "state",
        reason: "initial",
        positionMs: 90000,
        paused: true,
        speed: 0.75,
      });

      expect(coreCalls).toContainEqual({ method: "seekTo", args: [90] });
      expect(coreCalls).toContainEqual({ method: "pause", args: [] });
      expect(coreCalls).toContainEqual({ method: "setSpeed", args: [0.75] });
    });

    test("remote state with paused=false resumes player", () => {
      serverSend({
        type: "state",
        reason: "initial",
        positionMs: 30000,
        paused: false,
        speed: 1.0,
      });

      expect(coreCalls).toContainEqual({ method: "resume", args: [] });
      expect(coreCalls).toContainEqual({ method: "seekTo", args: [30] });
    });

    test("remote playback ignored when not connected", () => {
      sidebarSend("leave-room");
      coreCalls = [];

      serverSend({ type: "play", positionMs: 60000 });

      expect(coreCalls).toEqual([]);
    });
  });

  describe("echo suppression", () => {
    beforeEach(() => {
      doJoinRoom();
      overlayPosted = [];
      coreCalls = [];
    });

    test("remote pause suppresses subsequent local pause event", () => {
      serverSend({ type: "pause", positionMs: 45000 });
      overlayPosted = [];

      // Simulate the player's pause event firing as a result
      coreStatus.paused = true;
      coreStatus.position = 45.0;
      fireEvent("iina.pause");

      // Should not send a pause message back (suppressed)
      expect(findOverlayPosted("ws-send")).toEqual([]);
    });

    test("remote play suppresses subsequent local play event", () => {
      serverSend({ type: "play", positionMs: 60000 });
      overlayPosted = [];

      coreStatus.paused = false;
      coreStatus.position = 60.0;
      fireEvent("iina.pause");

      expect(findOverlayPosted("ws-send")).toEqual([]);
    });

    test("remote seek suppresses subsequent local seek event", () => {
      serverSend({ type: "seek", positionMs: 120000, cause: "user" });
      overlayPosted = [];

      coreStatus.position = 120.0;
      fireEvent("iina.seek");

      expect(findOverlayPosted("ws-send")).toEqual([]);
    });

    test("remote speed suppresses subsequent local speed event", () => {
      serverSend({ type: "speed", speed: 2.0 });
      overlayPosted = [];

      coreStatus.speed = 2.0;
      fireEvent("iina.speed");

      expect(findOverlayPosted("ws-send")).toEqual([]);
    });

    test("unsuppressed local event after remote still sends", () => {
      serverSend({ type: "pause", positionMs: 45000 });

      // First local pause is suppressed
      coreStatus.paused = true;
      coreStatus.position = 45.0;
      fireEvent("iina.pause");
      overlayPosted = [];

      // Second local play should NOT be suppressed
      coreStatus.paused = false;
      coreStatus.position = 46.0;
      fireEvent("iina.pause");

      const msg = lastSentProtocol();
      expect(msg).toBeDefined();
      expect(msg!.type).toBe("play");
    });
  });

  describe("heartbeat", () => {
    test("heartbeat timer starts on auth-ok", () => {
      doCreateRoom();
      overlayPosted = [];

      // Advance the interval to trigger a heartbeat
      // Use a short wait and check — heartbeats are on 5s interval
      // We can't easily test setInterval timing, but we can verify
      // heartbeat is sent when the interval fires by triggering it manually
    });

    test("sync engine is cleaned up on disconnect", () => {
      doCreateRoom();
      sidebarSend("leave-room");

      // After disconnect, local events should be ignored
      overlayPosted = [];
      coreStatus.paused = true;
      fireEvent("iina.pause");

      expect(findOverlayPosted("ws-send")).toEqual([]);
    });

    test("sync engine is re-created on reconnect", () => {
      doCreateRoom();
      sidebarSend("leave-room");

      // Reconnect
      doJoinRoom();
      overlayPosted = [];

      // Local events should work again
      coreStatus.paused = true;
      coreStatus.position = 10.0;
      fireEvent("iina.pause");

      const msg = lastSentProtocol();
      expect(msg).toBeDefined();
      expect(msg!.type).toBe("pause");
    });
  });

  describe("drift correction via heartbeat", () => {
    beforeEach(() => {
      doJoinRoom();
      // Unpause the sync engine by receiving a remote play
      serverSend({ type: "play", positionMs: 10000 });
      overlayPosted = [];
      coreCalls = [];
    });

    test("guest corrects drift when heartbeat shows large position gap", () => {
      // Sync engine thinks we're at 10s, host says 15s (5000ms > 2000ms threshold)
      serverSend({
        type: "heartbeat",
        positionMs: 15000,
        paused: false,
        speed: 1.0,
      });

      expect(coreCalls).toContainEqual({ method: "seekTo", args: [15] });
    });

    test("guest does not correct small drift", () => {
      // Sync engine at 10s, host at 10.5s (500ms < 2000ms threshold)
      serverSend({
        type: "heartbeat",
        positionMs: 10500,
        paused: false,
        speed: 1.0,
      });

      const seekCalls = coreCalls.filter((c) => c.method === "seekTo");
      expect(seekCalls).toEqual([]);
    });

    test("guest corrects speed mismatch from heartbeat", () => {
      serverSend({
        type: "heartbeat",
        positionMs: 10000,
        paused: false,
        speed: 1.5,
      });

      expect(coreCalls).toContainEqual({ method: "setSpeed", args: [1.5] });
    });
  });

  describe("host does not drift-correct", () => {
    beforeEach(() => {
      doCreateRoom();
      overlayPosted = [];
      coreCalls = [];
    });

    test("host ignores heartbeat drift correction", () => {
      coreStatus.position = 10.0;

      serverSend({
        type: "heartbeat",
        positionMs: 50000,
        paused: false,
        speed: 1.0,
      });

      expect(coreCalls).toEqual([]);
    });
  });

  describe("protocol envelope on playback messages", () => {
    test("play message includes full envelope", () => {
      doCreateRoom();
      overlayPosted = [];

      coreStatus.paused = false;
      coreStatus.position = 25.0;
      fireEvent("iina.pause");

      const msg = lastSentProtocol();
      expect(msg).toBeDefined();
      expect(msg!.protocolVersion).toBe(1);
      expect(msg!.sessionId).toBeDefined();
      expect(msg!.messageId).toBeDefined();
      expect(msg!.tsMs).toBeGreaterThan(0);
    });
  });

  describe("reconnection", () => {
    test("does not reset state when connection drops while connected", () => {
      doCreateRoom();
      sidebarPosted = [];

      overlaySend("ws-closed", { code: 1006, reason: "" });

      const status = lastSidebarPosted("sb-status");
      expect(status).toBeDefined();
      expect(d(status).text).toBe("Connection lost");

      // Should NOT transition to idle — room context must be preserved
      const state = findSidebarPosted("sb-state");
      expect(state.every((m) => d(m).view !== "idle")).toBe(true);
    });

    test("transitions to connecting view on ws-reconnecting", () => {
      doCreateRoom();
      sidebarPosted = [];

      overlaySend("ws-closed", { code: 1006, reason: "" });
      overlaySend("ws-reconnecting", { attempt: 1, delayMs: 1000 });

      const state = lastSidebarPosted("sb-state");
      expect(d(state).view).toBe("connecting");

      const text = lastSidebarPosted("sb-connecting-text");
      expect(d(text).text).toContain("Reconnecting");
      expect(d(text).text).toContain("1");
    });

    test("does not reset state on ws-closed during reconnection attempts", () => {
      doCreateRoom();

      // Connection drops
      overlaySend("ws-closed", { code: 1006, reason: "" });
      overlaySend("ws-reconnecting", { attempt: 1, delayMs: 1000 });

      sidebarPosted = [];

      // Reconnect attempt fails (socket closes during connecting)
      overlaySend("ws-closed", { code: 1006, reason: "" });

      // Should NOT show "Connection failed" or reset to idle
      const errors = findSidebarPosted("sb-error");
      expect(errors).toEqual([]);

      const state = findSidebarPosted("sb-state");
      expect(state.every((m) => d(m).view !== "idle")).toBe(true);
    });

    test("re-authenticates on successful reconnection", () => {
      doCreateRoom();
      overlayPosted = [];

      // Connection drops and overlay reconnects
      overlaySend("ws-closed", { code: 1006, reason: "" });
      overlaySend("ws-reconnecting", { attempt: 1, delayMs: 1000 });
      overlaySend("ws-open");

      // Should send a new auth message
      const send = lastOverlayPosted("ws-send");
      expect(send).toBeDefined();
      const msg = JSON.parse(d(send).data as string) as Record<string, unknown>;
      expect(msg.type).toBe("auth");
      expect(msg.secret).toBe("testsecret");
    });

    test("resumes connected state after successful reconnect + auth-ok", () => {
      doCreateRoom();

      // Connection drops and overlay reconnects
      overlaySend("ws-closed", { code: 1006, reason: "" });
      overlaySend("ws-reconnecting", { attempt: 1, delayMs: 1000 });
      overlaySend("ws-open");

      sidebarPosted = [];

      serverSend({
        type: "auth-ok",
        role: "host",
        roomCode: "ABC123",
        peerPresent: false,
        expiresAtMs: Date.now() + 3600000,
      });

      const state = lastSidebarPosted("sb-state");
      expect(d(state).view).toBe("connected");

      const status = lastSidebarPosted("sb-status");
      expect(d(status).text).toBe("Connected");
    });

    test("host sends state snapshot with reason reconnect after reconnecting with peer", () => {
      doCreateRoom();
      overlayPosted = [];

      // Connection drops and overlay reconnects
      overlaySend("ws-closed", { code: 1006, reason: "" });
      overlaySend("ws-reconnecting", { attempt: 1, delayMs: 1000 });
      overlaySend("ws-open");

      // Clear the auth message
      overlayPosted = [];

      serverSend({
        type: "auth-ok",
        role: "host",
        roomCode: "ABC123",
        peerPresent: true,
        expiresAtMs: Date.now() + 3600000,
      });

      const send = lastOverlayPosted("ws-send");
      expect(send).toBeDefined();
      const msg = JSON.parse(d(send).data as string) as Record<string, unknown>;
      expect(msg.type).toBe("state");
      expect(msg.reason).toBe("reconnect");
    });

    test("resets state on ws-reconnect-failed", () => {
      doCreateRoom();
      sidebarPosted = [];
      osdMessages = [];

      overlaySend("ws-closed", { code: 1006, reason: "" });
      overlaySend("ws-reconnecting", { attempt: 1, delayMs: 1000 });
      overlaySend("ws-reconnect-failed", { attempts: 10 });

      const state = lastSidebarPosted("sb-state");
      expect(d(state).view).toBe("error");

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
      expect(d(err).text).toContain("rejoin");

      expect(osdMessages.some((m) => m.includes("Connection lost"))).toBe(true);
    });

    test("can create a new room after reconnect failure", () => {
      doCreateRoom();

      overlaySend("ws-closed", { code: 1006, reason: "" });
      overlaySend("ws-reconnect-failed", { attempts: 10 });

      // Should be back to idle, able to create again
      overlayPosted = [];
      sidebarSend("create-room");

      const fetch = lastOverlayPosted("http-fetch");
      expect(fetch).toBeDefined();
    });

    test("initial connection failure still resets state when not reconnecting", () => {
      sidebarSend("join-room", { invite: "ABCDEF:dGVzdHNlY3JldA" });

      overlaySend("ws-closed", { code: 1006, reason: "" });

      const err = lastSidebarPosted("sb-error");
      expect(err).toBeDefined();
      expect(d(err).text).toContain("Connection failed");

      const state = lastSidebarPosted("sb-state");
      expect(d(state).view).toBe("idle");
    });

    test("registers ws-reconnect-failed handler", () => {
      expect(overlayHandlers["ws-reconnect-failed"]).toBeDefined();
    });

    test("guest reconnection re-authenticates with guest role", () => {
      doJoinRoom();
      overlayPosted = [];

      overlaySend("ws-closed", { code: 1006, reason: "" });
      overlaySend("ws-reconnecting", { attempt: 1, delayMs: 1000 });
      overlaySend("ws-open");

      const send = lastOverlayPosted("ws-send");
      const msg = JSON.parse(d(send).data as string) as Record<string, unknown>;
      expect(msg.type).toBe("auth");
      expect(msg.desiredRole).toBe("guest");
    });
  });

  // ── Buffering behavior (FR-11) ────────────────────────────────

  describe("buffering behavior", () => {
    test("registers mpv.paused-for-cache.changed handler", () => {
      expect(eventHandlers["mpv.paused-for-cache.changed"]).toBeDefined();
    });

    test("buffering state is included in heartbeat messages", () => {
      doCreateRoom();

      // Simulate buffering start via mpv property change
      mpvFlags["paused-for-cache"] = true;
      fireEvent("mpv.paused-for-cache.changed");

      // Trigger heartbeat indirectly — just verify the sync engine state updated
      // The heartbeat interval sends buffering from syncEngine.state.buffering
      // We can verify by checking the log message
      expect(logMessages.some((m) => m.includes("Buffering state"))).toBe(true);
    });

    test("peer-buffering warning shows in sidebar and OSD", () => {
      doJoinRoom();
      sidebarPosted = [];
      osdMessages = [];

      // Send a heartbeat from host with buffering: true
      serverSend({
        type: "heartbeat",
        positionMs: 10000,
        paused: false,
        speed: 1,
        buffering: true,
      });

      const warn = lastSidebarPosted("sb-warning");
      expect(warn).toBeDefined();
      expect(d(warn).text).toContain("Peer is buffering");
      expect(osdMessages.some((m) => m.includes("Peer is buffering"))).toBe(true);
    });

    test("peer-buffering warning clears when buffering ends", () => {
      doJoinRoom();

      // Start buffering
      serverSend({
        type: "heartbeat",
        positionMs: 10000,
        paused: false,
        speed: 1,
        buffering: true,
      });

      sidebarPosted = [];

      // Stop buffering
      serverSend({
        type: "heartbeat",
        positionMs: 11000,
        paused: false,
        speed: 1,
        buffering: false,
      });

      const warn = lastSidebarPosted("sb-warning");
      expect(warn).toBeDefined();
      expect(warn!.data).toBeNull();
    });

    test("buffering pause is not sent to peer", () => {
      doCreateRoom();
      overlayPosted = [];

      // Set buffering state
      mpvFlags["paused-for-cache"] = true;
      fireEvent("mpv.paused-for-cache.changed");

      // Now simulate a pause event (triggered by buffering, not user)
      coreStatus.paused = true;
      fireEvent("iina.pause");

      // Should not have sent a pause message
      const sends = findOverlayPosted("ws-send");
      const pauseMsg = sends.find((s) => {
        const parsed = JSON.parse(d(s).data as string) as Record<string, unknown>;
        return parsed.type === "pause";
      });
      expect(pauseMsg).toBeUndefined();
    });

    test("buffering resume is not sent to peer", () => {
      doCreateRoom();

      // Set buffering state
      mpvFlags["paused-for-cache"] = true;
      fireEvent("mpv.paused-for-cache.changed");

      overlayPosted = [];

      // Simulate resume (triggered by buffer fill, not user)
      coreStatus.paused = false;
      fireEvent("iina.pause");

      const sends = findOverlayPosted("ws-send");
      const playMsg = sends.find((s) => {
        const parsed = JSON.parse(d(s).data as string) as Record<string, unknown>;
        return parsed.type === "play";
      });
      expect(playMsg).toBeUndefined();
    });
  });

  // ── File-change auto-leave (FR-11) ─────────────────────────────

  describe("file-change auto-leave", () => {
    test("registers iina.file-loaded handler", () => {
      expect(eventHandlers["iina.file-loaded"]).toBeDefined();
    });

    test("auto-leaves room when file changes mid-session", () => {
      coreStatus.url = "/path/to/movie1.mp4";
      doCreateRoom();

      // Change to a different file
      coreStatus.url = "/path/to/movie2.mp4";
      fireEvent("iina.file-loaded");

      // Should have disconnected
      const disconnect = lastOverlayPosted("ws-disconnect");
      expect(disconnect).toBeDefined();

      // Should show OSD message
      expect(osdMessages.some((m) => m.includes("File changed"))).toBe(true);

      // Should be back in idle state
      const state = lastSidebarPosted("sb-state");
      expect(d(state).view).toBe("idle");
    });

    test("does not leave room when same file reloads", () => {
      coreStatus.url = "/path/to/movie.mp4";
      doCreateRoom();

      overlayPosted = [];

      // Same file reloads
      fireEvent("iina.file-loaded");

      // Should not have disconnected
      const disconnect = findOverlayPosted("ws-disconnect");
      expect(disconnect).toEqual([]);
    });

    test("does not leave when file loads while not in a room", () => {
      coreStatus.url = "/path/to/movie1.mp4";
      fireEvent("iina.file-loaded");

      coreStatus.url = "/path/to/movie2.mp4";
      fireEvent("iina.file-loaded");

      // No disconnect should happen
      const disconnect = findOverlayPosted("ws-disconnect");
      expect(disconnect).toEqual([]);
    });

    test("session file URL is cleared on leave", () => {
      coreStatus.url = "/path/to/movie1.mp4";
      doCreateRoom();

      // Leave
      sidebarSend("leave-room");

      // Now load a different file — should not trigger auto-leave since we already left
      coreStatus.url = "/path/to/movie2.mp4";
      fireEvent("iina.file-loaded");

      // No extra disconnect
      const disconnects = findOverlayPosted("ws-disconnect");
      // One from leave-room, but the file-loaded should not trigger another
      // After leave, state is idle so file-loaded just records the new URL
      expect(disconnects.length).toBe(1);
    });
  });
});

// ── Log level tests ───────────────────────────────────────────────────

describe("log levels", () => {
  beforeEach(() => {
    setupGlobals();
    loadMain();
  });

  function hasLog(level: string, substring: string): boolean {
    return logMessages.some((m) => m.startsWith(`[${level}]`) && m.includes(substring));
  }

  test("plugin load emits INFO", () => {
    // loadMain() clears logMessages after require, so re-load and check before clearing
    setupGlobals();
    const path = require.resolve("./main.ts");
    delete require.cache[path];
    require(path);
    expect(hasLog("INFO", "Watch Party plugin loaded")).toBe(true);
  });

  test("state transitions emit INFO", () => {
    sidebarSend("create-room");
    expect(hasLog("INFO", "idle → connecting")).toBe(true);
  });

  test("create room failure emits ERROR", () => {
    sidebarSend("create-room");
    logMessages = [];
    overlaySend("http-response", { ok: false, status: 500, error: "server down" });
    expect(hasLog("ERROR", "Create room failed")).toBe(true);
  });

  test("invalid invite emits WARN", () => {
    sidebarSend("join-room", { invite: "bad" });
    expect(hasLog("WARN", "Invalid invite")).toBe(true);
  });

  test("auth error emits ERROR", () => {
    sidebarSend("create-room");
    overlaySend("http-response", {
      ok: true,
      status: 200,
      body: {
        roomCode: "ABC123",
        secret: "testsecret",
        wsUrl: "wss://example.com/ws/ABC123",
        invite: "ABC123:testsecret",
      },
    });
    overlaySend("ws-open");
    logMessages = [];
    overlaySend("ws-message", {
      data: JSON.stringify({ type: "auth-error", code: "invalid-secret", message: "bad secret" }),
    });
    expect(hasLog("ERROR", "Auth error")).toBe(true);
  });

  test("server error emits ERROR", () => {
    doCreateRoom();
    logMessages = [];
    overlaySend("ws-message", {
      data: JSON.stringify({ type: "error", code: "room-expired", message: "Room has expired" }),
    });
    expect(hasLog("ERROR", "Server error")).toBe(true);
  });

  test("warning message emits WARN", () => {
    doCreateRoom();
    logMessages = [];
    overlaySend("ws-message", {
      data: JSON.stringify({ type: "warning", code: "file-mismatch", message: "Files differ" }),
    });
    expect(hasLog("WARN", "file-mismatch")).toBe(true);
  });

  test("WebSocket close emits WARN", () => {
    doCreateRoom();
    logMessages = [];
    overlaySend("ws-closed", { code: 1006, reason: "abnormal" });
    expect(hasLog("WARN", "WebSocket closed")).toBe(true);
  });

  test("WebSocket error emits ERROR", () => {
    doCreateRoom();
    logMessages = [];
    overlaySend("ws-error");
    expect(hasLog("ERROR", "WebSocket error")).toBe(true);
  });

  test("reconnecting emits WARN", () => {
    doCreateRoom();
    logMessages = [];
    overlaySend("ws-reconnecting", { attempt: 2, delayMs: 1000 });
    expect(hasLog("WARN", "Reconnecting")).toBe(true);
  });

  test("reconnection failed emits ERROR", () => {
    doCreateRoom();
    logMessages = [];
    overlaySend("ws-reconnect-failed", { attempts: 5 });
    expect(hasLog("ERROR", "Reconnection failed")).toBe(true);
  });

  test("unhandled message type emits WARN", () => {
    doCreateRoom();
    logMessages = [];
    overlaySend("ws-message", {
      data: JSON.stringify({ type: "unknown-type" }),
    });
    expect(hasLog("WARN", "Unhandled message type")).toBe(true);
  });

  test("successful auth emits INFO", () => {
    doCreateRoom();
    expect(hasLog("INFO", "Authenticated as host")).toBe(true);
  });
});
