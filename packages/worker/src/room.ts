/**
 * Room Durable Object — manages a single watch-party room.
 *
 * Handles WebSocket connections with hibernation API, authentication,
 * message relay, presence notifications, session replacement, and expiry.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.js";

// ── Constants ───────────────────────────────────────────────────

/** 24 hours in milliseconds. */
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

/** Time allowed for a client to send auth after connecting. */
const AUTH_TIMEOUT_MS = 10_000;

/** Room code: 6 chars from human-friendly alphabet. */
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const MAX_MESSAGE_SIZE_BYTES = 8192;
const PROTOCOL_VERSION = 1;
const MAX_PARTICIPANTS = 2;

/** Duration tolerance for file mismatch detection (5 seconds). */
const FILE_DURATION_TOLERANCE_MS = 5000;

/** Message types that get relayed to the peer as-is. */
const RELAY_TYPES: ReadonlySet<string> = new Set([
  "play",
  "pause",
  "seek",
  "speed",
  "heartbeat",
  "state",
  "warning",
  "goodbye",
]);

// ── Types ───────────────────────────────────────────────────────

/** File metadata sent during auth. */
interface FileMetadata {
  name?: string;
  durationMs?: number;
  sizeBytes?: number;
}

/** Metadata attached to each WebSocket via serializeAttachment. */
interface WsAttachment {
  authenticated: boolean;
  sessionId: string;
  role: string;
  connectedAtMs: number;
  file?: FileMetadata;
}

function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i++) {
    if (!ROOM_CODE_ALPHABET.includes(code[i])) return false;
  }
  return true;
}

// ── Logging ─────────────────────────────────────────────────────

function roomLog(level: "info" | "warn" | "error", message: string, ctx?: Record<string, unknown>) {
  const entry = ctx ? `${message} ${JSON.stringify(ctx)}` : message;
  switch (level) {
    case "info":
      console.log(`[room] ${entry}`);
      break;
    case "warn":
      console.warn(`[room] ${entry}`);
      break;
    case "error":
      console.error(`[room] ${entry}`);
      break;
  }
}

// ── Durable Object ──────────────────────────────────────────────

