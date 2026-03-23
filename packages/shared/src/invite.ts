/**
 * Invite string parsing and formatting.
 *
 * Invite format: a 6-character room code from a human-friendly alphabet.
 * No secret — the room code alone is sufficient for joining.
 */

import { ROOM_CODE_LENGTH } from "./constants.js";

// Human-friendly alphabet excluding ambiguous characters (0/O, 1/I/L)
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const ROOM_CODE_PATTERN = new RegExp(
  `^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`,
);

export interface ParsedInvite {
  roomCode: string;
}

export type InviteParseResult =
  | { ok: true; invite: ParsedInvite }
  | { ok: false; error: string };

/**
 * Parse a raw invite string into a room code.
 *
 * Accepts a bare room code (6 characters). Also accepts the legacy
 * `ROOMCODE:secret` format for backwards compatibility — the secret
 * portion is silently discarded.
 *
 * Whitespace is trimmed before parsing.
 */
export function parseInvite(raw: string): InviteParseResult {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: "Invite string is empty" };
  }

  // Support legacy format: strip anything after a colon
  const roomCode = trimmed.includes(":")
    ? trimmed.slice(0, trimmed.indexOf(":"))
    : trimmed;

  const codeError = validateRoomCode(roomCode);
  if (codeError !== null) {
    return { ok: false, error: codeError };
  }

  return { ok: true, invite: { roomCode } };
}

/**
 * Format a room code into an invite string.
 */
export function formatInvite(roomCode: string): string {
  return roomCode;
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

export { ROOM_CODE_ALPHABET };
