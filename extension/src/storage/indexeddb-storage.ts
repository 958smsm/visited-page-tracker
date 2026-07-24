import type {
  DatabaseStatus,
  ExportBundle,
  ImportResult,
  PageSearchQuery,
  PageSearchResult,
  PageVisitRecord,
  RecordVisitInput,
  RecordVisitResult,
  VisitEvent,
  VisitStatistics
} from "../types/models.js";
import { mergeExportBundles, replaceBundleSource, validateExportBundle } from "./migration.js";
import type { VisitStorage } from "./storage-interface.js";

const DB_NAME = "visited-page-tracker";
const DB_VERSION = 1;
const PAGE_STORE = "pages";
const VISIT_STORE = "visits";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

export class IndexedDbStorage implements VisitStorage {
  readonly sourceName = "per-profile";
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error("IndexedDB is unavailable."));
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = this.factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const pages = db.objectStoreNames.contains(PAGE_STORE)
          ? request.transaction!.objectStore(PAGE_STORE)
          : db.createObjectStore(PAGE_STORE, { keyPath: "normalizedUrl" });
        if (!pages.indexNames.contains("hostname")) pages.createIndex("hostname", "hostname", { unique: false });
        if (!pages.indexNames.contains("lastVisitedAt")) pages.createIndex("lastVisitedAt", "lastVisitedAt", { unique: false });
        if (!pages.indexNames.contains("visitCount")) pages.createIndex("visitCount", "visitCount", { unique: false });

        const visits = db.objectStoreNames.contains(VISIT_STORE)
          ? request.transaction!.objectStore(VISIT_STORE)
          : db.createObjectStore(VISIT_STORE, { keyPath: "id" });
        if (!visits.indexNames.contains("normalizedUrl")) visits.createIndex("normalizedUrl", "normalizedUrl", { unique: false });
        if (!visits.indexNames.contains("visitedAt")) visits.createIndex("visitedAt", "visitedAt", { unique: false });
        if (!visits.indexNames.contains("normalizedUrlVisitedAt")) {
          visits.createIndex("normalizedUrlVisitedAt", ["normalizedUrl", "visitedAt"], { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error ?? new Error("Could not open IndexedDB."));
      };
      request.onblocked = () => {
        this.dbPromise = null;
        reject(new Error("IndexedDB upgrade is blocked by another extension page."));
      };
    });
    return this.dbPromise;
  }

  async getStatus(): Promise<DatabaseStatus> {
    try {
      await this.open();
      return { available: true, path: "Chrome profile IndexedDB", errorCode: null, errorMessage: null };
    } catch (error) {
      return { available: false, path: null, errorCode: "INDEXEDDB_UNAVAILABLE", errorMessage: String(error) };
    }
  }

  async recordVisit(input: RecordVisitInput): Promise<RecordVisitResult> {
    const db = await this.open();
    const transaction = db.transaction([PAGE_STORE, VISIT_STORE], "readwrite");
    const pages = transaction.objectStore(PAGE_STORE);
    const visits = transaction.objectStore(VISIT_STORE);
    const previous = await requestResult(pages.get(input.normalizedUrl) as IDBRequest<PageVisitRecord | undefined>);
    const now = input.visitedAt;
    const event: VisitEvent = {
      id: input.eventId ?? crypto.randomUUID(),
      normalizedUrl: input.normalizedUrl,
      originalUrl: input.originalUrl,
      visitedAt: now,
      transitionType: input.transitionType,
      tabId: input.tabId,
      incognito: input.incognito,
      storageSource: this.sourceName
    };
    const page: PageVisitRecord = previous ? {
      ...previous,
      lastOriginalUrl: input.originalUrl,
      hostname: input.hostname,
      title: input.suppressTitle ? null : (input.title ?? previous.title),
      visitCount: previous.visitCount + 1,
      lastVisitedAt: now,
      updatedAt: now,
      storageSource: this.sourceName
    } : {
      normalizedUrl: input.normalizedUrl,
      lastOriginalUrl: input.originalUrl,
      hostname: input.hostname,
      title: input.title,
      visitCount: 1,
      firstVisitedAt: now,
      lastVisitedAt: now,
      createdAt: now,
      updatedAt: now,
      storageSource: this.sourceName
    };
    visits.add(event);
    pages.put(page);
    await transactionComplete(transaction);
    return {
      wasSeen: Boolean(previous),
      previousVisitCount: previous?.visitCount ?? 0,
      visitCount: page.visitCount,
      firstVisitedAt: page.firstVisitedAt,
      previousLastVisitedAt: previous?.lastVisitedAt ?? null,
      lastVisitedAt: page.lastVisitedAt
    };
  }

  async getPage(normalizedUrl: string): Promise<PageVisitRecord | null> {
    const db = await this.open();
    const transaction = db.transaction(PAGE_STORE, "readonly");
    const record = await requestResult(transaction.objectStore(PAGE_STORE).get(normalizedUrl) as IDBRequest<PageVisitRecord | undefined>);
    await transactionComplete(transaction);
    return record ?? null;
  }

  async searchPages(query: PageSearchQuery): Promise<PageSearchResult> {
    const db = await this.open();
    const transaction = db.transaction(PAGE_STORE, "readonly");
    const all = await requestResult(transaction.objectStore(PAGE_STORE).getAll() as IDBRequest<PageVisitRecord[]>);
    await transactionComplete(transaction);
    const needle = query.search?.trim().toLowerCase();
    const urlNeedle = query.url?.trim().toLowerCase();
    const domainNeedle = query.domain?.trim().toLowerCase();
    const filtered = all.filter((record) => {
      if (needle && ![record.normalizedUrl, record.lastOriginalUrl, record.hostname, record.title ?? ""].some((value) => value.toLowerCase().includes(needle))) return false;
      if (urlNeedle && !record.normalizedUrl.toLowerCase().includes(urlNeedle)) return false;
      if (domainNeedle && !record.hostname.toLowerCase().includes(domainNeedle)) return false;
      if (query.dateFrom != null && record.lastVisitedAt < query.dateFrom) return false;
      if (query.dateTo != null && record.lastVisitedAt > query.dateTo) return false;
      if (query.minCount != null && record.visitCount < query.minCount) return false;
      if (query.maxCount != null && record.visitCount > query.maxCount) return false;
      if (query.storageSource && record.storageSource !== query.storageSource) return false;
      return true;
    });
    const direction = query.sortDirection === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      let comparison = 0;
      switch (query.sortField) {
        case "url": comparison = a.normalizedUrl.localeCompare(b.normalizedUrl); break;
        case "domain": comparison = a.hostname.localeCompare(b.hostname); break;
        case "count": comparison = a.visitCount - b.visitCount; break;
        case "firstVisit": comparison = a.firstVisitedAt - b.firstVisitedAt; break;
        case "lastVisit": comparison = a.lastVisitedAt - b.lastVisitedAt; break;
      }
      return comparison * direction;
    });
    return { records: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length };
  }

  async getVisitEvents(normalizedUrl: string, offset = 0, limit = 200): Promise<VisitEvent[]> {
    const db = await this.open();
    const transaction = db.transaction(VISIT_STORE, "readonly");
    const all = await requestResult(
      transaction.objectStore(VISIT_STORE).index("normalizedUrl").getAll(normalizedUrl) as IDBRequest<VisitEvent[]>
    );
    await transactionComplete(transaction);
    return all.sort((a, b) => b.visitedAt - a.visitedAt).slice(offset, offset + limit);
  }

  async deletePage(normalizedUrl: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction([PAGE_STORE, VISIT_STORE], "readwrite");
    transaction.objectStore(PAGE_STORE).delete(normalizedUrl);
    const visits = transaction.objectStore(VISIT_STORE);
    const matching = await requestResult(visits.index("normalizedUrl").getAllKeys(normalizedUrl));
    for (const key of matching) visits.delete(key);
    await transactionComplete(transaction);
  }

  async deleteDomain(hostname: string): Promise<number> {
    const db = await this.open();
    const transaction = db.transaction([PAGE_STORE, VISIT_STORE], "readwrite");
    const pagesStore = transaction.objectStore(PAGE_STORE);
    const pages = await requestResult(pagesStore.index("hostname").getAll(hostname) as IDBRequest<PageVisitRecord[]>);
    const visitsStore = transaction.objectStore(VISIT_STORE);
    for (const page of pages) {
      pagesStore.delete(page.normalizedUrl);
      const keys = await requestResult(visitsStore.index("normalizedUrl").getAllKeys(page.normalizedUrl));
      for (const key of keys) visitsStore.delete(key);
    }
    await transactionComplete(transaction);
    return pages.length;
  }

  async clearHistory(): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction([PAGE_STORE, VISIT_STORE], "readwrite");
    transaction.objectStore(PAGE_STORE).clear();
    transaction.objectStore(VISIT_STORE).clear();
    await transactionComplete(transaction);
  }

  async getStatistics(): Promise<VisitStatistics> {
    const bundle = await this.exportData();
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const domainTotals = new Map<string, number>();
    const perDay = new Map<string, number>();
    let pagesVisitedToday = 0;
    for (const page of bundle.pages) {
      if (page.lastVisitedAt >= startToday.getTime()) pagesVisitedToday += 1;
      domainTotals.set(page.hostname, (domainTotals.get(page.hostname) ?? 0) + page.visitCount);
    }
    for (const visit of bundle.visits) {
      const key = new Date(visit.visitedAt).toISOString().slice(0, 10);
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    const domain = [...domainTotals.entries()].sort((a, b) => b[1] - a[1])[0];
    const mostVisitedPage = [...bundle.pages].sort((a, b) => b.visitCount - a.visitCount)[0] ?? null;
    return {
      totalTrackedPages: bundle.pages.length,
      totalVisits: bundle.visits.length,
      pagesVisitedToday,
      mostVisitedDomain: domain ? { hostname: domain[0], visits: domain[1] } : null,
      mostVisitedPage,
      perDayVisitTotals: [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, visits]) => ({ date, visits }))
    };
  }

  async exportData(): Promise<ExportBundle> {
    const db = await this.open();
    const transaction = db.transaction([PAGE_STORE, VISIT_STORE], "readonly");
    const pages = await requestResult(transaction.objectStore(PAGE_STORE).getAll() as IDBRequest<PageVisitRecord[]>);
    const visits = await requestResult(transaction.objectStore(VISIT_STORE).getAll() as IDBRequest<VisitEvent[]>);
    await transactionComplete(transaction);
    return { schemaVersion: 1, exportedAt: Date.now(), storageMode: "perProfile", pages, visits };
  }

  async importData(value: ExportBundle, mode: "merge" | "replace"): Promise<ImportResult> {
    const incoming = validateExportBundle(value);
    const preview = { pages: incoming.pages.length, visits: incoming.visits.length, malformedPages: 0, malformedVisits: 0 };
    const target = mode === "merge"
      ? mergeExportBundles(await this.exportData(), incoming, "perProfile", this.sourceName)
      : replaceBundleSource(incoming, "perProfile", this.sourceName);
    const db = await this.open();
    const transaction = db.transaction([PAGE_STORE, VISIT_STORE], "readwrite");
    const pages = transaction.objectStore(PAGE_STORE);
    const visits = transaction.objectStore(VISIT_STORE);
    pages.clear();
    visits.clear();
    for (const page of target.pages) pages.put(page);
    for (const visit of target.visits) visits.put(visit);
    await transactionComplete(transaction);
    return {
      ...preview,
      importedPages: target.pages.length,
      importedVisits: target.visits.length,
      skippedPages: 0,
      skippedVisits: 0
    };
  }

  async removeVisitsOlderThan(cutoff: number): Promise<number> {
    const bundle = await this.exportData();
    const kept = bundle.visits.filter((visit) => visit.visitedAt >= cutoff);
    const removed = bundle.visits.length - kept.length;
    if (removed === 0) return 0;
    const urlSet = new Set(kept.map((visit) => visit.normalizedUrl));
    const filtered: ExportBundle = {
      ...bundle,
      pages: bundle.pages.filter((page) => urlSet.has(page.normalizedUrl)),
      visits: kept
    };
    const rebuilt = mergeExportBundles(
      { schemaVersion: 1, exportedAt: Date.now(), storageMode: "perProfile", pages: [], visits: [] },
      filtered,
      "perProfile",
      this.sourceName
    );
    await this.importData(rebuilt, "replace");
    return removed;
  }
}
