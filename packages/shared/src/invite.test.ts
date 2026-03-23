import { describe, expect, test } from "bun:test";
import {
  parseInvite,
  formatInvite,
  validateRoomCode,
  ROOM_CODE_ALPHABET,
} from "./invite.js";
import { ROOM_CODE_LENGTH } from "./constants.js";

// ---------------------------------------------------------------------------
// parseInvite
// ---------------------------------------------------------------------------

describe("parseInvite", () => {
  test("parses a valid bare room code", () => {
    const result = parseInvite("ABCDEF");
    expect(result).toEqual({
      ok: true,
      invite: { roomCode: "ABCDEF" },
    });
  });

  test("trims surrounding whitespace", () => {
    const result = parseInvite("  ABCDEF  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invite.roomCode).toBe("ABCDEF");
    }
  });

  test("accepts legacy format with colon+secret (discards secret)", () => {
    const result = parseInvite("ABCDEF:c2VjcmV0");
    expect(result).toEqual({
      ok: true,
      invite: { roomCode: "ABCDEF" },
    });
  });

  test("accepts legacy format with padding in secret", () => {
    const result = parseInvite("HJKMNP:abc-def_ghi=");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invite.roomCode).toBe("HJKMNP");
    }
  });

  test("rejects empty string", () => {
    const result = parseInvite("");
    expect(result).toEqual({ ok: false, error: "Invite string is empty" });
  });

  test("rejects whitespace-only string", () => {
    const result = parseInvite("   ");
    expect(result).toEqual({ ok: false, error: "Invite string is empty" });
  });

  test("rejects room code that is too short", () => {
    const result = parseInvite("ABC");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exactly 6 characters");
    }
  });

  test("rejects room code that is too long", () => {
    const result = parseInvite("ABCDEFGH");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exactly 6 characters");
    }
  });

  test("rejects room code with ambiguous characters (0, O, 1, I, L)", () => {
    for (const bad of ["0", "O", "1", "I", "L"]) {
      const code = bad + "BCDEF";
      const result = parseInvite(code);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("invalid characters");
      }
    }
  });

  test("rejects lowercase room code", () => {
    const result = parseInvite("abcdef");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid characters");
    }
  });
});

// ---------------------------------------------------------------------------
// formatInvite
// ---------------------------------------------------------------------------

describe("formatInvite", () => {
  test("returns the room code as-is", () => {
    expect(formatInvite("ABCDEF")).toBe("ABCDEF");
  });

  test("round-trips with parseInvite", () => {
    const invite = formatInvite("HJKMNP");
    const result = parseInvite(invite);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invite.roomCode).toBe("HJKMNP");
    }
  });
});

// ---------------------------------------------------------------------------
// validateRoomCode
// ---------------------------------------------------------------------------

describe("validateRoomCode", () => {
  test("accepts valid room code", () => {
    expect(validateRoomCode("ABCDEF")).toBeNull();
  });

  test("accepts all alphabet characters", () => {
    const code = ROOM_CODE_ALPHABET.slice(0, ROOM_CODE_LENGTH);
    expect(validateRoomCode(code)).toBeNull();
  });

  test("accepts numeric characters from alphabet", () => {
    expect(validateRoomCode("234567")).toBeNull();
  });

  test("rejects wrong length", () => {
    expect(validateRoomCode("ABC")).not.toBeNull();
    expect(validateRoomCode("ABCDEFGH")).not.toBeNull();
  });

  test("rejects empty string", () => {
    expect(validateRoomCode("")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ROOM_CODE_ALPHABET
// ---------------------------------------------------------------------------

describe("ROOM_CODE_ALPHABET", () => {
  test("excludes ambiguous characters", () => {
    expect(ROOM_CODE_ALPHABET).not.toContain("0");
    expect(ROOM_CODE_ALPHABET).not.toContain("O");
    expect(ROOM_CODE_ALPHABET).not.toContain("1");
    expect(ROOM_CODE_ALPHABET).not.toContain("I");
    expect(ROOM_CODE_ALPHABET).not.toContain("L");
  });

  test("contains only uppercase letters and digits", () => {
    expect(ROOM_CODE_ALPHABET).toMatch(/^[A-Z0-9]+$/);
  });

  test("has 31 characters (26 letters - 3 ambiguous + 10 digits - 2 ambiguous)", () => {
    expect(ROOM_CODE_ALPHABET.length).toBe(31);
  });
});

// ---------------------------------------------------------------------------
// parseInvite - additional edge cases
// ---------------------------------------------------------------------------

describe("parseInvite edge cases", () => {
  test("rejects room code with special characters", () => {
    const result = parseInvite("AB@DE#");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid characters");
    }
  });

  test("rejects room code with digits not in alphabet (0 and 1)", () => {
    const result = parseInvite("A01BCD");
    expect(result.ok).toBe(false);
  });

  test("accepts room code using all digits from alphabet", () => {
    const result = parseInvite("234567");
    expect(result.ok).toBe(true);
  });

  test("legacy format: colon with empty secret still extracts valid code", () => {
    // "ABCDEF:" → roomCode = "ABCDEF", secret portion is empty but discarded
    const result = parseInvite("ABCDEF:");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invite.roomCode).toBe("ABCDEF");
    }
  });
});

// ---------------------------------------------------------------------------
// validateRoomCode - additional edge cases
// ---------------------------------------------------------------------------

describe("validateRoomCode edge cases", () => {
  test("rejects room code with spaces", () => {
    expect(validateRoomCode("AB CD ")).not.toBeNull();
  });

  test("rejects room code with lowercase", () => {
    expect(validateRoomCode("abcdef")).not.toBeNull();
  });

  test("accepts code from last 6 chars of alphabet", () => {
    const code = ROOM_CODE_ALPHABET.slice(-ROOM_CODE_LENGTH);
    expect(validateRoomCode(code)).toBeNull();
  });
});
