export interface NavigationIdentity {
  tabId: number;
  frameId: number;
  normalizedUrl: string;
  documentId?: string | null;
  timestamp: number;
}

export interface DedupeStore {
  get(key: string): Promise<number | undefined>;
  set(key: string, expiresAt: number): Promise<void>;
  removeExpired(now: number): Promise<void>;
}

export function navigationDedupeKey(identity: NavigationIdentity, bucketMs = 2_000): string {
  const bucket = Math.floor(identity.timestamp / bucketMs);
  return [identity.tabId, identity.frameId, identity.documentId ?? "no-document", identity.normalizedUrl, bucket].join("|");
}

export class NavigationDeduper {
  constructor(private readonly store: DedupeStore, private readonly ttlMs = 4_000, private readonly bucketMs = 2_000) {}

  async shouldProcess(identity: NavigationIdentity): Promise<boolean> {
    const now = identity.timestamp;
    const stableIdentity: NavigationIdentity = { ...identity, documentId: null };
    const identities = identity.documentId ? [identity, stableIdentity] : [stableIdentity];
    const keys = new Set<string>();
    for (const candidate of identities) {
      keys.add(navigationDedupeKey(candidate, this.bucketMs));
      keys.add(navigationDedupeKey({ ...candidate, timestamp: candidate.timestamp - this.bucketMs }, this.bucketMs));
    }
    for (const key of keys) {
      const expiresAt = await this.store.get(key);
      if (expiresAt != null && expiresAt > now) return false;
    }
    const expiresAt = now + this.ttlMs;
    for (const candidate of identities) await this.store.set(navigationDedupeKey(candidate, this.bucketMs), expiresAt);
    await this.store.removeExpired(now);
    return true;
  }
}

export class MemoryDedupeStore implements DedupeStore {
  private readonly values = new Map<string, number>();
  async get(key: string): Promise<number | undefined> { return this.values.get(key); }
  async set(key: string, expiresAt: number): Promise<void> { this.values.set(key, expiresAt); }
  async removeExpired(now: number): Promise<void> {
    for (const [key, expires] of this.values) if (expires <= now) this.values.delete(key);
  }
}

export class SessionDedupeStore implements DedupeStore {
  private prefix = "navigationDedupe:";
  private hash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }
  private storageKey(key: string): string { return `${this.prefix}${this.hash(key)}`; }
  async get(key: string): Promise<number | undefined> {
    const storageKey = this.storageKey(key);
    const result = await chrome.storage.session.get(storageKey);
    const value = result[storageKey];
    return typeof value === "number" ? value : undefined;
  }
  async set(key: string, expiresAt: number): Promise<void> {
    await chrome.storage.session.set({ [this.storageKey(key)]: expiresAt });
  }
  async removeExpired(now: number): Promise<void> {
    const all = await chrome.storage.session.get(null);
    const expired = Object.entries(all)
      .filter(([key, value]) => key.startsWith(this.prefix) && typeof value === "number" && value <= now)
      .map(([key]) => key);
    if (expired.length > 0) await chrome.storage.session.remove(expired);
  }
}
