/**
 * @iina-watch-party/shared
 *
 * Protocol types, runtime validation, sync state machine, and shared utilities.
 */

export { PROTOCOL_VERSION, MAX_MESSAGE_SIZE_BYTES, ROOM_CODE_LENGTH } from "./constants.js";

export type {
  MessageEnvelope,
  Role,
  PresenceEvent,
  SeekCause,
  StateReason,
  WarningCode,
  FileMetadata,
  AuthMessage,
  AuthOkMessage,
  AuthErrorMessage,
  PresenceMessage,
  StateMessage,
  PlayMessage,
  PauseMessage,
  SeekMessage,
  SpeedMessage,
  HeartbeatMessage,
  WarningMessage,
  GoodbyeMessage,
  ErrorMessage,
  ProtocolMessage,
  MessageType,
} from "./types.js";

export { MESSAGE_TYPES } from "./types.js";

export { validateMessage, type ValidationResult } from "./validation.js";

export {
  parseInvite,
  formatInvite,
  validateRoomCode,
  ROOM_CODE_ALPHABET,
  type ParsedInvite,
  type InviteParseResult,
} from "./invite.js";
