import type {
  DatabaseConfig,
  ExportBundle,
  ExtensionSettings,
  PageSearchQuery,
  RecordVisitInput,
  TabPageState
} from "../types/models.js";

export type RuntimeRequest =
  | { type: "CONTENT_READY"; url: string; title: string }
  | { type: "SPA_NAVIGATION"; url: string; title: string; navigationType: "pushState" | "replaceState" | "popstate" }
  | { type: "GET_ACTIVE_PAGE_STATE"; tabId?: number }
  | { type: "GET_PAGE"; normalizedUrl: string }
  | { type: "SEARCH_PAGES"; query: PageSearchQuery }
  | { type: "GET_VISIT_EVENTS"; normalizedUrl: string; offset?: number; limit?: number }
  | { type: "GET_STATISTICS" }
  | { type: "DELETE_PAGE"; normalizedUrl: string }
  | { type: "DELETE_DOMAIN"; hostname: string }
  | { type: "CLEAR_HISTORY" }
  | { type: "EXPORT_DATA" }
  | { type: "IMPORT_DATA"; bundle: ExportBundle; mode: "merge" | "replace" }
  | { type: "FORGET_CURRENT_PAGE"; tabId: number }
  | { type: "DISABLE_CURRENT_DOMAIN"; tabId: number }
  | { type: "TEST_SHARED_CONNECTION"; config: DatabaseConfig }
  | { type: "OPEN_STORAGE_DIRECTORY"; config: DatabaseConfig }
  | { type: "MIGRATE_STORAGE"; source: "perProfile" | "shared"; target: "perProfile" | "shared"; merge: boolean; config: DatabaseConfig }
  | { type: "SETTINGS_UPDATED"; settings: ExtensionSettings }
  | { type: "INTERNAL_RECORD_VISIT"; input: RecordVisitInput };

export type ContentCommand =
  | { type: "SHOW_SEEN_TAG"; state: TabPageState; settings: ExtensionSettings }
  | { type: "HIDE_SEEN_TAG" };

export interface RuntimeResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: {
    code: string;
    message: string;
  };
}

export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && [
    "CONTENT_READY", "SPA_NAVIGATION", "GET_ACTIVE_PAGE_STATE", "GET_PAGE", "SEARCH_PAGES",
    "GET_VISIT_EVENTS", "GET_STATISTICS", "DELETE_PAGE", "DELETE_DOMAIN", "CLEAR_HISTORY",
    "EXPORT_DATA", "IMPORT_DATA", "FORGET_CURRENT_PAGE", "DISABLE_CURRENT_DOMAIN",
    "TEST_SHARED_CONNECTION", "OPEN_STORAGE_DIRECTORY", "MIGRATE_STORAGE", "SETTINGS_UPDATED",
    "INTERNAL_RECORD_VISIT"
  ].includes(type);
}
