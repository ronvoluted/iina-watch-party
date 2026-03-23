/** Protocol version. Bumped on breaking wire-format changes. */
export const PROTOCOL_VERSION = 2;

/** Maximum allowed message size in bytes (8 KB). */
export const MAX_MESSAGE_SIZE_BYTES = 8192;

/** Length of a room code. */
export const ROOM_CODE_LENGTH = 6;

/** Maximum number of participants per room. */
export const MAX_PARTICIPANTS = 8;
