// The collector's routes, independent of the runtime: src/lambda.ts adapts API Gateway to
// this, scripts/dev.ts adapts Bun.serve.

import { bearer, keyMatches } from "./auth";
import { BATCH_LIMITS, collectBatch, collectIdentify, RECORD_WIRE, WEB_WIRE, type StoredRecord } from "./collect";
import { exportPage, type EventStore } from "./export";
import type { Source } from "./identity";
import { RateLimiter } from "./ratelimit";
import { PULL_CURSOR, ROUTES } from "./surface";
import { uaFamily } from "./ua";

export type Req = {
  method: string;
  path: string;
  headers: Record<string, string | undefined>; // lowercased names
  query: Record<string, string | undefined>;
  body: string;
  sourceIp?: string;
};

export type Res = { status: number; headers: Record<string, string>; body: string };

export interface Sink {
  put(records: StoredRecord[]): Promise<void>;
}

export type Config = {
  allowedOrigins: string[];
  writeKeyHashes: Buffer[];
  exportKeyHashes: Buffer[];
};

export type Deps = {
  config: Config;
  sink: Sink;
  store: EventStore;
  snippet: string;
  limiter?: RateLimiter;
  now?: () => number;
};

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function json(status: number, body: unknown, extra: Record<string, string> = {}): Res {
  return { status, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(body) };
}

function parse(body: string, maxBytes: number): { ok: true; value: unknown } | { ok: false; res: Res } {
  if (Buffer.byteLength(body, "utf8") > maxBytes) return { ok: false, res: json(413, { error: `body larger than ${maxBytes} bytes` }) };
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false, res: json(400, { error: "body is not JSON" }) };
  }
}

export function createApp(deps: Deps) {
  const limiter = deps.limiter ?? new RateLimiter(120, 60);
  const now = deps.now ?? Date.now;
  const { config } = deps;

  const corsHeaders = (origin: string | undefined): Record<string, string> =>
    origin && config.allowedOrigins.includes(origin)
      ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "false", vary: "Origin" }
      : {};

  // Who is calling: a browser on an allowed origin, the desktop app (no Origin header),
  // or a server holding the write key. A foreign Origin is refused outright. Each POST
  // route then accepts only the callers it is for.
  function sourceOf(req: Req, allowServer: boolean): Source | Res {
    const origin = req.headers["origin"];
    const key = bearer(req.headers);
    if (key) {
      if (allowServer && keyMatches(key, config.writeKeyHashes)) return "server";
      return json(401, { error: "bad write key" });
    }
    if (origin !== undefined) return config.allowedOrigins.includes(origin) ? "browser" : json(403, { error: "origin not allowed" });
    return "app";
  }

  const optedOut = (req: Req) => req.headers["sec-gpc"] === "1" || req.headers["dnt"] === "1";

  return async function handle(req: Req): Promise<Res> {
    const origin = req.headers["origin"];
    const cors = corsHeaders(origin);
    const route = `${req.method} ${req.path}`;

    if (req.method === "OPTIONS") {
      return {
        status: 204,
        headers: { ...cors, "access-control-allow-methods": "POST, GET", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" },
        body: "",
      };
    }
    if (route === `GET ${ROUTES.health}`) return json(200, { ok: true });
    if (route === `GET ${ROUTES.script}`)
      return {
        status: 200,
        headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" },
        body: deps.snippet,
      };

    const post = req.method === "POST" ? Object.entries(ROUTES).find(([, p]) => p === req.path)?.[0] : undefined;
    if (post === "web" || post === "app" || post === "server" || post === "link") {
      if (!limiter.allow(req.sourceIp, now())) return json(429, { error: "slow down" }, cors);
      const source = sourceOf(req, post === "server" || post === "link");
      if (typeof source !== "string") return { ...source, headers: { ...source.headers, ...cors } };
      if (post === "web" && source !== "browser") return json(403, { error: `${ROUTES.web} takes requests from an allowed Origin only` }, cors);
      if (post === "app" && source !== "app") return json(403, { error: `${ROUTES.app} is for the desktop app` }, cors);
      if (post === "server" && source !== "server") return json(401, { error: `${ROUTES.server} needs the write key` }, cors);
      if (post === "link" && source === "app") return json(401, { error: `${ROUTES.link} needs an allowed Origin or the write key` }, cors);
      // The browser speaks the plain-word wire format; the app and servers use record names.
      const wire = source === "browser" ? WEB_WIRE : RECORD_WIRE;

      const ua = source === "browser" ? uaFamily(req.headers["user-agent"]) : null;
      // Browser opt-outs win over anything the page sends. Answer 200 so nothing retries.
      if (source === "browser" && (optedOut(req) || ua?.bot)) return json(200, { accepted: 0, dropped: ua?.bot ? "bot" : "opt-out" }, cors);

      const parsed = parse(req.body, BATCH_LIMITS[source].bytes);
      if (!parsed.ok) return { ...parsed.res, headers: { ...parsed.res.headers, ...cors } };

      if (post === "link") {
        const r = collectIdentify(source, parsed.value, { now: now(), wire });
        if (!r.ok) return json(r.status, { error: r.error }, cors);
        await deps.sink.put([r.record]);
        return json(200, { accepted: 1 }, cors);
      }
      const r = collectBatch(source, parsed.value, { now: now(), ua, wire });
      if (!r.ok) return json(r.status, { error: r.error }, cors);
      if (r.records.length) await deps.sink.put(r.records);
      const status = r.records.length === 0 ? 400 : 200;
      return json(status, { accepted: r.records.length, rejected: r.rejected }, cors);
    }

    if (route === `GET ${ROUTES.pull}`) {
      if (!keyMatches(bearer(req.headers), config.exportKeyHashes)) return json(401, { error: "bad export key" });
      const page = await exportPage(deps.store, req.query[PULL_CURSOR]);
      if (!page.ok) return json(400, { error: page.error });
      return json(200, page);
    }

    return json(404, { error: "not found" }, cors);
  };
}
