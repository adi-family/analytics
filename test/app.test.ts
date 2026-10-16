import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { createApp, type Req } from "../src/app";
import { hashKey } from "../src/auth";
import type { StoredRecord } from "../src/collect";
import { encodeCursor, exportPage, type EventStore } from "../src/export";
import { RateLimiter } from "../src/ratelimit";

const AID = "0b7e6c1e-3f9a-4c2d-9b1a-2f6e8d4c5a71";
const INSTALL = "5f0c2a8e-1b3d-4e6f-8a9b-0c1d2e3f4a5b";
const WRITE = "w".repeat(32);
const EXPORT = "x".repeat(32);
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";

function memoryStore(objects: Record<string, string[]>): EventStore {
  return {
    async list(prefix, startAfter, max) {
      const keys = Object.keys(objects).filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort();
      return { keys: keys.slice(0, max), truncated: keys.length > max };
    },
    async get(key) {
      return gzipSync(objects[key].join("\n") + "\n");
    },
  };
}

function setup(opts: { limiter?: RateLimiter; store?: EventStore } = {}) {
  const stored: StoredRecord[] = [];
  const handle = createApp({
    config: { allowedOrigins: ["https://withadi.dev"], writeKeyHashes: [Buffer.from(hashKey(WRITE), "hex")], exportKeyHashes: [Buffer.from(hashKey(EXPORT), "hex")] },
    sink: { async put(r) { stored.push(...r); } },
    store: opts.store ?? memoryStore({}),
    snippet: "/*snippet*/",
    limiter: opts.limiter,
    now: () => Date.parse("2026-10-16T12:00:00Z"),
  });
  const call = (method: string, path: string, body: unknown = "", headers: Record<string, string> = {}, query: Record<string, string> = {}) =>
    handle({ method, path, headers, query, body: typeof body === "string" ? body : JSON.stringify(body), sourceIp: "203.0.113.9" } as Req);
  return { call, stored };
}

const browser = { origin: "https://withadi.dev", "user-agent": FIREFOX, "content-type": "text/plain" };
const pv = { consent: true, browser_id: AID, items: [{ name: "page_view", props: { path: "/" } }] };
const appBatch = { distinct_id: INSTALL, events: [{ event: "app_daily_active", properties: { runs_human: 3, runs_agent: 1, runs_automation: 0, version: "1.30.0", os: "linux", arch: "x86_64" } }] };

