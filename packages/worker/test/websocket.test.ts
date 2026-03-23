import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";
import type { Env } from "../src/index.js";

const typedEnv = env as Env;

// ── Helpers ──────────────────────────────────────────────────────

/** Create a room via the Worker and return its code and secret. */
async function createRoom(): Promise<{
  roomCode: string;
  secret: string;
  expiresAtMs: number;
}> {
  const res = await SELF.fetch("https://example.com/api/rooms", {
    method: "POST",
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    roomCode: string;
    secret: string;
    expiresAtMs: number;
  };
}

/** Open a WebSocket to the room DO via the Worker upgrade path. */
async function connectWs(roomCode: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://example.com/ws/${roomCode}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

/** Build an auth message payload. */
function authPayload(
  secret: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "auth",
    protocolVersion: 1,
    sessionId,
    messageId: crypto.randomUUID(),
    tsMs: Date.now(),
    secret,
    file: {},
    ...overrides,
  });
}

/** Collect messages from a WebSocket into an array. Returns a getter. */
function collectMessages(ws: WebSocket): {
  get: () => Record<string, unknown>[];
} {
  const messages: Record<string, unknown>[] = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string));
  });
  return {
    get: () => messages,
  };
}

/** Wait briefly for async message delivery in the DO. */
async function tick(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a protocol message for sending. */
function makeMessage(
  type: string,
  sessionId: string,
  fields: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type,
    protocolVersion: 1,
    sessionId,
    messageId: crypto.randomUUID(),
    tsMs: Date.now(),
    ...fields,
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe("Room WebSocket lifecycle", () => {
  // ── Auth ──────────────────────────────────────────────────────

  describe("authentication", () => {
    it("accepts auth with correct secret and returns auth-ok as host", async () => {
      const { roomCode, secret } = await createRoom();
      const ws = await connectWs(roomCode);
      const msgs = collectMessages(ws);

      ws.send(authPayload(secret, "session-host-1"));
      await tick();

      const authOk = msgs.get().find((m) => m.type === "auth-ok");
      expect(authOk).toBeDefined();
      expect(authOk!.role).toBe("host");
      expect(authOk!.roomCode).toBe(roomCode);
      expect(authOk!.peerPresent).toBe(false);
      expect(authOk!.protocolVersion).toBe(1);
      expect(authOk!.sessionId).toBe("server");

      ws.close();
    });

    it("assigns guest role to second participant", async () => {
      const { roomCode, secret } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(authPayload(secret, "session-host-2"));
      await tick();

      const ws2 = await connectWs(roomCode);
      const msgs2 = collectMessages(ws2);
      ws2.send(authPayload(secret, "session-guest-2"));
      await tick();

      const authOk2 = msgs2.get().find((m) => m.type === "auth-ok");
      expect(authOk2).toBeDefined();
      expect(authOk2!.role).toBe("guest");
      expect(authOk2!.peerPresent).toBe(true);

      // Host should receive presence notification
      const presence = msgs1.get().find((m) => m.type === "presence");
      expect(presence).toBeDefined();
      expect(presence!.event).toBe("peer-joined");
      expect(presence!.role).toBe("guest");

      ws1.close();
      ws2.close();
    });

    it("rejects auth with wrong secret", async () => {
      const { roomCode } = await createRoom();
      const ws = await connectWs(roomCode);
      const msgs = collectMessages(ws);

      ws.send(authPayload("wrong-secret", "session-wrong"));
      await tick();

      const authErr = msgs.get().find((m) => m.type === "auth-error");
      expect(authErr).toBeDefined();
      expect(authErr!.code).toBe("invalid-secret");
    });

    it("rejects auth with missing secret", async () => {
      const { roomCode } = await createRoom();
      const ws = await connectWs(roomCode);
      const msgs = collectMessages(ws);

      ws.send(
        JSON.stringify({
          type: "auth",
          protocolVersion: 1,
          sessionId: "session-nosecret",
          messageId: crypto.randomUUID(),
          tsMs: Date.now(),
          secret: "",
          file: {},
        }),
      );
      await tick();

      const authErr = msgs.get().find((m) => m.type === "auth-error");
      expect(authErr).toBeDefined();
      expect(authErr!.code).toBe("missing-secret");
    });

    it("rejects auth with missing sessionId", async () => {
      const { roomCode, secret } = await createRoom();
      const ws = await connectWs(roomCode);
      const msgs = collectMessages(ws);

      ws.send(
        JSON.stringify({
          type: "auth",
          protocolVersion: 1,
          sessionId: "",
          messageId: crypto.randomUUID(),
          tsMs: Date.now(),
          secret,
          file: {},
        }),
      );
      await tick();

      const authErr = msgs.get().find((m) => m.type === "auth-error");
      expect(authErr).toBeDefined();
      expect(authErr!.code).toBe("missing-session-id");
    });

    it("rejects non-auth first message", async () => {
      const { roomCode } = await createRoom();
      const ws = await connectWs(roomCode);
      const msgs = collectMessages(ws);

      ws.send(makeMessage("play", "session-noauth", { positionMs: 0 }));
      await tick();

      const err = msgs.get().find((m) => m.type === "auth-error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("not-authenticated");
    });
  });

  // ── Third participant rejection ────────────────────────────

  describe("participant limits", () => {
    it("rejects a third participant", async () => {
      const { roomCode, secret } = await createRoom();

      const ws1 = await connectWs(roomCode);
      ws1.send(authPayload(secret, "session-p1"));
      await tick();

      const ws2 = await connectWs(roomCode);
      ws2.send(authPayload(secret, "session-p2"));
      await tick();

      const ws3 = await connectWs(roomCode);
      const msgs3 = collectMessages(ws3);
      ws3.send(authPayload(secret, "session-p3"));
      await tick();

      const authErr = msgs3.get().find((m) => m.type === "auth-error");
      expect(authErr).toBeDefined();
      expect(authErr!.code).toBe("room-full");

      ws1.close();
      ws2.close();
    });
  });

  // ── Session replacement ────────────────────────────────────

  describe("session replacement", () => {
    it("replaces stale socket when same sessionId reconnects", async () => {
      const { roomCode, secret } = await createRoom();

      // Host connects
      const ws1 = await connectWs(roomCode);
      ws1.send(authPayload(secret, "session-replace-host"));
      await tick();

      // Guest connects
      const ws2 = await connectWs(roomCode);
      const msgs2 = collectMessages(ws2);
      ws2.send(authPayload(secret, "session-replace-guest"));
      await tick();

      // Host reconnects with same sessionId
      const ws3 = await connectWs(roomCode);
      const msgs3 = collectMessages(ws3);
      ws3.send(authPayload(secret, "session-replace-host"));
      await tick();

      // New host socket gets auth-ok with host role
      const authOk = msgs3.get().find((m) => m.type === "auth-ok");
      expect(authOk).toBeDefined();
      expect(authOk!.role).toBe("host");
      expect(authOk!.peerPresent).toBe(true);

      // Guest receives peer-replaced
      const presence = msgs2.get().find((m) => m.type === "presence");
      expect(presence).toBeDefined();
      expect(presence!.event).toBe("peer-replaced");
      expect(presence!.role).toBe("host");

      ws2.close();
      ws3.close();
    });

    it("restores role on reconnection after disconnect", async () => {
      const { roomCode, secret } = await createRoom();

      // Host connects and disconnects
      const ws1 = await connectWs(roomCode);
      ws1.send(authPayload(secret, "session-restore-host"));
      await tick();
      ws1.close();
      await tick();

      // Guest connects
      const ws2 = await connectWs(roomCode);
      ws2.send(authPayload(secret, "session-restore-guest"));
      await tick();

      // Host reconnects — should still be host
      const ws3 = await connectWs(roomCode);
      const msgs3 = collectMessages(ws3);
      ws3.send(authPayload(secret, "session-restore-host"));
      await tick();

      const authOk = msgs3.get().find((m) => m.type === "auth-ok");
      expect(authOk).toBeDefined();
      expect(authOk!.role).toBe("host");

      ws2.close();
      ws3.close();
    });
  });

  // ── Message relay ──────────────────────────────────────────

  describe("message relay", () => {
    it("relays play message from host to guest", async () => {
      const { roomCode, secret } = await createRoom();

      const ws1 = await connectWs(roomCode);
      ws1.send(authPayload(secret, "session-relay-host"));
      await tick();

      const ws2 = await connectWs(roomCode);
      const msgs2 = collectMessages(ws2);
      ws2.send(authPayload(secret, "session-relay-guest"));
      await tick();

      // Clear presence messages
      msgs2.get().length = 0;

      // Host sends play
      const playMsg = makeMessage("play", "session-relay-host", {
        positionMs: 5000,
      });
      ws1.send(playMsg);
      await tick();

      const relayed = msgs2.get().find((m) => m.type === "play");
      expect(relayed).toBeDefined();
      expect(relayed!.positionMs).toBe(5000);

      ws1.close();
      ws2.close();
    });

    it("relays pause message from guest to host", async () => {
      const { roomCode, secret } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(authPayload(secret, "session-relay2-host"));
      await tick();

      const ws2 = await connectWs(roomCode);
      ws2.send(authPayload(secret, "session-relay2-guest"));
      await tick();

      // Clear presence messages on host
      msgs1.get().length = 0;

      // Guest sends pause
      ws2.send(
        makeMessage("pause", "session-relay2-guest", { positionMs: 12000 }),
      );
      await tick();

      const relayed = msgs1.get().find((m) => m.type === "pause");
      expect(relayed).toBeDefined();
      expect(relayed!.positionMs).toBe(12000);

      ws1.close();
      ws2.close();
    });

    it("relays seek, speed, heartbeat, and state messages", async () => {
      const { roomCode, secret } = await createRoom();

      const ws1 = await connectWs(roomCode);
      ws1.send(authPayload(secret, "session-multi-host"));
      await tick();

      const ws2 = await connectWs(roomCode);
      const msgs2 = collectMessages(ws2);
      ws2.send(authPayload(secret, "session-multi-guest"));
      await tick();
      msgs2.get().length = 0;

      // Seek
      ws1.send(
        makeMessage("seek", "session-multi-host", {
          positionMs: 30000,
          cause: "user",
        }),
      );
      await tick();
      expect(msgs2.get().some((m) => m.type === "seek")).toBe(true);

      // Speed
      ws1.send(makeMessage("speed", "session-multi-host", { speed: 1.5 }));
      await tick();
      expect(msgs2.get().some((m) => m.type === "speed")).toBe(true);

      // Heartbeat
      ws1.send(
        makeMessage("heartbeat", "session-multi-host", {
          positionMs: 31000,
          paused: false,
          speed: 1.5,
        }),
      );
      await tick();
      expect(msgs2.get().some((m) => m.type === "heartbeat")).toBe(true);

      // State
      ws1.send(
        makeMessage("state", "session-multi-host", {
          reason: "initial",
          positionMs: 0,
          paused: true,
          speed: 1.0,
        }),
      );
      await tick();
      expect(msgs2.get().some((m) => m.type === "state")).toBe(true);

      ws1.close();
      ws2.close();
    });

    it("does not relay to unauthenticated sockets", async () => {
      const { roomCode, secret } = await createRoom();

      const ws1 = await connectWs(roomCode);
      ws1.send(authPayload(secret, "session-norel-host"));
      await tick();

      // Second socket connects but does NOT auth
      const ws2 = await connectWs(roomCode);
      const msgs2 = collectMessages(ws2);
      await tick();

      // Host sends play — should not be relayed to unauthenticated ws2
      ws1.send(
        makeMessage("play", "session-norel-host", { positionMs: 1000 }),
      );
      await tick();

      expect(msgs2.get().filter((m) => m.type === "play")).toHaveLength(0);

      ws1.close();
      ws2.close();
    });
  });

  // ── Message validation ──────────────────────────────────────

  describe("message validation", () => {
    it("rejects invalid JSON", async () => {
      const { roomCode, secret } = await createRoom();
      const ws = await connectWs(roomCode);
      ws.send(authPayload(secret, "session-val-1"));
      await tick();

      const msgs = collectMessages(ws);
      ws.send("not valid json {{{");
      await tick();

      const err = msgs.get().find((m) => m.type === "error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("invalid-json");

      ws.close();
    });

    it("rejects non-object JSON payload", async () => {
      const { roomCode, secret } = await createRoom();
      const ws = await connectWs(roomCode);
      ws.send(authPayload(secret, "session-val-2"));
      await tick();

      const msgs = collectMessages(ws);
      ws.send(JSON.stringify([1, 2, 3]));
      await tick();

      const err = msgs.get().find((m) => m.type === "error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("invalid-format");

      ws.close();
    });

    it("rejects oversized messages", async () => {
      const { roomCode, secret } = await createRoom();
      const ws = await connectWs(roomCode);
      ws.send(authPayload(secret, "session-val-3"));
      await tick();

      const msgs = collectMessages(ws);
      const bigPayload = JSON.stringify({
        type: "play",
        data: "x".repeat(9000),
      });
      ws.send(bigPayload);
      await tick();

      const err = msgs.get().find((m) => m.type === "error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("message-too-large");

      ws.close();
    });

    it("rejects invalid message type after auth", async () => {
      const { roomCode, secret } = await createRoom();
      const ws = await connectWs(roomCode);
      ws.send(authPayload(secret, "session-val-4"));
      await tick();

      const msgs = collectMessages(ws);
      ws.send(makeMessage("auth", "session-val-4", { secret: "x", file: {} }));
      await tick();

      const err = msgs.get().find((m) => m.type === "error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("invalid-type");

      ws.close();
    });
  });

  // ── Presence ───────────────────────────────────────────────

  describe("presence", () => {
    it("notifies host when guest joins", async () => {
      const { roomCode, secret } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(authPayload(secret, "session-pres-host"));
      await tick();

      const ws2 = await connectWs(roomCode);
      ws2.send(authPayload(secret, "session-pres-guest"));
      await tick();

      const presence = msgs1
        .get()
        .find((m) => m.type === "presence" && m.event === "peer-joined");
      expect(presence).toBeDefined();
      expect(presence!.role).toBe("guest");

      ws1.close();
      ws2.close();
    });

    it("notifies host when guest disconnects", async () => {
      const { roomCode, secret } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(authPayload(secret, "session-leave-host"));
      await tick();

      const ws2 = await connectWs(roomCode);
      ws2.send(authPayload(secret, "session-leave-guest"));
      await tick();

      // Clear previous messages
      msgs1.get().length = 0;

      ws2.close();
      await tick();

      const presence = msgs1
        .get()
        .find((m) => m.type === "presence" && m.event === "peer-left");
      expect(presence).toBeDefined();
      expect(presence!.role).toBe("guest");

      ws1.close();
    });
  });

  // ── Goodbye ────────────────────────────────────────────────

  describe("goodbye", () => {
    it("relays goodbye to peer and emits peer-left", async () => {
      const { roomCode, secret } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(authPayload(secret, "session-bye-host"));
      await tick();

      const ws2 = await connectWs(roomCode);
      ws2.send(authPayload(secret, "session-bye-guest"));
      await tick();

      // Clear previous messages
      msgs1.get().length = 0;

      // Guest sends goodbye
      ws2.send(
        makeMessage("goodbye", "session-bye-guest", { reason: "user-left" }),
      );
      await tick();

      const goodbye = msgs1.get().find((m) => m.type === "goodbye");
      expect(goodbye).toBeDefined();
      expect(goodbye!.reason).toBe("user-left");

      const presence = msgs1
        .get()
        .find((m) => m.type === "presence" && m.event === "peer-left");
      expect(presence).toBeDefined();

      ws1.close();
    });

    it("removes participant on goodbye allowing new participant", async () => {
      const { roomCode, secret } = await createRoom();

      // Host and guest connect
      const ws1 = await connectWs(roomCode);
      ws1.send(authPayload(secret, "session-bye2-host"));
      await tick();

      const ws2 = await connectWs(roomCode);
      ws2.send(authPayload(secret, "session-bye2-guest"));
      await tick();

      // Guest sends goodbye (removes from participants table)
      ws2.send(
        makeMessage("goodbye", "session-bye2-guest", { reason: "leaving" }),
      );
      await tick();

      // New participant can now join
      const ws3 = await connectWs(roomCode);
      const msgs3 = collectMessages(ws3);
      ws3.send(authPayload(secret, "session-bye2-new-guest"));
      await tick();

      const authOk = msgs3.get().find((m) => m.type === "auth-ok");
      expect(authOk).toBeDefined();
      expect(authOk!.role).toBe("guest");

      ws1.close();
      ws3.close();
    });
  });

  // ── WebSocket upgrade validation ───────────────────────────

  describe("upgrade validation", () => {
    it("returns 404 for non-existent room", async () => {
      const stub = typedEnv.ROOM.get(
        typedEnv.ROOM.idFromName("ZZZZZZ"),
      );
      const res = await stub.fetch(
        new Request("https://do/ws", {
          method: "GET",
          headers: { Upgrade: "websocket" },
        }),
      );
      expect(res.status).toBe(404);
    });
  });
});
