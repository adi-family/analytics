import { describe, expect, test } from "bun:test";
import { collectBatch } from "../src/collect";
import { compile, schema, validateProperties } from "../src/schema";
import { parseProperties } from "../scripts/sync-dictionary";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const AID = "0b7e6c1e-3f9a-4c2d-9b1a-2f6e8d4c5a71";
const INSTALL = "5f0c2a8e-1b3d-4e6f-8a9b-0c1d2e3f4a5b";
const ua = { browser: "firefox", os: "linux", device: "desktop" as const, bot: false };
const site = (events: unknown[], extra: object = {}) => collectBatch("browser", { consent: true, anonymous_id: AID, events, ...extra }, { now: NOW, ua });
const okBatch = (r: ReturnType<typeof collectBatch>) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("allowlist", () => {
  test("the shipped dictionary compiles and keeps its events", () => {
    for (const name of ["page_view", "download_clicked", "app_first_launch", "crm_company_added", "licence_activated"])
      expect(schema.events.has(name)).toBe(true);
  });

  test("an unknown event is rejected", () => {
    const r = okBatch(site([{ event: "button_clicked", properties: {} }]));
    expect(r.records).toHaveLength(0);
    expect(r.rejected[0].errors[0]).toContain("not in the allowlist");
  });

  test("vendor names are not accepted", () => {
    const r = okBatch(site([{ event: "$pageview", properties: { path: "/" } }]));
    expect(r.rejected).toHaveLength(1);
  });

  test("a known event with valid properties is stored", () => {
    const r = okBatch(site([{ event: "download_clicked", properties: { platform: "linux", path: "/" } }]));
    expect(r.rejected).toEqual([]);
    expect(r.records[0]).toMatchObject({ type: "track", event: "download_clicked", layer: "site", properties: { platform: "linux", path: "/" } });
  });

  test("unknown properties are rejected, not silently dropped", () => {
    const r = okBatch(site([{ event: "download_clicked", properties: { platform: "linux", path: "/", email: "a@b.c" } }]));
    expect(r.rejected[0].errors).toContain("unknown property email");
  });

  test("missing required properties are rejected; optional ones may be absent", () => {
    expect(okBatch(site([{ event: "download_clicked", properties: { path: "/" } }])).rejected[0].errors).toContain("missing property platform");
    expect(okBatch(site([{ event: "page_view", properties: { path: "/pricing" } }])).records).toHaveLength(1);
  });

  test("types and enums are enforced", () => {
    const bad = okBatch(site([{ event: "download_clicked", properties: { platform: "beos", path: "/" } }]));
    expect(bad.rejected[0].errors[0]).toContain("expected one of");
    const app = collectBatch(
      "app",
      { distinct_id: INSTALL, events: [{ event: "app_first_launch", properties: { fresh: "yes", version: "1.30.0", os: "linux", arch: "x86_64" } }] },
      { now: NOW, ua: null },
    );
    expect(okBatch(app).rejected[0].errors).toContain("fresh: expected a boolean");
  });

  test("paths cannot carry a query string or fragment", () => {
    for (const path of ["/x?email=a@b.c", "/x#top", "no-slash", "/a b"]) {
      expect(okBatch(site([{ event: "page_view", properties: { path } }])).rejected).toHaveLength(1);
    }
  });

  test("referring_domain must be a bare hostname", () => {
    expect(okBatch(site([{ event: "page_view", properties: { path: "/", referring_domain: "news.ycombinator.com" } }])).records).toHaveLength(1);
    expect(okBatch(site([{ event: "page_view", properties: { path: "/", referring_domain: "https://x.com/a" } }])).rejected).toHaveLength(1);
  });

  test("strings are length-limited and free of control characters", () => {
    const long = "a".repeat(201);
    expect(okBatch(site([{ event: "page_view", properties: { path: "/", utm_source: long } }])).rejected).toHaveLength(1);
    expect(okBatch(site([{ event: "page_view", properties: { path: "/", utm_source: "a\nb" } }])).rejected).toHaveLength(1);
  });

  test("common app properties are required on every app event", () => {
    const r = collectBatch("app", { distinct_id: INSTALL, events: [{ event: "fleet_invite_created", properties: {} }] }, { now: NOW, ua: null });
    expect(okBatch(r).rejected[0].errors).toEqual(["missing property version", "missing property os", "missing property arch"]);
  });

  test("a bad event does not sink the rest of the batch", () => {
    const r = okBatch(site([{ event: "page_view", properties: { path: "/" } }, { event: "nope" }]));
    expect(r.records).toHaveLength(1);
    expect(r.rejected.map((x) => x.index)).toEqual([1]);
  });

  test("unknown envelope fields are rejected", () => {
    expect(okBatch(site([{ event: "page_view", properties: { path: "/" }, ip: "1.2.3.4" }])).rejected[0].errors).toEqual(["unknown field ip"]);
  });

  test("batch limits", () => {
    const many = Array.from({ length: 51 }, () => ({ event: "page_view", properties: { path: "/" } }));
    expect(site(many)).toMatchObject({ ok: false, status: 413 });
    expect(collectBatch("browser", { events: [] }, { now: NOW, ua })).toMatchObject({ ok: false, status: 400 });
  });

  test("client timestamps outside the window fall back to arrival time", () => {
    const r = okBatch(site([
      { event: "page_view", properties: { path: "/" }, ts: "2026-10-16T11:59:00Z" },
      { event: "page_view", properties: { path: "/" }, ts: "2031-01-01T00:00:00Z" },
    ]));
    expect(r.records[0].ts).toBe("2026-10-16T11:59:00.000Z");
    expect(r.records[1].ts).toBe("2026-10-16T12:00:00.000Z");
    expect(okBatch(site([{ event: "page_view", properties: { path: "/" }, ts: "yesterday" }])).rejected).toHaveLength(1);
  });

  test("client ids must be UUIDs; missing ones are generated", () => {
    const r = okBatch(site([{ event: "page_view", properties: { path: "/" } }, { event: "page_view", properties: { path: "/" }, id: "x" }]));
    expect(r.records[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.rejected[0].errors).toEqual(["id must be a lowercase UUID"]);
  });
});

describe("dictionary compiler", () => {
  test("rejects a site event without a consent rule", () => {
    expect(() => compile({ events: { x_y: { layer: "site", properties: {} } } })).toThrow("consent");
  });

  test("adding an event is one entry", () => {
    const s = compile({ events: { cta_click: { layer: "site", consent: "cookieless", properties: { cta: { type: "slug" } } } } });
    const spec = s.events.get("cta_click")!;
    expect(validateProperties(spec, { cta: "hero-download" })).toEqual({ ok: true, properties: { cta: "hero-download" } });
  });
});

describe("sync-dictionary parser", () => {
  test("reads the free-text property lines from mb_events", () => {
    const p = parseProperties(
      [
        "path: string — URL path",
        "utm_source / utm_medium: string — only when present in the URL",
        "$referring_domain: string — PostHog default, the domain only",
        "runs_human, runs_agent: int — runs started",
        "status: paid | trialing | …",
        "source: welcome_link",
        "version, os, arch: string — sent on every app event",
      ].join("\n"),
    );
    expect(p).toEqual({
      path: { type: "path" },
      utm_source: { type: "string", optional: true },
      utm_medium: { type: "string", optional: true },
      referring_domain: { type: "hostname", optional: true },
      runs_human: { type: "int" },
      runs_agent: { type: "int" },
      status: { type: "token" },
      source: { type: "enum", values: ["welcome_link"] },
    });
  });
});
