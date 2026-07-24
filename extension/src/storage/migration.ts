import type {
  ExportBundle,
  ExtensionSettings,
  ImportPreview,
  PageVisitRecord,
  StorageMode,
  VisitEvent
} from "../types/models.js";

export class ImportValidationError extends Error {
  constructor(public readonly preview: ImportPreview) {
    super(`Import contains ${preview.malformedPages} malformed pages and ${preview.malformedVisits} malformed visits.`);
    this.name = "ImportValidationError";
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPage(value: unknown): value is PageVisitRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.normalizedUrl === "string"
    && typeof item.lastOriginalUrl === "string"
    && typeof item.hostname === "string"
    && (typeof item.title === "string" || item.title === null)
    && finiteNumber(item.visitCount)
    && item.visitCount >= 0
    && finiteNumber(item.firstVisitedAt)
    && finiteNumber(item.lastVisitedAt)
    && finiteNumber(item.createdAt)
    && finiteNumber(item.updatedAt)
    && typeof item.storageSource === "string";
}

function isVisit(value: unknown): value is VisitEvent {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && typeof item.normalizedUrl === "string"
    && typeof item.originalUrl === "string"
    && finiteNumber(item.visitedAt)
    && (typeof item.transitionType === "string" || item.transitionType === null)
    && (finiteNumber(item.tabId) || item.tabId === null)
    && typeof item.incognito === "boolean"
    && typeof item.storageSource === "string";
}

export function inspectImportBundle(value: unknown): ImportPreview {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const pages = Array.isArray(candidate.pages) ? candidate.pages : [];
  const visits = Array.isArray(candidate.visits) ? candidate.visits : [];
  return {
    pages: pages.length,
    visits: visits.length,
    malformedPages: pages.filter((item) => !isPage(item)).length,
    malformedVisits: visits.filter((item) => !isVisit(item)).length
  };
}

export function validateExportBundle(value: unknown): ExportBundle {
  const preview = inspectImportBundle(value);
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (candidate.schemaVersion !== 1
      || !finiteNumber(candidate.exportedAt)
      || (candidate.storageMode !== "perProfile" && candidate.storageMode !== "shared")
      || !Array.isArray(candidate.pages)
      || !Array.isArray(candidate.visits)
      || preview.malformedPages > 0
      || preview.malformedVisits > 0) {
    throw new ImportValidationError(preview);
  }
  const bundle: ExportBundle = {
    schemaVersion: 1,
    exportedAt: candidate.exportedAt,
    storageMode: candidate.storageMode,
    pages: candidate.pages as PageVisitRecord[],
    visits: candidate.visits as VisitEvent[]
  };
  if (candidate.settings && typeof candidate.settings === "object") {
    bundle.settings = candidate.settings as ExtensionSettings;
  }
  return structuredClone(bundle);
}

function chooseBasePage(a: PageVisitRecord | undefined, b: PageVisitRecord | undefined): PageVisitRecord | undefined {
  if (!a) return b ? structuredClone(b) : undefined;
  if (!b) return structuredClone(a);
  const latest = a.lastVisitedAt >= b.lastVisitedAt ? a : b;
  return {
    ...structuredClone(latest),
    firstVisitedAt: Math.min(a.firstVisitedAt, b.firstVisitedAt),
    lastVisitedAt: Math.max(a.lastVisitedAt, b.lastVisitedAt),
    createdAt: Math.min(a.createdAt, b.createdAt),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    visitCount: Math.max(a.visitCount, b.visitCount)
  };
}

export function mergeExportBundles(
  existing: ExportBundle,
  incoming: ExportBundle,
  targetMode: StorageMode,
  targetSource: string
): ExportBundle {
  const pageKeys = new Set<string>([
    ...existing.pages.map((page) => page.normalizedUrl),
    ...incoming.pages.map((page) => page.normalizedUrl)
  ]);
  const existingPages = new Map(existing.pages.map((page) => [page.normalizedUrl, page]));
  const incomingPages = new Map(incoming.pages.map((page) => [page.normalizedUrl, page]));
  const eventMap = new Map<string, VisitEvent>();
  for (const event of [...existing.visits, ...incoming.visits]) {
    if (!eventMap.has(event.id)) eventMap.set(event.id, { ...event, storageSource: targetSource });
  }
  const visits = [...eventMap.values()].sort((a, b) => a.visitedAt - b.visitedAt || a.id.localeCompare(b.id));
  const eventsByUrl = new Map<string, VisitEvent[]>();
  for (const event of visits) {
    const group = eventsByUrl.get(event.normalizedUrl) ?? [];
    group.push(event);
    eventsByUrl.set(event.normalizedUrl, group);
    pageKeys.add(event.normalizedUrl);
  }

  const pages: PageVisitRecord[] = [];
  for (const normalizedUrl of pageKeys) {
    const base = chooseBasePage(existingPages.get(normalizedUrl), incomingPages.get(normalizedUrl));
    const events = eventsByUrl.get(normalizedUrl) ?? [];
    if (!base && events.length === 0) continue;
    const latestEvent = events.at(-1);
    const earliestEvent = events[0];
    const url = latestEvent?.originalUrl ?? base?.lastOriginalUrl ?? normalizedUrl;
    let hostname = base?.hostname ?? "";
    try { hostname = new URL(url).hostname.toLowerCase(); } catch { /* keep imported hostname */ }
    const first = earliestEvent?.visitedAt ?? base?.firstVisitedAt ?? Date.now();
    const last = latestEvent?.visitedAt ?? base?.lastVisitedAt ?? first;
    pages.push({
      normalizedUrl,
      lastOriginalUrl: url,
      hostname,
      title: base?.title ?? null,
      visitCount: events.length > 0 ? events.length : (base?.visitCount ?? 0),
      firstVisitedAt: first,
      lastVisitedAt: last,
      createdAt: Math.min(base?.createdAt ?? first, first),
      updatedAt: Math.max(base?.updatedAt ?? last, last),
      storageSource: targetSource
    });
  }
  pages.sort((a, b) => a.normalizedUrl.localeCompare(b.normalizedUrl));
  return {
    schemaVersion: 1,
    exportedAt: Date.now(),
    storageMode: targetMode,
    pages,
    visits
  };
}

export function replaceBundleSource(bundle: ExportBundle, mode: StorageMode, source: string): ExportBundle {
  return {
    ...structuredClone(bundle),
    storageMode: mode,
    exportedAt: Date.now(),
    pages: bundle.pages.map((page) => ({ ...page, storageSource: source })),
    visits: bundle.visits.map((visit) => ({ ...visit, storageSource: source }))
  };
}
