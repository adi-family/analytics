#!/usr/bin/env bun
// Regenerates dictionary/events.json from the marketing branch's event dictionary
// (table mb_events). Input: a JSON array of mb_events rows, from a file argument or
// stdin, e.g.
//
//   sqlite3 -json "$(adi-db path --project adi-marketing-branch)" \
//     "select * from mb_events order by position" | bun scripts/sync-dictionary.ts
//
// The dictionary describes properties as free text, one `name: type — meaning` per line.
// This script turns that into strict schemas. Anything vendor-specific ($-prefixed
// names) is renamed. Hand edits to events.json are fine; rerunning this overwrites them,
// so put lasting rules in the tables below.

type Row = { name: string; position: number; layer: string; funnel_id: string; properties: string; fires_when: string; gate: string };

type Prop =
  | { type: "string" | "token" | "path" | "hostname" | "slug" | "int" | "bool"; optional?: true; max?: number }
  | { type: "enum"; values: string[]; optional?: true };

const EVENT_RENAMES: Record<string, string> = { $pageview: "page_view" };
const PROP_RENAMES: Record<string, string> = { $referring_domain: "referring_domain" };

// Property names whose format is stricter than "string".
const FORMATS: Record<string, Exclude<Prop["type"], "enum">> = {
  path: "path",
  referring_domain: "hostname",
  slug: "slug",
  backend: "token",
};

// Sent with every app event; declared once under `common.app`.
const COMMON_APP: Record<string, Prop> = {
  version: { type: "token" },
  os: { type: "enum", values: ["macos", "linux", "windows"] },
  arch: { type: "token" },
};

const OPTIONAL_HINT = /only when present|omitted|when given|default/i;

export function parseProperties(text: string): Record<string, Prop> {
  const out: Record<string, Prop> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("(")) continue; // "(none beyond version, os, arch)"
    const colon = line.indexOf(":");
    if (colon < 0) throw new Error(`cannot parse property line: ${line}`);
    const names = line.slice(0, colon).split(/[,/]/).map((s) => s.trim()).filter(Boolean);
    const rest = line.slice(colon + 1);
    const [typePart, meaning = ""] = rest.split(" — ");
    const t = typePart.trim();
    for (const original of names) {
      const name = PROP_RENAMES[original] ?? original;
      if (name in COMMON_APP && /every app event/.test(meaning)) continue;
      let prop: Prop;
      if (t.includes("|") && !t.includes("…")) {
        prop = { type: "enum", values: t.split("|").map((v) => v.trim()) };
      } else if (t.includes("|")) {
        prop = { type: "token" }; // open enum: "paid | trialing | …"
      } else if (t === "bool") {
        prop = { type: "bool" };
      } else if (t === "int") {
        prop = { type: "int" };
      } else if (t === "string") {
        prop = { type: FORMATS[name] ?? "string" };
        if (/\(.*\|.*…\)/.test(meaning)) prop = { type: "token" }; // "string — the status (paid | trialing | …)"
      } else if (/^[a-z_]+$/.test(t)) {
        prop = { type: "enum", values: [t] }; // a single literal, e.g. "source: welcome_link"
      } else {
        throw new Error(`unknown type "${t}" in: ${line}`);
      }
      if (OPTIONAL_HINT.test(meaning)) prop.optional = true;
      out[name] = prop;
    }
  }
  return out;
}

export function buildDictionary(rows: Row[]) {
  const events: Record<string, unknown> = {};
  for (const row of [...rows].sort((a, b) => a.position - b.position)) {
    const name = EVENT_RENAMES[row.name] ?? row.name;
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) throw new Error(`bad event name: ${row.name}`);
    const entry: Record<string, unknown> = { layer: row.layer, funnel: row.funnel_id };
    if (row.layer === "site") entry.consent = /Accept required/i.test(row.gate) ? "required" : "cookieless";
    entry.description = row.fires_when.split("\n")[0].replace(/\s*\(capture_pageview[^)]*\)?/, "").trim();
    entry.properties = parseProperties(row.properties);
    events[name] = entry;
  }
  return {
    $comment:
      "The allowlist. An event or property not listed here is rejected by the collector. Generated from mb_events by scripts/sync-dictionary.ts; hand edits are allowed.",
    common: { app: COMMON_APP },
    events,
  };
}

if (import.meta.main) {
  const input = process.argv[2] ? await Bun.file(process.argv[2]).text() : await Bun.stdin.text();
  const dict = buildDictionary(JSON.parse(input));
  const target = new URL("../dictionary/events.json", import.meta.url).pathname;
  await Bun.write(target, JSON.stringify(dict, null, 2) + "\n");
  console.log(`wrote ${Object.keys(dict.events).length} events to dictionary/events.json`);
}
