import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, MAX_MESSAGE_SIZE_BYTES, ROOM_CODE_LENGTH, MAX_PARTICIPANTS } from "./constants.js";

describe("protocol constants", () => {
  test("PROTOCOL_VERSION is 2", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  test("MAX_PARTICIPANTS is 8", () => {
    expect(MAX_PARTICIPANTS).toBe(8);
  });

  test("MAX_MESSAGE_SIZE_BYTES is 8 KB", () => {
    expect(MAX_MESSAGE_SIZE_BYTES).toBe(8192);
  });

  test("ROOM_CODE_LENGTH is 6", () => {
    expect(ROOM_CODE_LENGTH).toBe(6);
  });
});
