import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { pull } from "../clients/adi-pull";
import { createApp } from "../src/app";
import { hashKey } from "../src/auth";
import type { EventStore } from "../src/export";

const KEY = "k".repeat(32);

test("pulls incrementally into SQLite and dedupes on id", async () => {
  const objects: Record<string, Buffer> = {};
  const store: EventStore = {
    async list(prefix, after, max) {
      const keys = Object.keys(objects).filter((k) => k.startsWith(prefix) && (!after || k > after)).sort();
      return { keys: keys.slice(0, max), truncated: keys.length > max };
    },
    async get(k) {
      return objects[k];
    },
  };
  const put = (key: string, recs: object[]) => (objects[key] = gzipSync(recs.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  const rec = (id: string, event = "page_view") => ({ v: 1, type: "track", id, event, layer: "site", ts: "2026-10-16T00:00:00.000Z", received_at: "2026-10-16T00:00:00.000Z", anonymous_id: null, distinct_id: null, consent: false, properties: { path: "/" }, groups: null, ua_browser: "chrome", ua_os: "macos", ua_device: "desktop" });

  const handle = createApp({
    config: { allowedOrigins: [], writeKeyHashes: [], exportKeyHashes: [Buffer.from(hashKey(KEY), "hex")] },
    sink: { async put() {} },
    store,
    snippet: "",
  });
  const fakeFetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const res = await handle({
      method: "GET",
      path: url.pathname,
      headers: { authorization: (init?.headers as Record<string, string>).authorization },
      query: Object.fromEntries(url.searchParams),
      body: "",
    });
    return new Response(res.body, { status: res.status });
  }) as unknown as typeof fetch;

  const db = new Database(":memory:");
  put("events/dt=2026-10-16/s-1-2026-10-16-00-00-00-a.gz", [rec("a"), rec("b")]);
  expect(await pull(db, { url: "https://t.example", key: KEY, fetch: fakeFetch })).toEqual({ pages: 1, received: 2, added: 2 });

  put("events/dt=2026-10-16/s-1-2026-10-16-00-05-00-b.gz", [rec("b"), rec("c", "download_clicked")]);
  expect(await pull(db, { url: "https://t.example", key: KEY, fetch: fakeFetch })).toEqual({ pages: 1, received: 2, added: 1 });
  expect(await pull(db, { url: "https://t.example", key: KEY, fetch: fakeFetch })).toEqual({ pages: 1, received: 0, added: 0 });

  const rows = db.query("select id, event, json_extract(properties, '$.path') as path from analytics_events order by id").all();
  expect(rows).toEqual([
    { id: "a", event: "page_view", path: "/" },
    { id: "b", event: "page_view", path: "/" },
    { id: "c", event: "download_clicked", path: "/" },
  ]);

  await expect(pull(new Database(":memory:"), { url: "https://t.example", key: "wrong".repeat(8), fetch: fakeFetch })).rejects.toThrow("401");
});
