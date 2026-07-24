function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, "").replace(/^\.+|\.+$/g, "");
}

export function domainMatches(hostname: string, excludedDomains: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return excludedDomains.some((candidate) => {
    const domain = normalizeDomain(candidate);
    return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`));
  });
}

export function exactUrlMatches(url: string, excludedUrls: string[]): boolean {
  return excludedUrls.some((candidate) => candidate.trim() === url);
}

export function wildcardToRegExp(pattern: string): RegExp | null {
  const trimmed = pattern.trim();
  if (!trimmed) return null;
  const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  try {
    return new RegExp(`^${escaped}$`, "i");
  } catch {
    return null;
  }
}

export function urlPatternMatches(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => wildcardToRegExp(pattern)?.test(url) === true);
}
