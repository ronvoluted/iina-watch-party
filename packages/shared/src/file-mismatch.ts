/**
 * File mismatch detection.
 *
 * Compares file metadata exchanged during auth to detect when peers are
 * watching different files. Per PRD FR-10: minimum heuristic is filename
 * and duration. Duration tolerance is configurable.
 */

import type { FileMetadata } from "./types.js";

/** Default tolerance for duration comparison (5 seconds). */
export const DEFAULT_DURATION_TOLERANCE_MS = 5000;

export interface FileMismatchResult {
  mismatch: boolean;
  reasons: string[];
}

/**
 * Compare two peers' file metadata and return whether they mismatch.
 *
 * Returns `{ mismatch: false, reasons: [] }` when both files appear to match
 * or when there is insufficient metadata to compare.
 */
export function checkFileMismatch(
  a: FileMetadata,
  b: FileMetadata,
  durationToleranceMs: number = DEFAULT_DURATION_TOLERANCE_MS,
): FileMismatchResult {
  const reasons: string[] = [];

  // Duration comparison — primary signal
  if (a.durationMs != null && b.durationMs != null) {
    const diff = Math.abs(a.durationMs - b.durationMs);
    if (diff > durationToleranceMs) {
      reasons.push(
        `duration differs by ${Math.round(diff / 1000)}s`,
      );
    }
  }

  // Filename comparison — secondary signal (only when both present)
  if (a.name != null && b.name != null && a.name !== "" && b.name !== "") {
    if (a.name !== b.name) {
      reasons.push("filenames differ");
    }
  }

  return { mismatch: reasons.length > 0, reasons };
}
