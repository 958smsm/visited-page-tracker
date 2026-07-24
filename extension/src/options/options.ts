import { sendRequest } from "../shared/runtime.js";
import { DEFAULT_SHARED_DIRECTORY, getSettings } from "../shared/settings.js";
import { parseLines, uniqueStrings } from "../shared/utils.js";
import { runSharedConnectionTest, saveSettingsAfterConnectionTest } from "./shared-connection.js";
import type { DatabaseConfig, DatabaseStatus, ExtensionSettings, StorageMode } from "../types/models.js";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const checkbox = (id: string): HTMLInputElement => byId<HTMLInputElement>(id);
const input = (id: string): HTMLInputElement => byId<HTMLInputElement>(id);
const select = (id: string): HTMLSelectElement => byId<HTMLSelectElement>(id);
let settings: ExtensionSettings;
let lastSavedMode: StorageMode = "perProfile";

function setStatus(message: string): void { byId("saveStatus").textContent = message; }

function showLastStorageError(message: string, at = Date.now()): void {
  const panel = byId("lastError");
  panel.textContent = `Most recent storage error (${new Date(at).toLocaleString()}): ${message}`;
  panel.classList.remove("hidden");
}

async function rememberStorageError(status: DatabaseStatus): Promise<void> {
  const message = status.errorMessage ?? "The shared database connection failed.";
  const at = Date.now();
  await chrome.storage.local.set({
    lastStorageError: `[${status.errorCode ?? "CONNECTION_FAILED"}] ${message}`,
    lastStorageErrorAt: at
  });
  showLastStorageError(message, at);
}
function sharedConfig(): DatabaseConfig {
  const directory = input("sharedDirectory").value.trim() || DEFAULT_SHARED_DIRECTORY;
  const filename = input("sharedFilename").value.trim() || "visited_page_tracker.sqlite3";
  input("sharedDirectory").value = directory;
  input("sharedFilename").value = filename;
  return { directory, filename };
}

function populate(value: ExtensionSettings): void {
  settings = value;
  lastSavedMode = value.storageMode;
  for (const key of ["trackingEnabled","seenTagEnabled","tagDismissible","showVisitDetails","includeIncognitoVisits","countReloads","countSpaRoutes","includeFragments","ignoreTrackingParameters","unifyHttpHttps","unifyWww","ignoreQueryStrings","neverStoreTitles","enableFileUrls"] as const) checkbox(key).checked = value[key];
  select("tagPosition").value = value.tagPosition;
  select("tagSize").value = value.tagSize;
  select("dateFormat").value = value.dateFormat;
  select("badgeNewPageBehavior").value = value.badgeNewPageBehavior;
  input("tagOpacity").value = String(value.tagOpacity);
  byId<HTMLOutputElement>("tagOpacityOutput").value = `${Math.round(value.tagOpacity * 100)}%`;
  input("retentionDays").value = String(value.retentionDays);
  input("sharedDirectory").value = value.sharedDatabase.directory;
  input("sharedFilename").value = value.sharedDatabase.filename;
  byId<HTMLTextAreaElement>("excludedDomains").value = value.excludedDomains.join("\n");
  byId<HTMLTextAreaElement>("excludedPages").value = value.excludedPages.join("\n");
  byId<HTMLTextAreaElement>("excludedUrlPatterns").value = value.excludedUrlPatterns.join("\n");
  const radio = document.querySelector<HTMLInputElement>(`input[name="storageMode"][value="${value.storageMode}"]`);
  if (radio) radio.checked = true;
  updateSharedVisibility();
}

function collect(): ExtensionSettings {
  const selectedMode = document.querySelector<HTMLInputElement>('input[name="storageMode"]:checked')?.value as StorageMode;
  return {
    ...settings,
    trackingEnabled: checkbox("trackingEnabled").checked,
    seenTagEnabled: checkbox("seenTagEnabled").checked,
    tagPosition: select("tagPosition").value as ExtensionSettings["tagPosition"],
    tagOpacity: Number(input("tagOpacity").value),
    tagSize: select("tagSize").value as ExtensionSettings["tagSize"],
    tagDismissible: checkbox("tagDismissible").checked,
    showVisitDetails: checkbox("showVisitDetails").checked,
    dateFormat: select("dateFormat").value as ExtensionSettings["dateFormat"],
    includeIncognitoVisits: checkbox("includeIncognitoVisits").checked,
    countReloads: checkbox("countReloads").checked,
    countSpaRoutes: checkbox("countSpaRoutes").checked,
    includeFragments: checkbox("includeFragments").checked,
    ignoreTrackingParameters: checkbox("ignoreTrackingParameters").checked,
    unifyHttpHttps: checkbox("unifyHttpHttps").checked,
    unifyWww: checkbox("unifyWww").checked,
    ignoreQueryStrings: checkbox("ignoreQueryStrings").checked,
    excludedDomains: uniqueStrings(parseLines(byId<HTMLTextAreaElement>("excludedDomains").value)),
    excludedPages: uniqueStrings(parseLines(byId<HTMLTextAreaElement>("excludedPages").value)),
    excludedUrlPatterns: uniqueStrings(parseLines(byId<HTMLTextAreaElement>("excludedUrlPatterns").value)),
    neverStoreTitles: checkbox("neverStoreTitles").checked,
    retentionDays: Math.max(0, Math.floor(Number(input("retentionDays").value) || 0)),
    storageMode: selectedMode ?? lastSavedMode,
    sharedDatabase: sharedConfig(),
    badgeNewPageBehavior: select("badgeNewPageBehavior").value as ExtensionSettings["badgeNewPageBehavior"],
    enableFileUrls: checkbox("enableFileUrls").checked
  };
}

