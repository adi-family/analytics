// Runs the built, minified snippet against a fake window/document.
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { METHODS } from "../src/surface";

const SRC = await Bun.file(new URL("../dist/web.min.js", import.meta.url)).text();

function browser(opts: { attrs?: Record<string, string>; cookies?: Record<string, string>; gpc?: boolean; search?: string; referrer?: string } = {}) {
  const jar = new Map(Object.entries(opts.cookies ?? {}));
  const written: string[] = [];
  const beacons: string[] = [];
  const fetches: { url: string; body: any }[] = [];
  const listeners: Record<string, () => void> = {};
  const attrs: Record<string, string> = opts.attrs ?? {};
  const document = {
    currentScript: { src: "https://relay.withadi.dev/web.js", getAttribute: (n: string) => attrs[n] ?? null },
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
      sendBeacon: (url: string) => {
        beacons.push(url);
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
  const sent = () => fetches.filter((f) => f.url.endsWith("/v1/web"));
  return { window, jar, written, sent, fetches, beacons, pagehide: () => listeners.pagehide() };
}

describe("snippet", () => {
  test("stays under 3 KB gzipped", () => {
    expect(gzipSync(SRC).length).toBeLessThan(3 * 1024);
  });

  test("before consent: one page_view, no cookie, no ids", () => {
    const b = browser({ search: "?utm_source=hn&email=a@b.c", referrer: "https://news.ycombinator.com/item?id=1" });
    b.pagehide();
    const [req] = b.sent();
    expect(req.url).toBe("https://relay.withadi.dev/v1/web");
    expect(req.body.consent).toBe(false);
    expect(req.body.browser_id).toBeUndefined();
    expect(req.body.items[0]).toMatchObject({ name: "page_view", props: { path: "/for-teams", utm_source: "hn", referring_domain: "news.ycombinator.com" } });
    expect(JSON.stringify(req.body)).not.toContain("email");
    expect(b.written).toEqual([]);
  });

  test("never uses sendBeacon, which EasyPrivacy blocks as a third-party ping", () => {
    const b = browser();
    b.window.adi.send("download_clicked", { platform: "macos", path: "/" });
    b.pagehide();
    expect(b.beacons).toEqual([]);
    expect(b.sent()).toHaveLength(1);
    expect(SRC).not.toContain("sendBeacon");
  });

  test("the page sees only neutral names", () => {
    const b = browser({ attrs: { "data-pageview": "false" } });
    expect(Object.keys(b.window.adi).sort()).toEqual([...METHODS].sort());
  });

  test("consent sets adi_id for a year on .withadi.dev, SameSite=Lax", async () => {
    const b = browser({ attrs: { "data-pageview": "false" } });
    b.window.adi.consent(true);
    const set = b.written.find((c) => c.startsWith("adi_id="))!;
    expect(set).toContain("Max-Age=31536000");
    expect(set).toContain("Domain=.withadi.dev");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Secure");
    b.window.adi.send("download_clicked", { platform: "macos", path: "/" });
    b.pagehide();
    const [req] = b.sent();
    expect(req.body.consent).toBe(true);
    expect(req.body.browser_id).toBe(b.jar.get("adi_id"));
  });

  test("a returning visitor with the cookie keeps the same id", async () => {
    const aid = "0b7e6c1e-3f9a-4c2d-9b1a-2f6e8d4c5a71";
    const b = browser({ cookies: { adi_id: aid } });
    b.pagehide();
    expect((b.sent())[0].body.browser_id).toBe(aid);
  });

  test("link is ignored without consent and sent with it", () => {
    const b = browser({ attrs: { "data-pageview": "false" } });
    b.window.adi.link("5f0c2a8e-1b3d-4e6f-8a9b-0c1d2e3f4a5b");
    expect(b.fetches).toHaveLength(0);
    b.window.adi.consent(true);
    b.window.adi.link("5f0c2a8e-1b3d-4e6f-8a9b-0c1d2e3f4a5b");
    expect(b.fetches[0].url).toBe("https://relay.withadi.dev/v1/link");
    expect(b.fetches[0].body).toMatchObject({ consent: true, browser_id: b.jar.get("adi_id"), known_id: "5f0c2a8e-1b3d-4e6f-8a9b-0c1d2e3f4a5b" });
  });

  test("withdrawing consent deletes the cookies", () => {
    const b = browser({ attrs: { "data-pageview": "false" } });
    b.window.adi.consent(true);
    b.window.adi.consent(false);
    expect(b.jar.has("adi_id")).toBe(false);
    expect(b.jar.has("adi_link")).toBe(false);
  });

  test("Global Privacy Control: nothing is sent and nothing is stored", async () => {
    const b = browser({ gpc: true });
    b.window.adi.consent(true);
    b.window.adi.send("download_clicked", { platform: "linux", path: "/" });
    b.pagehide();
    expect(b.sent()).toEqual([]);
    expect(b.written.every((c) => c.includes("Max-Age=0"))).toBe(true);
    expect(b.jar.size).toBe(0);
  });
});
