/**
 * Invite string parsing and formatting.
 *
 * Invite format: `ROOMCODE:base64url_secret`
 * - Room code: 6 uppercase characters from a human-friendly alphabet
 * - Separator: colon
 * - Secret: non-empty base64url string
 */

import { ROOM_CODE_LENGTH } from "./constants.js";

// Human-friendly alphabet excluding ambiguous characters (0/O, 1/I/L)
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const ROOM_CODE_PATTERN = new RegExp(
  `^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`,
);

// base64url: A-Z, a-z, 0-9, -, _ (no padding required)
const BASE64URL_PATTERN = /^[A-Za-z0-9\-_]+=*$/;

export interface ParsedInvite {
  roomCode: string;
  secret: string;
}

export type InviteParseResult =
  | { ok: true; invite: ParsedInvite }
  | { ok: false; error: string };

/**
 * Parse a raw invite string into room code and secret.
 *
 * Accepts the combined format `ROOMCODE:secret` as primary input.
 * Whitespace is trimmed before parsing.
 */
export function parseInvite(raw: string): InviteParseResult {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: "Invite string is empty" };
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1) {
    return { ok: false, error: "Invalid invite format: missing colon separator" };
  }

  const roomCode = trimmed.slice(0, colonIndex);
  const secret = trimmed.slice(colonIndex + 1);

  const codeError = validateRoomCode(roomCode);
  if (codeError !== null) {
    return { ok: false, error: codeError };
  }

  const secretError = validateSecret(secret);
  if (secretError !== null) {
    return { ok: false, error: secretError };
  }

  return { ok: true, invite: { roomCode, secret } };
}

/**
 * Format a room code and secret into an invite string.
 */
export function formatInvite(roomCode: string, secret: string): string {
  return `${roomCode}:${secret}`;
}

/**
 * Validate a room code. Returns an error string or null if valid.
 */
export function validateRoomCode(code: string): string | null {
  if (code.length !== ROOM_CODE_LENGTH) {
    return `Room code must be exactly ${ROOM_CODE_LENGTH} characters, got ${code.length}`;
  }
  if (!ROOM_CODE_PATTERN.test(code)) {
    return "Room code contains invalid characters";
  }
  return null;
}

/**
 * Validate a secret. Returns an error string or null if valid.
 */
function validateSecret(secret: string): string | null {
  if (secret.length === 0) {
    return "Secret is empty";
  }
  if (!BASE64URL_PATTERN.test(secret)) {
    return "Secret contains invalid characters (expected base64url)";
  }
  return null;
}

export { ROOM_CODE_ALPHABET };
