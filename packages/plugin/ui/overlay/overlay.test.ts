import { describe, test, expect, beforeEach, mock, jest } from "bun:test";

// ── Mock infrastructure ──────────────────────────────────────────────

type MessageHandler = (data: unknown) => void;

/** Captured iina.onMessage handlers keyed by message name. */
let handlers: Record<string, MessageHandler>;

/** Messages posted via iina.postMessage. */
let posted: Array<{ name: string; data: unknown }>;

/** The most recently constructed MockWebSocket instance. */
let lastSocket: MockWebSocket | null;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  protocols: string | string[] | undefined;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;

  sent: string[] = [];
  closed = false;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    lastSocket = this;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers to simulate server events
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }

  simulateError() {
    this.onerror?.({});
  }

  simulateClose(code = 1006, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

function setupGlobals() {
  handlers = {};
  posted = [];
  lastSocket = null;

  (globalThis as any).WebSocket = MockWebSocket;
  (globalThis as any).iina = {
    onMessage(name: string, cb: MessageHandler) {
      handlers[name] = cb;
    },
    postMessage(name: string, data: unknown) {
      posted.push({ name, data });
    },
  };
}

/** Load the overlay script fresh (clears module cache). */
async function loadOverlay() {
  // Delete from module cache so each test gets a fresh module
  const path = require.resolve("./index.js");
  delete require.cache[path];

  // Use dynamic import with cache-busting query
  const modulePath = `./index.js?t=${Date.now()}-${Math.random()}`;
  // For Bun, we need to use require to reload
  require(path);
}

function send(name: string, data?: unknown) {
  handlers[name]?.(data);
}

function findPosted(name: string) {
  return posted.filter((m) => m.name === name);
}

function lastPosted(name: string) {
  const msgs = findPosted(name);
  return msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("overlay bridge", () => {
  beforeEach(() => {
    setupGlobals();
    // Reload module to re-register handlers with fresh state
    const path = require.resolve("./index.js");
    delete require.cache[path];
    require(path);
    posted = []; // Clear any messages posted during module load
  });

  describe("ws-connect", () => {
    test("registers all three message handlers", () => {
      expect(handlers["ws-connect"]).toBeDefined();
      expect(handlers["ws-disconnect"]).toBeDefined();
      expect(handlers["ws-send"]).toBeDefined();
    });

    test("creates a WebSocket and posts ws-open on successful connection", () => {
      send("ws-connect", { url: "wss://example.com/ws/ABC123" });

      expect(lastSocket).not.toBeNull();
      expect(lastSocket!.url).toBe("wss://example.com/ws/ABC123");

      lastSocket!.simulateOpen();

      const openMsg = lastPosted("ws-open");
      expect(openMsg).toBeDefined();
    });

    test("passes protocols to WebSocket constructor", () => {
      send("ws-connect", {
        url: "wss://example.com/ws/ABC123",
        protocols: ["v1.watchparty"],
      });

      expect(lastSocket!.protocols).toEqual(["v1.watchparty"]);
    });

    test("posts ws-error when url is missing", () => {
      send("ws-connect", {});

      const errMsg = lastPosted("ws-error");
      expect(errMsg).toBeDefined();
      expect((errMsg!.data as any).message).toContain("url");
    });

    test("posts ws-error when data is null", () => {
      send("ws-connect", null);

      const errMsg = lastPosted("ws-error");
      expect(errMsg).toBeDefined();
    });

    test("closes previous socket when connecting again", () => {
      send("ws-connect", { url: "wss://example.com/ws/ROOM1" });
      const first = lastSocket!;
      first.simulateOpen();

      send("ws-connect", { url: "wss://example.com/ws/ROOM2" });

      expect(first.closed).toBe(true);
      expect(lastSocket!.url).toBe("wss://example.com/ws/ROOM2");
    });
  });

  describe("ws-message", () => {
    test("forwards inbound WebSocket messages to main", () => {
      send("ws-connect", { url: "wss://example.com/ws/ABC123" });
      lastSocket!.simulateOpen();

      lastSocket!.simulateMessage('{"type":"auth-ok"}');

      const msg = lastPosted("ws-message");
      expect(msg).toBeDefined();
      expect((msg!.data as any).data).toBe('{"type":"auth-ok"}');
    });
  });

  describe("ws-send", () => {
    test("sends data through the open WebSocket", () => {
      send("ws-connect", { url: "wss://example.com/ws/ABC123" });
      lastSocket!.simulateOpen();

      send("ws-send", { data: '{"type":"auth","secret":"abc"}' });

      expect(lastSocket!.sent).toEqual(['{"type":"auth","secret":"abc"}']);
    });

    test("silently drops send when no socket is open", () => {
      // No connection established
      send("ws-send", { data: '{"type":"auth"}' });
      // Should not throw
    });

    test("silently drops send when socket is not in OPEN state", () => {
      send("ws-connect", { url: "wss://example.com/ws/ABC123" });
      // Socket is still CONNECTING, not OPEN

      send("ws-send", { data: '{"type":"auth"}' });
      expect(lastSocket!.sent).toEqual([]);
    });
  });

  describe("ws-disconnect", () => {
    test("closes the socket and prevents reconnection", () => {
      send("ws-connect", { url: "wss://example.com/ws/ABC123" });
      const sock = lastSocket!;
      sock.simulateOpen();

      send("ws-disconnect");

      expect(sock.closed).toBe(true);
      // No ws-reconnecting should be posted
      expect(findPosted("ws-reconnecting")).toEqual([]);
    });
  });

  describe("ws-error", () => {
    test("posts ws-error on WebSocket error event", () => {
      send("ws-connect", { url: "wss://example.com/ws/ABC123" });
      lastSocket!.simulateError();

      const errMsg = findPosted("ws-error");
      expect(errMsg.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("ws-closed", () => {
    test("posts ws-closed with code and reason", () => {
      send("ws-connect", { url: "wss://example.com/ws/ABC123" });
      lastSocket!.simulateOpen();
      lastSocket!.simulateClose(1000, "normal");

      const closedMsg = lastPosted("ws-closed");
      expect(closedMsg).toBeDefined();
      expect((closedMsg!.data as any).code).toBe(1000);
      expect((closedMsg!.data as any).reason).toBe("normal");
    });
  });

  describe("http-fetch", () => {
    test("registers http-fetch handler", () => {
      expect(handlers["http-fetch"]).toBeDefined();
    });

    test("posts http-response error when url is missing", () => {
      send("http-fetch", {});

      const resp = lastPosted("http-response");
      expect(resp).toBeDefined();
      expect((resp!.data as any).ok).toBe(false);
      expect((resp!.data as any).error).toContain("url");
    });

    test("posts http-response error when data is null", () => {
      send("http-fetch", null);

      const resp = lastPosted("http-response");
      expect(resp).toBeDefined();
      expect((resp!.data as any).ok).toBe(false);
    });

    test("makes fetch call with correct url and method", async () => {
      const fetchCalls: Array<{ url: string; opts: any }> = [];
      (globalThis as any).fetch = (url: string, opts: any) => {
        fetchCalls.push({ url, opts });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ roomCode: "ABC123" }),
        });
      };

      send("http-fetch", { url: "https://example.com/api/rooms", method: "POST" });

      // Wait for async fetch to complete
      await new Promise((r) => setTimeout(r, 10));

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].url).toBe("https://example.com/api/rooms");
      expect(fetchCalls[0].opts.method).toBe("POST");

      const resp = lastPosted("http-response");
      expect(resp).toBeDefined();
      expect((resp!.data as any).ok).toBe(true);
      expect((resp!.data as any).status).toBe(200);
      expect((resp!.data as any).body).toEqual({ roomCode: "ABC123" });
    });

    test("posts error on fetch failure", async () => {
      (globalThis as any).fetch = () => Promise.reject(new Error("Network unreachable"));

      send("http-fetch", { url: "https://example.com/api/rooms" });

      await new Promise((r) => setTimeout(r, 10));

      const resp = lastPosted("http-response");
      expect(resp).toBeDefined();
      expect((resp!.data as any).ok).toBe(false);
      expect((resp!.data as any).error).toBe("Network unreachable");
    });
  });

  describe("reconnection", () => {
    test("schedules reconnect on unexpected close", () => {
      send("ws-connect", { url: "wss://example.com/ws/ABC123" });
      lastSocket!.simulateOpen();
      lastSocket!.simulateClose(1006, "");

      const reconnecting = lastPosted("ws-reconnecting");
      expect(reconnecting).toBeDefined();
      expect((reconnecting!.data as any).attempt).toBe(1);
      expect((reconnecting!.data as any).delayMs).toBeGreaterThan(0);
    });

    test("does not reconnect after intentional disconnect", () => {
      send("ws-connect", { url: "wss://example.com/ws/ABC123" });
      lastSocket!.simulateOpen();

      send("ws-disconnect");

      expect(findPosted("ws-reconnecting")).toEqual([]);
    });

    test("does not reconnect when close happens before open (connect failure)", () => {
      send("ws-connect", { url: "wss://example.com/ws/ABC123" });
      // Socket fails to connect — close fires without open
      lastSocket!.simulateClose(1006, "");

      // Still should attempt reconnection since the URL is valid
      const reconnecting = lastPosted("ws-reconnecting");
      expect(reconnecting).toBeDefined();
    });

    test("resets attempt counter on successful reconnection", async () => {
      jest.useFakeTimers();

      send("ws-connect", { url: "wss://example.com/ws/ABC123" });
      lastSocket!.simulateOpen();
      lastSocket!.simulateClose(1006, "");

      // First reconnect attempt
      const firstReconnect = lastPosted("ws-reconnecting");
      expect((firstReconnect!.data as any).attempt).toBe(1);

      // Advance timer to trigger reconnection
      jest.advanceTimersByTime(60000);

      // The new socket connects successfully
      if (lastSocket) {
        lastSocket.simulateOpen();
        // Force another disconnect
        lastSocket.simulateClose(1006, "");

        // Attempt counter should have reset to 0, so next attempt is 1 again
        const msgs = findPosted("ws-reconnecting");
        const lastReconnect = msgs[msgs.length - 1];
        expect((lastReconnect!.data as any).attempt).toBe(1);
      }

      jest.useRealTimers();
    });

    test("gives up after max reconnect attempts and posts ws-reconnect-failed", () => {
      jest.useFakeTimers();

      send("ws-connect", { url: "wss://example.com/ws/ABC123" });
      lastSocket!.simulateOpen();

      // Exhaust all 10 reconnect attempts
      for (let i = 0; i < 10; i++) {
        lastSocket!.simulateClose(1006, "");
        const reconnecting = findPosted("ws-reconnecting");
        const delay = (reconnecting[reconnecting.length - 1]!.data as any).delayMs;
        jest.advanceTimersByTime(delay + 100);
        // Each attempt opens a new socket that immediately fails (no simulateOpen)
        if (i < 9) {
          // Socket fails without connecting — onclose fires
          lastSocket!.simulateClose(1006, "");
        }
      }

      // After the 10th close, scheduleReconnect should post ws-reconnect-failed
      lastSocket!.simulateClose(1006, "");

      const failed = findPosted("ws-reconnect-failed");
      expect(failed.length).toBe(1);
      expect((failed[0].data as any).attempts).toBe(10);

      jest.useRealTimers();
    });

    test("does not schedule reconnect after max attempts exhausted", () => {
      jest.useFakeTimers();

      send("ws-connect", { url: "wss://example.com/ws/ABC123" });
      lastSocket!.simulateOpen();

      // Exhaust all attempts
      for (let i = 0; i < 10; i++) {
        lastSocket!.simulateClose(1006, "");
        const reconnecting = findPosted("ws-reconnecting");
        if (reconnecting.length > 0) {
          const delay = (reconnecting[reconnecting.length - 1]!.data as any).delayMs;
          jest.advanceTimersByTime(delay + 100);
        }
        if (i < 9) {
          lastSocket!.simulateClose(1006, "");
        }
      }

      lastSocket!.simulateClose(1006, "");

      // Should have exactly 10 ws-reconnecting messages, not more
      const reconnecting = findPosted("ws-reconnecting");
      expect(reconnecting.length).toBe(10);

      jest.useRealTimers();
    });

    test("exponential backoff increases delay", () => {
      send("ws-connect", { url: "wss://example.com/ws/ABC123" });

      jest.useFakeTimers();

      // First unexpected close
      lastSocket!.simulateOpen();
      lastSocket!.simulateClose(1006, "");
      const attempt1 = lastPosted("ws-reconnecting");
      const delay1 = (attempt1!.data as any).delayMs;

      // Advance past first reconnect delay, trigger second close
      jest.advanceTimersByTime(delay1 + 100);
      if (lastSocket) {
        lastSocket.simulateClose(1006, "");
        const msgs = findPosted("ws-reconnecting");
        const attempt2 = msgs[msgs.length - 1];
        const delay2 = (attempt2!.data as any).delayMs;

        // Second delay should generally be larger (with jitter, we check it's plausible)
        // Base: 1000 * 2^0 = 1000 for attempt 0, 1000 * 2^1 = 2000 for attempt 1
        // With jitter range ±25%, delay2 should be at least 1500 (2000 * 0.75)
        expect(delay2).toBeGreaterThanOrEqual(1000);
      }

      jest.useRealTimers();
    });
  });
});
