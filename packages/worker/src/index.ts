/**
 * @iina-watch-party/worker
 *
 * Cloudflare Worker entry point with HTTP router and Durable Object binding.
 */

export { Room } from "./room.js";

/**
 * Room code constants — mirrored from @iina-watch-party/shared to avoid
 * cross-package resolution issues in the workerd runtime.
 */
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Maximum retries for room code collision. */
const MAX_CODE_RETRIES = 5;

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

/**
 * Generate a cryptographically random secret as base64url.
 */
function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // Convert to base64url without padding
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Handle POST /api/rooms — create a new room.
 */
async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  for (let attempt = 0; attempt < MAX_CODE_RETRIES; attempt++) {
    const roomCode = generateRoomCode();
    const secret = generateSecret();

    // Deterministic DO id from room code
    const doId = env.ROOM.idFromName(roomCode);
    const stub = env.ROOM.get(doId);

    // Forward init request to the Durable Object
    const initRes = await stub.fetch(
      new Request(`https://do/init`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomCode, secret }),
      }),
    );

    if (initRes.status === 409) {
      // Code collision — retry with a new code
      continue;
    }

    if (!initRes.ok) {
      return jsonResponse({ error: "Failed to create room" }, 500);
    }

    const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${url.host}/ws/${roomCode}`;

    const initData = (await initRes.json()) as { expiresAtMs: number };

    return jsonResponse({
      roomCode,
      secret,
      invite: `${roomCode}:${secret}`,
      wsUrl,
      expiresAtMs: initData.expiresAtMs,
    });
  }

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
      return handleRoomStatus(env, apiRoomCode);
    }

    // GET /ws/:code — WebSocket upgrade
    const roomCode = extractRoomCode(url.pathname);
    if (roomCode !== null) {
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }
      return handleWebSocketUpgrade(request, env, roomCode);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
