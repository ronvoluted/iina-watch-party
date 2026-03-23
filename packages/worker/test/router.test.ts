import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("Worker router", () => {
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
