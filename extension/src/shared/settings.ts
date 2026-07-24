import type { ExtensionSettings } from "../types/models.js";

export const SETTINGS_KEY = "settings";

export const DEFAULT_SHARED_DIRECTORY = "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Global\\VisitedPageTracker";
const LEGACY_SHARED_DIRECTORY = "C:\\Users\\%username%\\AppData\\Local\\Google\\Chrome\\User Data\\Global\\VisitedPageTracker";

function normalizeSharedDirectory(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_SHARED_DIRECTORY;
  const directory = value.trim();
  return directory.toLowerCase() === LEGACY_SHARED_DIRECTORY.toLowerCase()
    ? DEFAULT_SHARED_DIRECTORY
    : directory;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  trackingEnabled: true,
  seenTagEnabled: true,
  tagPosition: "top-right",
  tagOpacity: 0.95,
  tagSize: "medium",
  tagDismissible: true,
  showVisitDetails: true,
  dateFormat: "locale",
  includeIncognitoVisits: false,
  countReloads: true,
  countSpaRoutes: true,
  includeFragments: false,
  ignoreTrackingParameters: false,
  unifyHttpHttps: false,
  unifyWww: false,
  ignoreQueryStrings: false,
  excludedDomains: [],
  excludedUrlPatterns: [],
  neverStoreTitles: false,
  retentionDays: 0,
  storageMode: "perProfile",
  sharedDatabase: {
    directory: DEFAULT_SHARED_DIRECTORY,
    filename: "visited_page_tracker.sqlite3"
  },
  badgeNewPageBehavior: "hidden",
  enableFileUrls: false
};

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY]);
}

export function mergeSettings(value: unknown): ExtensionSettings {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_SETTINGS);
  const partial = value as Partial<ExtensionSettings>;
  const partialShared: Partial<ExtensionSettings["sharedDatabase"]> = partial.sharedDatabase && typeof partial.sharedDatabase === "object"
    ? partial.sharedDatabase
    : {};
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    sharedDatabase: {
      ...DEFAULT_SETTINGS.sharedDatabase,
      ...partialShared,
      directory: normalizeSharedDirectory(partialShared.directory),
      filename: typeof partialShared.filename === "string" && partialShared.filename.trim()
        ? partialShared.filename.trim()
        : DEFAULT_SETTINGS.sharedDatabase.filename
    },
    excludedDomains: Array.isArray(partial.excludedDomains)
      ? partial.excludedDomains.filter((item): item is string => typeof item === "string")
      : [],
    excludedUrlPatterns: Array.isArray(partial.excludedUrlPatterns)
      ? partial.excludedUrlPatterns.filter((item): item is string => typeof item === "string")
      : []
  };
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}
