/**
 * Protocol v1 type definitions.
 *
 * All messages share a common envelope and are distinguished by the `type` field
 * (discriminated union). See PRD §11 for the full specification.
 */

import { PROTOCOL_VERSION } from "./constants.js";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface MessageEnvelope {
  type: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  messageId: string;
  tsMs: number;
}

// ---------------------------------------------------------------------------
// Roles & events
// ---------------------------------------------------------------------------

export type Role = "host" | "guest";
export type PresenceEvent = "peer-joined" | "peer-left" | "peer-replaced";
export type SeekCause = "user" | "drift-correction";
export type StateReason = "initial" | "reconnect" | "manual";
export type WarningCode = "file-mismatch" | "peer-buffering" | "room-expiring";

// ---------------------------------------------------------------------------
// File metadata (sent during auth)
// ---------------------------------------------------------------------------

export interface FileMetadata {
  name?: string;
  durationMs?: number;
  sizeBytes?: number;
}

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export interface AuthMessage extends MessageEnvelope {
  type: "auth";
  secret: string;
  displayName?: string;
  desiredRole?: Role;
  file: FileMetadata;
}

export interface PlayMessage extends MessageEnvelope {
  type: "play";
  positionMs: number;
}

export interface PauseMessage extends MessageEnvelope {
  type: "pause";
  positionMs: number;
}

export interface SeekMessage extends MessageEnvelope {
  type: "seek";
  positionMs: number;
  cause: SeekCause;
}

export interface SpeedMessage extends MessageEnvelope {
  type: "speed";
  speed: number;
}

export interface HeartbeatMessage extends MessageEnvelope {
  type: "heartbeat";
  positionMs: number;
  paused: boolean;
  speed: number;
  buffering?: boolean;
  seeking?: boolean;
}

export interface GoodbyeMessage extends MessageEnvelope {
  type: "goodbye";
  reason: string;
}

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export interface AuthOkMessage extends MessageEnvelope {
  type: "auth-ok";
  role: Role;
  roomCode: string;
  expiresAtMs: number;
  peerPresent: boolean;
}

export interface AuthErrorMessage extends MessageEnvelope {
  type: "auth-error";
  code: string;
  message: string;
}

export interface PresenceMessage extends MessageEnvelope {
  type: "presence";
  event: PresenceEvent;
  role: Role;
}

export interface StateMessage extends MessageEnvelope {
  type: "state";
  reason: StateReason;
  positionMs: number;
  paused: boolean;
  speed: number;
  buffering?: boolean;
}

export interface WarningMessage extends MessageEnvelope {
  type: "warning";
  code: WarningCode;
  message: string;
}

export interface ErrorMessage extends MessageEnvelope {
  type: "error";
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type ProtocolMessage =
  | AuthMessage
  | AuthOkMessage
  | AuthErrorMessage
  | PresenceMessage
  | StateMessage
  | PlayMessage
  | PauseMessage
  | SeekMessage
  | SpeedMessage
  | HeartbeatMessage
  | WarningMessage
  | GoodbyeMessage
  | ErrorMessage;

export type MessageType = ProtocolMessage["type"];

export const MESSAGE_TYPES: readonly MessageType[] = [
  "auth",
  "auth-ok",
  "auth-error",
  "presence",
  "state",
  "play",
  "pause",
  "seek",
  "speed",
  "heartbeat",
  "warning",
  "goodbye",
  "error",
] as const;
