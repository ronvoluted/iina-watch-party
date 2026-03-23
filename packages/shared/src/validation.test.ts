import { describe, expect, test } from "bun:test";
import { validateMessage, type ValidationResult } from "./validation.js";
import { PROTOCOL_VERSION, MAX_MESSAGE_SIZE_BYTES } from "./constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "sess-1",
    messageId: "msg-1",
    tsMs: Date.now(),
    ...overrides,
  };
}

function json(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function expectOk(result: ValidationResult) {
  expect(result.ok).toBe(true);
}

function expectErr(result: ValidationResult, substring: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain(substring);
  }
}

// ---------------------------------------------------------------------------
// Raw payload checks
// ---------------------------------------------------------------------------

describe("raw payload validation", () => {
  test("rejects non-string payload", () => {
    expectErr(validateMessage(42), "payload must be a string");
    expectErr(validateMessage(null), "payload must be a string");
    expectErr(validateMessage(undefined), "payload must be a string");
  });

  test("rejects oversized payload", () => {
    const big = "x".repeat(MAX_MESSAGE_SIZE_BYTES + 1);
    expectErr(validateMessage(big), "exceeds max size");
  });

  test("rejects invalid JSON", () => {
    expectErr(validateMessage("{bad json"), "invalid JSON");
  });

  test("rejects non-object JSON", () => {
    expectErr(validateMessage('"hello"'), "payload must be a JSON object");
    expectErr(validateMessage("[]"), "payload must be a JSON object");
    expectErr(validateMessage("null"), "payload must be a JSON object");
  });
});

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

describe("envelope validation", () => {
  test("rejects missing type", () => {
    expectErr(
      validateMessage(json({ ...envelope(), sessionId: "s" })),
      "missing or invalid field: type",
    );
  });

  test("rejects unknown type", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "unknown-type" })),
      "unknown message type",
    );
  });

  test("rejects wrong protocolVersion", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "play", positionMs: 0, protocolVersion: 99 })),
      "unsupported protocolVersion",
    );
  });

  test("rejects missing sessionId", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "play", sessionId: "" })),
      "missing or invalid field: sessionId",
    );
  });

  test("rejects missing messageId", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "play", messageId: "" })),
      "missing or invalid field: messageId",
    );
  });

  test("rejects non-positive tsMs", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "play", tsMs: -1 })),
      "missing or invalid field: tsMs",
    );
  });

  test("rejects non-finite tsMs", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "play", tsMs: null })),
      "missing or invalid field: tsMs",
    );
  });
});

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

describe("auth message", () => {
  const validAuth = () =>
    json({
      ...envelope(),
      type: "auth",
      file: { name: "video.mp4", durationMs: 60000 },
    });

  test("accepts valid auth", () => {
    expectOk(validateMessage(validAuth()));
  });

  test("accepts auth with optional fields", () => {
    expectOk(
      validateMessage(
        json({
          ...envelope(),
          type: "auth",
          displayName: "Ron",
          desiredRole: "host",
          file: { name: "v.mp4", durationMs: 1000, sizeBytes: 500 },
        }),
      ),
    );
  });

  test("rejects invalid desiredRole", () => {
    expectErr(
      validateMessage(
        json({ ...envelope(), type: "auth", desiredRole: "admin", file: {} }),
      ),
      "desiredRole",
    );
  });

  test("rejects missing file", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "auth" })),
      "file",
    );
  });

  test("rejects negative file.durationMs", () => {
    expectErr(
      validateMessage(
        json({ ...envelope(), type: "auth", file: { durationMs: -1 } }),
      ),
      "file.durationMs",
    );
  });

  test("rejects negative file.sizeBytes", () => {
    expectErr(
      validateMessage(
        json({ ...envelope(), type: "auth", file: { sizeBytes: -100 } }),
      ),
      "file.sizeBytes",
    );
  });
});

// ---------------------------------------------------------------------------
// auth-ok
// ---------------------------------------------------------------------------

describe("auth-ok message", () => {
  const valid = () =>
    json({
      ...envelope({ sessionId: "server" }),
      type: "auth-ok",
      role: "host",
      roomCode: "ABCDEF",
      expiresAtMs: Date.now() + 3600000,
      peerPresent: false,
    });

  test("accepts valid auth-ok", () => {
    expectOk(validateMessage(valid()));
  });

  test("rejects missing role", () => {
    expectErr(
      validateMessage(
        json({
          ...envelope({ sessionId: "server" }),
          type: "auth-ok",
          roomCode: "ABC",
          expiresAtMs: 1000,
          peerPresent: false,
        }),
      ),
      "role",
    );
  });

  test("rejects missing peerPresent", () => {
    expectErr(
      validateMessage(
        json({
          ...envelope({ sessionId: "server" }),
          type: "auth-ok",
          role: "guest",
          roomCode: "ABC",
          expiresAtMs: 1000,
        }),
      ),
      "peerPresent",
    );
  });
});

