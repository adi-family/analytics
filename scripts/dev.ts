#!/usr/bin/env bun
// Local collector: the same routes as the Lambda, writing gzip JSONL objects into .dev/
// with the S3 key layout Firehose uses, so /export behaves as it does in AWS.
//
//   ANALYTICS_WRITE_KEY=... ANALYTICS_EXPORT_KEY=... bun run dev     (PORT, default 8787)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { createApp } from "../src/app";
import { hashKey } from "../src/auth";
import type { EventStore } from "../src/export";

const root = join(import.meta.dir, "..", ".dev");
const port = Number(process.env.PORT ?? 8787);
const hashes = (k: string | undefined) => (k ? [Buffer.from(hashKey(k), "hex")] : []);

const store: EventStore = {
  async list(prefix, startAfter, max) {
    const walk = (dir: string): string[] => {
      try {
        return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
      } catch {
        return [];
      }
    };
    const keys = walk(join(root, prefix)).map((f) => relative(root, f)).filter((k) => !startAfter || k > startAfter).sort();
    return { keys: keys.slice(0, max), truncated: keys.length > max };
  },
  async get(key) {
    return readFileSync(join(root, key));
  },
};

let seq = 0;
const handle = createApp({
  config: {
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "https://withadi.dev,http://localhost:4321").split(","),
    writeKeyHashes: hashes(process.env.ANALYTICS_WRITE_KEY),
    exportKeyHashes: hashes(process.env.ANALYTICS_EXPORT_KEY),
  },
  sink: {
    async put(records) {
      const now = new Date();
      const stamp = now.toISOString().replace(/[T:]/g, "-").slice(0, 19);
      const key = `events/dt=${now.toISOString().slice(0, 10)}/adi-analytics-dev-1-${stamp}-${String(seq++).padStart(6, "0")}.gz`;
      mkdirSync(dirname(join(root, key)), { recursive: true });
      writeFileSync(join(root, key), gzipSync(records.map((r) => JSON.stringify(r)).join("\n") + "\n"));
    },
  },
  store,
  snippet: await Bun.file(join(import.meta.dir, "..", "dist", "adi.min.js")).text(),
});

Bun.serve({
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => (headers[k] = v));
    const res = await handle({
      method: request.method,
      path: url.pathname,
      headers,
      query: Object.fromEntries(url.searchParams),
      body: await request.text(),
      sourceIp: server.requestIP(request)?.address,
    });
    return new Response(res.body || null, { status: res.status, headers: res.headers });
  },
});
console.log(`collector on http://localhost:${port}, writing to ${root}`);
