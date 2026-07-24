import { updateBadge } from "./badge-manager.js";
import { NavigationDeduper, SessionDedupeStore } from "./dedupe.js";
import { normalizeUrl } from "../normalization/normalize-url.js";
import { createStorage } from "../storage/storage-factory.js";
import type { ContentCommand } from "../shared/messages.js";
import { domainMatches, urlPatternMatches } from "../shared/matchers.js";
import { getSettings } from "../shared/settings.js";
import type { DatabaseStatus, ExtensionSettings, TabPageState } from "../types/models.js";

const deduper = new NavigationDeduper(new SessionDedupeStore());
const TAB_STATE_PREFIX = "tabState:";
const COMMIT_PREFIX = "navigationCommit:";

interface NavigationDetails {
  tabId: number;
  frameId: number;
  url: string;
  timeStamp: number;
  documentId?: string;
  transitionType?: string;
  isSpa?: boolean;
  title?: string;
}

function tabStateKey(tabId: number): string { return `${TAB_STATE_PREFIX}${tabId}`; }
function commitKey(tabId: number, frameId: number, documentId?: string): string {
  return `${COMMIT_PREFIX}${tabId}:${frameId}:${documentId ?? "current"}`;
}

export async function saveTabState(state: TabPageState): Promise<void> {
  await chrome.storage.session.set({ [tabStateKey(state.tabId)]: state });
}

export async function getTabState(tabId: number): Promise<TabPageState | null> {
  const result = await chrome.storage.session.get(tabStateKey(tabId));
  const value = result[tabStateKey(tabId)];
  return value && typeof value === "object" ? value as TabPageState : null;
}

export async function clearTabState(tabId: number): Promise<void> {
  await chrome.storage.session.remove(tabStateKey(tabId));
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
}

async function tabExists(tabId: number): Promise<boolean> {
  try { await chrome.tabs.get(tabId); return true; } catch { return false; }
}

async function sendContentCommand(tabId: number, command: ContentCommand): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, command);
  } catch {
    // The content script may not be ready yet. CONTENT_READY will replay stored tab state.
  }
}

async function hideForTab(tabId: number, settings: ExtensionSettings): Promise<void> {
  await clearTabState(tabId);
  await updateBadge(tabId, null, settings);
  await sendContentCommand(tabId, { type: "HIDE_SEEN_TAG" });
}

function defaultStatus(settings: ExtensionSettings): DatabaseStatus {
  return settings.storageMode === "shared"
    ? { available: true, path: null, errorCode: null, errorMessage: null }
    : { available: true, path: "Chrome profile IndexedDB", errorCode: null, errorMessage: null };
}

export function shouldCountNavigation(transitionType: string | undefined, isSpa: boolean, settings: ExtensionSettings): boolean {
  if (isSpa && !settings.countSpaRoutes) return false;
  if (transitionType === "reload" && !settings.countReloads) return false;
  return true;
}

export async function processNavigation(details: NavigationDetails): Promise<TabPageState | null> {
  if (details.tabId < 0 || details.frameId !== 0) return null;
  const settings = await getSettings();
  if (!settings.trackingEnabled) {
    await hideForTab(details.tabId, settings);
    return null;
  }
  let tab: any;
  try {
    tab = await chrome.tabs.get(details.tabId);
  } catch {
    return null;
  }
  if (tab.incognito && !settings.includeIncognitoVisits) {
    await hideForTab(details.tabId, settings);
    return null;
  }
  const normalized = normalizeUrl(details.url, settings);
  if (!normalized
      || domainMatches(normalized.hostname, settings.excludedDomains)
      || urlPatternMatches(normalized.originalUrl, settings.excludedUrlPatterns)) {
    await hideForTab(details.tabId, settings);
    return null;
  }
  const allowed = await deduper.shouldProcess({
    tabId: details.tabId,
    frameId: details.frameId,
    normalizedUrl: normalized.normalizedUrl,
    timestamp: details.timeStamp,
    ...(details.documentId ? { documentId: details.documentId } : {})
  });
  if (!allowed) return getTabState(details.tabId);

  const storage = createStorage(settings);
  const currentVisitTime = Math.round(details.timeStamp || Date.now());
  const title = settings.neverStoreTitles ? null : (details.title ?? tab.title ?? null);
  let status = defaultStatus(settings);
  try {
    if (settings.storageMode === "shared") {
      status = await storage.getStatus();
      if (!status.available) throw new Error(status.errorMessage ?? "Shared database unavailable.");
    }
    const countThisNavigation = shouldCountNavigation(details.transitionType, Boolean(details.isSpa), settings);
    let state: TabPageState;
    if (countThisNavigation) {
      const result = await storage.recordVisit({
        normalizedUrl: normalized.normalizedUrl,
        originalUrl: normalized.originalUrl,
        hostname: normalized.hostname,
        title,
        suppressTitle: settings.neverStoreTitles,
        visitedAt: currentVisitTime,
        transitionType: details.transitionType ?? null,
        tabId: details.tabId,
        incognito: Boolean(tab.incognito),
        storageSource: storage.sourceName
      });
      state = {
        tabId: details.tabId,
        originalUrl: normalized.originalUrl,
        normalizedUrl: normalized.normalizedUrl,
        hostname: normalized.hostname,
        title,
        wasSeen: result.wasSeen,
        previousVisitCount: result.previousVisitCount,
        visitCount: result.visitCount,
        firstVisitedAt: result.firstVisitedAt,
        previousLastVisitedAt: result.previousLastVisitedAt,
        currentVisitTime,
        storageMode: settings.storageMode,
        storageStatus: status
      };
    } else {
      const page = await storage.getPage(normalized.normalizedUrl);
      state = {
        tabId: details.tabId,
        originalUrl: normalized.originalUrl,
        normalizedUrl: normalized.normalizedUrl,
        hostname: normalized.hostname,
        title,
        wasSeen: page !== null,
        previousVisitCount: page?.visitCount ?? 0,
        visitCount: page?.visitCount ?? 0,
        firstVisitedAt: page?.firstVisitedAt ?? null,
        previousLastVisitedAt: page?.lastVisitedAt ?? null,
        currentVisitTime,
        storageMode: settings.storageMode,
        storageStatus: status
      };
    }
    if (!await tabExists(details.tabId)) return state;
    await saveTabState(state);
    await updateBadge(details.tabId, state, settings);
    await sendContentCommand(details.tabId, state.wasSeen && settings.seenTagEnabled
      ? { type: "SHOW_SEEN_TAG", state, settings }
      : { type: "HIDE_SEEN_TAG" });
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await chrome.storage.local.set({ lastStorageError: message, lastStorageErrorAt: Date.now() });
    const state: TabPageState = {
      tabId: details.tabId,
      originalUrl: normalized.originalUrl,
      normalizedUrl: normalized.normalizedUrl,
      hostname: normalized.hostname,
      title,
      wasSeen: false,
      previousVisitCount: 0,
      visitCount: 0,
      firstVisitedAt: null,
      previousLastVisitedAt: null,
      currentVisitTime,
      storageMode: settings.storageMode,
      storageStatus: { available: false, path: status.path, errorCode: status.errorCode ?? "STORAGE_UNAVAILABLE", errorMessage: message },
      error: message
    };
    if (!await tabExists(details.tabId)) return state;
    await saveTabState(state);
    await updateBadge(details.tabId, state, settings);
    await sendContentCommand(details.tabId, { type: "HIDE_SEEN_TAG" });
    return state;
  }
}