// ---------------------------------------------------------------------------
// auth-error and error
// ---------------------------------------------------------------------------

describe("auth-error / error messages", () => {
  test("accepts valid auth-error", () => {
    expectOk(
      validateMessage(
        json({
          ...envelope({ sessionId: "server" }),
          type: "auth-error",
          code: "bad-secret",
          message: "Invalid secret",
        }),
      ),
    );
  });

  test("accepts valid error", () => {
    expectOk(
      validateMessage(
        json({
          ...envelope({ sessionId: "server" }),
          type: "error",
          code: "internal",
          message: "Something went wrong",
        }),
      ),
    );
  });

  test("rejects missing code", () => {
    expectErr(
      validateMessage(
        json({ ...envelope(), type: "error", message: "oops" }),
      ),
      "code",
    );
  });

  test("rejects missing message", () => {
    expectErr(
      validateMessage(
        json({ ...envelope(), type: "error", code: "x" }),
      ),
      "message",
    );
  });
});

// ---------------------------------------------------------------------------
// presence
// ---------------------------------------------------------------------------

describe("presence message", () => {
  test("accepts valid presence", () => {
    expectOk(
      validateMessage(
        json({
          ...envelope({ sessionId: "server" }),
          type: "presence",
          event: "peer-joined",
          role: "guest",
        }),
      ),
    );
  });

  test("rejects invalid event", () => {
    expectErr(
      validateMessage(
        json({ ...envelope(), type: "presence", event: "appeared", role: "host" }),
      ),
      "event",
    );
  });

  test("rejects invalid role", () => {
    expectErr(
      validateMessage(
        json({ ...envelope(), type: "presence", event: "peer-joined", role: "admin" }),
      ),
      "role",
    );
  });
});

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

describe("state message", () => {
  const valid = () =>
    json({
      ...envelope(),
      type: "state",
      reason: "initial",
      positionMs: 5000,
      paused: false,
      speed: 1,
    });

  test("accepts valid state", () => {
    expectOk(validateMessage(valid()));
  });

  test("accepts state with buffering", () => {
    expectOk(
      validateMessage(
        json({
          ...envelope(),
          type: "state",
          reason: "reconnect",
          positionMs: 0,
          paused: true,
          speed: 1,
          buffering: true,
        }),
      ),
    );
  });

  test("rejects invalid reason", () => {
    expectErr(
      validateMessage(
        json({
          ...envelope(),
          type: "state",
          reason: "auto",
          positionMs: 0,
          paused: false,
          speed: 1,
        }),
      ),
      "reason",
    );
  });

  test("rejects negative positionMs", () => {
    expectErr(
      validateMessage(
        json({
          ...envelope(),
          type: "state",
          reason: "initial",
          positionMs: -1,
          paused: false,
          speed: 1,
        }),
      ),
      "positionMs",
    );
  });

  test("rejects zero speed", () => {
    expectErr(
      validateMessage(
        json({
          ...envelope(),
          type: "state",
          reason: "initial",
          positionMs: 0,
          paused: false,
          speed: 0,
        }),
      ),
      "speed",
    );
  });

  test("rejects non-boolean buffering", () => {
    expectErr(
      validateMessage(
        json({
          ...envelope(),
          type: "state",
          reason: "initial",
          positionMs: 0,
          paused: false,
          speed: 1,
          buffering: "yes",
        }),
      ),
      "buffering",
    );
  });
});

// ---------------------------------------------------------------------------
// play / pause
// ---------------------------------------------------------------------------

describe("play and pause messages", () => {
  test("accepts valid play", () => {
    expectOk(
      validateMessage(json({ ...envelope(), type: "play", positionMs: 1234 })),
    );
  });

  test("accepts valid pause", () => {
    expectOk(
      validateMessage(json({ ...envelope(), type: "pause", positionMs: 0 })),
    );
  });

  test("rejects negative positionMs in play", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "play", positionMs: -1 })),
      "positionMs",
    );
  });

  test("rejects missing positionMs in pause", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "pause" })),
      "positionMs",
    );
  });
});

// ---------------------------------------------------------------------------
// seek
// ---------------------------------------------------------------------------