function updateSharedVisibility(): void {
  const mode = document.querySelector<HTMLInputElement>('input[name="storageMode"]:checked')?.value;
  byId("sharedSettings").classList.toggle("hidden", mode !== "shared");
}

async function testConnection(showSuccess = true): Promise<DatabaseStatus> {
  const config = sharedConfig();
  return runSharedConnectionTest({
    config,
    send: (database) => sendRequest<DatabaseStatus>(
      { type: "TEST_SHARED_CONNECTION", config: database },
      12_000
    ),
    ui: {
      testButton: byId<HTMLButtonElement>("testConnection"),
      nativeStatus: byId("nativeStatus"),
      resolvedPath: byId("resolvedPath")
    },
    onStatus: (message) => {
      if (showSuccess || message === "Connection failed") setStatus(message);
    },
    onFailure: rememberStorageError
  });
}

async function migrate(source: StorageMode, target: StorageMode): Promise<void> {
  const merge = checkbox("mergeMigration").checked;
  const targetName = target === "shared" ? "Shared" : "Per Profile";
  const action = merge ? "merge into" : "replace";
  if (!confirm(`This will ${action} ${targetName} storage. The source database will be preserved. Continue?`)) return;
  byId("migrationStatus").textContent = "Migrating…";
  try {
    const result = await sendRequest<{ importedPages: number; importedVisits: number }>({
      type: "MIGRATE_STORAGE", source, target, merge, config: sharedConfig()
    });
    byId("migrationStatus").textContent = `Migrated ${result.importedPages} pages and ${result.importedVisits} visit events. Source data was not deleted.`;
  } catch (error) {
    byId("migrationStatus").textContent = `Migration failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

document.querySelectorAll<HTMLInputElement>('input[name="storageMode"]').forEach((radio) => {
  radio.addEventListener("change", async () => {
    updateSharedVisibility();
    const next = radio.value as StorageMode;
    if (next === lastSavedMode) return;
    const explanation = next === "shared"
      ? "Shared mode requires the native host and will stop recording if SQLite is unavailable. There is no automatic fallback."
      : "Per Profile mode uses this Chrome profile’s IndexedDB. Shared records remain in SQLite.";
    if (!confirm(`${explanation}\n\nSwitch storage mode?`)) {
      const previous = document.querySelector<HTMLInputElement>(`input[name="storageMode"][value="${lastSavedMode}"]`);
      if (previous) previous.checked = true;
      updateSharedVisibility();
      return;
    }
    if (next === "shared") {
      const status = await testConnection(false);
      if (!status.available) {
        const previous = document.querySelector<HTMLInputElement>(`input[name="storageMode"][value="${lastSavedMode}"]`);
        if (previous) previous.checked = true;
        updateSharedVisibility();
        alert(`Shared mode was not selected. ${status.errorMessage ?? "The native host/database connection failed."} No fallback was selected.`);
        return;
      }
    }
    const shouldMigrate = confirm("Migrate existing data now? Choose Cancel to switch without migration. The source will not be deleted.");
    if (shouldMigrate) {
      await migrate(lastSavedMode, next);
    }
  });
});

input("tagOpacity").addEventListener("input", () => { byId<HTMLOutputElement>("tagOpacityOutput").value = `${Math.round(Number(input("tagOpacity").value) * 100)}%`; });
checkbox("enableFileUrls").addEventListener("change", async () => {
  if (!checkbox("enableFileUrls").checked) return;
  const granted = await chrome.permissions.request({ origins: ["file:///*"] });
  if (!granted) {
    checkbox("enableFileUrls").checked = false;
    alert("Chrome did not grant file URL access. You can also enable it on the extension details page.");
  }
});

byId("testConnection").addEventListener("click", () => void testConnection());
byId("openDirectory").addEventListener("click", async () => {
  try { await sendRequest({ type: "OPEN_STORAGE_DIRECTORY", config: sharedConfig() }); }
  catch (error) { alert(error instanceof Error ? error.message : String(error)); }
});
byId("migrateToShared").addEventListener("click", () => void migrate("perProfile", "shared"));
byId("migrateToProfile").addEventListener("click", () => void migrate("shared", "perProfile"));
byId("clearHistory").addEventListener("click", async () => {
  if (!confirm("Clear every page and visit event from the currently selected storage? This cannot be undone.")) return;
  if (prompt('Type CLEAR to confirm:') !== "CLEAR") return;
  await sendRequest({ type: "CLEAR_HISTORY" });
  setStatus("History cleared");
});

byId<HTMLFormElement>("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const next = collect();
  try {
    const saved = await saveSettingsAfterConnectionTest(
      next,
      () => testConnection(false),
      async (value) => {
        await sendRequest({ type: "SETTINGS_UPDATED", settings: value });
      }
    );
    if (!saved) {
      alert("Shared mode was not saved because the native host/database connection failed. No fallback was selected.");
      return;
    }
    settings = next;
    lastSavedMode = next.storageMode;
    setStatus("Saved");
    setTimeout(() => setStatus("Ready"), 1_500);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Save failed: ${message}`);
    await rememberStorageError({
      available: false,
      path: null,
      errorCode: "SETTINGS_SAVE_FAILED",
      errorMessage: message
    });
  }
});

void Promise.all([getSettings(), chrome.storage.local.get(["lastStorageError", "lastStorageErrorAt"])]).then(async ([value, errorInfo]) => {
  populate(value);
  if (typeof errorInfo.lastStorageError === "string" && errorInfo.lastStorageError) {
    showLastStorageError(
      errorInfo.lastStorageError,
      typeof errorInfo.lastStorageErrorAt === "number" ? errorInfo.lastStorageErrorAt : Date.now()
    );
  }
  if (value.storageMode === "shared" && value.sharedDatabase.directory) await testConnection(false);
}).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