export class Room extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS room_meta (
        room_code TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS participants (
        session_id TEXT PRIMARY KEY,
        role TEXT NOT NULL
      )`,
    );
  }

  // ── HTTP Router ─────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      return this.handleInit(request);
    }

    if (url.pathname === "/status" && request.method === "GET") {
      return this.handleStatus();
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade();
    }

    return new Response("Not Found", { status: 404 });
  }

  // ── WebSocket Hibernation Handlers ──────────────────────────

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // Reject binary messages
    if (typeof message !== "string") {
      roomLog("warn", "Rejected binary message");
      this.sendServerMessage(ws, "error", {
        code: "invalid-format",
        message: "Binary messages not supported",
      });
      return;
    }

    // Size check
    if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_SIZE_BYTES) {
      roomLog("warn", "Rejected oversized message", {
        bytes: new TextEncoder().encode(message).byteLength,
      });
      this.sendServerMessage(ws, "error", {
        code: "message-too-large",
        message: `Exceeds ${MAX_MESSAGE_SIZE_BYTES} bytes`,
      });
      return;
    }

    // Parse JSON
    let parsed: Record<string, unknown>;
    try {
      const raw = JSON.parse(message);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        this.sendServerMessage(ws, "error", {
          code: "invalid-format",
          message: "Must be a JSON object",
        });
        return;
      }
      parsed = raw;
    } catch {
      roomLog("warn", "Rejected invalid JSON");
      this.sendServerMessage(ws, "error", {
        code: "invalid-json",
        message: "Invalid JSON",
      });
      return;
    }

    const att = this.getAttachment(ws);

    // Unauthenticated — must send auth first
    if (!att.authenticated) {
      if (parsed.type === "auth") {
        await this.handleAuth(ws, parsed, att);
      } else {
        roomLog("warn", "Rejected unauthenticated message", { type: parsed.type });
        this.sendServerMessage(ws, "auth-error", {
          code: "not-authenticated",
          message: "First message must be auth",
        });
        ws.close(4001, "Not authenticated");
      }
      return;
    }

    // Authenticated — validate message type
    const type = parsed.type;
    if (typeof type !== "string" || !RELAY_TYPES.has(type)) {
      this.sendServerMessage(ws, "error", {
        code: "invalid-type",
        message: "Invalid or non-relayable message type",
      });
      return;
    }

    // Goodbye: relay, notify, remove participant, close
    if (type === "goodbye") {
      this.relayToPeer(ws, message);
      this.notifyPeerLeft(ws);
      if (att.sessionId) {
        this.ctx.storage.sql.exec(
          "DELETE FROM participants WHERE session_id = ?",
          att.sessionId,
        );
      }
      ws.close(1000, "Goodbye");
      return;
    }

    // Relay all other valid types
    this.relayToPeer(ws, message);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const att = this.getAttachment(ws);
    roomLog("info", "WebSocket closed", { sessionId: att.sessionId, code, reason });
    if (att.authenticated) {
      this.notifyPeerLeft(ws);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const att = this.getAttachment(ws);
    roomLog("error", "WebSocket error", {
      sessionId: att.sessionId,
      error: String(error),
    });
    if (att.authenticated) {
      this.notifyPeerLeft(ws);
    }
    try {
      ws.close(1011, "WebSocket error");
    } catch {
      // Already closed
    }
  }

  // ── Alarm ────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    const now = Date.now();

    // Close unauthenticated sockets past auth timeout
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAttachment(ws);
      if (
        !att.authenticated &&
        att.connectedAtMs > 0 &&
        now - att.connectedAtMs >= AUTH_TIMEOUT_MS
      ) {
        roomLog("warn", "Auth timeout", { sessionId: att.sessionId });
        this.sendServerMessage(ws, "error", {
          code: "auth-timeout",
          message: "Authentication timed out",
        });
        ws.close(4001, "Auth timeout");
      }
    }

    // Check room expiry
    const rows = this.ctx.storage.sql
      .exec("SELECT expires_at_ms FROM room_meta LIMIT 1")
      .toArray();

    if (rows.length > 0 && now >= (rows[0].expires_at_ms as number)) {
      roomLog("info", "Room expired, cleaning up");
      for (const ws of this.ctx.getWebSockets()) {
        this.sendServerMessage(ws, "error", {
          code: "room-expired",
          message: "Room has expired",
        });
        ws.close(4002, "Room expired");
      }
      this.ctx.storage.deleteAll();
      return;
    }

    // Reschedule for remaining deadlines
    await this.scheduleNextAlarm();
  }

  // ── Internal Route Handlers ──────────────────────────────────

  /**
   * Accept a WebSocket upgrade. Checks that the room exists and is not expired.
   * Starts auth timeout via alarm.
   */
  private async handleWebSocketUpgrade(): Promise<Response> {
    const rows = this.ctx.storage.sql
      .exec("SELECT expires_at_ms FROM room_meta LIMIT 1")
      .toArray();

    if (rows.length === 0) {
      return jsonResponse({ error: "Room not found" }, 404);
    }

    if (Date.now() >= (rows[0].expires_at_ms as number)) {
      return jsonResponse({ error: "Room expired" }, 410);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      authenticated: false,
      sessionId: "",
      role: "",
      connectedAtMs: Date.now(),
    } satisfies WsAttachment);

    await this.scheduleNextAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Handle an auth message from an unauthenticated WebSocket.
   * Verifies secret, assigns/restores role, handles replacement.
   */
  private async handleAuth(
    ws: WebSocket,
    parsed: Record<string, unknown>,
    att: WsAttachment,
  ): Promise<void> {
    // Validate required fields
    if (typeof parsed.secret !== "string" || parsed.secret === "") {
      roomLog("warn", "Auth rejected: missing secret");
      this.sendServerMessage(ws, "auth-error", {
        code: "missing-secret",
        message: "Secret is required",
      });
      ws.close(4003, "Missing secret");
      return;
    }

    if (typeof parsed.sessionId !== "string" || parsed.sessionId === "") {
      roomLog("warn", "Auth rejected: missing sessionId");
      this.sendServerMessage(ws, "auth-error", {
        code: "missing-session-id",
        message: "sessionId is required",
      });
      ws.close(4003, "Missing sessionId");
      return;
    }

    // Fetch room metadata
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT room_code, secret_hash, expires_at_ms FROM room_meta LIMIT 1",
      )
      .toArray();

    if (rows.length === 0) {
      roomLog("warn", "Auth rejected: room not found");
      this.sendServerMessage(ws, "auth-error", {
        code: "room-not-found",
        message: "Room not found",
      });
      ws.close(4004, "Room not found");
      return;
    }

    const roomCode = rows[0].room_code as string;
    const storedHash = rows[0].secret_hash as string;
    const expiresAtMs = rows[0].expires_at_ms as number;

    if (Date.now() >= expiresAtMs) {
      roomLog("warn", "Auth rejected: room expired", { roomCode });
      this.sendServerMessage(ws, "auth-error", {
        code: "room-expired",
        message: "Room has expired",
      });
      ws.close(4002, "Room expired");
      return;
    }

    // Verify secret hash
    const hashHex = await this.hashSecret(parsed.secret as string);
    if (hashHex !== storedHash) {
      roomLog("warn", "Auth rejected: invalid secret", { roomCode });
      this.sendServerMessage(ws, "auth-error", {
        code: "invalid-secret",
        message: "Invalid secret",
      });
      ws.close(4003, "Invalid secret");
      return;
    }

    const sessionId = parsed.sessionId as string;

    // Extract file metadata from auth message
    const rawFile =
      typeof parsed.file === "object" && parsed.file !== null && !Array.isArray(parsed.file)
        ? (parsed.file as Record<string, unknown>)
        : {};
    const file: FileMetadata = {
      name: typeof rawFile.name === "string" ? rawFile.name : undefined,
      durationMs: typeof rawFile.durationMs === "number" ? rawFile.durationMs : undefined,
      sizeBytes: typeof rawFile.sizeBytes === "number" ? rawFile.sizeBytes : undefined,
    };

    // Check if this sessionId is a known participant (reconnection)
    const existingRows = this.ctx.storage.sql
      .exec("SELECT role FROM participants WHERE session_id = ?", sessionId)
      .toArray();

    // Get currently connected authenticated peers (excluding this socket)
    const connectedPeers = this.getAuthenticatedPeers(ws);

    if (existingRows.length > 0) {
      // Reconnection — restore stored role
      const role = existingRows[0].role as string;

      // Replace stale socket with same sessionId if still connected
      const staleIdx = connectedPeers.findIndex(
        (p) => p.att.sessionId === sessionId,
      );
      let wasReplaced = false;
      if (staleIdx >= 0) {
        connectedPeers[staleIdx].ws.close(4000, "Replaced by new connection");
        connectedPeers.splice(staleIdx, 1);
        wasReplaced = true;
      }

      this.setAuthenticated(ws, att, sessionId, role, file);
      const peerPresent = connectedPeers.length > 0;

      roomLog("info", "Auth OK (reconnect)", {
        roomCode,
        sessionId,
        role,
        replaced: wasReplaced,
      });

      this.sendServerMessage(ws, "auth-ok", {
        role,
        roomCode,
        expiresAtMs,
        peerPresent,
      });

      if (peerPresent) {
        this.sendServerMessage(connectedPeers[0].ws, "presence", {
          event: wasReplaced ? "peer-replaced" : "peer-joined",
          role,
        });
        this.checkAndWarnFileMismatch(ws, connectedPeers[0].ws);
      }
      return;
    }

    // New participant — check capacity
    const participantCount = this.ctx.storage.sql
      .exec("SELECT COUNT(*) as cnt FROM participants")
      .toArray()[0].cnt as number;

    if (participantCount >= MAX_PARTICIPANTS) {
      roomLog("warn", "Auth rejected: room full", { roomCode, sessionId });
      this.sendServerMessage(ws, "auth-error", {
        code: "room-full",
        message: "Room already has two participants",
      });
      ws.close(4005, "Room full");
      return;
    }

    // Assign role: first = host, second = guest
    const role = participantCount === 0 ? "host" : "guest";

    // Register in participants table
    this.ctx.storage.sql.exec(
      "INSERT INTO participants (session_id, role) VALUES (?, ?)",
      sessionId,
      role,
    );

    this.setAuthenticated(ws, att, sessionId, role, file);
    const peerPresent = connectedPeers.length > 0;

    roomLog("info", "Auth OK (new)", { roomCode, sessionId, role });

    this.sendServerMessage(ws, "auth-ok", {
      role,
      roomCode,
      expiresAtMs,
      peerPresent,
    });

    if (peerPresent) {
      this.sendServerMessage(connectedPeers[0].ws, "presence", {
        event: "peer-joined",
        role,
      });
      this.checkAndWarnFileMismatch(ws, connectedPeers[0].ws);
    }
  }

  /**
   * Initialize the room. Stores the room code and a SHA-256 hash of the secret.
   * Returns 409 if the room is already initialized (code collision).
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

    if (typeof roomCode !== "string" || !isValidRoomCode(roomCode)) {
      return jsonResponse({ error: "Invalid room code format" }, 400);
    }

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
      this.ctx.storage.sql.exec("DELETE FROM participants");
    }

    const secretHash = await this.hashSecret(secret);
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

    await this.ctx.storage.setAlarm(expiresAtMs);

    roomLog("info", "Room initialized", { roomCode, expiresAtMs });
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

  // ── Helpers ──────────────────────────────────────────────────

  private getAttachment(ws: WebSocket): WsAttachment {
    return (ws.deserializeAttachment() ?? {
      authenticated: false,
      sessionId: "",
      role: "",
      connectedAtMs: 0,
    }) as WsAttachment;
  }

  private setAuthenticated(
    ws: WebSocket,
    att: WsAttachment,
    sessionId: string,
    role: string,
    file?: FileMetadata,
  ): void {
    ws.serializeAttachment({
      ...att,
      authenticated: true,
      sessionId,
      role,
      file,
    } satisfies WsAttachment);
  }

  private getAuthenticatedPeers(
    excludeWs: WebSocket,
  ): { ws: WebSocket; att: WsAttachment }[] {
    const peers: { ws: WebSocket; att: WsAttachment }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      const att = this.getAttachment(ws);
      if (att.authenticated) {
        peers.push({ ws, att });
      }
    }
    return peers;
  }

  /**
   * Compare file metadata between two peers and send a file-mismatch warning
   * to both if they appear to be watching different files.
   */
  private checkAndWarnFileMismatch(wsA: WebSocket, wsB: WebSocket): void {
    const fileA = this.getAttachment(wsA).file;
    const fileB = this.getAttachment(wsB).file;
    if (!fileA || !fileB) return;

    const reasons: string[] = [];

    // Duration comparison — primary signal
    if (fileA.durationMs != null && fileB.durationMs != null) {
      const diff = Math.abs(fileA.durationMs - fileB.durationMs);
      if (diff > FILE_DURATION_TOLERANCE_MS) {
        reasons.push(`duration differs by ${Math.round(diff / 1000)}s`);
      }
    }

    // Filename comparison — secondary signal
    if (
      fileA.name != null && fileB.name != null &&
      fileA.name !== "" && fileB.name !== "" &&
      fileA.name !== fileB.name
    ) {
      reasons.push("filenames differ");
    }

    if (reasons.length === 0) return;

    const message = `File mismatch: ${reasons.join(", ")}`;
    this.sendServerMessage(wsA, "warning", { code: "file-mismatch", message });
    this.sendServerMessage(wsB, "warning", { code: "file-mismatch", message });
  }

  private relayToPeer(fromWs: WebSocket, message: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === fromWs) continue;
      const att = this.getAttachment(ws);
      if (att.authenticated) {
        ws.send(message);
      }
    }
  }

  private notifyPeerLeft(closedWs: WebSocket): void {
    const closedAtt = this.getAttachment(closedWs);
    if (!closedAtt.authenticated) return;

    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closedWs) continue;
      const att = this.getAttachment(ws);
      if (att.authenticated) {
        this.sendServerMessage(ws, "presence", {
          event: "peer-left",
          role: closedAtt.role,
        });
      }
    }
  }

  private sendServerMessage(
    ws: WebSocket,
    type: string,
    fields: Record<string, unknown>,
  ): void {
    try {
      ws.send(
        JSON.stringify({
          type,
          protocolVersion: PROTOCOL_VERSION,
          sessionId: "server",
          messageId: crypto.randomUUID(),
          tsMs: Date.now(),
          ...fields,
        }),
      );
    } catch {
      // Socket may already be closed
    }
  }

  private async hashSecret(secret: string): Promise<string> {
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(secret),
    );
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async scheduleNextAlarm(): Promise<void> {
    const deadlines: number[] = [];

    const rows = this.ctx.storage.sql
      .exec("SELECT expires_at_ms FROM room_meta LIMIT 1")
      .toArray();
    if (rows.length > 0) {
      deadlines.push(rows[0].expires_at_ms as number);
    }

    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAttachment(ws);
      if (!att.authenticated && att.connectedAtMs > 0) {
        deadlines.push(att.connectedAtMs + AUTH_TIMEOUT_MS);
      }
    }

    if (deadlines.length > 0) {
      const next = Math.min(...deadlines);
      await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 100));
    }
  }
}

// ── Module helpers ──────────────────────────────────────────────

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
