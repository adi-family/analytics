# ADI analytics collector

The first-party analytics collector for [ADI](https://withadi.dev). It receives a short,
hand-picked list of named events from the withadi.dev site, the desktop app and ADI's own
servers, checks every one against an allowlist, and stores them in S3. There is no
dashboard here. ADI pulls the events into its own SQLite and shows them there.

**Selective by construction.** The collector rejects any event or property that is not in
[`dictionary/events.json`](dictionary/events.json). The snippet does no autocapture
(no clicks, no scroll, no session recording, no heatmaps), and the server refuses anything
it was not told to expect.

## What is collected

- The events in the table below, with exactly the properties listed. Nothing else.
- For browser events: the browser family (`chrome`, `firefox`, `safari`…), OS family
  (`macos`, `windows`, `ios`…) and device class (`desktop`, `mobile`, `tablet`). No versions.
- Ids:
  - `anonymous_id`: a random UUID in the first-party cookie `adi_id` (1 year,
    `Domain=.withadi.dev`, `SameSite=Lax`, `Secure`). It is set **only after consent**.
    The browser sends it as `browser_id`.
  - `distinct_id`: a known id after a link (`adi.link(id)`, `POST /v1/link`). That is the
    app's random `install_id`, or a CRM id such as `crm:company:42`. The browser keeps it
    in the cookie `adi_link` and sends it as `known_id`.
  - `groups`: `company` and `deployment` keys on app and server events.
- Timestamps: the client's time (clamped to the last 30 days) and the arrival time.

## What is NOT collected

- **No IP addresses.** The address is used only for an in-memory rate limit. It is hashed
  with a per-instance random salt and never written anywhere.
- No raw User-Agent, no full referrer URL (only its domain), no query strings (only `utm_*`
  on `page_view`), no page titles, no form contents, no email addresses, no names.
- No country or geolocation in v1. The API sits directly behind API Gateway, which offers no
  country header, and the collector does no geo-IP lookup.
- No fingerprinting, no third-party cookies, no localStorage.
- **Before consent:** no cookie and no id at all. Cookieless events are stored with
  `anonymous_id = null`, even if a page sends one, so they cannot be joined into a person.
  Events marked `consent: required` are refused without consent, and so is a link.
- **Global Privacy Control / Do-Not-Track:** the snippet sends nothing, and the collector
  also drops any browser request that carries `Sec-GPC: 1` or `DNT: 1`.
- Obvious bots (by User-Agent) are dropped.

## Events (the allowlist)

Generated from the marketing branch's event dictionary (table `mb_events` in ADI project
`adi-marketing-branch`). App events also carry `version` (token), `os`
(`macos | linux | windows`) and `arch` (token).

| Event | Layer | Consent | Properties |
|---|---|---|---|
| `page_view` | site | cookieless | `path`: path<br>`utm_source`: string (optional)<br>`utm_medium`: string (optional)<br>`utm_campaign`: string (optional)<br>`referring_domain`: hostname (optional) |
| `download_clicked` | site | cookieless | `platform`: macos \| linux \| windows<br>`path`: path |
| `sales_mail_clicked` | site | cookieless | `intent`: walkthrough \| write \| referral \| over_ten<br>`path`: path |
| `app_linked` | site | required | `source`: welcome_link |
| `app_first_launch` | app | n/a | `fresh`: bool |
| `onboarding_completed` | app | n/a | `backend`: token |
| `agent_run_started` | app | n/a | `launched_by`: human \| agent \| automation<br>`backend`: token |
| `agent_run_finished` | app | n/a | `is_error`: bool<br>`terminal_reason`: string (optional)<br>`launched_by`: human \| agent \| automation |
| `app_daily_active` | app | n/a | `runs_human`: int<br>`runs_agent`: int<br>`runs_automation`: int |
| `dashboard_created` | app | n/a | `from`: blank \| import |
| `store_item_installed` | app | n/a | `kind`: agent \| tool \| dashboard \| service<br>`slug`: slug (optional) |
| `fleet_invite_created` | app | n/a | (none) |
| `licence_code_entered` | app | n/a | `status`: token |
| `crm_company_added` | server-crm | n/a | `origin`: outbound \| inbound \| referral \| unknown |
| `crm_message_logged` | server-crm | n/a | `direction`: in \| out<br>`channel_kind`: email \| linkedin \| other |
| `crm_stage_changed` | server-crm | n/a | `from_stage`: target \| first_touch \| conversation \| pilot \| purchase \| retain \| lost<br>`to_stage`: target \| first_touch \| conversation \| pilot \| purchase \| retain \| lost<br>`referred`: bool |
| `crm_referral_logged` | server-crm | n/a | `referrer_kind`: customer \| individual \| partner \| consultant<br>`payout`: cash \| credit \| unknown |
| `licence_issued` | server-licence | n/a | `kind`: paid \| trialing<br>`max_deployments`: int<br>`referred`: bool |
| `licence_activated` | server-licence | n/a | `status`: token<br>`first_for_licence`: bool |

