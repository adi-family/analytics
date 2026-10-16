// Reduces a User-Agent header to coarse families. No versions, no device models:
// the raw header is never stored.

export type UaFamily = { browser: string; os: string; device: "desktop" | "mobile" | "tablet"; bot: boolean };

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl|wget|python|go-http|java\/|okhttp|axios|node-fetch/i;

export function uaFamily(ua: string | undefined): UaFamily {
  const s = (ua ?? "").slice(0, 512);
  const bot = s === "" || BOT.test(s);
  const browser = /Edg\//.test(s)
    ? "edge"
    : /OPR\/|Opera/.test(s)
      ? "opera"
      : /Firefox\/|FxiOS/.test(s)
        ? "firefox"
        : /Chrome\/|CriOS|Chromium/.test(s)
          ? "chrome"
          : /Safari\//.test(s)
            ? "safari"
            : "other";
  const os = /iPhone|iPad|iPod/.test(s)
    ? "ios"
    : /Android/.test(s)
      ? "android"
      : /Mac OS X|Macintosh/.test(s)
        ? "macos"
        : /Windows/.test(s)
          ? "windows"
          : /CrOS/.test(s)
            ? "chromeos"
            : /Linux/.test(s)
              ? "linux"
              : "other";
  const device = /iPad|Tablet/.test(s) ? "tablet" : /Mobi|iPhone|Android/.test(s) ? "mobile" : "desktop";
  return { browser, os, device, bot };
}
