#!/usr/bin/env bun
// Pulls new events from the collector's GET /export into a SQLite database, incrementally.
// Run it as often as you like: it resumes from the stored cursor and upserts on the record id,
// so a repeated page is harmless.
//
//   ANALYTICS_URL=https://t.withadi.dev ANALYTICS_EXPORT_KEY=... \
//     bun clients/adi-pull.ts "$(adi-db path --project adi-analytics)"
//
// Optional: ANALYTICS_SINCE=YYYY-MM-DD for the very first pull (default: everything kept).

import { Database } from "bun:sqlite";

export const SCHEMA = `
create table if not exists analytics_events (
  id           text primary key,
  type         text not null,             -- track | identify
  event        text,                      -- null for identify
  layer        text not null,
  ts           text not null,             -- client time (clamped), ISO 8601
  received_at  text not null,
  anonymous_id text,
  distinct_id  text,
  consent      integer,
  properties   text not null default '{}', -- JSON
  groups_json  text,                       -- JSON or null
  ua_browser   text,
  ua_os        text,
  ua_device    text
);
create index if not exists analytics_events_event_ts on analytics_events(event, ts);
create index if not exists analytics_events_distinct on analytics_events(distinct_id);
create index if not exists analytics_events_anonymous on analytics_events(anonymous_id);
create table if not exists analytics_cursor (
  name       text primary key,
  cursor     text not null,
  updated_at text not null
);
`;

type Rec = Record<string, any>;

export async function pull(db: Database, opts: { url: string; key: string; since?: string; fetch?: typeof fetch }) {
  db.exec(SCHEMA);
  const f = opts.fetch ?? fetch;
  const row = db.query("select cursor from analytics_cursor where name = 'export'").get() as { cursor: string } | null;
  let cursor = row?.cursor ?? opts.since ?? "";
  const insert = db.prepare(
    `insert into analytics_events (id, type, event, layer, ts, received_at, anonymous_id, distinct_id, consent, properties, groups_json, ua_browser, ua_os, ua_device)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do nothing`,
  );
  const saveCursor = db.prepare(
    "insert into analytics_cursor (name, cursor, updated_at) values ('export', ?, ?) on conflict(name) do update set cursor = excluded.cursor, updated_at = excluded.updated_at",
  );
  let pages = 0, received = 0, added = 0;
  for (;;) {
    const res = await f(`${opts.url.replace(/\/$/, "")}/export${cursor ? `?since=${encodeURIComponent(cursor)}` : ""}`, {
      headers: { authorization: `Bearer ${opts.key}` },
    });
    if (!res.ok) throw new Error(`export answered ${res.status}: ${await res.text()}`);
    const page = (await res.json()) as { records: Rec[]; cursor: string | null; more: boolean };
    db.transaction(() => {
      for (const r of page.records) {
        const changes = insert.run(
          r.id, r.type, r.event ?? null, r.layer, r.ts, r.received_at, r.anonymous_id ?? null, r.distinct_id ?? null,
          r.consent == null ? null : r.consent ? 1 : 0, JSON.stringify(r.properties ?? {}), r.groups ? JSON.stringify(r.groups) : null,
          r.ua_browser ?? null, r.ua_os ?? null, r.ua_device ?? null,
        ).changes;
        added += changes;
      }
      if (page.cursor) saveCursor.run(page.cursor, new Date().toISOString());
    })();
    pages++;
    received += page.records.length;
    if (!page.more || !page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  }
  return { pages, received, added };
}

if (import.meta.main) {
  const path = process.argv[2];
  const url = process.env.ANALYTICS_URL;
  const key = process.env.ANALYTICS_EXPORT_KEY;
  if (!path || !url || !key) {
    console.error("usage: ANALYTICS_URL=... ANALYTICS_EXPORT_KEY=... bun clients/adi-pull.ts <sqlite file>");
    process.exit(2);
  }
  const db = new Database(path);
  db.exec("pragma busy_timeout = 5000");
  const r = await pull(db, { url, key, since: process.env.ANALYTICS_SINCE });
  console.log(`pulled ${r.received} records in ${r.pages} page(s), ${r.added} new`);
}
