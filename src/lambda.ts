// AWS Lambda entry: API Gateway HTTP API (payload v2) → createApp, records → Firehose,
// export reads from S3. Configuration comes from the environment the template sets.

import { FirehoseClient, PutRecordCommand } from "@aws-sdk/client-firehose";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createApp, type Req, type Sink } from "./app";
import { parseHashes } from "./auth";
import type { EventStore } from "./export";
import { SNIPPET } from "./snippet";

const env = process.env;
const firehose = new FirehoseClient({});
const s3 = new S3Client({});

const sink: Sink = {
  async put(records) {
    // One Firehose record per request: Firehose bills each record rounded up to 5 KB.
    const data = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await firehose.send(new PutRecordCommand({ DeliveryStreamName: env.FIREHOSE_STREAM, Record: { Data: Buffer.from(data) } }));
  },
};

const store: EventStore = {
  async list(prefix, startAfter, max) {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: env.EVENTS_BUCKET, Prefix: prefix, StartAfter: startAfter, MaxKeys: max }));
    return { keys: (out.Contents ?? []).map((o) => o.Key!).filter(Boolean), truncated: !!out.IsTruncated };
  },
  async get(key) {
    const out = await s3.send(new GetObjectCommand({ Bucket: env.EVENTS_BUCKET, Key: key }));
    return out.Body!.transformToByteArray();
  },
};

const handle = createApp({
  config: {
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    writeKeyHashes: parseHashes(env.WRITE_KEY_HASHES),
    exportKeyHashes: parseHashes(env.EXPORT_KEY_HASHES),
  },
  sink,
  store,
  snippet: SNIPPET,
});

type ApiEvent = {
  rawPath: string;
  headers?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string; sourceIp?: string } };
};

export async function handler(event: ApiEvent) {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) headers[k.toLowerCase()] = v;
  const raw = event.body ?? "";
  const req: Req = {
    method: event.requestContext.http.method,
    path: event.rawPath,
    headers,
    query: event.queryStringParameters ?? {},
    body: event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw,
    sourceIp: event.requestContext.http.sourceIp, // used only for the in-memory rate limit, never stored
  };
  try {
    const res = await handle(req);
    return { statusCode: res.status, headers: res.headers, body: res.body };
  } catch (err) {
    console.error("unhandled", err instanceof Error ? err.message : String(err));
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: '{"error":"internal"}' };
  }
}
