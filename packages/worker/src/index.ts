/**
 * @iina-watch-party/worker
 *
 * Cloudflare Worker entry point with HTTP router and Durable Object binding.
 */

export { Room } from "./room.js";
import { IpRateLimiter } from "./rate-limit.js";

/**
 * Room code constants — mirrored from @iina-watch-party/shared to avoid
 * cross-package resolution issues in the workerd runtime.
 */
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Maximum retries for room code collision. */
const MAX_CODE_RETRIES = 5;

/** Rate limit: max 10 room creations per IP per 60-second window. */
const ROOM_CREATE_RATE_LIMIT_WINDOW_MS = 60_000;
const ROOM_CREATE_RATE_LIMIT_MAX = 10;

/** Rate limit: max 30 room status/join checks per IP per 60-second window. */
const ROOM_LOOKUP_RATE_LIMIT_WINDOW_MS = 60_000;
const ROOM_LOOKUP_RATE_LIMIT_MAX = 30;

/** Exported for test access (reset between tests). */
export const roomCreateLimiter = new IpRateLimiter(
  ROOM_CREATE_RATE_LIMIT_WINDOW_MS,
  ROOM_CREATE_RATE_LIMIT_MAX,
);

export const roomLookupLimiter = new IpRateLimiter(
  ROOM_LOOKUP_RATE_LIMIT_WINDOW_MS,
  ROOM_LOOKUP_RATE_LIMIT_MAX,
);

/** Prune stale entries every N requests. */
let requestCount = 0;
const PRUNE_INTERVAL = 100;

export interface Env {
  ROOM: DurableObjectNamespace;
}

/**
 * Generate a cryptographically random room code using the shared alphabet.
 */
function generateRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

/**
 * Handle POST /api/rooms — create a new room.
 */
async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";

  if (!roomCreateLimiter.check(ip)) {
    console.warn("[router] Rate limited room creation", { ip });
    return jsonResponse({ error: "Too many requests" }, 429);
  }

  console.log("[router] Creating room");
  for (let attempt = 0; attempt < MAX_CODE_RETRIES; attempt++) {
    const roomCode = generateRoomCode();

    // Deterministic DO id from room code
    const doId = env.ROOM.idFromName(roomCode);
    const stub = env.ROOM.get(doId);

    // Forward init request to the Durable Object
    const initRes = await stub.fetch(
      new Request(`https://do/init`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomCode }),
      }),
    );

    if (initRes.status === 409) {
      console.warn(`[router] Room code collision on attempt ${attempt + 1}, retrying`);
      continue;
    }

    if (!initRes.ok) {
      console.error(`[router] Room init failed: HTTP ${initRes.status}`);
      return jsonResponse({ error: "Failed to create room" }, 500);
    }

    const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${url.host}/ws/${roomCode}`;

    const initData = (await initRes.json()) as { expiresAtMs: number };

    return jsonResponse({
      roomCode,
      wsUrl,
      expiresAtMs: initData.expiresAtMs,
    });
  }

  console.error(`[router] Failed to generate unique room code after ${MAX_CODE_RETRIES} attempts`);
  return jsonResponse({ error: "Failed to generate unique room code" }, 503);
}

/**
 * Handle GET /api/rooms/:code — check room status.
 */
function handleRoomStatus(env: Env, roomCode: string): Promise<Response> {
  const doId = env.ROOM.idFromName(roomCode);
  const stub = env.ROOM.get(doId);
  return stub.fetch(new Request("https://do/status", { method: "GET" }));
}

/**
 * Extract room code from /api/rooms/:code path. Returns null if no match.
 */
function extractApiRoomCode(pathname: string): string | null {
  const match = pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (!match) return null;
  const code = match[1];
  if (!isValidRoomCode(code)) return null;
  return code;
}

/**
 * Handle GET /ws/:code — WebSocket upgrade to room Durable Object.
 */
function handleWebSocketUpgrade(
  request: Request,
  env: Env,
  roomCode: string,
): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader?.toLowerCase() !== "websocket") {
    return Promise.resolve(
      jsonResponse({ error: "Expected WebSocket upgrade" }, 426),
    );
  }

  const doId = env.ROOM.idFromName(roomCode);
  const stub = env.ROOM.get(doId);

  // Forward the upgrade request to the Durable Object
  return stub.fetch(request);
}

/**
 * Validate a room code against the expected format.
 */
function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i++) {
    if (!ROOM_CODE_ALPHABET.includes(code[i])) return false;
  }
  return true;
}

/**
 * Extract room code from /ws/:code path. Returns null if invalid.
 */
function extractRoomCode(pathname: string): string | null {
  // Match /ws/ followed by exactly the code (no trailing segments)
  const match = pathname.match(/^\/ws\/([^/]+)$/);
  if (!match) return null;
  const code = match[1];
  if (!isValidRoomCode(code)) return null;
  return code;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Periodically prune expired rate-limit entries
    requestCount++;
    if (requestCount % PRUNE_INTERVAL === 0) {
      roomCreateLimiter.prune();
      roomLookupLimiter.prune();
    }

    // POST /api/rooms — create room
    if (url.pathname === "/api/rooms") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }
      return handleCreateRoom(request, env);
    }

    // GET /api/rooms/:code — room status
    const apiRoomCode = extractApiRoomCode(url.pathname);
    if (apiRoomCode !== null) {
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!roomLookupLimiter.check(ip)) {
        return jsonResponse({ error: "Too many requests" }, 429);
      }
      return handleRoomStatus(env, apiRoomCode);
    }

    // GET /ws/:code — WebSocket upgrade
    const roomCode = extractRoomCode(url.pathname);
    if (roomCode !== null) {
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!roomLookupLimiter.check(ip)) {
        return jsonResponse({ error: "Too many requests" }, 429);
      }
      return handleWebSocketUpgrade(request, env, roomCode);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
} satisfies ExportedHandler<Env>;
