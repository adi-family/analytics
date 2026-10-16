// Turns a request body into stored records, or into reasons for refusing them.
// One stored record is one line of JSON (see README, "Record format").

import { randomUUID } from "node:crypto";
import { LAYERS_BY_SOURCE, resolveIds, validateGroups, validateIdentify, type Source } from "./identity";
import { schema as defaultSchema, validateProperties, type Schema } from "./schema";
import type { UaFamily } from "./ua";

export const RECORD_VERSION = 1;

export const BATCH_LIMITS: Record<Source, { events: number; bytes: number }> = {
  browser: { events: 50, bytes: 32 * 1024 },
  app: { events: 100, bytes: 64 * 1024 },
  server: { events: 500, bytes: 256 * 1024 },
};

// Client timestamps outside this window are replaced by the arrival time.
const MAX_PAST_MS = 30 * 24 * 3600 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

export type StoredRecord = {
  v: number;
  type: "track" | "identify";
  id: string;
  event: string | null;
  layer: string;
  ts: string;
  received_at: string;
  anonymous_id: string | null;
  distinct_id: string | null;
  consent: boolean | null;
  properties: Record<string, unknown>;
  groups: Record<string, string> | null;
  ua_browser: string | null;
  ua_os: string | null;
  ua_device: string | null;
};

export type Rejection = { index: number; name: unknown; errors: string[] };

/**
 * The field names of a request body. Servers and the desktop app use the record's own
 * names. The browser uses plain words instead, because everything a browser sends is
 * visible to content blockers and their scriptlets (see src/surface.ts).
 */
export type Wire = {
  top: readonly string[] | null; // the allowed batch-level fields; null = not checked
  items: string;
  name: string;
  props: string;
  at: string;
  itemFields: readonly string[];
  browserId: string;
  knownId: string;
};

export const RECORD_WIRE: Wire = {
  top: null,
  items: "events",
  name: "event",
  props: "properties",
  at: "ts",
  itemFields: ["event", "properties", "ts", "id", "distinct_id", "groups"],
  browserId: "anonymous_id",
  knownId: "distinct_id",
};

export const WEB_WIRE: Wire = {
  top: ["consent", "browser_id", "known_id", "items"],
  items: "items",
  name: "name",
  props: "props",
  at: "at",
  itemFields: ["name", "props", "at", "id"],
  browserId: "browser_id",
  knownId: "known_id",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function eventTime(ts: unknown, now: number, field = "ts"): string | { error: string } {
  if (ts == null) return new Date(now).toISOString();
  const t = typeof ts === "number" ? ts : typeof ts === "string" && ts.length <= 40 ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return { error: `${field} must be an ISO 8601 string or epoch milliseconds` };
  if (t > now + MAX_FUTURE_MS || t < now - MAX_PAST_MS) return new Date(now).toISOString();
  return new Date(t).toISOString();
}

export function collectBatch(
  source: Source,
  body: unknown,
  ctx: { now: number; ua: UaFamily | null; schema?: Schema; wire?: Wire },
): { ok: false; status: number; error: string } | { ok: true; records: StoredRecord[]; rejected: Rejection[] } {
  const schema = ctx.schema ?? defaultSchema;
  const w = ctx.wire ?? RECORD_WIRE;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, status: 400, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (w.top && !w.top.includes(k)) return { ok: false, status: 400, error: `unknown field ${k}` };
  const items = b[w.items];
  if (!Array.isArray(items) || items.length === 0) return { ok: false, status: 400, error: `${w.items} must be a non-empty array` };
  if (items.length > BATCH_LIMITS[source].events)
    return { ok: false, status: 413, error: `at most ${BATCH_LIMITS[source].events} ${w.items} per request` };
  if (b.consent != null && typeof b.consent !== "boolean") return { ok: false, status: 400, error: "consent must be a boolean" };
  const consent = b.consent === true;
  const allowedLayers = LAYERS_BY_SOURCE[source];
  const receivedAt = new Date(ctx.now).toISOString();

  const records: StoredRecord[] = [];
  const rejected: Rejection[] = [];
  items.forEach((raw, index) => {
    const reject = (...errors: string[]) => rejected.push({ index, name: (raw as Record<string, unknown>)?.[w.name] ?? null, errors });
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return reject("each item must be an object");
    const e = raw as Record<string, unknown>;
    for (const k of Object.keys(e)) if (!w.itemFields.includes(k)) return reject(`unknown field ${k}`);
    const name = e[w.name];
    const spec = typeof name === "string" ? schema.events.get(name) : undefined;
    if (!spec) return reject(`${JSON.stringify(name)} is not in the allowlist`);
    if (!allowedLayers.includes(spec.layer)) return reject(`${name} belongs to the ${spec.layer} layer and cannot be sent here`);
    if (source === "browser" && spec.consent === "required" && !consent) return reject(`${name} needs consent`);

    const ids = resolveIds(source, consent, b[w.browserId], e[w.knownId] ?? b[w.knownId], w);
    if (!ids.ok) return reject(ids.error);
    const groups = validateGroups(source, e.groups);
    if (!groups.ok) return reject(groups.error);
    const props = validateProperties(spec, e[w.props]);
    if (!props.ok) return reject(...props.errors);
    const ts = eventTime(e[w.at], ctx.now, w.at);
    if (typeof ts !== "string") return reject(ts.error);
    if (e.id != null && !(typeof e.id === "string" && UUID.test(e.id))) return reject("id must be a lowercase UUID");

    records.push({
      v: RECORD_VERSION,
      type: "track",
      id: (e.id as string) ?? randomUUID(),
      event: name as string,
      layer: spec.layer,
      ts,
      received_at: receivedAt,
      ...ids.ids,
      consent: source === "browser" ? consent : null,
      properties: props.properties,
      groups: groups.groups,
      ua_browser: ctx.ua?.browser ?? null,
      ua_os: ctx.ua?.os ?? null,
      ua_device: ctx.ua?.device ?? null,
    });
  });
  return { ok: true, records, rejected };
}

export function collectIdentify(
  source: Source,
  body: unknown,
  ctx: { now: number; wire?: Wire },
): { ok: false; status: number; error: string } | { ok: true; record: StoredRecord } {
  const w = ctx.wire ?? RECORD_WIRE;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, status: 400, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b))
    if (![w.browserId, w.knownId, "consent", "id", w.at].includes(k)) return { ok: false, status: 400, error: `unknown field ${k}` };
  const v = validateIdentify(source, b, w);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  const ts = eventTime(b[w.at], ctx.now, w.at);
  if (typeof ts !== "string") return { ok: false, status: 400, error: ts.error };
  if (b.id != null && !(typeof b.id === "string" && UUID.test(b.id))) return { ok: false, status: 400, error: "id must be a lowercase UUID" };
  return {
    ok: true,
    record: {
      v: RECORD_VERSION,
      type: "identify",
      id: (b.id as string) ?? randomUUID(),
      event: null,
      layer: source === "browser" ? "site" : "server",
      ts,
      received_at: new Date(ctx.now).toISOString(),
      anonymous_id: v.anonymous_id,
      distinct_id: v.distinct_id,
      consent: source === "browser" ? true : null,
      properties: {},
      groups: null,
      ua_browser: null,
      ua_os: null,
      ua_device: null,
    },
  };
}