async function getCommit(details: any): Promise<{ transitionType?: string; timeStamp?: number } | null> {
  const keys = [commitKey(details.tabId, details.frameId, details.documentId), commitKey(details.tabId, details.frameId)];
  const result = await chrome.storage.session.get(keys);
  for (const key of keys) {
    const value = result[key];
    if (value && typeof value === "object") return value;
  }
  return null;
}

export async function getLatestTransition(tabId: number): Promise<string | undefined> {
  const result = await chrome.storage.session.get(commitKey(tabId, 0));
  const value = result[commitKey(tabId, 0)];
  return value && typeof value.transitionType === "string" ? value.transitionType : undefined;
}

export function registerNavigationListeners(): void {
  chrome.webNavigation.onBeforeNavigate.addListener(async (details: any) => {
    if (details.frameId !== 0) return;
    await clearTabState(details.tabId);
    await sendContentCommand(details.tabId, { type: "HIDE_SEEN_TAG" });
  });

  chrome.webNavigation.onCommitted.addListener(async (details: any) => {
    if (details.frameId !== 0) return;
    const value = { transitionType: details.transitionType, timeStamp: details.timeStamp, url: details.url };
    await chrome.storage.session.set({
      [commitKey(details.tabId, details.frameId, details.documentId)]: value,
      [commitKey(details.tabId, details.frameId)]: value
    });
  });

  chrome.webNavigation.onCompleted.addListener(async (details: any) => {
    if (details.frameId !== 0) return;
    const commit = await getCommit(details);
    await processNavigation({
      tabId: details.tabId,
      frameId: details.frameId,
      url: details.url,
      timeStamp: details.timeStamp,
      ...(details.documentId ? { documentId: details.documentId } : {}),
      ...(commit?.transitionType ? { transitionType: commit.transitionType } : {})
    });
  });

  chrome.webNavigation.onHistoryStateUpdated.addListener(async (details: any) => {
    if (details.frameId !== 0) return;
    await processNavigation({
      tabId: details.tabId,
      frameId: details.frameId,
      url: details.url,
      timeStamp: details.timeStamp,
      documentId: details.documentId,
      transitionType: "history",
      isSpa: true
    });
  });

  chrome.webNavigation.onReferenceFragmentUpdated.addListener(async (details: any) => {
    if (details.frameId !== 0) return;
    const settings = await getSettings();
    if (!settings.includeFragments) return;
    await processNavigation({
      tabId: details.tabId,
      frameId: details.frameId,
      url: details.url,
      timeStamp: details.timeStamp,
      documentId: details.documentId,
      transitionType: "fragment",
      isSpa: true
    });
  });

  chrome.tabs.onRemoved.addListener((tabId: number) => { void clearTabState(tabId); });
}

export async function replayTabState(tabId: number): Promise<void> {
  const settings = await getSettings();
  const state = await getTabState(tabId);
  if (!state) return;
  await sendContentCommand(tabId, state.wasSeen && settings.seenTagEnabled
    ? { type: "SHOW_SEEN_TAG", state, settings }
    : { type: "HIDE_SEEN_TAG" });
}
