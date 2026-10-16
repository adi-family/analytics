// A per-instance token bucket, keyed on a salted hash of the caller's address. The salt is
// random per Lambda instance and lives only in memory, so the key cannot be reversed and
// nothing about the address outlives the instance. API Gateway's stage throttle is the
// global limit; this one stops a single caller from using all of it.

import { createHash, randomBytes } from "node:crypto";

export class RateLimiter {
  private salt = randomBytes(16);
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private perMinute: number,
    private burst: number,
    private maxKeys = 10_000,
  ) {}

  allow(address: string | undefined, now = Date.now()): boolean {
    if (!address) return true;
    const key = createHash("sha256").update(this.salt).update(address).digest("base64url").slice(0, 16);
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.clear();
      b = { tokens: this.burst, at: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 60_000) * this.perMinute);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
