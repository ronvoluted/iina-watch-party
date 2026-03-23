import { describe, expect, test } from "bun:test";
import {
  checkFileMismatch,
  DEFAULT_DURATION_TOLERANCE_MS,
} from "./file-mismatch.js";

describe("checkFileMismatch", () => {
  // ── No mismatch cases ──────────────────────────────────────────

  test("identical metadata returns no mismatch", () => {
    const result = checkFileMismatch(
      { name: "movie.mkv", durationMs: 7200000 },
      { name: "movie.mkv", durationMs: 7200000 },
    );
    expect(result.mismatch).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  test("durations within tolerance return no mismatch", () => {
    const result = checkFileMismatch(
      { name: "movie.mkv", durationMs: 7200000 },
      { name: "movie.mkv", durationMs: 7204000 },
    );
    expect(result.mismatch).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  test("duration exactly at tolerance returns no mismatch", () => {
    const result = checkFileMismatch(
      { durationMs: 10000 },
      { durationMs: 10000 + DEFAULT_DURATION_TOLERANCE_MS },
    );
    expect(result.mismatch).toBe(false);
  });

  test("empty metadata returns no mismatch", () => {
    const result = checkFileMismatch({}, {});
    expect(result.mismatch).toBe(false);
  });

  test("one side missing duration returns no mismatch", () => {
    const result = checkFileMismatch(
      { name: "movie.mkv", durationMs: 7200000 },
      { name: "movie.mkv" },
    );
    expect(result.mismatch).toBe(false);
  });

  test("one side missing name returns no mismatch for names", () => {
    const result = checkFileMismatch(
      { name: "movie.mkv", durationMs: 7200000 },
      { durationMs: 7200000 },
    );
    expect(result.mismatch).toBe(false);
  });

  test("both names empty returns no mismatch", () => {
    const result = checkFileMismatch(
      { name: "", durationMs: 7200000 },
      { name: "", durationMs: 7200000 },
    );
    expect(result.mismatch).toBe(false);
  });

  // ── Mismatch cases ────────────────────────────────────────────

  test("duration beyond tolerance returns mismatch", () => {
    const result = checkFileMismatch(
      { durationMs: 7200000 },
      { durationMs: 3600000 },
    );
    expect(result.mismatch).toBe(true);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("duration differs by");
  });

  test("duration just over tolerance returns mismatch", () => {
    const result = checkFileMismatch(
      { durationMs: 10000 },
      { durationMs: 10000 + DEFAULT_DURATION_TOLERANCE_MS + 1 },
    );
    expect(result.mismatch).toBe(true);
  });

  test("different filenames returns mismatch", () => {
    const result = checkFileMismatch(
      { name: "movie-v1.mkv", durationMs: 7200000 },
      { name: "movie-v2.mkv", durationMs: 7200000 },
    );
    expect(result.mismatch).toBe(true);
    expect(result.reasons).toEqual(["filenames differ"]);
  });

  test("both duration and filename mismatch returns both reasons", () => {
    const result = checkFileMismatch(
      { name: "movie-v1.mkv", durationMs: 7200000 },
      { name: "movie-v2.mkv", durationMs: 3600000 },
    );
    expect(result.mismatch).toBe(true);
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]).toContain("duration differs by");
    expect(result.reasons[1]).toBe("filenames differ");
  });

  // ── Custom tolerance ──────────────────────────────────────────

  test("custom tolerance: stricter threshold catches smaller drift", () => {
    const result = checkFileMismatch(
      { durationMs: 10000 },
      { durationMs: 12000 },
      1000,
    );
    expect(result.mismatch).toBe(true);
  });

  test("custom tolerance: looser threshold ignores larger drift", () => {
    const result = checkFileMismatch(
      { durationMs: 10000 },
      { durationMs: 20000 },
      15000,
    );
    expect(result.mismatch).toBe(false);
  });

  // ── Duration diff message formatting ──────────────────────────

  test("duration diff message is rounded to seconds", () => {
    const result = checkFileMismatch(
      { durationMs: 0 },
      { durationMs: 65432 },
    );
    expect(result.mismatch).toBe(true);
    expect(result.reasons[0]).toBe("duration differs by 65s");
  });
});
