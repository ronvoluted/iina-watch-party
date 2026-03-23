/**
 * Room Durable Object — manages a single watch-party room.
 * SQLite-backed per PRD requirement.
 */

import { DurableObject } from "cloudflare:workers";

/** 24 hours in milliseconds. */
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

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
   *
   * External routes (forwarded from the Worker):
   *   WebSocket upgrade — Join the room as host or guest.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      return this.handleInit(request);
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
   */
  private async handleInit(request: Request): Promise<Response> {
    const { roomCode, secret } = (await request.json()) as {
      roomCode: string;
      secret: string;
    };

    // Check if already initialized
    const existing = this.ctx.storage.sql
      .exec("SELECT room_code FROM room_meta LIMIT 1")
      .toArray();

    if (existing.length > 0) {
      return new Response(JSON.stringify({ error: "Room already exists" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }

    // Hash the secret
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(secret),
    );
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const secretHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

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

    return new Response(JSON.stringify({ expiresAtMs }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * Alarm handler — clean up expired rooms.
   */
  async alarm(): Promise<void> {
    this.ctx.storage.deleteAll();
  }
}
