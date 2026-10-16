#!/usr/bin/env bun
// Refreshes the vendored snapshot of content-blocker lists in test/blocklists/, which
// test/blocklists.test.ts checks every client-visible name against.
//
//   bun run refresh-blocklists          # fetch the lists, keep the relevant rules, write the snapshot
//
// A rule is kept when it could ever apply to the collector: generic rules (no host anchor),
// regex rules, and rules anchored on one of RELEVANT_DOMAINS, minus rules restricted to
// other sites with $domain=. That keeps the snapshot small without losing anything that
// can match our hostname, the API Gateway host behind its CNAME, or our paths.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "..", "test", "blocklists");

/** Where the collector's names live, including the hosts uBlock Origin uncloaks the CNAME to. */
export const RELEVANT_DOMAINS = ["withadi.dev", "amazonaws.com", "on.aws"];

type Format = "abp" | "domains" | "disconnect";
export const LISTS: { name: string; url: string; format: Format }[] = [
  { name: "easyprivacy", url: "https://easylist.to/easylist/easyprivacy.txt", format: "abp" },
  { name: "easylist", url: "https://easylist.to/easylist/easylist.txt", format: "abp" },
  { name: "ublock-filters", url: "https://ublockorigin.github.io/uAssets/filters/filters.txt", format: "abp" },
  { name: "ublock-privacy", url: "https://ublockorigin.github.io/uAssets/filters/privacy.txt", format: "abp" },
  { name: "ublock-badware", url: "https://ublockorigin.github.io/uAssets/filters/badware.txt", format: "abp" },
  { name: "ublock-quick-fixes", url: "https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt", format: "abp" },
  { name: "adguard-base", url: "https://filters.adtidy.org/extension/ublock/filters/2.txt", format: "abp" },
  { name: "adguard-tracking-protection", url: "https://filters.adtidy.org/extension/ublock/filters/3.txt", format: "abp" },
  { name: "adguard-url-tracking", url: "https://filters.adtidy.org/extension/ublock/filters/17.txt", format: "abp" },
  { name: "adguard-dns", url: "https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt", format: "abp" },
  { name: "adguard-cname-trackers", url: "https://raw.githubusercontent.com/AdguardTeam/cname-trackers/master/data/combined_disguised_trackers_justdomains.txt", format: "domains" },
  { name: "peter-lowe", url: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext", format: "abp" },
  { name: "disconnect", url: "https://raw.githubusercontent.com/disconnectme/disconnect-tracking-protection/master/services.json", format: "disconnect" },
  { name: "brave-specific", url: "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-specific.txt", format: "abp" },
  { name: "brave-firstparty", url: "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty.txt", format: "abp" },
];

function toAbp(text: string, format: Format): string[] {
  if (format === "abp") return text.split(/\r?\n/);
  if (format === "domains") return text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#")).map((d) => `||${d.trim()}^`);
  // Disconnect (Firefox Enhanced Tracking Protection): categories → services → domains.
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(`||${v}^`);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(JSON.parse(text).categories);
  return out.filter((l) => /^\|\|[a-z0-9.-]+\.[a-z]+\^$/i.test(l));
}

const ours = (host: string) =>
  RELEVANT_DOMAINS.some((d) => host === d || host.endsWith("." + d) || d.endsWith("." + host));

export function relevant(rule: string): boolean {
  const r = rule.trim();
  if (!r || r.startsWith("!") || r.startsWith("[")) return false;
  // Cosmetic rules hide elements; only generic scriptlets could touch the snippet's global.
  const cosmetic = r.match(/^([^#]*)#[@?$%]*#/);
  if (cosmetic) return cosmetic[1] === "" && /^#[@]?(%#|#\+js\(|\$#)/.test(r.slice(cosmetic[1].length));
  const body = r.startsWith("@@") ? r.slice(2) : r;
  const domainOpt = body.match(/\$(?:.*,)?(?:domain|from)=([^,]+)/);
  if (domainOpt) {
    const doms = domainOpt[1].split("|");
    const positive = doms.filter((d) => !d.startsWith("~"));
    if (positive.length && !positive.some((d) => ours(d) || d.includes("*"))) return false;
  }
  const anchored = body.match(/^(?:\|\||\|https?:\/\/)([^/^$|:?]*)/);
  if (anchored) {
    const host = anchored[1].toLowerCase();
    if (host === "" || host.includes("*") || host.endsWith(".") || host.endsWith("-")) return true;
    return ours(host);
  }
  // A bare hostname without the || anchor (em.example.com$image) is a host rule in practice:
  // it can only match a URL that contains that exact hostname.
  const bare = body.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})\^?(?:\$|$)/i);
  if (bare) return ours(bare[1].toLowerCase()) || RELEVANT_DOMAINS.some((d) => d.includes(bare[1].toLowerCase()));
  return true;
}

if (import.meta.main) {
  const date = new Date().toISOString().slice(0, 10);
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith(".txt")) rmSync(join(OUT, f));
  const manifest: Record<string, { url: string; rules: number; kept: number; version: string | null }> = {};
  for (const list of LISTS) {
    const res = await fetch(list.url);
    if (!res.ok) throw new Error(`${list.name}: HTTP ${res.status} from ${list.url}`);
    const text = await res.text();
    const lines = toAbp(text, list.format);
    const rules = lines.filter((l) => l.trim() && !/^[!\[#]/.test(l.trim()));
    if (rules.length < 50) throw new Error(`${list.name}: only ${rules.length} rules, refusing to vendor a broken download`);
    const kept = [...new Set(rules.filter(relevant).map((l) => l.trim()))];
    const version = text.match(/^! (?:Version|Last modified): *(.+)$/m)?.[1]?.trim() ?? null;
    writeFileSync(
      join(OUT, `${list.name}.txt`),
      [`! Snapshot of ${list.url}`, `! Fetched ${date}${version ? `, list version ${version}` : ""}`,
        `! ${kept.length} of ${rules.length} rules kept (see scripts/refresh-blocklists.ts)`, ...kept, ""].join("\n"),
    );
    manifest[list.name] = { url: list.url, rules: rules.length, kept: kept.length, version };
    console.log(`${list.name.padEnd(28)} ${String(kept.length).padStart(6)} / ${rules.length}`);
  }
  writeFileSync(join(OUT, "snapshot.json"), JSON.stringify({ fetched: date, relevantDomains: RELEVANT_DOMAINS, lists: manifest }, null, 2) + "\n");
  console.log(`snapshot of ${date} written to ${OUT}`);
}
