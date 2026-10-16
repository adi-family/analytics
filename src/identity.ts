// Identity rules. Three kinds of id exist:
//   anonymous_id  a random UUID the browser snippet keeps in the first-party cookie adi_id,
//                 only after consent. Without consent the collector stores no id at all.
//                 The browser sends it as browser_id.
//   distinct_id   a known id: an app install_id (UUID), or crm:company:<id>, crm:user:<id>,
//                 or a licence deployment_id. Linked to an anonymous_id by POST /v1/link.
//                 The browser sends it as known_id.
//   groups        company / deployment keys on app and server events.
// Nothing here is derived from an IP address or the hardware.

import type { Layer } from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DISTINCT = /^[A-Za-z0-9][A-Za-z0-9:_.@\-]{0,127}$/;
export const GROUP_KEYS = ["company", "deployment"] as const;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
export const isDistinctId = (v: unknown): v is string => typeof v === "string" && DISTINCT.test(v);

/** Where a request came from, decided by the route and its credentials, never by the body. */
export type Source = "browser" | "app" | "server";

export const LAYERS_BY_SOURCE: Record<Source, Layer[]> = {
  browser: ["site"],
  app: ["app"],
  server: ["server-crm", "server-licence"],
};

export type Ids = { anonymous_id: string | null; distinct_id: string | null };

/** What the two ids are called in the request body (they differ for the browser). */
export type IdNames = { browserId: string; knownId: string };
const RECORD_NAMES: IdNames = { browserId: "anonymous_id", knownId: "distinct_id" };

/**
 * Resolves the ids an event is stored with, or explains why it is refused.
 * `consent` only matters for the browser: without it both ids are dropped, so a
 * cookieless event cannot be joined to anything.
 */
export function resolveIds(
  source: Source,
  consent: boolean,
  anonymousId: unknown,
  distinctId: unknown,
  names: IdNames = RECORD_NAMES,
): { ok: true; ids: Ids } | { ok: false; error: string } {
  const { browserId: A, knownId: D } = names;
  if (anonymousId != null && !isUuid(anonymousId)) return { ok: false, error: `${A} must be a lowercase UUID` };
  if (distinctId != null && !isDistinctId(distinctId)) return { ok: false, error: `${D} has a bad format` };
  switch (source) {
    case "browser":
      if (!consent) return { ok: true, ids: { anonymous_id: null, distinct_id: null } };
      if (anonymousId == null) return { ok: false, error: `${A} is required with consent` };
      return { ok: true, ids: { anonymous_id: anonymousId as string, distinct_id: (distinctId as string) ?? null } };
    case "app":
      if (anonymousId != null) return { ok: false, error: "app events carry no anonymous_id" };
      if (!isUuid(distinctId)) return { ok: false, error: "app events need distinct_id = the install_id (UUID)" };
      return { ok: true, ids: { anonymous_id: null, distinct_id: distinctId } };
    case "server":
      if (anonymousId != null) return { ok: false, error: "server events carry no anonymous_id" };
      if (distinctId == null) return { ok: false, error: "server events need a distinct_id" };
      return { ok: true, ids: { anonymous_id: null, distinct_id: distinctId as string } };
  }
}

export function validateGroups(
  source: Source,
  groups: unknown,
): { ok: true; groups: Record<string, string> | null } | { ok: false; error: string } {
  if (groups == null) return { ok: true, groups: null };
  if (source === "browser") return { ok: false, error: "site events carry no groups" };
  if (typeof groups !== "object" || Array.isArray(groups)) return { ok: false, error: "groups must be an object" };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(groups as Record<string, unknown>)) {
    if (!(GROUP_KEYS as readonly string[]).includes(k)) return { ok: false, error: `unknown group ${k}` };
    if (!isDistinctId(v)) return { ok: false, error: `group ${k} has a bad key` };
    out[k] = v;
  }
  return { ok: true, groups: Object.keys(out).length ? out : null };
}

/** An alias: from now on, this anonymous_id is the same person as distinct_id. */
export function validateIdentify(
  source: Source,
  body: Record<string, unknown>,
  names: IdNames = RECORD_NAMES,
): { ok: true; anonymous_id: string; distinct_id: string } | { ok: false; error: string } {
  const { browserId: A, knownId: D } = names;
  const a = body[A], d = body[D];
  if (source === "app") return { ok: false, error: "a link comes from the browser or a server" };
  if (source === "browser" && body.consent !== true) return { ok: false, error: "a link needs consent" };
  if (!isUuid(a)) return { ok: false, error: `${A} must be a lowercase UUID` };
  if (!isDistinctId(d)) return { ok: false, error: `${D} has a bad format` };
  if (a === d) return { ok: false, error: `${A} and ${D} are the same` };
  return { ok: true, anonymous_id: a, distinct_id: d };
}
