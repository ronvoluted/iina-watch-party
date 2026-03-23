/**
 * Rate limiting utilities for the worker.
 *
 * Two strategies:
 * 1. IpRateLimiter  — sliding-window counter per IP for HTTP endpoints.
 * 2. ConnectionRateLimiter — token-bucket per WebSocket connection for messages.
 */

// ── IP-based sliding window ─────────────────────────────────────

interface IpEntry {
  count: number;
  resetAtMs: number;
}

/**
 * In-memory sliding-window rate limiter keyed by IP address.
 * Designed for use at the Worker level (not inside a Durable Object).
 *
 * Note: each Worker isolate has its own Map, so limits are per-isolate.
 * This is acceptable for conservative limits on room creation.
 */
export class IpRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly entries = new Map<string, IpEntry>();

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  /**
   * Check whether the request should be allowed.
   * Returns true if allowed, false if rate-limited.
   */
  check(ip: string): boolean {
    const now = Date.now();
    const entry = this.entries.get(ip);

    if (!entry || now >= entry.resetAtMs) {
      this.entries.set(ip, { count: 1, resetAtMs: now + this.windowMs });
      return true;
    }

    entry.count++;
    if (entry.count > this.maxRequests) {
      return false;
    }
    return true;
  }

  /**
   * Remove expired entries to prevent unbounded memory growth.
   * Called periodically (e.g. every N requests).
   */
  prune(): void {
    const now = Date.now();
    for (const [ip, entry] of this.entries) {
      if (now >= entry.resetAtMs) {
        this.entries.delete(ip);
      }
    }
  }

  /** Reset all entries. Useful for testing. */
  reset(): void {
    this.entries.clear();
  }
}

// ── Per-connection token bucket ─────────────────────────────────

/**
 * Token-bucket rate limiter for a single WebSocket connection.
 * Tokens refill at a fixed rate; each message consumes one token.
 */
export class ConnectionRateLimiter {
  private tokens: number;
  private lastRefillMs: number;
  private readonly maxTokens: number;
  private readonly refillRatePerSec: number;

  constructor(maxTokens: number, refillRatePerSec: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRatePerSec = refillRatePerSec;
    this.lastRefillMs = Date.now();
  }

  /**
   * Consume a token. Returns true if allowed, false if rate-limited.
   */
  consume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsedSec * this.refillRatePerSec,
    );
    this.lastRefillMs = now;
  }
}