Property types: `path` = starts with `/`, no `?`/`#`; `hostname` = a bare lowercase domain;
`slug` = `[a-z0-9-]`; `token` = `[A-Za-z0-9:_.+-]`, max 64; `string` = max 200, no control
characters; `int`, `bool`, or an enum. A property is required unless marked optional.

### Adding or changing an event

Edit [`dictionary/events.json`](dictionary/events.json): one entry, one file. Then
`bun run test` and `infra/deploy.sh`. To regenerate the whole file from `mb_events`:

```sh
sqlite3 -json "$(adi-db path --project adi-marketing-branch)" \
  "select * from mb_events order by position" | bun scripts/sync-dictionary.ts
```

## Architecture

```
browser snippet ─┐
desktop app ─────┼─► API Gateway HTTP API ─► Lambda (Node 22, arm64) ─► Firehose ─► S3
CRM / licence ───┘  (relay.withadi.dev)       validate, strip, enrich      (5 min / 5 MB buffer)
                                                       │                   events/dt=YYYY-MM-DD/*.gz
ADI ◄── GET /v1/pull ◄─────────────────────────────────┘                    │
                                                         Glue table + Athena workgroup (ad-hoc SQL)
```

- Everything is in [`infra/template.yaml`](infra/template.yaml) (plain CloudFormation).
  No artifact bucket is needed: the stack creates the function with a stub, then
  `deploy.sh` uploads the bundled code.
- S3 lifecycle: `events/` expires after 395 days (`RawRetentionDays`), `errors/` after 30,
  `athena-results/` after 7. Public access is blocked, the bucket is encrypted, and TLS is
  required.
- Throttling: 50 rps steady / 100 burst for the whole API (stage throttle), plus a
  per-caller token bucket in the Lambda (120/min, burst 60).
- The Athena workgroup caps each query at 1 GB scanned. The Glue table uses partition
  projection on `dt`, so no crawler is needed.

## Endpoints

