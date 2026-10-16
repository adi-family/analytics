// Compiles dictionary/events.json into validators. The dictionary is the allowlist:
// an event or a property that is not in it is rejected.

import dictionary from "../dictionary/events.json";

export type Layer = "site" | "app" | "server-crm" | "server-licence";
export const LAYERS: Layer[] = ["site", "app", "server-crm", "server-licence"];

export type PropSpec =
  | { type: "string" | "token" | "path" | "hostname" | "slug" | "int" | "bool"; optional?: boolean; max?: number }
  | { type: "enum"; values: string[]; optional?: boolean };

export type EventSpec = {
  layer: Layer;
  funnel?: string;
  consent?: "cookieless" | "required";
  description?: string;
  properties: Record<string, PropSpec>;
};

export type Dictionary = {
  common?: Partial<Record<Layer, Record<string, PropSpec>>>;
  events: Record<string, EventSpec>;
};

export const LIMITS = {
  string: 200,
  token: 64,
  path: 512,
  hostname: 253,
  slug: 96,
  int: 1_000_000_000,
};

const PATTERNS = {
  token: /^[A-Za-z0-9][A-Za-z0-9:_.+\-]*$/,
  path: /^\/[^\s?#]*$/,
  hostname: /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  slug: /^[a-z0-9][a-z0-9-]*$/,
};

// Control characters never make it into stored strings.
const CONTROL = /[\u0000-\u001f\u007f]/;

export function checkValue(spec: PropSpec, value: unknown): string | null {
  switch (spec.type) {
    case "bool":
      return typeof value === "boolean" ? null : "expected a boolean";
    case "int":
      return Number.isSafeInteger(value) && Math.abs(value as number) <= LIMITS.int ? null : "expected an integer";
    case "enum":
      return typeof value === "string" && spec.values.includes(value) ? null : `expected one of ${spec.values.join(", ")}`;
    default: {
      if (typeof value !== "string" || value.length === 0) return "expected a non-empty string";
      const max = spec.max ?? LIMITS[spec.type];
      if (value.length > max) return `longer than ${max} characters`;
      if (CONTROL.test(value)) return "contains control characters";
      if (spec.type !== "string" && !PATTERNS[spec.type].test(value)) return `not a valid ${spec.type}`;
      return null;
    }
  }
}

export type Schema = {
  events: Map<string, EventSpec & { props: Record<string, PropSpec> }>;
};

export function compile(dict: Dictionary): Schema {
  const events = new Map<string, EventSpec & { props: Record<string, PropSpec> }>();
  for (const [name, spec] of Object.entries(dict.events)) {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) throw new Error(`dictionary: bad event name ${name}`);
    if (!LAYERS.includes(spec.layer)) throw new Error(`dictionary: ${name} has unknown layer ${spec.layer}`);
    if (spec.layer === "site" && spec.consent !== "cookieless" && spec.consent !== "required")
      throw new Error(`dictionary: site event ${name} needs consent: cookieless | required`);
    const props = { ...(dict.common?.[spec.layer] ?? {}), ...spec.properties };
    for (const [p, ps] of Object.entries(props)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(p)) throw new Error(`dictionary: ${name}.${p} is a bad property name`);
      if (ps.type === "enum" && (!Array.isArray(ps.values) || ps.values.length === 0))
        throw new Error(`dictionary: ${name}.${p} enum has no values`);
    }
    events.set(name, { ...spec, props });
  }
  return { events };
}

export const schema = compile(dictionary as Dictionary);

/** Validates one event's properties. Returns the cleaned properties or a list of errors. */
export function validateProperties(
  spec: { props: Record<string, PropSpec> },
  input: unknown,
): { ok: true; properties: Record<string, unknown> } | { ok: false; errors: string[] } {
  if (input === undefined || input === null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["properties must be an object"] };
  const errors: string[] = [];
  const out: Record<string, unknown> = {};
  const given = input as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!(key in spec.props)) errors.push(`unknown property ${key}`);
  }
  for (const [key, ps] of Object.entries(spec.props)) {
    const value = given[key];
    if (value === undefined || value === null) {
      if (!ps.optional) errors.push(`missing property ${key}`);
      continue;
    }
    const err = checkValue(ps, value);
    if (err) errors.push(`${key}: ${err}`);
    else out[key] = value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, properties: out };
}
