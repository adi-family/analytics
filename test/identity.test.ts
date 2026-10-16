import { describe, expect, test } from "bun:test";
import { collectBatch, collectIdentify } from "../src/collect";
import { resolveIds, validateGroups } from "../src/identity";
import { uaFamily } from "../src/ua";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const AID = "0b7e6c1e-3f9a-4c2d-9b1a-2f6e8d4c5a71";
const INSTALL = "5f0c2a8e-1b3d-4e6f-8a9b-0c1d2e3f4a5b";
const APP_PROPS = { version: "1.30.0", os: "macos", arch: "aarch64" };
const ua = uaFamily("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15");

describe("browser consent", () => {
  test("without consent no id is stored, even if the page sends one", () => {
    const r = collectBatch("browser", { consent: false, anonymous_id: AID, distinct_id: "crm:user:7", events: [{ event: "page_view", properties: { path: "/" } }] }, { now: NOW, ua });
    if (!r.ok) throw new Error(r.error);
    expect(r.records[0]).toMatchObject({ anonymous_id: null, distinct_id: null, consent: false });
  });

  test("with consent the anonymous id is required and kept", () => {
    expect(resolveIds("browser", true, undefined, undefined)).toMatchObject({ ok: false });
    expect(resolveIds("browser", true, AID, undefined)).toEqual({ ok: true, ids: { anonymous_id: AID, distinct_id: null } });
  });

  test("consent-only events are refused without consent", () => {
    const r = collectBatch("browser", { events: [{ event: "app_linked", properties: { source: "welcome_link" } }] }, { now: NOW, ua });
    if (!r.ok) throw new Error(r.error);
    expect(r.rejected[0].errors).toEqual(["app_linked needs consent"]);
  });

  test("anonymous ids must be UUIDs", () => {
    expect(resolveIds("browser", true, "1.2.3.4", undefined)).toMatchObject({ ok: false });
    expect(resolveIds("browser", true, AID.toUpperCase(), undefined)).toMatchObject({ ok: false });
  });

  test("site events carry no groups", () => {
    expect(validateGroups("browser", { company: "acme" })).toMatchObject({ ok: false });
  });
});

describe("app and server identity", () => {
  test("app events need the install_id as distinct_id", () => {
    const send = (body: object) => collectBatch("app", body, { now: NOW, ua: null });
    const bad = send({ events: [{ event: "app_first_launch", properties: { fresh: true, ...APP_PROPS } }] });
    if (!bad.ok) throw new Error(bad.error);
    expect(bad.rejected[0].errors[0]).toContain("install_id");
    const good = send({ distinct_id: INSTALL, events: [{ event: "app_first_launch", properties: { fresh: true, ...APP_PROPS } }] });
    if (!good.ok) throw new Error(good.error);
    expect(good.records[0]).toMatchObject({ distinct_id: INSTALL, anonymous_id: null, consent: null, ua_browser: null });
  });

  test("a layer can only be sent from its own source", () => {
    const r = collectBatch("app", { distinct_id: INSTALL, events: [{ event: "crm_company_added", properties: { origin: "inbound" } }] }, { now: NOW, ua: null });
    if (!r.ok) throw new Error(r.error);
    expect(r.rejected[0].errors[0]).toContain("server-crm event");
    const s = collectBatch("server", { events: [{ event: "page_view", distinct_id: "x", properties: { path: "/" } }] }, { now: NOW, ua: null });
    if (!s.ok) throw new Error(s.error);
    expect(s.rejected).toHaveLength(1);
  });

  test("server events take a per-event distinct_id and groups", () => {
    const r = collectBatch(
      "server",
      { events: [{ event: "crm_stage_changed", distinct_id: "crm:company:42", groups: { company: "acme-gmbh" }, properties: { from_stage: "target", to_stage: "first_touch", referred: false } }] },
      { now: NOW, ua: null },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.records[0]).toMatchObject({ distinct_id: "crm:company:42", groups: { company: "acme-gmbh" } });
  });

  test("only company and deployment groups exist", () => {
    expect(validateGroups("server", { team: "x" })).toMatchObject({ ok: false });
    expect(validateGroups("app", { deployment: INSTALL })).toEqual({ ok: true, groups: { deployment: INSTALL } });
  });
});

describe("identify", () => {
  test("browser identify needs consent", () => {
    expect(collectIdentify("browser", { anonymous_id: AID, distinct_id: INSTALL }, { now: NOW })).toMatchObject({ ok: false, error: "identify needs consent" });
  });

  test("links the anonymous id to the known id", () => {
    const r = collectIdentify("browser", { consent: true, anonymous_id: AID, distinct_id: INSTALL }, { now: NOW });
    if (!r.ok) throw new Error(r.error);
    expect(r.record).toMatchObject({ type: "identify", event: null, anonymous_id: AID, distinct_id: INSTALL, layer: "site" });
  });

  test("the desktop app cannot identify; servers can", () => {
    expect(collectIdentify("app", { anonymous_id: AID, distinct_id: INSTALL }, { now: NOW })).toMatchObject({ ok: false });
    expect(collectIdentify("server", { anonymous_id: AID, distinct_id: "crm:user:7" }, { now: NOW })).toMatchObject({ ok: true });
  });

  test("rejects malformed and self-referencing aliases", () => {
    expect(collectIdentify("server", { anonymous_id: AID, distinct_id: AID }, { now: NOW })).toMatchObject({ ok: false });
    expect(collectIdentify("server", { anonymous_id: AID, distinct_id: "has space" }, { now: NOW })).toMatchObject({ ok: false });
    expect(collectIdentify("server", { anonymous_id: AID, distinct_id: "x", email: "a@b.c" }, { now: NOW })).toMatchObject({ ok: false });
  });
});

describe("user agent", () => {
  test("keeps only coarse families", () => {
    expect(ua).toEqual({ browser: "safari", os: "macos", device: "desktop", bot: false });
    expect(uaFamily("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36")).toMatchObject({ browser: "chrome", os: "android", device: "mobile" });
    expect(uaFamily("Mozilla/5.0 (compatible; Googlebot/2.1)").bot).toBe(true);
    expect(uaFamily(undefined).bot).toBe(true);
  });
});