Every client-visible name is in [`src/surface.ts`](src/surface.ts). Read
[Not blocked by content blockers](#not-blocked-by-content-blockers) before you rename one.
All bodies are JSON. `text/plain` is accepted too, so the browser needs no CORS preflight.

| Route | Who | Auth |
|---|---|---|
| `POST /v1/web` | browser on withadi.dev (site events) | an allowed `Origin`; no `Origin` or a foreign one → 403 |
| `POST /v1/app` | desktop app (app events) | no `Origin` (a page → 403) |
| `POST /v1/server` | CRM, licence service (server events) | `Authorization: Bearer <write key>` |
| `POST /v1/link` | browser (with consent) or a server: alias a browser id to a known id | allowed `Origin`, or the write key |
| `GET /v1/pull?since=<cursor>` | ADI | `Authorization: Bearer <export key>` |
| `GET /web.js` | the snippet | none |
| `GET /health` | monitoring | none |

Each route accepts only its own layers. A site event sent to `/v1/server`, or a CRM event
sent to `/v1/web`, is rejected.

### POST /v1/web (the browser's wire format)

The browser uses plain field names, so that nothing it sends reads like a tracker:

```json
{
  "consent": true,
  "browser_id": "0b7e6c1e-3f9a-4c2d-9b1a-2f6e8d4c5a71",
  "known_id": "5f0c2a8e-1b3d-4e6f-8a9b-0c1d2e3f4a5b",
  "items": [
    { "name": "download_clicked", "props": { "platform": "macos", "path": "/" },
      "at": "2026-10-16T12:00:00Z", "id": "<uuid, optional, for retries>" }
  ]
}
```

- `consent`, `browser_id` and `known_id` are batch-level. Without `consent: true` both
  ids are dropped. Any other field is refused.
- They are stored as `anonymous_id`, `distinct_id`, `event`, `properties` and `ts`.

### POST /v1/app, POST /v1/server (record names)

```json
{
  "distinct_id": "5f0c2a8e-1b3d-4e6f-8a9b-0c1d2e3f4a5b",
  "events": [
    { "event": "app_first_launch", "properties": { "fresh": true, "version": "1.30.0", "os": "linux", "arch": "x86_64" },
      "ts": "2026-10-16T12:00:00Z", "id": "<uuid, optional, for retries>" }
  ]
}
```

- App: `distinct_id` = the install_id (UUID) is required, there is no `anonymous_id`, and
  `groups` is optional.
- Server: `distinct_id` may be set per event, and `groups: {company, deployment}` is optional.

For every batch route:

- Limits: browser 50 items / 32 KB, app 100 / 64 KB, server 500 / 256 KB.
- Answer: `200 {"accepted": n, "rejected": [{index, name, errors}]}`. When nothing is
  accepted the answer is `400`. Envelope errors are `400`/`413`, a bad key is `401`, a
  wrong caller for the route is `403`, and the rate limit is `429`. Opted-out and bot
  requests get `200 {"accepted":0,"dropped":...}` so that nothing retries.

### POST /v1/link

From the browser: `{"consent": true, "browser_id": "<uuid>", "known_id": "<known id>"}`.
From a server with the write key: `{"anonymous_id": "<uuid>", "distinct_id": "<known id>"}`.
Either stores an `identify` record. From now on, that anonymous id belongs to that
distinct id. ADI applies the alias when it builds people and funnels. Stored events are
never rewritten.

### GET /v1/pull: the contract for ADI

```
GET /v1/pull?since=<cursor | YYYY-MM-DD | empty>
Authorization: Bearer <export key>

200 {"ok": true, "records": [<record>, ...], "cursor": "<opaque>", "more": true|false}
```

- Pass back the `cursor` you received. Loop while `more` is true.
- An empty `since` starts at the oldest kept data. `YYYY-MM-DD` starts at that day.
- A page holds up to 50 S3 objects or about 5,000 records.
- **At-least-once delivery: dedupe on `id`.** Records arrive in roughly arrival order, not
  in `ts` order.
- New events appear after Firehose's buffer flushes, within about 5 minutes.
- [`clients/adi-pull.ts`](clients/adi-pull.ts) implements this contract. It pulls into the
  tables `analytics_events` (upsert on `id`) and `analytics_cursor` in any SQLite file:

  ```sh
  ANALYTICS_URL=https://relay.withadi.dev ANALYTICS_EXPORT_KEY=... \
    bun clients/adi-pull.ts "$(adi-db path --project adi-analytics)"
  ```

### Record format (one JSON line per record, gzip JSONL in S3)

```json
{"v":1,"type":"track","id":"…","event":"page_view","layer":"site",
 "ts":"2026-10-16T12:00:00.000Z","received_at":"2026-10-16T12:00:00.412Z",
 "anonymous_id":null,"distinct_id":null,"consent":false,
 "properties":{"path":"/for-teams","utm_source":"hn"},"groups":null,
 "ua_browser":"firefox","ua_os":"linux","ua_device":"desktop"}
```

`type` is `track` or `identify`. For an `identify` record, `event` is null and `layer` is
`site` or `server`. `consent` is null for app and server records.

### Ad-hoc SQL (Athena, workgroup `adi-analytics`, database `adi_analytics`)

```sql
select dt, event, count(*) as n, count(distinct anonymous_id) as visitors
from events
where dt >= '2026-10-01' and type = 'track'
group by 1, 2 order by 1, 2;

select json_extract_scalar(properties, '$.platform') as platform, count(*)
from events where event = 'download_clicked' group by 1;
```

## The browser snippet

```html
<script async src="https://relay.withadi.dev/web.js"></script>
<script>
  // after the banner: adi.consent(true) or adi.consent(false)
  // adi.send("download_clicked", { platform: "macos", path: location.pathname })
  // on /welcome/?i=<install_id>, after consent: adi.link(installId)
</script>
```

- It is about 1.2 KB gzipped and has no dependencies. It sends one `page_view` per load
  (`data-pageview="false"` turns that off) and only what the page calls with `adi.send`.
- API: `adi.send(name, props)`, `adi.link(id)`, `adi.consent(bool)`, `adi.page()`.
- Consent: until `adi.consent(true)`, nothing is stored and no id is sent.
  `adi.consent(false)` deletes `adi_id` and `adi_link`. A visitor who already has `adi_id`
  counts as having consented.
- GPC / DNT: it does nothing at all.
- Transport: `fetch` with `keepalive`, never `navigator.sendBeacon` (see below).
- Options: `data-endpoint` (default: the script's origin), `data-cookie-domain`
  (default `.withadi.dev`), `data-consent="true"`.
- Calls made before it loads can be queued: `window.adi = {q: [["send", "…", {…}]]}`.
- Safari caps cookies written by script at 7 days, so a Safari visitor who does not come
  back within a week gets a new `adi_id`. Funnels across longer gaps rely on a link.

Embedding it on withadi.dev is a separate step. The privacy page must say what is collected
before tracking starts.

## Not blocked by content blockers

The collector is first party and selective, and it should not be caught by filters written
for third-party trackers. Everything a browser or a DNS blocker can see is named in plain
words: the host `relay.withadi.dev`, the paths above, `web.js`, `window.adi` with
`send`/`link`/`consent`/`page`, the cookies `adi_id`/`adi_link` and the wire fields. None
of them contains a tracker word (analytics, track, collect, event, pixel, beacon, telemetry,
metric, stats, identify…). AWS resource names keep the `adi-analytics` prefix, because no
browser sees them.

Audit of 2026-10-16, against EasyList, EasyPrivacy, uBlock filters (+ privacy, badware,
quick fixes), AdGuard Base, Tracking Protection, URL Tracking, DNS filter and CNAME-tracker
list, Peter Lowe's list, Disconnect (Firefox Enhanced Tracking Protection) and Brave's own
lists, using a real filter engine:

- **uBlock Origin on Firefox uncloaks CNAMEs.** It re-checks every request as if it went to
  `d-….execute-api.<region>.amazonaws.com`, which is third party to withadi.dev. Rules found
  there: `*$ping,third-party` (EasyPrivacy) blocks every `sendBeacon`, so the snippet uses
  `fetch(keepalive)`. `||execute-api.*.amazonaws.com/event|` (AdGuard) and
  `||amazonaws.com/beacon^`, `||amazonaws.com/analytics/` (EasyPrivacy) rule out those path
  names.
- No list names withadi.dev or an API Gateway host we use. Header, cookie and generic
  scriptlet rules do not touch our names. Body-matching scriptlets (`no-fetch-if body:`)
  exist only for specific sites.
- The old names (`t.withadi.dev`, `/e`, `/a.js`, `adi.track`, `adi_aid`) did not hit a rule
  directly, but they read as tracker names and `sendBeacon` was blocked once uncloaked.

[`test/blocklists.test.ts`](test/blocklists.test.ts) keeps it that way. It runs every
client-visible URL, as `script`/`xhr`/`fetch`/`other` from withadi.dev pages, on our host
and on both API Gateway hosts, through
[`@ghostery/adblocker`](https://github.com/ghostery/adblocker) loaded with a vendored, dated
snapshot of those lists in [`test/blocklists/`](test/blocklists/). The snapshot holds only
the rules that could ever apply: generic and regex rules, and rules anchored on withadi.dev,
amazonaws.com or on.aws. Known tracker URLs serve as controls, so a broken snapshot fails
loudly. Refresh it with:

```sh
bun run refresh-blocklists && bun run test   # then commit test/blocklists/
```

A weekly CI job does the same against the live lists and fails if a new rule would block
us.

## Deploy

Requirements: AWS CLI v2, bun, python3 and openssl. Credentials come from your
environment or profile, and none are stored in this repo.

```sh
AWS_REGION=eu-central-1 infra/deploy.sh          # build, test, deploy the stack, upload the code
API=<ApiEndpoint> infra/smoke.sh                 # health, page_view, rejection, origin check
AWS_REGION=eu-central-1 infra/teardown.sh --yes  # delete everything, including collected events
```

- **Keys.** On the first deploy, `deploy.sh` generates the write and export keys into
  `.deploy/keys.env` (mode 600, gitignored). Store them in your secret manager, then delete
  the file. Only their SHA-256 hashes reach AWS. To rotate a key, pass
  `ANALYTICS_WRITE_KEY=…` / `ANALYTICS_EXPORT_KEY=…` to `deploy.sh`.
- **Custom domain `relay.withadi.dev`** (DNS on Cloudflare, DNS-only CNAME):
  ```sh
  export DOMAIN=relay.withadi.dev CLOUDFLARE_API_TOKEN=...
  infra/domain.sh cert                     # ACM cert + validation CNAME, waits until issued; prints CERT_ARN
  CERT_ARN=arn:... infra/deploy.sh         # adds the API Gateway custom domain
  infra/domain.sh dns                      # CNAME relay.withadi.dev -> the regional API Gateway target
  ```
  For a few minutes after the domain is attached, some API Gateway front ends still present
  their default certificate. Until that clears, curl fails with "no alternative certificate
  subject name matches".
- **Deploy user.** [`infra/deploy-policy.json`](infra/deploy-policy.json) is a least-privilege
  policy for a dedicated IAM user. Create it as a *customer managed* policy, because it is
  larger than the 2 KB inline limit. It is scoped to resources named `adi-analytics*` and
  assumes the default stack name. It was checked against CloudTrail for a real deploy and
  with the IAM policy simulator. A few actions fall outside the prefix:
  - `iam:CreateServiceLinkedRole`, limited to API Gateway's `ops.apigateway` role. API Gateway
    creates that role the first time an account gets a custom domain.
  - Account-level reads that only accept `*`: `iam:GetAccountSummary`,
    `lambda:GetAccountSettings` and `logs:Describe*`. CloudFormation calls them.
  - ACM. A certificate ARN is not known before it is requested.

## Cost

Idle cost is about $0. There is no fixed-price resource: you pay for requests, Firehose
ingest and S3 storage. The figures below are for eu-central-1, without the free tier.

| Volume | Requests | API GW | Lambda | Firehose (5 KB/record min) | S3 + logs | Total |
|---|---|---|---|---|---|---|
| today, ~10k events/mo | ~7k | $0.01 | ~$0 | ~$0 | ~$0.05 | **< $0.10** |
| launch, ~100k/mo | ~70k | $0.07 | ~$0.02 | $0.01 | ~$0.10 | **≈ $0.20** |
| target, ~600k/mo | ~400k | $0.40 | ~$0.10 | $0.06 | ~$0.30 | **≈ $1** |

Athena costs $5 per TB scanned, and the workgroup caps each query at 1 GB.

## Development

```sh
bun install
bun run test        # builds the snippet, then 74 tests: validation, identity, routes, export, snippet, pull, blocklists
bun run typecheck
ANALYTICS_WRITE_KEY=... ANALYTICS_EXPORT_KEY=... bun run dev   # local collector on :8787, writes to .dev/
API=http://localhost:8787 ANALYTICS_WRITE_KEY=... ANALYTICS_EXPORT_KEY=... WAIT=1 infra/smoke.sh
```

## License

MIT
