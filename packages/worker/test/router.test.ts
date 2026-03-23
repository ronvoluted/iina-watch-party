import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { roomCreateLimiter } from "../src/index.js";

describe("Worker router", () => {
  beforeEach(() => {
    roomCreateLimiter.reset();
  });
  // ── POST /api/rooms ──────────────────────────────────────────

  describe("POST /api/rooms", () => {
    it("creates a room and returns expected fields", async () => {
      const res = await SELF.fetch("https://example.com/api/rooms", {
        method: "POST",
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("roomCode");
      expect(body).toHaveProperty("secret");
      expect(body).toHaveProperty("invite");
      expect(body).toHaveProperty("wsUrl");
      expect(body).toHaveProperty("expiresAtMs");

      // Room code is 6 characters from the valid alphabet
      expect(typeof body.roomCode).toBe("string");
      expect((body.roomCode as string).length).toBe(6);

      // Secret is non-empty base64url
      expect(typeof body.secret).toBe("string");
      expect((body.secret as string).length).toBeGreaterThan(0);

      // Invite is roomCode:secret
      expect(body.invite).toBe(`${body.roomCode}:${body.secret}`);

      // WebSocket URL uses the room code
      expect(body.wsUrl).toContain(`/ws/${body.roomCode}`);

      // expiresAtMs is a future timestamp
      expect(typeof body.expiresAtMs).toBe("number");
      expect(body.expiresAtMs as number).toBeGreaterThan(Date.now());
    });

    it("returns unique room codes on successive calls", async () => {
      const res1 = await SELF.fetch("https://example.com/api/rooms", {
        method: "POST",
      });
      const res2 = await SELF.fetch("https://example.com/api/rooms", {
        method: "POST",
      });

      const body1 = (await res1.json()) as { roomCode: string };
      const body2 = (await res2.json()) as { roomCode: string };

      expect(body1.roomCode).not.toBe(body2.roomCode);
    });
  });

  // ── Method enforcement ────────────────────────────────────────

  describe("method enforcement", () => {
    it("rejects GET on /api/rooms with 405", async () => {
      const res = await SELF.fetch("https://example.com/api/rooms", {
        method: "GET",
      });
      expect(res.status).toBe(405);
    });

    it("rejects PUT on /api/rooms with 405", async () => {
      const res = await SELF.fetch("https://example.com/api/rooms", {
        method: "PUT",
      });
      expect(res.status).toBe(405);
    });

    it("rejects POST on /ws/:code with 405", async () => {
      const res = await SELF.fetch("https://example.com/ws/ABCDEF", {
        method: "POST",
      });
      expect(res.status).toBe(405);
    });
  });

  // ── GET /ws/:code ─────────────────────────────────────────────

  describe("GET /ws/:code", () => {
    it("rejects non-upgrade GET with 426", async () => {
      const res = await SELF.fetch("https://example.com/ws/ABCDEF", {
        method: "GET",
      });
      expect(res.status).toBe(426);
    });
  });

  // ── GET /api/rooms/:code ─────────────────────────────────────

  describe("GET /api/rooms/:code", () => {
    it("returns 404 for non-existent room", async () => {
      const res = await SELF.fetch("https://example.com/api/rooms/ZYXWVU", {
        method: "GET",
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { exists: boolean };
      expect(body.exists).toBe(false);
    });

    it("returns 200 for existing room", async () => {
      // Create a room first
      const createRes = await SELF.fetch("https://example.com/api/rooms", {
        method: "POST",
      });
      const { roomCode } = (await createRes.json()) as { roomCode: string };

      // Check status
      const res = await SELF.fetch(
        `https://example.com/api/rooms/${roomCode}`,
        { method: "GET" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { exists: boolean; roomCode: string };
      expect(body.exists).toBe(true);
      expect(body.roomCode).toBe(roomCode);
    });

    it("rejects invalid room code format", async () => {
      const res = await SELF.fetch("https://example.com/api/rooms/bad!", {
        method: "GET",
      });
      expect(res.status).toBe(404);
    });

    it("rejects POST on /api/rooms/:code with 405", async () => {
      const res = await SELF.fetch("https://example.com/api/rooms/ABCDEF", {
        method: "POST",
      });
      expect(res.status).toBe(405);
    });
  });

  // ── Room code validation ────────────────────────────────────

  describe("room code validation", () => {
    it("rejects /ws/ with invalid room code characters", async () => {
      const res = await SELF.fetch("https://example.com/ws/abc123", {
        method: "GET",
      });
      // lowercase is not in the alphabet — should 404
      expect(res.status).toBe(404);
    });

    it("rejects /ws/ with too-short room code", async () => {
      const res = await SELF.fetch("https://example.com/ws/ABC", {
        method: "GET",
      });
      expect(res.status).toBe(404);
    });

    it("rejects /ws/ with too-long room code", async () => {
      const res = await SELF.fetch("https://example.com/ws/ABCDEFGH", {
        method: "GET",
      });
      expect(res.status).toBe(404);
    });

    it("rejects /ws/ with ambiguous characters (0, O, 1, I, L)", async () => {
      const res = await SELF.fetch("https://example.com/ws/A0O1IL", {
        method: "GET",
      });
      expect(res.status).toBe(404);
    });
  });

  // ── 404 fallback ──────────────────────────────────────────────

  describe("404 fallback", () => {
    it("returns 404 for unknown paths", async () => {
      const res = await SELF.fetch("https://example.com/unknown");
      expect(res.status).toBe(404);
    });

    it("returns 404 for root path", async () => {
      const res = await SELF.fetch("https://example.com/");
      expect(res.status).toBe(404);
    });

    it("returns 404 for /ws/ without a code", async () => {
      const res = await SELF.fetch("https://example.com/ws/");
      expect(res.status).toBe(404);
    });

    it("returns 404 for /ws with no trailing slash", async () => {
      const res = await SELF.fetch("https://example.com/ws");
      expect(res.status).toBe(404);
    });

    it("returns 404 for /ws/:code/extra", async () => {
      const res = await SELF.fetch("https://example.com/ws/ABCDEF/extra");
      expect(res.status).toBe(404);
    });
  });

  // ── Response format ────────────────────────────────────────────

  describe("response format", () => {
    it("returns JSON content-type for room creation", async () => {
      const res = await SELF.fetch("https://example.com/api/rooms", {
        method: "POST",
      });
      expect(res.headers.get("content-type")).toBe("application/json");
    });

    it("returns JSON content-type for errors", async () => {
      const res = await SELF.fetch("https://example.com/api/rooms", {
        method: "GET",
      });
      expect(res.headers.get("content-type")).toBe("application/json");
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Method not allowed");
    });
  });
});
