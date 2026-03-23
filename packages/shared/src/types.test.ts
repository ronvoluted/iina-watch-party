import { describe, expect, test } from "bun:test";
import { MESSAGE_TYPES } from "./types.js";

describe("MESSAGE_TYPES", () => {
  test("contains all 13 message types", () => {
    expect(MESSAGE_TYPES).toHaveLength(13);
  });

  test("includes all client → server types", () => {
    expect(MESSAGE_TYPES).toContain("auth");
    expect(MESSAGE_TYPES).toContain("play");
    expect(MESSAGE_TYPES).toContain("pause");
    expect(MESSAGE_TYPES).toContain("seek");
    expect(MESSAGE_TYPES).toContain("speed");
    expect(MESSAGE_TYPES).toContain("heartbeat");
    expect(MESSAGE_TYPES).toContain("goodbye");
  });

  test("includes all server → client types", () => {
    expect(MESSAGE_TYPES).toContain("auth-ok");
    expect(MESSAGE_TYPES).toContain("auth-error");
    expect(MESSAGE_TYPES).toContain("presence");
    expect(MESSAGE_TYPES).toContain("state");
    expect(MESSAGE_TYPES).toContain("warning");
    expect(MESSAGE_TYPES).toContain("error");
  });

  test("has no duplicates", () => {
    const unique = new Set(MESSAGE_TYPES);
    expect(unique.size).toBe(MESSAGE_TYPES.length);
  });
});
