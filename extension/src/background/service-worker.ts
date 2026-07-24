import { clearTabState, registerNavigationListeners, getLatestTransition, getTabState, processNavigation, replayTabState, saveTabState } from "./navigation-tracker.js";
import { updateBadge } from "./badge-manager.js";
import { IndexedDbStorage } from "../storage/indexeddb-storage.js";
import { NativeHostError, NativeStorage } from "../storage/native-storage.js";
import { createStorage } from "../storage/storage-factory.js";
import { isRuntimeRequest, type RuntimeRequest, type RuntimeResponse } from "../shared/messages.js";
import { DEFAULT_SETTINGS, getSettings, saveSettings } from "../shared/settings.js";
import type { DatabaseConfig, ExportBundle, ExtensionSettings, TabPageState } from "../types/models.js";

const RETENTION_ALARM = "visited-page-tracker-retention";
registerNavigationListeners();

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("settings");
  if (!existing.settings) await saveSettings(structuredClone(DEFAULT_SETTINGS));
  await chrome.alarms.create(RETENTION_ALARM, { periodInMinutes: 24 * 60 });
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(RETENTION_ALARM, { periodInMinutes: 24 * 60 });
  await runRetention();
});

chrome.alarms.onAlarm.addListener((alarm: any) => {
  if (alarm.name === RETENTION_ALARM) void runRetention();
});

async function runRetention(): Promise<void> {
  const settings = await getSettings();
  if (settings.retentionDays <= 0) return;
  const cutoff = Date.now() - settings.retentionDays * 86_400_000;
  try {
    await createStorage(settings).removeVisitsOlderThan(cutoff);
  } catch (error) {
    await chrome.storage.local.set({ lastStorageError: String(error), lastStorageErrorAt: Date.now() });
  }
}

async function currentTabId(requested?: number): Promise<number | null> {
  if (typeof requested === "number") return requested;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return typeof tab?.id === "number" ? tab.id : null;
}

async function clearAllTabStates(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith("tabState:"));
  if (keys.length > 0) await chrome.storage.session.remove(keys);
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab: any) => typeof tab.id === "number" ? chrome.action.setBadgeText({ tabId: tab.id, text: "" }) : undefined));
}

async function storageForMode(mode: "perProfile" | "shared", config: DatabaseConfig) {
  return mode === "shared" ? new NativeStorage(config) : new IndexedDbStorage();
}

