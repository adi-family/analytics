// Content blockers must never block the collector. Every client-visible URL is matched,
// with a real filter engine, against a dated snapshot of the lists ad blockers and browsers
// ship (test/blocklists/, refreshed with `bun run refresh-blocklists`), both as the browser
// sees it (relay.withadi.dev, first party) and as uBlock Origin on Firefox sees it after
// uncloaking the CNAME (an API Gateway host, third party).
import { describe, expect, test } from "bun:test";
import { FiltersEngine, Request } from "@ghostery/adblocker";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WEB_WIRE } from "../src/collect";
import { BANNED_WORDS, COOKIES, GLOBAL, HOST, METHODS, PULL_CURSOR, ROUTES } from "../src/surface";

const DIR = join(import.meta.dir, "blocklists");
const snapshot = JSON.parse(readFileSync(join(DIR, "snapshot.json"), "utf8"));
const lists = readdirSync(DIR)
  .filter((f) => f.endsWith(".txt"))
  .map((f) => {
    const text = readFileSync(join(DIR, f), "utf8");
    return { name: f.replace(/\.txt$/, ""), text, engine: FiltersEngine.parse(text, { loadCosmeticFilters: false, debug: true }) };
  });

// The custom domain's CNAME target, and the API's own default hostname.
const AWS_HOSTS = ["d-k3x9q2w7zp.execute-api.eu-central-1.amazonaws.com", "k3x9q2w7zp.execute-api.eu-central-1.amazonaws.com"];
const PAGES = ["https://withadi.dev/", "https://www.withadi.dev/for-teams"];

const urls = (host: string) => [
  { url: `https://${host}${ROUTES.script}`, types: ["script"] },
  ...[ROUTES.web, ROUTES.link, ROUTES.app, ROUTES.server, ROUTES.health, `${ROUTES.pull}?${PULL_CURSOR}=ZXZlbnRzL2R0PTIwMjYtMTAtMTY`].map((p) => ({
    url: `https://${host}${p}`,
    types: ["xmlhttprequest", "fetch", "other"],
  })),
  { url: `https://${host}/`, types: ["document", "other"] },
];

function blockers(url: string, type: string, page: string): string[] {
  const hits: string[] = [];
  for (const l of lists) {
    const r = l.engine.match(Request.fromRawDetails({ url, type: type as any, sourceUrl: page }));
    if (r.match || r.redirect) hits.push(`${l.name}: ${r.filter?.toString()}`);
  }
  return hits;
}

describe(`blocklists (snapshot of ${snapshot.fetched})`, () => {
  test("the snapshot holds every list it should, each with rules", () => {
    expect(lists.map((l) => l.name).sort()).toEqual(Object.keys(snapshot.lists).sort());
    for (const l of lists) expect(l.engine.getFilters().networkFilters.length + l.text.split("\n").length).toBeGreaterThan(3);
  });

  // If these stop matching, the engine or the snapshot is broken and every other test here
  // would pass for the wrong reason.
  test("controls: known tracker URLs are blocked", () => {
    expect(blockers(`https://${HOST}/collect?event=x`, "xmlhttprequest", PAGES[0])).not.toEqual([]);
    expect(blockers(`https://${HOST}/beacon.js`, "script", PAGES[0])).not.toEqual([]);
    expect(blockers(`https://${AWS_HOSTS[0]}/beacon`, "xmlhttprequest", PAGES[0])).not.toEqual([]);
    expect(blockers(`https://${AWS_HOSTS[0]}/event`, "xmlhttprequest", PAGES[0])).not.toEqual([]);
    // Why the snippet never calls navigator.sendBeacon: once uncloaked, it is a third-party ping.
    expect(blockers(`https://${AWS_HOSTS[0]}${ROUTES.web}`, "ping", PAGES[0])).not.toEqual([]);
  });

  for (const host of [HOST, ...AWS_HOSTS])
    test(`no rule blocks ${host}`, () => {
      const hits: string[] = [];
      for (const { url, types } of urls(host))
        for (const type of types) for (const page of PAGES) for (const h of blockers(url, type, page)) hits.push(`${url} (${type}) ← ${h}`);
      expect([...new Set(hits)]).toEqual([]);
    });

  test("no generic scriptlet names the snippet's global or cookies", () => {
    const names = [`${GLOBAL}.`, `window.${GLOBAL}`, ...Object.values(COOKIES)];
    const hits = lists.flatMap((l) =>
      l.text.split("\n").filter((r) => /^#[@]?(%#|#\+js\(|\$#)/.test(r) && names.some((n) => r.includes(n))).map((r) => `${l.name}: ${r}`),
    );
    expect(hits).toEqual([]);
  });
});

describe("client-visible vocabulary", () => {
  const visible = [
    ...HOST.split(".").slice(0, -2),
    ...Object.values(ROUTES),
    PULL_CURSOR,
    ...Object.values(COOKIES),
    GLOBAL,
    ...METHODS,
    ...(WEB_WIRE.top ?? []),
    ...WEB_WIRE.itemFields,
  ];

  test("no name a browser sees uses a tracker word", () => {
    const bad = visible.filter((n) => BANNED_WORDS.some((w) => n.toLowerCase().includes(w)));
    expect(bad).toEqual([]);
  });

  test("the built snippet sends only to the routes in src/surface.ts", async () => {
    const src = await Bun.file(join(import.meta.dir, "..", "dist", "web.min.js")).text();
    for (const p of [ROUTES.web, ROUTES.link, ...Object.values(COOKIES)]) expect(src).toContain(`"${p}"`);
    // doNotTrack is the browser's own API, read to honour the opt-out.
    expect(src.replaceAll("doNotTrack", "")).not.toMatch(/analytic|sendBeacon|anonymous|distinct|identify|track/i);
  });
});
