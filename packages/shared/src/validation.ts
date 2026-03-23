/**
 * Runtime validation for protocol messages received as unknown JSON.
 *
 * Every public function returns a `ValidationResult`: either a typed message
 * or a human-readable error string. No exceptions are thrown for bad input.
 */

import { MAX_MESSAGE_SIZE_BYTES, PROTOCOL_VERSION } from "./constants.js";
import {
  MESSAGE_TYPES,
  type MessageType,
  type ProtocolMessage,
} from "./types.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true; message: ProtocolMessage }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw WebSocket payload into a typed `ProtocolMessage`.
 *
 * Checks, in order:
 *  1. Payload is a string (not binary).
 *  2. Payload size ≤ MAX_MESSAGE_SIZE_BYTES.
 *  3. Payload is valid JSON.
 *  4. Envelope fields are present and well-typed.
 *  5. Message-specific fields pass validation.
 */
export function validateMessage(raw: unknown): ValidationResult {
  if (typeof raw !== "string") {
    return fail("payload must be a string");
  }

  // Size check (byte length, not char length)
  const byteLength = new TextEncoder().encode(raw).byteLength;
  if (byteLength > MAX_MESSAGE_SIZE_BYTES) {
    return fail(
      `message exceeds max size (${byteLength} > ${MAX_MESSAGE_SIZE_BYTES})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("invalid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("payload must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  // Envelope validation
  const envelopeErr = validateEnvelope(obj);
  if (envelopeErr) return fail(envelopeErr);

  // Type-specific validation
  const type = obj.type as MessageType;
  const bodyErr = validateBody(type, obj);
  if (bodyErr) return fail(bodyErr);

  return { ok: true, message: obj as unknown as ProtocolMessage };
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

function validateEnvelope(obj: Record<string, unknown>): string | null {
  if (typeof obj.type !== "string") return "missing or invalid field: type";

  if (!MESSAGE_TYPES.includes(obj.type as MessageType)) {
    return `unknown message type: ${obj.type}`;
  }

  if (obj.protocolVersion !== PROTOCOL_VERSION) {
    return `unsupported protocolVersion: ${String(obj.protocolVersion)}`;
  }

  if (typeof obj.sessionId !== "string" || obj.sessionId === "") {
    return "missing or invalid field: sessionId";
  }

  if (typeof obj.messageId !== "string" || obj.messageId === "") {
    return "missing or invalid field: messageId";
  }

  if (!isFinitePositiveNumber(obj.tsMs)) {
    return "missing or invalid field: tsMs";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Body validators (per message type)
// ---------------------------------------------------------------------------

function validateBody(
  type: MessageType,
  obj: Record<string, unknown>,
): string | null {
  switch (type) {
    case "auth":
      return validateAuth(obj);
    case "auth-ok":
      return validateAuthOk(obj);
    case "auth-error":
      return validateCodeMessage(obj);
    case "presence":
      return validatePresence(obj);
    case "state":
      return validateState(obj);
    case "play":
    case "pause":
      return requirePositionMs(obj);
    case "seek":
      return validateSeek(obj);
    case "speed":
      return requireSpeed(obj);
    case "heartbeat":
      return validateHeartbeat(obj);
    case "warning":
      return validateWarning(obj);
    case "goodbye":
      return validateGoodbye(obj);
    case "error":
      return validateCodeMessage(obj);
  }
}

// ---------------------------------------------------------------------------
// Individual validators
// ---------------------------------------------------------------------------

function validateAuth(obj: Record<string, unknown>): string | null {
  if (typeof obj.secret !== "string" || obj.secret === "") {
    return "missing or invalid field: secret";
  }

  if (obj.displayName !== undefined && typeof obj.displayName !== "string") {
    return "invalid field: displayName";
  }

  if (
    obj.desiredRole !== undefined &&
    obj.desiredRole !== "host" &&
    obj.desiredRole !== "guest"
  ) {
    return "invalid field: desiredRole";
  }

  if (typeof obj.file !== "object" || obj.file === null || Array.isArray(obj.file)) {
    return "missing or invalid field: file";
  }

  const file = obj.file as Record<string, unknown>;

  if (file.name !== undefined && typeof file.name !== "string") {
    return "invalid field: file.name";
  }
  if (file.durationMs !== undefined && !isNonNegativeFinite(file.durationMs)) {
    return "invalid field: file.durationMs";
  }
  if (file.sizeBytes !== undefined && !isNonNegativeFinite(file.sizeBytes)) {
    return "invalid field: file.sizeBytes";
  }

  return null;
}

function validateAuthOk(obj: Record<string, unknown>): string | null {
  if (obj.role !== "host" && obj.role !== "guest") {
    return "missing or invalid field: role";
  }
  if (typeof obj.roomCode !== "string" || obj.roomCode === "") {
    return "missing or invalid field: roomCode";
  }
  if (!isFinitePositiveNumber(obj.expiresAtMs)) {
    return "missing or invalid field: expiresAtMs";
  }
  if (typeof obj.peerPresent !== "boolean") {
    return "missing or invalid field: peerPresent";
  }
  return null;
}

function validateCodeMessage(obj: Record<string, unknown>): string | null {
  if (typeof obj.code !== "string" || obj.code === "") {
    return "missing or invalid field: code";
  }
  if (typeof obj.message !== "string") {
    return "missing or invalid field: message";
  }
  return null;
}

function validatePresence(obj: Record<string, unknown>): string | null {
  const validEvents = ["peer-joined", "peer-left", "peer-replaced"];
  if (typeof obj.event !== "string" || !validEvents.includes(obj.event)) {
    return "missing or invalid field: event";
  }
  if (obj.role !== "host" && obj.role !== "guest") {
    return "missing or invalid field: role";
  }
  return null;
}

function validateState(obj: Record<string, unknown>): string | null {
  const validReasons = ["initial", "reconnect", "manual"];
  if (typeof obj.reason !== "string" || !validReasons.includes(obj.reason)) {
    return "missing or invalid field: reason";
  }
  const posErr = requirePositionMs(obj);
  if (posErr) return posErr;
  if (typeof obj.paused !== "boolean") {
    return "missing or invalid field: paused";
  }
  const speedErr = requireSpeed(obj);
  if (speedErr) return speedErr;
  if (obj.buffering !== undefined && typeof obj.buffering !== "boolean") {
    return "invalid field: buffering";
  }
  return null;
}

function validateSeek(obj: Record<string, unknown>): string | null {
  const posErr = requirePositionMs(obj);
  if (posErr) return posErr;
  if (obj.cause !== "user" && obj.cause !== "drift-correction") {
    return "missing or invalid field: cause";
  }
  return null;
}

function validateHeartbeat(obj: Record<string, unknown>): string | null {
  const posErr = requirePositionMs(obj);
  if (posErr) return posErr;
  if (typeof obj.paused !== "boolean") {
    return "missing or invalid field: paused";
  }
  const speedErr = requireSpeed(obj);
  if (speedErr) return speedErr;
  if (obj.buffering !== undefined && typeof obj.buffering !== "boolean") {
    return "invalid field: buffering";
  }
  if (obj.seeking !== undefined && typeof obj.seeking !== "boolean") {
    return "invalid field: seeking";
  }
  return null;
}

function validateWarning(obj: Record<string, unknown>): string | null {
  const validCodes = ["file-mismatch", "peer-buffering", "room-expiring"];
  if (typeof obj.code !== "string" || !validCodes.includes(obj.code)) {
    return "missing or invalid field: code";
  }
  if (typeof obj.message !== "string") {
    return "missing or invalid field: message";
  }
  return null;
}

function validateGoodbye(obj: Record<string, unknown>): string | null {
  if (typeof obj.reason !== "string") {
    return "missing or invalid field: reason";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared field helpers
// ---------------------------------------------------------------------------

function requirePositionMs(obj: Record<string, unknown>): string | null {
  if (!isNonNegativeFinite(obj.positionMs)) {
    return "missing or invalid field: positionMs";
  }
  return null;
}

function requireSpeed(obj: Record<string, unknown>): string | null {
  if (
    typeof obj.speed !== "number" ||
    !Number.isFinite(obj.speed) ||
    obj.speed <= 0
  ) {
    return "missing or invalid field: speed";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function isFinitePositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isNonNegativeFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(error: string): ValidationResult {
  return { ok: false, error };
}
