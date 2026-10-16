// Runs the built, minified snippet against a fake window/document.
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

const SRC = await Bun.file(new URL("../dist/adi.min.js", import.meta.url)).text();

function browser(opts: { attrs?: Record<string, string>; cookies?: Record<string, string>; gpc?: boolean; search?: string; referrer?: string } = {}) {
  const jar = new Map(Object.entries(opts.cookies ?? {}));
  const written: string[] = [];
  const beacons: any[] = [];
  const fetches: { url: string; body: any }[] = [];
  const listeners: Record<string, () => void> = {};
  const attrs: Record<string, string> = opts.attrs ?? {};
  const document = {
    currentScript: { src: "https://t.withadi.dev/a.js", getAttribute: (n: string) => attrs[n] ?? null },
    referrer: opts.referrer ?? "",
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(s: string) {
      written.push(s);
      const [pair] = s.split(";");
      const [k, v] = pair.split("=");
      if (/Max-Age=0\b/.test(s)) jar.delete(k);
      else jar.set(k, v);
    },
  };
  const window: any = {
    navigator: {
      globalPrivacyControl: opts.gpc ?? false,
      sendBeacon: (url: string, blob: Blob) => {
        beacons.push({ url, blob });
        return true;
      },
    },
    location: { protocol: "https:", pathname: "/for-teams", search: opts.search ?? "", hostname: "withadi.dev" },
    crypto: globalThis.crypto,
    fetch: (url: string, init: any) => {
      fetches.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve();
    },
    addEventListener: (n: string, f: () => void) => (listeners[n] = f),
  };
  new Function("window", "document", SRC)(window, document);
  const sent = async () => Promise.all(beacons.map(async (b) => ({ url: b.url, body: JSON.parse(await b.blob.text()) })));
  return { window, jar, written, sent, fetches, pagehide: () => listeners.pagehide() };
}

describe("snippet", () => {
  test("stays under 3 KB gzipped", () => {
    expect(gzipSync(SRC).length).toBeLessThan(3 * 1024);
  });

  test("before consent: one page_view, no cookie, no ids", async () => {
    const b = browser({ search: "?utm_source=hn&email=a@b.c", referrer: "https://news.ycombinator.com/item?id=1" });
    b.pagehide();
    const [req] = await b.sent();
    expect(req.url).toBe("https://t.withadi.dev/e");
    expect(req.body.consent).toBe(false);
    expect(req.body.anonymous_id).toBeUndefined();
    expect(req.body.events[0]).toMatchObject({ event: "page_view", properties: { path: "/for-teams", utm_source: "hn", referring_domain: "news.ycombinator.com" } });
    expect(JSON.stringify(req.body)).not.toContain("email");
    expect(b.written).toEqual([]);
  });

  test("consent sets adi_aid for a year on .withadi.dev, SameSite=Lax", async () => {
    const b = browser({ attrs: { "data-pageview": "false" } });
    b.window.adi.consent(true);
    const set = b.written.find((c) => c.startsWith("adi_aid="))!;
    expect(set).toContain("Max-Age=31536000");
    expect(set).toContain("Domain=.withadi.dev");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Secure");
    b.window.adi.track("download_clicked", { platform: "macos", path: "/" });
    b.pagehide();
    const [req] = await b.sent();
    expect(req.body.consent).toBe(true);
    expect(req.body.anonymous_id).toBe(b.jar.get("adi_aid"));
  });

  test("a returning visitor with the cookie keeps the same id", async () => {
    const aid = "0b7e6c1e-3f9a-4c2d-9b1a-2f6e8d4c5a71";
    const b = browser({ cookies: { adi_aid: aid } });
    b.pagehide();
    expect((await b.sent())[0].body.anonymous_id).toBe(aid);
  });

  test("identify is ignored without consent and sent with it", () => {
    const b = browser({ attrs: { "data-pageview": "false" } });
    b.window.adi.identify("5f0c2a8e-1b3d-4e6f-8a9b-0c1d2e3f4a5b");
    expect(b.fetches).toHaveLength(0);
    b.window.adi.consent(true);
    b.window.adi.identify("5f0c2a8e-1b3d-4e6f-8a9b-0c1d2e3f4a5b");
    expect(b.fetches[0].url).toBe("https://t.withadi.dev/identify");
    expect(b.fetches[0].body).toMatchObject({ consent: true, distinct_id: "5f0c2a8e-1b3d-4e6f-8a9b-0c1d2e3f4a5b" });
  });

  test("withdrawing consent deletes the cookies", () => {
    const b = browser({ attrs: { "data-pageview": "false" } });
    b.window.adi.consent(true);
    b.window.adi.consent(false);
    expect(b.jar.has("adi_aid")).toBe(false);
  });

  test("Global Privacy Control: nothing is sent and nothing is stored", async () => {
    const b = browser({ gpc: true });
    b.window.adi.consent(true);
    b.window.adi.track("download_clicked", { platform: "linux", path: "/" });
    b.pagehide();
    expect(await b.sent()).toEqual([]);
    expect(b.written.every((c) => c.includes("Max-Age=0"))).toBe(true);
    expect(b.jar.size).toBe(0);
  });
});
