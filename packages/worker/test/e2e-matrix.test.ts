/**
 * End-to-end test matrix — cross-package integration tests.
 *
 * Tests the full flow: room creation → WebSocket upgrade → auth →
 * message relay → validation → sync scenarios → teardown.
 *
 * Covers the matrix of:
 *  - All relay message types (play, pause, seek, speed, heartbeat, state, warning, goodbye)
 *  - Both relay directions (host→guest, guest→host)
 *  - Auth flows (new, reconnect, replacement, room full)
 *  - File mismatch detection through auth metadata
 *  - Rate limiting at the WebSocket message level
 *  - Validation enforcement (malformed, oversized, unknown types)
 *  - Presence lifecycle (join, leave, replace)
 *  - Multi-step sync scenarios (play→seek→pause sequences)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { roomCreateLimiter } from "../src/index.js";

// ── Helpers ──────────────────────────────────────────────────────

async function createRoom(): Promise<{
  roomCode: string;
  expiresAtMs: number;
}> {
  const res = await SELF.fetch("https://example.com/api/rooms", {
    method: "POST",
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    roomCode: string;
    expiresAtMs: number;
  };
}

async function connectWs(roomCode: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://example.com/ws/${roomCode}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

function authPayload(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "auth",
    protocolVersion: 2,
    sessionId,
    messageId: crypto.randomUUID(),
    tsMs: Date.now(),
    file: {},
    ...overrides,
  });
}

function collectMessages(ws: WebSocket): {
  get: () => Record<string, unknown>[];
  clear: () => void;
} {
  const messages: Record<string, unknown>[] = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string));
  });
  return {
    get: () => messages,
    clear: () => {
      messages.length = 0;
    },
  };
}

async function tick(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeMessage(
  type: string,
  sessionId: string,
  fields: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type,
    protocolVersion: 2,
    sessionId,
    messageId: crypto.randomUUID(),
    tsMs: Date.now(),
    ...fields,
  });
}

/** Set up a room with host and guest connected and authenticated. */
async function setupRoom(prefix: string): Promise<{
  roomCode: string;
  hostWs: WebSocket;
  guestWs: WebSocket;
  hostMsgs: ReturnType<typeof collectMessages>;
  guestMsgs: ReturnType<typeof collectMessages>;
}> {
  const { roomCode } = await createRoom();

  const hostWs = await connectWs(roomCode);
  const hostMsgs = collectMessages(hostWs);
  hostWs.send(authPayload(`${prefix}-host`));
  await tick();

  const guestWs = await connectWs(roomCode);
  const guestMsgs = collectMessages(guestWs);
  guestWs.send(authPayload(`${prefix}-guest`));
  await tick();

  // Clear auth/presence messages
  hostMsgs.clear();
  guestMsgs.clear();

  return { roomCode, hostWs, guestWs, hostMsgs, guestMsgs };
}

// ── Tests ────────────────────────────────────────────────────────

