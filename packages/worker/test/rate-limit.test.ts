import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { roomCreateLimiter } from "../src/index.js";
import { IpRateLimiter, ConnectionRateLimiter } from "../src/rate-limit.js";

// ── Unit tests: IpRateLimiter ───────────────────────────────────

describe("IpRateLimiter", () => {
  it("allows requests within the limit", () => {
    const limiter = new IpRateLimiter(60_000, 3);
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(true);
  });

  it("rejects requests exceeding the limit", () => {
    const limiter = new IpRateLimiter(60_000, 2);
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(false);
    expect(limiter.check("1.2.3.4")).toBe(false);
  });

  it("tracks different IPs independently", () => {
    const limiter = new IpRateLimiter(60_000, 1);
    expect(limiter.check("1.1.1.1")).toBe(true);
    expect(limiter.check("2.2.2.2")).toBe(true);
    expect(limiter.check("1.1.1.1")).toBe(false);
    expect(limiter.check("2.2.2.2")).toBe(false);
  });

  it("resets after window expires", () => {
    const limiter = new IpRateLimiter(1, 1); // 1ms window
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(false);

    // Wait for window to expire
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait
    }
    expect(limiter.check("1.2.3.4")).toBe(true);
  });

  it("prune removes expired entries", () => {
    const limiter = new IpRateLimiter(1, 1); // 1ms window
    limiter.check("1.1.1.1");
    limiter.check("2.2.2.2");

    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait for expiry
    }

    limiter.prune();
    // After prune, IPs should be allowed again
    expect(limiter.check("1.1.1.1")).toBe(true);
    expect(limiter.check("2.2.2.2")).toBe(true);
  });
});

// ── Unit tests: ConnectionRateLimiter ───────────────────────────

describe("ConnectionRateLimiter", () => {
  it("allows messages up to burst limit", () => {
    const limiter = new ConnectionRateLimiter(5, 1);
    for (let i = 0; i < 5; i++) {
      expect(limiter.consume()).toBe(true);
    }
  });

  it("rejects messages beyond burst limit", () => {
    const limiter = new ConnectionRateLimiter(3, 1);
    expect(limiter.consume()).toBe(true);
    expect(limiter.consume()).toBe(true);
    expect(limiter.consume()).toBe(true);
    expect(limiter.consume()).toBe(false);
  });

  it("refills tokens over time", () => {
    const limiter = new ConnectionRateLimiter(2, 1000); // 1000/sec = fast refill
    expect(limiter.consume()).toBe(true);
    expect(limiter.consume()).toBe(true);
    expect(limiter.consume()).toBe(false);

    // Wait a few ms for refill at 1000/sec
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait
    }
    expect(limiter.consume()).toBe(true);
  });

  it("does not exceed max tokens on refill", () => {
    const limiter = new ConnectionRateLimiter(2, 1000);
    // Wait to accumulate tokens
    const start = Date.now();
    while (Date.now() - start < 50) {
      // busy wait
    }
    // Should still only allow 2 (max)
    expect(limiter.consume()).toBe(true);
    expect(limiter.consume()).toBe(true);
    expect(limiter.consume()).toBe(false);
  });
});

// ── Integration: WebSocket message rate limiting ─────────────────

describe("WebSocket message rate limiting", () => {
  beforeEach(() => {
    roomCreateLimiter.reset();
  });

  async function createRoom(): Promise<{
    roomCode: string;
    secret: string;
  }> {
    const res = await SELF.fetch("https://example.com/api/rooms", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { roomCode: string; secret: string };
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

  function collectMessages(ws: WebSocket): {
    get: () => Record<string, unknown>[];
  } {
    const messages: Record<string, unknown>[] = [];
    ws.addEventListener("message", (event) => {
      messages.push(JSON.parse(event.data as string));
    });
    return { get: () => messages };
  }

  async function tick(ms = 50): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("returns rate-limited error when flooding messages", async () => {
    const { roomCode, secret } = await createRoom();
    const ws = await connectWs(roomCode);
    const msgs = collectMessages(ws);

    // Authenticate first
    ws.send(
      JSON.stringify({
        type: "auth",
        protocolVersion: 1,
        sessionId: "flood-test",
        messageId: crypto.randomUUID(),
        tsMs: Date.now(),
        secret,
        file: {},
      }),
    );
    await tick();

    // Burst: send more messages than the rate limit allows
    // The auth message already consumed 1 token, so we send enough to exhaust
    for (let i = 0; i < 25; i++) {
      ws.send(
        JSON.stringify({
          type: "heartbeat",
          protocolVersion: 1,
          sessionId: "flood-test",
          messageId: crypto.randomUUID(),
          tsMs: Date.now(),
          positionMs: i * 1000,
          paused: false,
          speed: 1,
        }),
      );
    }
    await tick();

    const errors = msgs
      .get()
      .filter(
        (m) => m.type === "error" && m.code === "rate-limited",
      );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toBe("Too many messages");
  });
});
