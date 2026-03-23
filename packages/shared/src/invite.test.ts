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
  test("parses a valid invite string", () => {
    const result = parseInvite("ABCDEF:c2VjcmV0");
    expect(result).toEqual({
      ok: true,
      invite: { roomCode: "ABCDEF", secret: "c2VjcmV0" },
    });
  });

  test("trims surrounding whitespace", () => {
    const result = parseInvite("  ABCDEF:c2VjcmV0  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invite.roomCode).toBe("ABCDEF");
    }
  });

  test("handles secret with base64url characters (-, _, =)", () => {
    const result = parseInvite("HJKMNP:abc-def_ghi=");
    expect(result).toEqual({
      ok: true,
      invite: { roomCode: "HJKMNP", secret: "abc-def_ghi=" },
    });
  });

  test("handles secret with padding", () => {
    const result = parseInvite("ABCDEF:dGVzdA==");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invite.secret).toBe("dGVzdA==");
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

  test("rejects string without colon", () => {
    const result = parseInvite("ABCDEFc2VjcmV0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("missing colon");
    }
  });

  test("rejects room code that is too short", () => {
    const result = parseInvite("ABC:c2VjcmV0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exactly 6 characters");
    }
  });

  test("rejects room code that is too long", () => {
    const result = parseInvite("ABCDEFGH:c2VjcmV0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exactly 6 characters");
    }
  });

  test("rejects room code with ambiguous characters (0, O, 1, I, L)", () => {
    for (const bad of ["0", "O", "1", "I", "L"]) {
      const code = bad + "BCDEF";
      const result = parseInvite(`${code}:c2VjcmV0`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("invalid characters");
      }
    }
  });

  test("rejects lowercase room code", () => {
    const result = parseInvite("abcdef:c2VjcmV0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid characters");
    }
  });

  test("rejects empty secret", () => {
    const result = parseInvite("ABCDEF:");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Secret is empty");
    }
  });

  test("rejects secret with non-base64url characters", () => {
    const result = parseInvite("ABCDEF:secret with spaces");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid characters");
    }
  });

  test("handles secret that contains colons", () => {
    // Only the first colon is the separator; rest belongs to the secret
    // base64url doesn't include colons, so this should fail
    const result = parseInvite("ABCDEF:abc:def");
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
  test("formats room code and secret into invite string", () => {
    expect(formatInvite("ABCDEF", "c2VjcmV0")).toBe("ABCDEF:c2VjcmV0");
  });

  test("round-trips with parseInvite", () => {
    const invite = formatInvite("HJKMNP", "dGVzdA==");
    const result = parseInvite(invite);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invite.roomCode).toBe("HJKMNP");
      expect(result.invite.secret).toBe("dGVzdA==");
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
    // Use first 6 characters of the alphabet
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
  test("rejects secret with special characters", () => {
    const result = parseInvite("ABCDEF:abc!@#$");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid characters");
    }
  });

  test("rejects room code with special characters", () => {
    const result = parseInvite("AB@DE#:c2VjcmV0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid characters");
    }
  });

  test("rejects room code with digits not in alphabet (0 and 1)", () => {
    const result = parseInvite("A01BCD:c2VjcmV0");
    expect(result.ok).toBe(false);
  });

  test("accepts room code using all digits from alphabet", () => {
    // 2-9 are valid digits in the alphabet
    const result = parseInvite("234567:c2VjcmV0");
    expect(result.ok).toBe(true);
  });

  test("accepts single-character secret", () => {
    const result = parseInvite("ABCDEF:a");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invite.secret).toBe("a");
    }
  });

  test("accepts long secret", () => {
    const longSecret = "abcdefghijklmnopqrstuvwxyz0123456789-_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const result = parseInvite(`ABCDEF:${longSecret}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invite.secret).toBe(longSecret);
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

// ---------------------------------------------------------------------------
// formatInvite edge cases
// ---------------------------------------------------------------------------

describe("formatInvite edge cases", () => {
  test("preserves secret with padding characters", () => {
    const invite = formatInvite("ABCDEF", "dGVzdA==");
    expect(invite).toBe("ABCDEF:dGVzdA==");
  });

  test("preserves secret with hyphens and underscores", () => {
    const invite = formatInvite("HJKMNP", "a-b_c");
    expect(invite).toBe("HJKMNP:a-b_c");
  });
});