describe("E2E test matrix", () => {
  beforeEach(() => {
    roomCreateLimiter.reset();
  });

  // ════════════════════════════════════════════════════════════════
  // 1. Message relay matrix — every relay type in both directions
  // ════════════════════════════════════════════════════════════════

  describe("message relay matrix", () => {
    const relayTypes = [
      {
        type: "play",
        fields: { positionMs: 5000 },
        check: (m: Record<string, unknown>) => expect(m.positionMs).toBe(5000),
      },
      {
        type: "pause",
        fields: { positionMs: 12000 },
        check: (m: Record<string, unknown>) =>
          expect(m.positionMs).toBe(12000),
      },
      {
        type: "seek",
        fields: { positionMs: 30000, cause: "user" },
        check: (m: Record<string, unknown>) => {
          expect(m.positionMs).toBe(30000);
          expect(m.cause).toBe("user");
        },
      },
      {
        type: "speed",
        fields: { speed: 1.5 },
        check: (m: Record<string, unknown>) => expect(m.speed).toBe(1.5),
      },
      {
        type: "heartbeat",
        fields: { positionMs: 8000, paused: false, speed: 1 },
        check: (m: Record<string, unknown>) => {
          expect(m.positionMs).toBe(8000);
          expect(m.paused).toBe(false);
          expect(m.speed).toBe(1);
        },
      },
      {
        type: "state",
        fields: { reason: "initial", positionMs: 0, paused: true, speed: 1 },
        check: (m: Record<string, unknown>) => {
          expect(m.reason).toBe("initial");
          expect(m.positionMs).toBe(0);
          expect(m.paused).toBe(true);
        },
      },
      {
        type: "warning",
        fields: { code: "peer-buffering", message: "Peer is buffering" },
        check: (m: Record<string, unknown>) => {
          expect(m.code).toBe("peer-buffering");
          expect(m.message).toBe("Peer is buffering");
        },
      },
    ];

    for (const { type, fields, check } of relayTypes) {
      it(`relays ${type} from host to guest`, async () => {
        const { hostWs, guestWs, guestMsgs } = await setupRoom(
          `h2g-${type}`,
        );

        hostWs.send(makeMessage(type, `h2g-${type}-host`, fields));
        await tick();

        const relayed = guestMsgs.get().find((m) => m.type === type);
        expect(relayed).toBeDefined();
        check(relayed!);

        hostWs.close();
        guestWs.close();
      });

      it(`relays ${type} from guest to host`, async () => {
        const { hostWs, guestWs, hostMsgs } = await setupRoom(
          `g2h-${type}`,
        );

        guestWs.send(makeMessage(type, `g2h-${type}-guest`, fields));
        await tick();

        const relayed = hostMsgs.get().find((m) => m.type === type);
        expect(relayed).toBeDefined();
        check(relayed!);

        hostWs.close();
        guestWs.close();
      });
    }
  });

  // ════════════════════════════════════════════════════════════════
  // 2. Auth flow matrix
  // ════════════════════════════════════════════════════════════════

  describe("auth flow matrix", () => {
    it("assigns host to first, guest to second participant", async () => {
      const { roomCode } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(authPayload("auth-role-host"));
      await tick();

      const authOk1 = msgs1.get().find((m) => m.type === "auth-ok");
      expect(authOk1!.role).toBe("host");
      expect(authOk1!.participants).toEqual([]);

      const ws2 = await connectWs(roomCode);
      const msgs2 = collectMessages(ws2);
      ws2.send(authPayload("auth-role-guest"));
      await tick();

      const authOk2 = msgs2.get().find((m) => m.type === "auth-ok");
      expect(authOk2!.role).toBe("guest");
      const participants2 = authOk2!.participants as { sessionId: string; role: string }[];
      expect(participants2.length).toBeGreaterThan(0);
      expect(participants2[0]).toHaveProperty("sessionId");
      expect(participants2[0]).toHaveProperty("role");

      // Host should receive peer-joined
      const presence = msgs1.get().find((m) => m.type === "presence");
      expect(presence!.event).toBe("peer-joined");
      expect(presence!.role).toBe("guest");

      ws1.close();
      ws2.close();
    });

    it("accepts third participant as guest (MAX_PARTICIPANTS is 8)", async () => {
      const { roomCode } = await createRoom();

      const ws1 = await connectWs(roomCode);
      ws1.send(authPayload("auth-multi-h"));
      await tick();

      const ws2 = await connectWs(roomCode);
      ws2.send(authPayload("auth-multi-g1"));
      await tick();

      const ws3 = await connectWs(roomCode);
      const msgs3 = collectMessages(ws3);
      ws3.send(authPayload("auth-multi-g2"));
      await tick();

      const authOk = msgs3.get().find((m) => m.type === "auth-ok");
      expect(authOk).toBeDefined();
      expect(authOk!.role).toBe("guest");
      const participants = authOk!.participants as { sessionId: string; role: string }[];
      expect(participants.length).toBe(2); // host + first guest already present

      ws1.close();
      ws2.close();
      ws3.close();
    });

    it("rejects participant when room is full", async () => {
      // This test verifies the room-full error code is sent when MAX_PARTICIPANTS is reached.
      // We don't connect 8+1 here; instead we rely on the server returning "Room is full"
      // with code "room-full". This is a lightweight smoke test — full capacity testing
      // belongs in unit tests for the room DO.
      const { roomCode } = await createRoom();

      const sockets: WebSocket[] = [];
      // Connect 8 participants (1 host + 7 guests) to fill the room
      for (let i = 0; i < 8; i++) {
        const ws = await connectWs(roomCode);
        ws.send(authPayload(`auth-full-${i}`));
        await tick();
        sockets.push(ws);
      }

      // 9th participant should be rejected
      const wsExtra = await connectWs(roomCode);
      const msgsExtra = collectMessages(wsExtra);
      wsExtra.send(authPayload("auth-full-overflow"));
      await tick();

      const err = msgsExtra.get().find((m) => m.type === "auth-error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("room-full");

      for (const ws of sockets) ws.close();
    });

    it("allows reconnect with same sessionId after disconnect", async () => {
      const { roomCode } = await createRoom();

      // Host connects
      const ws1 = await connectWs(roomCode);
      ws1.send(authPayload("auth-reconn-host"));
      await tick();

      // Guest connects
      const ws2 = await connectWs(roomCode);
      ws2.send(authPayload("auth-reconn-guest"));
      await tick();

      // Guest disconnects
      ws2.close();
      await tick();

      // Guest reconnects with same sessionId
      const ws3 = await connectWs(roomCode);
      const msgs3 = collectMessages(ws3);
      ws3.send(authPayload("auth-reconn-guest"));
      await tick();

      const authOk = msgs3.get().find((m) => m.type === "auth-ok");
      expect(authOk).toBeDefined();
      expect(authOk!.role).toBe("guest");
      const participants = authOk!.participants as { sessionId: string; role: string }[];
      expect(participants.length).toBeGreaterThan(0);
      expect(participants[0]).toHaveProperty("sessionId");
      expect(participants[0]).toHaveProperty("role");

      ws1.close();
      ws3.close();
    });

    it("replaces stale connection on reconnect", async () => {
      const { roomCode } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(authPayload("auth-replace-host"));
      await tick();

      const ws2 = await connectWs(roomCode);
      ws2.send(authPayload("auth-replace-guest"));
      await tick();
      msgs1.clear();

      // Guest reconnects without closing old socket
      const ws3 = await connectWs(roomCode);
      const msgs3 = collectMessages(ws3);
      ws3.send(authPayload("auth-replace-guest"));
      await tick();

      const authOk = msgs3.get().find((m) => m.type === "auth-ok");
      expect(authOk!.role).toBe("guest");

      // Host should receive peer-replaced
      const presence = msgs1.get().find(
        (m) => m.type === "presence" && m.event === "peer-replaced",
      );
      expect(presence).toBeDefined();

      ws1.close();
      ws3.close();
    });

    it("rejects non-auth first message with auth-error and closes", async () => {
      const { roomCode } = await createRoom();

      const ws = await connectWs(roomCode);
      const msgs = collectMessages(ws);
      ws.send(makeMessage("play", "auth-noauth", { positionMs: 0 }));
      await tick();

      const err = msgs.get().find((m) => m.type === "auth-error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("not-authenticated");
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 3. File mismatch detection matrix
  // ════════════════════════════════════════════════════════════════

  describe("file mismatch detection", () => {
    it("sends file-mismatch warning when durations differ significantly", async () => {
      const { roomCode } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(
        authPayload("fmm-dur-host", {
          file: { name: "movie.mkv", durationMs: 120000 },
        }),
      );
      await tick();

      const ws2 = await connectWs(roomCode);
      const msgs2 = collectMessages(ws2);
      ws2.send(
        authPayload("fmm-dur-guest", {
          file: { name: "movie.mkv", durationMs: 200000 },
        }),
      );
      await tick();

      // Both peers should get a file-mismatch warning
      const warn1 = msgs1.get().find(
        (m) => m.type === "warning" && m.code === "file-mismatch",
      );
      const warn2 = msgs2.get().find(
        (m) => m.type === "warning" && m.code === "file-mismatch",
      );
      expect(warn1).toBeDefined();
      expect(warn2).toBeDefined();
      expect((warn1!.message as string)).toContain("durations of videos");

      ws1.close();
      ws2.close();
    });

    it("sends file-mismatch warning when filenames differ", async () => {
      const { roomCode } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(
        authPayload("fmm-name-host", {
          file: { name: "episode01.mkv", durationMs: 60000 },
        }),
      );
      await tick();

      const ws2 = await connectWs(roomCode);
      ws2.send(
        authPayload("fmm-name-guest", {
          file: { name: "episode02.mkv", durationMs: 60000 },
        }),
      );
      await tick();

      const warn1 = msgs1.get().find(
        (m) => m.type === "warning" && m.code === "file-mismatch",
      );
      expect(warn1).toBeDefined();
      expect((warn1!.message as string)).toContain("filenames of videos");

      ws1.close();
      ws2.close();
    });

    it("does NOT warn when files match", async () => {
      const { roomCode } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(
        authPayload("fmm-ok-host", {
          file: { name: "movie.mkv", durationMs: 120000 },
        }),
      );
      await tick();

      const ws2 = await connectWs(roomCode);
      ws2.send(
        authPayload("fmm-ok-guest", {
          file: { name: "movie.mkv", durationMs: 121000 },
        }),
      );
      await tick();

      const warn = msgs1.get().find(
        (m) => m.type === "warning" && m.code === "file-mismatch",
      );
      expect(warn).toBeUndefined();

      ws1.close();
      ws2.close();
    });

    it("does NOT warn when file metadata is absent", async () => {
      const { roomCode } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(authPayload("fmm-no-host", { file: {} }));
      await tick();

      const ws2 = await connectWs(roomCode);
      ws2.send(
        authPayload("fmm-no-guest", {
          file: { name: "movie.mkv", durationMs: 120000 },
        }),
      );
      await tick();

      const warn = msgs1.get().find(
        (m) => m.type === "warning" && m.code === "file-mismatch",
      );
      expect(warn).toBeUndefined();

      ws1.close();
      ws2.close();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 4. Validation enforcement matrix
  // ════════════════════════════════════════════════════════════════

  describe("validation enforcement", () => {
    it("rejects oversized message with error", async () => {
      const { hostWs, guestWs, hostMsgs } = await setupRoom("val-size");

      // 9KB payload exceeds 8KB limit
      const hugePayload = JSON.stringify({
        type: "play",
        protocolVersion: 2,
        sessionId: "val-size-host",
        messageId: crypto.randomUUID(),
        tsMs: Date.now(),
        positionMs: 0,
        padding: "x".repeat(9000),
      });
      hostWs.send(hugePayload);
      await tick();

      const err = hostMsgs.get().find((m) => m.type === "error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("message-too-large");

      hostWs.close();
      guestWs.close();
    });

    it("rejects invalid JSON with error", async () => {
      const { hostWs, guestWs, hostMsgs } = await setupRoom("val-json");

      hostWs.send("{not valid json{{{");
      await tick();

      const err = hostMsgs.get().find((m) => m.type === "error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("invalid-json");

      hostWs.close();
      guestWs.close();
    });

    it("rejects non-object JSON payload", async () => {
      const { hostWs, guestWs, hostMsgs } = await setupRoom("val-arr");

      hostWs.send(JSON.stringify([1, 2, 3]));
      await tick();

      const err = hostMsgs.get().find((m) => m.type === "error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("invalid-format");

      hostWs.close();
      guestWs.close();
    });

    it("rejects unknown message type", async () => {
      const { hostWs, guestWs, hostMsgs } = await setupRoom("val-unk");

      hostWs.send(makeMessage("banana", "val-unk-host", {}));
      await tick();

      const err = hostMsgs.get().find((m) => m.type === "error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("invalid-type");

      hostWs.close();
      guestWs.close();
    });

    it("rejects auth message type after already authenticated", async () => {
      const { hostWs, guestWs, hostMsgs } =
        await setupRoom("val-reauth");

      hostWs.send(authPayload("val-reauth-host"));
      await tick();

      const err = hostMsgs.get().find((m) => m.type === "error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("invalid-type");

      hostWs.close();
      guestWs.close();
    });

    it("rejects binary message", async () => {
      const { hostWs, guestWs, hostMsgs } = await setupRoom("val-bin");

      hostWs.send(new ArrayBuffer(16));
      await tick();

      const err = hostMsgs.get().find((m) => m.type === "error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("invalid-format");

      hostWs.close();
      guestWs.close();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 5. Rate limiting matrix
  // ════════════════════════════════════════════════════════════════

  describe("rate limiting", () => {
    it("throttles burst of messages beyond limit", async () => {
      const { hostWs, guestWs, hostMsgs, guestMsgs } =
        await setupRoom("rl-burst");

      // Send 25 messages rapidly (limit is 20 burst)
      for (let i = 0; i < 25; i++) {
        hostWs.send(
          makeMessage("play", "rl-burst-host", { positionMs: i * 1000 }),
        );
      }
      await tick(100);

      const errors = hostMsgs.get().filter((m) => m.type === "error");
      const rateLimited = errors.filter((m) => m.code === "rate-limited");
      expect(rateLimited.length).toBeGreaterThan(0);

      // Guest should have received some but not all messages
      const plays = guestMsgs.get().filter((m) => m.type === "play");
      expect(plays.length).toBeLessThan(25);
      expect(plays.length).toBeGreaterThan(0);

      hostWs.close();
      guestWs.close();
    });

    it("rate limits room creation", async () => {
      // Reset to get a clean slate for this test
      roomCreateLimiter.reset();

      // Limit is 10 per 60s window — exhaust it then verify 429
      const results: number[] = [];
      for (let i = 0; i < 13; i++) {
        const res = await SELF.fetch("https://example.com/api/rooms", {
          method: "POST",
        });
        results.push(res.status);
      }

      const successes = results.filter((s) => s === 200);
      const rateLimited = results.filter((s) => s === 429);
      expect(successes.length).toBe(10);
      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 6. Presence lifecycle matrix
  // ════════════════════════════════════════════════════════════════

  describe("presence lifecycle", () => {
    it("notifies host when guest joins", async () => {
      const { roomCode } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(authPayload("pres-join-host"));
      await tick();
      msgs1.clear();

      const ws2 = await connectWs(roomCode);
      ws2.send(authPayload("pres-join-guest"));
      await tick();

      const presence = msgs1.get().find((m) => m.type === "presence");
      expect(presence).toBeDefined();
      expect(presence!.event).toBe("peer-joined");
      expect(presence!.role).toBe("guest");

      ws1.close();
      ws2.close();
    });

    it("notifies guest when host disconnects", async () => {
      const { hostWs, guestWs, guestMsgs } = await setupRoom("pres-leave");

      hostWs.close();
      await tick();

      const presence = guestMsgs.get().find(
        (m) => m.type === "presence" && m.event === "peer-left",
      );
      expect(presence).toBeDefined();
      expect(presence!.role).toBe("host");

      guestWs.close();
    });

    it("notifies host when guest sends goodbye", async () => {
      const { hostWs, guestWs, hostMsgs } = await setupRoom("pres-bye");

      guestWs.send(
        makeMessage("goodbye", "pres-bye-guest", { reason: "user left" }),
      );
      await tick();

      const goodbye = hostMsgs.get().find((m) => m.type === "goodbye");
      expect(goodbye).toBeDefined();

      const presence = hostMsgs.get().find(
        (m) => m.type === "presence" && m.event === "peer-left",
      );
      expect(presence).toBeDefined();
      expect(presence!.role).toBe("guest");

      hostWs.close();
    });

    it("does not send presence when unauthenticated socket closes", async () => {
      const { roomCode } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(authPayload("pres-unauth-host"));
      await tick();
      msgs1.clear();

      // Connect but never authenticate
      const ws2 = await connectWs(roomCode);
      await tick();
      ws2.close();
      await tick();

      const presence = msgs1.get().filter((m) => m.type === "presence");
      expect(presence).toHaveLength(0);

      ws1.close();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 7. Multi-step sync scenarios
  // ════════════════════════════════════════════════════════════════

  describe("multi-step sync scenarios", () => {
    it("host play→seek→pause sequence relays correctly", async () => {
      const { hostWs, guestWs, guestMsgs } = await setupRoom("seq-psp");

      // Play
      hostWs.send(
        makeMessage("play", "seq-psp-host", { positionMs: 0 }),
      );
      await tick();

      // Seek
      hostWs.send(
        makeMessage("seek", "seq-psp-host", {
          positionMs: 60000,
          cause: "user",
        }),
      );
      await tick();

      // Pause
      hostWs.send(
        makeMessage("pause", "seq-psp-host", { positionMs: 62000 }),
      );
      await tick();

      const types = guestMsgs.get().map((m) => m.type);
      expect(types).toEqual(["play", "seek", "pause"]);

      const play = guestMsgs.get()[0];
      expect(play.positionMs).toBe(0);

      const seek = guestMsgs.get()[1];
      expect(seek.positionMs).toBe(60000);

      const pause = guestMsgs.get()[2];
      expect(pause.positionMs).toBe(62000);

      hostWs.close();
      guestWs.close();
    });

    it("bidirectional play exchange (both sides control)", async () => {
      const { hostWs, guestWs, hostMsgs, guestMsgs } =
        await setupRoom("seq-bidir");

      // Host plays
      hostWs.send(
        makeMessage("play", "seq-bidir-host", { positionMs: 1000 }),
      );
      await tick();

      // Guest seeks
      guestWs.send(
        makeMessage("seek", "seq-bidir-guest", {
          positionMs: 50000,
          cause: "user",
        }),
      );
      await tick();

      // Host changes speed
      hostWs.send(
        makeMessage("speed", "seq-bidir-host", { speed: 2.0 }),
      );
      await tick();

      // Guest pauses
      guestWs.send(
        makeMessage("pause", "seq-bidir-guest", { positionMs: 52000 }),
      );
      await tick();

      // Verify guest received host messages
      const guestTypes = guestMsgs.get().map((m) => m.type);
      expect(guestTypes).toEqual(["play", "speed"]);

      // Verify host received guest messages
      const hostTypes = hostMsgs.get().map((m) => m.type);
      expect(hostTypes).toEqual(["seek", "pause"]);

      hostWs.close();
      guestWs.close();
    });

    it("heartbeat exchange preserves all fields through relay", async () => {
      const { hostWs, guestWs, guestMsgs } = await setupRoom("seq-hb");

      hostWs.send(
        makeMessage("heartbeat", "seq-hb-host", {
          positionMs: 45000,
          paused: false,
          speed: 1.25,
          buffering: false,
          seeking: false,
        }),
      );
      await tick();

      const hb = guestMsgs.get().find((m) => m.type === "heartbeat");
      expect(hb).toBeDefined();
      expect(hb!.positionMs).toBe(45000);
      expect(hb!.paused).toBe(false);
      expect(hb!.speed).toBe(1.25);
      expect(hb!.buffering).toBe(false);
      expect(hb!.seeking).toBe(false);

      hostWs.close();
      guestWs.close();
    });

    it("state message with all fields relays correctly", async () => {
      const { hostWs, guestWs, guestMsgs } = await setupRoom("seq-state");

      hostWs.send(
        makeMessage("state", "seq-state-host", {
          reason: "reconnect",
          positionMs: 90000,
          paused: false,
          speed: 1.5,
          buffering: true,
        }),
      );
      await tick();

      const state = guestMsgs.get().find((m) => m.type === "state");
      expect(state).toBeDefined();
      expect(state!.reason).toBe("reconnect");
      expect(state!.positionMs).toBe(90000);
      expect(state!.paused).toBe(false);
      expect(state!.speed).toBe(1.5);
      expect(state!.buffering).toBe(true);

      hostWs.close();
      guestWs.close();
    });

    it("guest replacement mid-session continues relay", async () => {
      const { roomCode, hostWs, guestWs, hostMsgs } =
        await setupRoom("seq-replace");

      // Guest disconnects
      guestWs.send(
        makeMessage("goodbye", "seq-replace-guest", { reason: "leaving" }),
      );
      await tick();
      hostMsgs.clear();

      // New guest joins
      const ws3 = await connectWs(roomCode);
      const msgs3 = collectMessages(ws3);
      ws3.send(authPayload("seq-replace-guest2"));
      await tick();

      const authOk = msgs3.get().find((m) => m.type === "auth-ok");
      expect(authOk!.role).toBe("guest");
      msgs3.clear();

      // Host sends play — should reach new guest
      hostWs.send(
        makeMessage("play", "seq-replace-host", { positionMs: 7000 }),
      );
      await tick();

      const relayed = msgs3.get().find((m) => m.type === "play");
      expect(relayed).toBeDefined();
      expect(relayed!.positionMs).toBe(7000);

      hostWs.close();
      ws3.close();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 8. Error recovery matrix
  // ════════════════════════════════════════════════════════════════

  describe("error recovery", () => {
    it("session continues after validation error", async () => {
      const { hostWs, guestWs, hostMsgs, guestMsgs } =
        await setupRoom("err-recov");

      // Send invalid message
      hostWs.send("{broken");
      await tick();

      const err = hostMsgs.get().find((m) => m.type === "error");
      expect(err).toBeDefined();
      hostMsgs.clear();

      // Send valid message — should still relay
      hostWs.send(
        makeMessage("play", "err-recov-host", { positionMs: 5000 }),
      );
      await tick();

      const relayed = guestMsgs.get().find((m) => m.type === "play");
      expect(relayed).toBeDefined();
      expect(relayed!.positionMs).toBe(5000);

      hostWs.close();
      guestWs.close();
    });

    it("multiple consecutive errors don't break the session", async () => {
      const { hostWs, guestWs, hostMsgs, guestMsgs } =
        await setupRoom("err-multi");

      // Three consecutive bad messages
      hostWs.send("{bad1");
      hostWs.send("{bad2");
      hostWs.send("{bad3");
      await tick();

      const errors = hostMsgs.get().filter((m) => m.type === "error");
      expect(errors).toHaveLength(3);
      hostMsgs.clear();

      // Valid message still works
      hostWs.send(
        makeMessage("pause", "err-multi-host", { positionMs: 10000 }),
      );
      await tick();

      const relayed = guestMsgs.get().find((m) => m.type === "pause");
      expect(relayed).toBeDefined();

      hostWs.close();
      guestWs.close();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 9. Room creation → full lifecycle → teardown
  // ════════════════════════════════════════════════════════════════

  describe("full room lifecycle", () => {
    it("create → auth → relay → goodbye → new guest → relay → close", async () => {
      // Step 1: Create room via HTTP
      const { roomCode, expiresAtMs } = await createRoom();
      expect(roomCode).toMatch(/^[A-Z2-9]{6}$/);
      expect(expiresAtMs).toBeGreaterThan(Date.now());

      // Step 2: Verify room status
      const statusRes = await SELF.fetch(
        `https://example.com/api/rooms/${roomCode}`,
      );
      expect(statusRes.status).toBe(200);
      const status = (await statusRes.json()) as Record<string, unknown>;
      expect(status.exists).toBe(true);

      // Step 3: Host connects and authenticates
      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(authPayload("lifecycle-host"));
      await tick();

      const authOk1 = msgs1.get().find((m) => m.type === "auth-ok");
      expect(authOk1!.role).toBe("host");
      msgs1.clear();

      // Step 4: Guest connects and authenticates
      const ws2 = await connectWs(roomCode);
      const msgs2 = collectMessages(ws2);
      ws2.send(authPayload("lifecycle-guest1"));
      await tick();

      const authOk2 = msgs2.get().find((m) => m.type === "auth-ok");
      expect(authOk2!.role).toBe("guest");

      // Host received peer-joined
      const joined = msgs1.get().find((m) => m.type === "presence");
      expect(joined!.event).toBe("peer-joined");
      msgs1.clear();
      msgs2.clear();

      // Step 5: Host sends play, guest receives it
      ws1.send(makeMessage("play", "lifecycle-host", { positionMs: 0 }));
      await tick();
      expect(msgs2.get().find((m) => m.type === "play")).toBeDefined();
      msgs2.clear();

      // Step 6: Guest sends goodbye
      ws2.send(
        makeMessage("goodbye", "lifecycle-guest1", { reason: "leaving" }),
      );
      await tick();

      expect(msgs1.get().find((m) => m.type === "goodbye")).toBeDefined();
      expect(
        msgs1.get().find((m) => m.type === "presence" && m.event === "peer-left"),
      ).toBeDefined();
      msgs1.clear();

      // Step 7: New guest joins
      const ws3 = await connectWs(roomCode);
      const msgs3 = collectMessages(ws3);
      ws3.send(authPayload("lifecycle-guest2"));
      await tick();

      const authOk3 = msgs3.get().find((m) => m.type === "auth-ok");
      expect(authOk3!.role).toBe("guest");
      msgs3.clear();

      // Step 8: Relay to new guest works
      ws1.send(
        makeMessage("seek", "lifecycle-host", {
          positionMs: 30000,
          cause: "user",
        }),
      );
      await tick();

      const seekRelayed = msgs3.get().find((m) => m.type === "seek");
      expect(seekRelayed).toBeDefined();
      expect(seekRelayed!.positionMs).toBe(30000);

      // Cleanup
      ws1.close();
      ws3.close();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 10. Server message envelope compliance
  // ════════════════════════════════════════════════════════════════

  describe("server message envelope compliance", () => {
    it("all server-originated messages include full envelope", async () => {
      const { roomCode } = await createRoom();

      const ws = await connectWs(roomCode);
      const msgs = collectMessages(ws);
      ws.send(authPayload("envelope-test"));
      await tick();

      // auth-ok is server-originated
      const authOk = msgs.get().find((m) => m.type === "auth-ok");
      expect(authOk).toBeDefined();
      expect(authOk!.protocolVersion).toBe(2);
      expect(authOk!.sessionId).toBe("server");
      expect(typeof authOk!.messageId).toBe("string");
      expect((authOk!.messageId as string).length).toBeGreaterThan(0);
      expect(typeof authOk!.tsMs).toBe("number");
      expect(authOk!.tsMs).toBeGreaterThan(0);

      ws.close();
    });

    it("error responses include full envelope", async () => {
      const { hostWs, guestWs, hostMsgs } = await setupRoom("envelope-err");

      hostWs.send("{bad json");
      await tick();

      const err = hostMsgs.get().find((m) => m.type === "error");
      expect(err).toBeDefined();
      expect(err!.protocolVersion).toBe(2);
      expect(err!.sessionId).toBe("server");
      expect(typeof err!.messageId).toBe("string");
      expect(typeof err!.tsMs).toBe("number");

      hostWs.close();
      guestWs.close();
    });

    it("presence messages include full envelope", async () => {
      const { roomCode } = await createRoom();

      const ws1 = await connectWs(roomCode);
      const msgs1 = collectMessages(ws1);
      ws1.send(authPayload("envelope-pres-host"));
      await tick();
      msgs1.clear();

      const ws2 = await connectWs(roomCode);
      ws2.send(authPayload("envelope-pres-guest"));
      await tick();

      const presence = msgs1.get().find((m) => m.type === "presence");
      expect(presence).toBeDefined();
      expect(presence!.protocolVersion).toBe(2);
      expect(presence!.sessionId).toBe("server");
      expect(typeof presence!.messageId).toBe("string");
      expect(typeof presence!.tsMs).toBe("number");

      ws1.close();
      ws2.close();
    });
  });
});
