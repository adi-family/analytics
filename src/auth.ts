// Bearer keys. The deployment holds only SHA-256 hashes of the keys (comma-separated, so
// a key can be rotated without downtime); the keys themselves live with their callers.

import { createHash, timingSafeEqual } from "node:crypto";

export const hashKey = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");

export function parseHashes(env: string | undefined): Buffer[] {
  return (env ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s))
    .map((s) => Buffer.from(s, "hex"));
}

export function bearer(headers: Record<string, string | undefined>): string | null {
  const h = headers["authorization"];
  const m = h?.match(/^Bearer\s+(\S{16,256})$/);
  return m ? m[1] : null;
}

export function keyMatches(key: string | null, hashes: Buffer[]): boolean {
  if (!key || hashes.length === 0) return false;
  const given = Buffer.from(hashKey(key), "hex");
  let ok = false;
  for (const h of hashes) ok = timingSafeEqual(given, h) || ok;
  return ok;
}
