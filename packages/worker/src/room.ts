/**
 * Room Durable Object — manages a single watch-party room.
 * SQLite-backed per PRD requirement.
 */

import { DurableObject } from "cloudflare:workers";

/** 24 hours in milliseconds. */
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

/** Room code: 6 chars from human-friendly alphabet. */
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i++) {
    if (!ROOM_CODE_ALPHABET.includes(code[i])) return false;
  }
  return true;
}

export class Room extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    // Ensure schema exists on first instantiation
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS room_meta (
        room_code TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      )`,
    );
  }

  /**
   * Handle incoming requests routed from the Worker.
   *
   * Internal routes (called by the Worker, not exposed externally):
   *   POST /init — Initialize a new room with code and secret hash.
   *   GET /status — Check if the room exists and is not expired.
   *
   * External routes (forwarded from the Worker):
   *   WebSocket upgrade — Join the room as host or guest.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      return this.handleInit(request);
    }

    if (url.pathname === "/status" && request.method === "GET") {
      return this.handleStatus();
    }

    // WebSocket upgrade will be implemented in the Durable Object auth/relay phase
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      return new Response("WebSocket handler not yet implemented", {
        status: 501,
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * Initialize the room. Stores the room code and a SHA-256 hash of the secret.
   * Returns 409 if the room is already initialized (code collision).
   * Returns 400 if inputs are invalid.
   */
  private async handleInit(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonResponse({ error: "Request body must be a JSON object" }, 400);
    }

    const { roomCode, secret } = body as {
      roomCode: unknown;
      secret: unknown;
    };

    // Validate roomCode
    if (typeof roomCode !== "string" || !isValidRoomCode(roomCode)) {
      return jsonResponse({ error: "Invalid room code format" }, 400);
    }

    // Validate secret
    if (typeof secret !== "string" || secret.length === 0) {
      return jsonResponse({ error: "Secret is required" }, 400);
    }

    // Check if already initialized (not expired)
    const existing = this.ctx.storage.sql
      .exec("SELECT room_code, expires_at_ms FROM room_meta LIMIT 1")
      .toArray();

    if (existing.length > 0) {
      const expiresAtMs = existing[0].expires_at_ms as number;
      if (Date.now() < expiresAtMs) {
        return jsonResponse({ error: "Room already exists" }, 409);
      }
      // Room expired but alarm hasn't fired yet — clean up and allow reuse
      this.ctx.storage.sql.exec("DELETE FROM room_meta");
    }

    // Hash the secret
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(secret),
    );
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const secretHash = hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const now = Date.now();
    const expiresAtMs = now + ROOM_TTL_MS;

    this.ctx.storage.sql.exec(
      `INSERT INTO room_meta (room_code, secret_hash, created_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?)`,
      roomCode,
      secretHash,
      now,
      expiresAtMs,
    );

    // Schedule alarm for room expiry
    await this.ctx.storage.setAlarm(expiresAtMs);

    return jsonResponse({ expiresAtMs });
  }

  /**
   * Return room status. Used to check if a room exists and is not expired.
   */
  private handleStatus(): Response {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT room_code, created_at_ms, expires_at_ms FROM room_meta LIMIT 1",
      )
      .toArray();

    if (rows.length === 0) {
      return jsonResponse({ exists: false }, 404);
    }

    const row = rows[0];
    const expiresAtMs = row.expires_at_ms as number;

    if (Date.now() >= expiresAtMs) {
      return jsonResponse({ exists: false, reason: "expired" }, 404);
    }

    return jsonResponse({
      exists: true,
      roomCode: row.room_code,
      createdAtMs: row.created_at_ms,
      expiresAtMs,
    });
  }

  /**
   * Alarm handler — clean up expired rooms.
   */
  async alarm(): Promise<void> {
    this.ctx.storage.deleteAll();
  }
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
