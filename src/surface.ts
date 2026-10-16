// Everything a browser, a filter list or a DNS blocker can see of the collector, in one
// place. These names are plain words on purpose: content blockers match URLs, hostnames
// and file names against lists such as EasyPrivacy, and words like analytics, track,
// collect, event, pixel, beacon or telemetry get a request blocked. test/blocklists.test.ts
// checks every name here against a dated snapshot of those lists.
//
// AWS resource names (adi-analytics*) are not part of this: no browser ever sees them.

export const HOST = "relay.withadi.dev";

export const ROUTES = {
  script: "/web.js", //      GET   the browser snippet
  web: "/v1/web", //         POST  site events from the browser
  app: "/v1/app", //         POST  app events from the desktop app
  server: "/v1/server", //   POST  server events, write key
  link: "/v1/link", //       POST  alias a browser id to a known id
  pull: "/v1/pull", //       GET   incremental read for ADI, export key
  health: "/health", //      GET
} as const;

/** The query parameter of the pull route. */
export const PULL_CURSOR = "since";

export const COOKIES = { browserId: "adi_id", knownId: "adi_link" } as const;

/** window.adi and its methods. */
export const GLOBAL = "adi";
export const METHODS = ["send", "link", "consent", "page"] as const;

/**
 * Words that must not appear in any client-visible name. Filter lists key on them, and
 * the operator's rule is that nothing the browser sees reads like a tracker.
 */
export const BANNED_WORDS = [
  "analytic", "track", "collect", "event", "pixel", "beacon", "telemetry", "metric", "stat",
  "identify", "ingest", "log", "measure", "monitor", "insight", "spy", "tag", "hit", "ping",
  "count", "visit", "click", "pageview", "segment", "fingerprint", "ads", "advert", "aid",
  "uid", "cid", "distinct", "anonymous",
];