describe("POST /v1/web", () => {
  test("accepts site events from an allowed origin and answers with CORS", async () => {
    const { call, stored } = setup();
    const res = await call("POST", "/v1/web", pv, browser);
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://withadi.dev");
    expect(stored[0]).toMatchObject({ event: "page_view", ua_browser: "firefox", ua_os: "linux", anonymous_id: AID });
  });

  test("refuses a foreign origin", async () => {
    const { call, stored } = setup();
    const res = await call("POST", "/v1/web", pv, { ...browser, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(stored).toHaveLength(0);
  });

  test("takes the plain-word wire format only, strictly", async () => {
    const { call, stored } = setup();
    const old = { consent: true, anonymous_id: AID, events: [{ event: "page_view", properties: { path: "/" } }] };
    expect(JSON.parse((await call("POST", "/v1/web", old, browser)).body).error).toBe("unknown field anonymous_id");
    const res = await call("POST", "/v1/web", { items: [{ event: "page_view", props: { path: "/" } }] }, browser);
    expect(JSON.parse(res.body).rejected[0].errors).toEqual(["unknown field event"]);
    const bad = await call("POST", "/v1/web", { consent: true, browser_id: "nope", items: pv.items }, browser);
    expect(JSON.parse(bad.body).rejected[0].errors).toEqual(["browser_id must be a lowercase UUID"]);
    expect(stored).toHaveLength(0);
  });

  test("site events with consent keep the ids; without it they are dropped", async () => {
    const { call, stored } = setup();
    await call("POST", "/v1/web", { ...pv, known_id: "crm:user:7" }, browser);
    await call("POST", "/v1/web", { ...pv, consent: false }, browser);
    expect(stored.map((r) => [r.anonymous_id, r.distinct_id, r.consent])).toEqual([[AID, "crm:user:7", true], [null, null, false]]);
  });

  test("without an Origin it is refused: that is the app's route", async () => {
    const { call, stored } = setup();
    expect((await call("POST", "/v1/web", pv)).status).toBe(403);
    expect(stored).toHaveLength(0);
  });

  test("GPC, DNT and bots are dropped server-side too", async () => {
    const { call, stored } = setup();
    expect(JSON.parse((await call("POST", "/v1/web", pv, { ...browser, "sec-gpc": "1" })).body)).toEqual({ accepted: 0, dropped: "opt-out" });
    expect(JSON.parse((await call("POST", "/v1/web", pv, { ...browser, dnt: "1" })).body).dropped).toBe("opt-out");
    expect(JSON.parse((await call("POST", "/v1/web", pv, { ...browser, "user-agent": "curl/8.0" })).body).dropped).toBe("bot");
    expect(stored).toHaveLength(0);
  });

  test("size limit and bad JSON", async () => {
    const { call } = setup();
    expect((await call("POST", "/v1/web", "x".repeat(40 * 1024), browser)).status).toBe(413);
    expect((await call("POST", "/v1/web", "{not json", browser)).status).toBe(400);
  });

  test("a write key on /v1/web is refused rather than ignored", async () => {
    const { call } = setup();
    expect((await call("POST", "/v1/web", pv, { authorization: `Bearer ${WRITE}` })).status).toBe(401);
  });

  test("rate limit", async () => {
    const { call } = setup({ limiter: new RateLimiter(1, 2) });
    expect((await call("POST", "/v1/web", pv, browser)).status).toBe(200);
    expect((await call("POST", "/v1/web", pv, browser)).status).toBe(200);
    expect((await call("POST", "/v1/web", pv, browser)).status).toBe(429);
  });

  test("nothing about the address is stored", async () => {
    const { call, stored } = setup();
    await call("POST", "/v1/web", pv, browser);
    expect(JSON.stringify(stored)).not.toContain("203.0.113.9");
    expect(JSON.stringify(stored)).not.toContain("Firefox/131");
  });
});

describe("POST /v1/app", () => {
  test("the desktop app (no Origin) may send only app events", async () => {
    const { call, stored } = setup();
    expect((await call("POST", "/v1/app", appBatch)).status).toBe(200);
    const site = { events: [{ event: "page_view", properties: { path: "/" } }] };
    expect(JSON.parse((await call("POST", "/v1/app", site)).body).rejected[0].errors[0]).toContain("cannot be sent here");
    expect(stored).toHaveLength(1);
    expect(stored[0].ua_browser).toBeNull();
  });

  test("a page cannot post app events", async () => {
    const { call, stored } = setup();
    expect((await call("POST", "/v1/app", appBatch, browser)).status).toBe(403);
    expect(stored).toHaveLength(0);
  });
});

describe("POST /v1/server", () => {
  const crm = { events: [{ event: "crm_company_added", distinct_id: "crm:company:42", properties: { origin: "inbound" } }] };

  test("needs the write key", async () => {
    const { call, stored } = setup();
    expect((await call("POST", "/v1/server", crm)).status).toBe(401);
    expect((await call("POST", "/v1/server", crm, { authorization: "Bearer " + "z".repeat(32) })).status).toBe(401);
    expect((await call("POST", "/v1/server", crm, { authorization: `Bearer ${WRITE}` })).status).toBe(200);
    expect(stored).toHaveLength(1);
  });
});

describe("POST /v1/link", () => {
  test("from the site with consent, in the browser's wire format", async () => {
    const { call, stored } = setup();
    const res = await call("POST", "/v1/link", { consent: true, browser_id: AID, known_id: INSTALL }, browser);
    expect(res.status).toBe(200);
    expect(stored[0]).toMatchObject({ type: "identify", anonymous_id: AID, distinct_id: INSTALL });
  });

  test("from a server with the write key, in record names", async () => {
    const { call, stored } = setup();
    const res = await call("POST", "/v1/link", { anonymous_id: AID, distinct_id: "crm:user:7" }, { authorization: `Bearer ${WRITE}` });
    expect(res.status).toBe(200);
    expect(stored[0]).toMatchObject({ type: "identify", layer: "server", anonymous_id: AID, distinct_id: "crm:user:7" });
  });

  test("refused without origin or key, and without consent", async () => {
    const { call } = setup();
    expect((await call("POST", "/v1/link", { consent: true, browser_id: AID, known_id: INSTALL })).status).toBe(401);
    expect((await call("POST", "/v1/link", { browser_id: AID, known_id: INSTALL }, browser)).status).toBe(400);
    expect((await call("POST", "/v1/link", { consent: true, anonymous_id: AID, distinct_id: INSTALL }, browser)).status).toBe(400);
  });
});

describe("GET /web.js and /v1/pull", () => {
  test("serves the snippet", async () => {
    const res = await setup().call("GET", "/web.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
  });

  test("export needs the export key, not the write key", async () => {
    const { call } = setup();
    expect((await call("GET", "/v1/pull")).status).toBe(401);
    expect((await call("GET", "/v1/pull", "", { authorization: `Bearer ${WRITE}` })).status).toBe(401);
    expect((await call("GET", "/v1/pull", "", { authorization: `Bearer ${EXPORT}` })).status).toBe(200);
  });

  test("unknown routes 404, the old names included", async () => {
    const { call } = setup();
    expect((await call("GET", "/")).status).toBe(404);
    for (const [m, p] of [["POST", "/e"], ["POST", "/s"], ["POST", "/identify"], ["GET", "/a.js"], ["GET", "/export"]])
      expect((await call(m, p, pv, browser)).status).toBe(404);
  });
});

describe("export cursor", () => {
  const line = (id: string) => JSON.stringify({ v: 1, type: "track", id });
  const objects = {
    "events/dt=2026-10-15/adi-analytics-1-2026-10-15-23-55-00-a.gz": [line("1"), line("2")],
    "events/dt=2026-10-16/adi-analytics-1-2026-10-16-00-05-00-b.gz": [line("3")],
    "events/dt=2026-10-16/adi-analytics-1-2026-10-16-00-10-00-c.gz": [line("4")],
    "errors/x.gz": [line("err")],
  };

  test("pages through objects in key order and resumes after the cursor", async () => {
    const store = memoryStore(objects);
    const first = await exportPage(store, undefined, { objects: 2, records: 100 });
    if (!first.ok) throw new Error(first.error);
    expect(first.records.map((r: any) => r.id)).toEqual(["1", "2", "3"]);
    expect(first.more).toBe(true);
    const second = await exportPage(store, first.cursor!, { objects: 2, records: 100 });
    if (!second.ok) throw new Error(second.error);
    expect(second.records.map((r: any) => r.id)).toEqual(["4"]);
    expect(second.more).toBe(false);
    const third = await exportPage(store, second.cursor!, { objects: 2, records: 100 });
    if (!third.ok) throw new Error(third.error);
    expect(third).toMatchObject({ records: [], cursor: second.cursor, more: false });
  });

  test("a bare date starts at that day; error objects are never exported", async () => {
    const page = await exportPage(memoryStore(objects), "2026-10-16");
    if (!page.ok) throw new Error(page.error);
    expect(page.records.map((r: any) => r.id)).toEqual(["3", "4"]);
  });

  test("the record cap stops between objects and says there is more", async () => {
    const page = await exportPage(memoryStore(objects), undefined, { objects: 10, records: 2 });
    if (!page.ok) throw new Error(page.error);
    expect(page.records).toHaveLength(2);
    expect(page.more).toBe(true);
  });

  test("rejects cursors outside the events prefix", async () => {
    expect(await exportPage(memoryStore(objects), encodeCursor("errors/x.gz"))).toMatchObject({ ok: false });
    expect(await exportPage(memoryStore(objects), "../../etc")).toMatchObject({ ok: false });
  });
});
