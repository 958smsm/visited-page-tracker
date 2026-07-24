import type { ExtensionSettings } from "../types/models.js";

const TRACKING_PARAMETERS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "gclid", "dclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "ref", "ref_"
]);

export interface NormalizedUrlResult {
  normalizedUrl: string;
  hostname: string;
  originalUrl: string;
}

export function normalizeUrl(rawUrl: string, settings: Pick<ExtensionSettings,
  "includeFragments" | "ignoreTrackingParameters" | "unifyHttpHttps" | "unifyWww" | "ignoreQueryStrings" | "enableFileUrls"
>): NormalizedUrlResult | null {
  if (!rawUrl || /^view-source:/i.test(rawUrl)) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol === "file:") {
    if (!settings.enableFileUrls) return null;
  } else if (protocol !== "http:" && protocol !== "https:") {
    return null;
  }

  url.hostname = url.hostname.toLowerCase();
  if (settings.unifyWww && url.hostname.startsWith("www.")) url.hostname = url.hostname.slice(4);
  if (settings.unifyHttpHttps && (protocol === "http:" || protocol === "https:")) url.protocol = "https:";

  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
    url.port = "";
  }
  if (!url.pathname) url.pathname = "/";
  if (!settings.includeFragments) url.hash = "";
  if (settings.ignoreQueryStrings) {
    url.search = "";
  } else if (settings.ignoreTrackingParameters && url.search.length > 1) {
    const segments = url.search.slice(1).split("&");
    const kept = segments.filter((segment) => {
      const rawKey = segment.split("=", 1)[0] ?? "";
      let key = rawKey;
      try { key = decodeURIComponent(rawKey.replaceAll("+", " ")); } catch { /* use raw key */ }
      return !TRACKING_PARAMETERS.has(key.toLowerCase());
    });
    url.search = kept.length > 0 ? `?${kept.join("&")}` : "";
  }

  return {
    normalizedUrl: url.toString(),
    hostname: url.hostname,
    originalUrl: rawUrl
  };
}
