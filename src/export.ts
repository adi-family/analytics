// GET /v1/pull?since=<cursor>: hands stored records to ADI incrementally.
//
// Firehose writes gzip JSONL objects under events/dt=YYYY-MM-DD/, named with the time the
// buffer opened, so object keys sort by time. The cursor is the last key handed out; the
// next call lists the keys after it. Delivery is at least once: dedupe on the record id.

import { gunzipSync } from "node:zlib";

export const EVENTS_PREFIX = "events/";

export interface EventStore {
  /** Keys under `prefix`, in key order, strictly after `startAfter`. */
  list(prefix: string, startAfter: string | undefined, max: number): Promise<{ keys: string[]; truncated: boolean }>;
  /** The raw object body (gzip). */
  get(key: string): Promise<Uint8Array>;
}

export const encodeCursor = (key: string) => Buffer.from(key, "utf8").toString("base64url");

export function decodeCursor(since: string | undefined): { ok: true; startAfter: string | undefined } | { ok: false; error: string } {
  if (!since) return { ok: true, startAfter: undefined };
  // A bare date starts at that day's partition, so a first pull need not begin at the start of time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) return { ok: true, startAfter: `${EVENTS_PREFIX}dt=${since}/` };
  if (!/^[A-Za-z0-9_-]{1,700}$/.test(since)) return { ok: false, error: "since is not a cursor" };
  const key = Buffer.from(since, "base64url").toString("utf8");
  if (!key.startsWith(EVENTS_PREFIX) || key.includes("..")) return { ok: false, error: "since is not a cursor" };
  return { ok: true, startAfter: key };
}

export async function exportPage(
  store: EventStore,
  since: string | undefined,
  limits = { objects: 50, records: 5_000 },
): Promise<{ ok: false; error: string } | { ok: true; records: unknown[]; cursor: string | null; more: boolean }> {
  const c = decodeCursor(since);
  if (!c.ok) return c;
  const { keys, truncated } = await store.list(EVENTS_PREFIX, c.startAfter, limits.objects);
  const records: unknown[] = [];
  let last: string | undefined;
  let stoppedEarly = false;
  for (const key of keys) {
    const text = gunzipSync(await store.get(key)).toString("utf8");
    for (const line of text.split("\n")) if (line.trim()) records.push(JSON.parse(line));
    last = key;
    if (records.length >= limits.records) {
      stoppedEarly = key !== keys[keys.length - 1];
      break;
    }
  }
  const cursor = last ? encodeCursor(last) : (since ?? null);
  return { ok: true, records, cursor, more: truncated || stoppedEarly };
}
