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
  };
}

function loadMain() {
  const path = require.resolve("./main.ts");
  delete require.cache[path];
  require(path);
  overlayPosted = [];
  sidebarPosted = [];
  logMessages = [];
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

    test("sends auth message on ws-open", () => {
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
      expect(msg.protocolVersion).toBe(1);
      expect(msg.sessionId).toBeDefined();
      expect(msg.messageId).toBeDefined();
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

    test("shows connecting view on join-room", () => {
      sidebarSend("join-room", { invite: "ABCDEF:dGVzdHNlY3JldA" });

      const state = findSidebarPosted("sb-state");
      expect(state.some((m) => d(m).view === "connecting")).toBe(true);
    });

    test("sends auth with guest role on ws-open", () => {
      sidebarSend("join-room", { invite: "ABCDEF:dGVzdHNlY3JldA" });
      overlaySend("ws-open");

      const send = lastOverlayPosted("ws-send");
      expect(send).toBeDefined();
      const msg = JSON.parse(d(send).data as string) as Record<string, unknown>;
      expect(msg.type).toBe("auth");
      expect(msg.secret).toBe("dGVzdHNlY3JldA");
      expect(msg.desiredRole).toBe("guest");
    });

    test("transitions to connected on auth-ok", () => {
      doJoinRoom();

      const state = findSidebarPosted("sb-state");
      expect(state.some((m) => d(m).view === "connected")).toBe(true);

      const peer = lastSidebarPosted("sb-peer");
      expect(peer).toBeDefined();
      expect(d(peer).present).toBe(true);
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
    test("logs invite when room exists", () => {
      doCreateRoom();
      logMessages = [];

      sidebarSend("copy-invite");

      expect(logMessages.some((m) => m.includes("ABC123:testsecret"))).toBe(true);
    });

    test("does nothing when no room", () => {
      logMessages = [];
      sidebarSend("copy-invite");
      expect(logMessages.filter((m) => m.includes("invite"))).toEqual([]);
    });
  });
});