describe("seek message", () => {
  test("accepts valid user seek", () => {
    expectOk(
      validateMessage(
        json({ ...envelope(), type: "seek", positionMs: 500, cause: "user" }),
      ),
    );
  });

  test("accepts drift-correction seek", () => {
    expectOk(
      validateMessage(
        json({ ...envelope(), type: "seek", positionMs: 500, cause: "drift-correction" }),
      ),
    );
  });

  test("rejects invalid cause", () => {
    expectErr(
      validateMessage(
        json({ ...envelope(), type: "seek", positionMs: 500, cause: "auto" }),
      ),
      "cause",
    );
  });
});

// ---------------------------------------------------------------------------
// speed
// ---------------------------------------------------------------------------

describe("speed message", () => {
  test("accepts valid speed", () => {
    expectOk(
      validateMessage(json({ ...envelope(), type: "speed", speed: 1.5 })),
    );
  });

  test("rejects zero speed", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "speed", speed: 0 })),
      "speed",
    );
  });

  test("rejects negative speed", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "speed", speed: -1 })),
      "speed",
    );
  });

  test("rejects NaN speed", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "speed", speed: null })),
      "speed",
    );
  });
});

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

describe("heartbeat message", () => {
  const valid = () =>
    json({
      ...envelope(),
      type: "heartbeat",
      positionMs: 10000,
      paused: false,
      speed: 1,
    });

  test("accepts valid heartbeat", () => {
    expectOk(validateMessage(valid()));
  });

  test("accepts heartbeat with optional fields", () => {
    expectOk(
      validateMessage(
        json({
          ...envelope(),
          type: "heartbeat",
          positionMs: 10000,
          paused: false,
          speed: 1,
          buffering: true,
          seeking: false,
        }),
      ),
    );
  });

  test("rejects non-boolean seeking", () => {
    expectErr(
      validateMessage(
        json({
          ...envelope(),
          type: "heartbeat",
          positionMs: 0,
          paused: false,
          speed: 1,
          seeking: 1,
        }),
      ),
      "seeking",
    );
  });
});

// ---------------------------------------------------------------------------
// warning
// ---------------------------------------------------------------------------

describe("warning message", () => {
  test("accepts valid warning", () => {
    expectOk(
      validateMessage(
        json({
          ...envelope(),
          type: "warning",
          code: "file-mismatch",
          message: "Duration differs",
        }),
      ),
    );
  });

  test("rejects unknown warning code", () => {
    expectErr(
      validateMessage(
        json({
          ...envelope(),
          type: "warning",
          code: "unknown-warning",
          message: "oops",
        }),
      ),
      "code",
    );
  });
});

// ---------------------------------------------------------------------------
// goodbye
// ---------------------------------------------------------------------------

describe("goodbye message", () => {
  test("accepts valid goodbye", () => {
    expectOk(
      validateMessage(
        json({ ...envelope(), type: "goodbye", reason: "user left" }),
      ),
    );
  });

  test("rejects missing reason", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "goodbye" })),
      "reason",
    );
  });
});

// ---------------------------------------------------------------------------
// Boundary and edge cases
// ---------------------------------------------------------------------------

describe("boundary and edge cases", () => {
  test("accepts payload at exactly MAX_MESSAGE_SIZE_BYTES", () => {
    const base = json({
      ...envelope(),
      type: "goodbye",
      reason: "",
    });
    // Pad reason to hit exactly MAX_MESSAGE_SIZE_BYTES
    const byteLength = new TextEncoder().encode(base).byteLength;
    const padding = "x".repeat(MAX_MESSAGE_SIZE_BYTES - byteLength);
    const padded = json({
      ...envelope(),
      type: "goodbye",
      reason: padding,
    });
    const paddedByteLength = new TextEncoder().encode(padded).byteLength;
    expect(paddedByteLength).toBeLessThanOrEqual(MAX_MESSAGE_SIZE_BYTES);
    expectOk(validateMessage(padded));
  });

  test("rejects Infinity as tsMs", () => {
    // JSON.stringify converts Infinity to null, so this tests null tsMs
    expectErr(
      validateMessage(json({ ...envelope(), type: "play", positionMs: 0, tsMs: null })),
      "tsMs",
    );
  });

  test("rejects zero tsMs", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "play", positionMs: 0, tsMs: 0 })),
      "tsMs",
    );
  });

  test("accepts positionMs of zero", () => {
    expectOk(
      validateMessage(json({ ...envelope(), type: "play", positionMs: 0 })),
    );
  });

  test("rejects NaN positionMs (serialized as null)", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "play", positionMs: null })),
      "positionMs",
    );
  });

  test("rejects non-numeric positionMs", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "play", positionMs: "1000" })),
      "positionMs",
    );
  });

  test("rejects non-numeric sessionId", () => {
    expectErr(
      validateMessage(json({ ...envelope(), type: "play", positionMs: 0, sessionId: 123 })),
      "sessionId",
    );
  });
});

