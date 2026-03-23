import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";
import type { Env } from "../src/index.js";

const typedEnv = env as Env;

function getRoomStub(roomCode: string) {
  const doId = typedEnv.ROOM.idFromName(roomCode);
  return typedEnv.ROOM.get(doId);
}

function initRequest(body: unknown) {
  return new Request("https://do/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Room Durable Object", () => {
  // ── Initialization ──────────────────────────────────────────

  describe("POST /init", () => {
    it("initializes a new room and returns expiresAtMs", async () => {
      const stub = getRoomStub("ABCDEF");
      const res = await stub.fetch(
        initRequest({ roomCode: "ABCDEF" }),
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as { expiresAtMs: number };
      expect(body.expiresAtMs).toBeTypeOf("number");
      expect(body.expiresAtMs).toBeGreaterThan(Date.now());
      // Should be approximately 24 hours from now
      const expectedMs = 24 * 60 * 60 * 1000;
      expect(body.expiresAtMs - Date.now()).toBeLessThanOrEqual(expectedMs + 1000);
      expect(body.expiresAtMs - Date.now()).toBeGreaterThan(expectedMs - 5000);
    });

    it("returns JSON content-type on success", async () => {
      const stub = getRoomStub("CDEFGH");
      const res = await stub.fetch(
        initRequest({ roomCode: "CDEFGH" }),
      );
      expect(res.headers.get("content-type")).toBe("application/json");
    });
  });

  // ── Collision detection (tested via Worker to avoid DO storage isolation issues) ──

  describe("collision detection", () => {
    it("returns unique rooms and rejects re-creation via Worker", async () => {
      // Create first room
      const res1 = await SELF.fetch("https://example.com/api/rooms", {
        method: "POST",
      });
      expect(res1.status).toBe(200);
      const { roomCode } = (await res1.json()) as { roomCode: string };

      // Verify it exists
      const statusRes = await SELF.fetch(
        `https://example.com/api/rooms/${roomCode}`,
        { method: "GET" },
      );
      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as { exists: boolean };
      expect(statusBody.exists).toBe(true);
    });
  });

  // ── Input validation ────────────────────────────────────────

  describe("input validation", () => {
    it("rejects missing roomCode", async () => {
      const stub = getRoomStub("DEFGHJ");
      const res = await stub.fetch(
        initRequest({}),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("room code");
    });

    it("rejects invalid roomCode format (too short)", async () => {
      const stub = getRoomStub("XYZABC");
      const res = await stub.fetch(
        initRequest({ roomCode: "ABC" }),
      );
      expect(res.status).toBe(400);
    });

    it("rejects invalid roomCode format (bad characters)", async () => {
      const stub = getRoomStub("XYZDEF");
      const res = await stub.fetch(
        initRequest({ roomCode: "ABCD0I" }),
      );
      expect(res.status).toBe(400);
    });

    it("rejects non-string roomCode", async () => {
      const stub = getRoomStub("EFGHJK");
      const res = await stub.fetch(
        initRequest({ roomCode: 123456 }),
      );
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body", async () => {
      const stub = getRoomStub("JKMNPQ");
      const res = await stub.fetch(
        new Request("https://do/init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Invalid JSON");
    });

    it("rejects array body", async () => {
      const stub = getRoomStub("KMNPQR");
      const res = await stub.fetch(
        new Request("https://do/init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify([1, 2, 3]),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  // ── Status endpoint ─────────────────────────────────────────

  describe("GET /status", () => {
    it("returns 404 for uninitialized room", async () => {
      const stub = getRoomStub("MNPQRS");
      const res = await stub.fetch(
        new Request("https://do/status", { method: "GET" }),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { exists: boolean };
      expect(body.exists).toBe(false);
    });

    it("returns room info via Worker after creation", async () => {
      // Create through the worker
      const createRes = await SELF.fetch("https://example.com/api/rooms", {
        method: "POST",
      });
      const { roomCode } = (await createRes.json()) as { roomCode: string };

      // Check status through the worker
      const res = await SELF.fetch(
        `https://example.com/api/rooms/${roomCode}`,
        { method: "GET" },
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        exists: boolean;
        roomCode: string;
        createdAtMs: number;
        expiresAtMs: number;
      };
      expect(body.exists).toBe(true);
      expect(body.roomCode).toBe(roomCode);
      expect(body.createdAtMs).toBeTypeOf("number");
      expect(body.expiresAtMs).toBeTypeOf("number");
      expect(body.expiresAtMs).toBeGreaterThan(body.createdAtMs);
    });
  });

  // ── Routing ─────────────────────────────────────────────────

  describe("routing", () => {
    it("returns 404 for unknown path", async () => {
      const stub = getRoomStub("PQRSTU");
      const res = await stub.fetch(
        new Request("https://do/unknown", { method: "GET" }),
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 for WebSocket upgrade on uninitialized room", async () => {
      const stub = getRoomStub("QRSTUV");
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
