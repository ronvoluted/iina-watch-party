import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, MAX_MESSAGE_SIZE_BYTES, ROOM_CODE_LENGTH } from "./constants.js";

describe("protocol constants", () => {
  test("PROTOCOL_VERSION is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  test("MAX_MESSAGE_SIZE_BYTES is 8 KB", () => {
    expect(MAX_MESSAGE_SIZE_BYTES).toBe(8192);
  });

  test("ROOM_CODE_LENGTH is 6", () => {
    expect(ROOM_CODE_LENGTH).toBe(6);
  });
});