// ---------------------------------------------------------------------------
// auth - additional edge cases
// ---------------------------------------------------------------------------

describe("auth edge cases", () => {
  test("rejects displayName as number", () => {
    expectErr(
      validateMessage(
        json({ ...envelope(), type: "auth", displayName: 42, file: {} }),
      ),
      "displayName",
    );
  });

  test("rejects file.name as number", () => {
    expectErr(
      validateMessage(
        json({ ...envelope(), type: "auth", file: { name: 123 } }),
      ),
      "file.name",
    );
  });

  test("rejects file as array", () => {
    expectErr(
      validateMessage(
        json({ ...envelope(), type: "auth", file: [1, 2] }),
      ),
      "file",
    );
  });

  test("accepts auth with minimal file (empty object)", () => {
    expectOk(
      validateMessage(json({ ...envelope(), type: "auth", file: {} })),
    );
  });

  test("accepts auth with displayName but no desiredRole", () => {
    expectOk(
      validateMessage(
        json({
          ...envelope(),
          type: "auth",
          displayName: "Alice",
          file: {},
        }),
      ),
    );
  });

  test("accepts auth with desiredRole guest", () => {
    expectOk(
      validateMessage(
        json({
          ...envelope(),
          type: "auth",
          desiredRole: "guest",
          file: {},
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// presence - all valid events
// ---------------------------------------------------------------------------

describe("presence - all valid events", () => {
  for (const event of ["peer-joined", "peer-left", "peer-replaced"]) {
    test(`accepts presence with event "${event}"`, () => {
      expectOk(
        validateMessage(
          json({
            ...envelope({ sessionId: "server" }),
            type: "presence",
            event,
            role: "host",
          }),
        ),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// state - all valid reasons
// ---------------------------------------------------------------------------

describe("state - all valid reasons", () => {
  for (const reason of ["initial", "reconnect", "manual"]) {
    test(`accepts state with reason "${reason}"`, () => {
      expectOk(
        validateMessage(
          json({
            ...envelope(),
            type: "state",
            reason,
            positionMs: 0,
            paused: true,
            speed: 1,
          }),
        ),
      );
    });
  }

  test("rejects non-boolean paused", () => {
    expectErr(
      validateMessage(
        json({
          ...envelope(),
          type: "state",
          reason: "initial",
          positionMs: 0,
          paused: "yes",
          speed: 1,
        }),
      ),
      "paused",
    );
  });
});

// ---------------------------------------------------------------------------
// warning - all valid codes
// ---------------------------------------------------------------------------

describe("warning - all valid codes", () => {
  for (const code of ["file-mismatch", "peer-buffering", "room-expiring"]) {
    test(`accepts warning with code "${code}"`, () => {
      expectOk(
        validateMessage(
          json({
            ...envelope(),
            type: "warning",
            code,
            message: "test",
          }),
        ),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// heartbeat - additional edge cases
// ---------------------------------------------------------------------------

describe("heartbeat edge cases", () => {
  test("rejects non-boolean buffering", () => {
    expectErr(
      validateMessage(
        json({
          ...envelope(),
          type: "heartbeat",
          positionMs: 0,
          paused: false,
          speed: 1,
          buffering: "yes",
        }),
      ),
      "buffering",
    );
  });

  test("rejects missing paused", () => {
    expectErr(
      validateMessage(
        json({
          ...envelope(),
          type: "heartbeat",
          positionMs: 0,
          speed: 1,
        }),
      ),
      "paused",
    );
  });

  test("rejects missing speed", () => {
    expectErr(
      validateMessage(
        json({
          ...envelope(),
          type: "heartbeat",
          positionMs: 0,
          paused: false,
        }),
      ),
      "speed",
    );
  });
});

// ---------------------------------------------------------------------------
// seek - additional edge cases
// ---------------------------------------------------------------------------

describe("seek edge cases", () => {
  test("rejects missing cause", () => {
    expectErr(
      validateMessage(
        json({ ...envelope(), type: "seek", positionMs: 500 }),
      ),
      "cause",
    );
  });

  test("rejects missing positionMs", () => {
    expectErr(
      validateMessage(
        json({ ...envelope(), type: "seek", cause: "user" }),
      ),
      "positionMs",
    );
  });
});