async function handleRequest(request: RuntimeRequest, sender: any): Promise<unknown> {
  const settings = await getSettings();
  switch (request.type) {
    case "CONTENT_READY": {
      if (typeof sender.tab?.id !== "number" || typeof request.url !== "string") throw new Error("CONTENT_READY must originate from a tab.");
      await new Promise((resolve) => setTimeout(resolve, 150));
      const existingState = await getTabState(sender.tab.id);
      if (existingState) {
        await replayTabState(sender.tab.id);
        return { ready: true, replayed: true };
      }
      const transitionType = await getLatestTransition(sender.tab.id);
      await processNavigation({
        tabId: sender.tab.id,
        frameId: 0,
        url: request.url,
        title: typeof request.title === "string" ? request.title : "",
        timeStamp: Date.now(),
        transitionType: transitionType ?? "content_ready"
      });
      return { ready: true, replayed: false };
    }
    case "SPA_NAVIGATION": {
      if (typeof sender.tab?.id !== "number" || typeof request.url !== "string") throw new Error("Invalid SPA navigation message.");
      return processNavigation({
        tabId: sender.tab.id,
        frameId: 0,
        url: request.url,
        title: typeof request.title === "string" ? request.title : "",
        timeStamp: Date.now(),
        transitionType: request.navigationType,
        isSpa: true
      });
    }
    case "GET_ACTIVE_PAGE_STATE": {
      const tabId = await currentTabId(request.tabId);
      if (tabId == null) return null;
      const state = await getTabState(tabId);
      if (!state || settings.storageMode !== "shared") return state;
      const status = await createStorage(settings).getStatus();
      let refreshed: TabPageState;
      if (status.available) {
        const { error: _ignored, ...withoutError } = state;
        refreshed = { ...withoutError, storageStatus: status };
      } else {
        refreshed = { ...state, storageStatus: status, error: status.errorMessage ?? "Shared database unavailable." };
      }
      await saveTabState(refreshed);
      await updateBadge(tabId, refreshed, settings);
      return refreshed;
    }
    case "GET_PAGE": return createStorage(settings).getPage(request.normalizedUrl);
    case "SEARCH_PAGES": return createStorage(settings).searchPages(request.query);
    case "GET_VISIT_EVENTS": return createStorage(settings).getVisitEvents(request.normalizedUrl, request.offset, request.limit);
    case "GET_STATISTICS": return createStorage(settings).getStatistics();
    case "DELETE_PAGE": {
      await createStorage(settings).deletePage(request.normalizedUrl);
      return { deleted: true };
    }
    case "DELETE_DOMAIN": return { deleted: await createStorage(settings).deleteDomain(request.hostname) };
    case "CLEAR_HISTORY": {
      await createStorage(settings).clearHistory();
      await clearAllTabStates();
      return { cleared: true };
    }
    case "EXPORT_DATA": return createStorage(settings).exportData();
    case "IMPORT_DATA": {
      const bundle = settings.neverStoreTitles
        ? { ...request.bundle, pages: request.bundle.pages.map((page) => ({ ...page, title: null })) }
        : request.bundle;
      return createStorage(settings).importData(bundle, request.mode);
    }
    case "FORGET_CURRENT_PAGE": {
      const state = await getTabState(request.tabId);
      if (!state) return { deleted: false };
      await createStorage(settings).deletePage(state.normalizedUrl);
      const next: TabPageState = { ...state, wasSeen: false, previousVisitCount: 0, visitCount: 0, firstVisitedAt: null, previousLastVisitedAt: null };
      await saveTabState(next);
      await updateBadge(request.tabId, next, settings);
      await chrome.tabs.sendMessage(request.tabId, { type: "HIDE_SEEN_TAG" }).catch(() => undefined);
      return { deleted: true };
    }
    case "DISABLE_CURRENT_PAGE": {
      const state = await getTabState(request.tabId);
      if (!state) return settings;
      const updated: ExtensionSettings = {
        ...settings,
        excludedPages: [...new Set([...settings.excludedPages, state.normalizedUrl])].sort()
      };
      await saveSettings(updated);
      await clearTabState(request.tabId);
      await chrome.tabs.sendMessage(request.tabId, { type: "HIDE_SEEN_TAG" }).catch(() => undefined);
      return updated;
    }
    case "DISABLE_CURRENT_DOMAIN": {
      const state = await getTabState(request.tabId);
      if (!state) return settings;
      const updated: ExtensionSettings = {
        ...settings,
        excludedDomains: [...new Set([...settings.excludedDomains, state.hostname])].sort()
      };
      await saveSettings(updated);
      await clearTabState(request.tabId);
      await chrome.tabs.sendMessage(request.tabId, { type: "HIDE_SEEN_TAG" }).catch(() => undefined);
      return updated;
    }
    case "TEST_SHARED_CONNECTION": {
      const native = new NativeStorage(request.config);
      return native.configureDatabase();
    }
    case "OPEN_STORAGE_DIRECTORY": {
      await new NativeStorage(request.config).openStorageDirectory();
      return { opened: true };
    }
    case "MIGRATE_STORAGE": {
      if (request.source === request.target) throw new Error("Source and target storage modes must differ.");
      const source = await storageForMode(request.source, request.config);
      const target = await storageForMode(request.target, request.config);
      const exported = await source.exportData();
      const bundle = settings.neverStoreTitles
        ? { ...exported, pages: exported.pages.map((page) => ({ ...page, title: null })) }
        : exported;
      const result = await target.importData(bundle, request.merge ? "merge" : "replace");
      return { ...result, sourceRecordsPreserved: true };
    }
    case "SETTINGS_UPDATED": {
      if (request.settings.neverStoreTitles && !settings.neverStoreTitles) {
        const backends = [createStorage(settings)];
        const modeChanged = request.settings.storageMode !== settings.storageMode
          || JSON.stringify(request.settings.sharedDatabase) !== JSON.stringify(settings.sharedDatabase);
        if (modeChanged) backends.push(createStorage(request.settings));
        for (const storage of backends) {
          const existing = await storage.exportData();
          if (existing.pages.some((page) => page.title !== null)) {
            await storage.importData({ ...existing, pages: existing.pages.map((page) => ({ ...page, title: null })) }, "replace");
          }
        }
      }
      await saveSettings(request.settings);
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (typeof tab.id !== "number") continue;
        const state = await getTabState(tab.id);
        if (state) {
          await updateBadge(tab.id, state, request.settings);
          await chrome.tabs.sendMessage(tab.id, state.wasSeen && request.settings.seenTagEnabled
            ? { type: "SHOW_SEEN_TAG", state, settings: request.settings }
            : { type: "HIDE_SEEN_TAG" }).catch(() => undefined);
        }
      }
      await runRetention();
      return request.settings;
    }
    case "INTERNAL_RECORD_VISIT": return createStorage(settings).recordVisit(request.input);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender: any, sendResponse: (value: RuntimeResponse) => void) => {
  if (!isRuntimeRequest(message)) {
    sendResponse({ ok: false, error: { code: "INVALID_REQUEST", message: "Invalid request." } });
    return false;
  }
  void handleRequest(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      const text = error instanceof Error ? error.message : String(error);
      const code = error instanceof NativeHostError ? error.code : "EXTENSION_REQUEST_FAILED";
      void chrome.storage.local.set({ lastStorageError: text, lastStorageErrorAt: Date.now() });
      sendResponse({ ok: false, error: { code, message: text } });
    });
  return true;
});
