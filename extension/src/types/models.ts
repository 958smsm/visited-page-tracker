export type StorageMode = "perProfile" | "shared";
export type TagPosition = "top-right" | "top-left" | "bottom-right" | "bottom-left";
export type TagSize = "small" | "medium" | "large";
export type DateFormat = "locale" | "iso" | "relative";
export type SortField = "url" | "domain" | "count" | "firstVisit" | "lastVisit";
export type SortDirection = "asc" | "desc";

export interface PageVisitRecord {
  normalizedUrl: string;
  lastOriginalUrl: string;
  hostname: string;
  title: string | null;
  visitCount: number;
  firstVisitedAt: number;
  lastVisitedAt: number;
  createdAt: number;
  updatedAt: number;
  storageSource: string;
}

export interface VisitEvent {
  id: string;
  normalizedUrl: string;
  originalUrl: string;
  visitedAt: number;
  transitionType: string | null;
  tabId: number | null;
  incognito: boolean;
  storageSource: string;
}

export interface RecordVisitInput {
  normalizedUrl: string;
  originalUrl: string;
  hostname: string;
  title: string | null;
  suppressTitle?: boolean;
  visitedAt: number;
  transitionType: string | null;
  tabId: number | null;
  incognito: boolean;
  eventId?: string;
  storageSource: string;
}

export interface RecordVisitResult {
  wasSeen: boolean;
  previousVisitCount: number;
  visitCount: number;
  firstVisitedAt: number;
  previousLastVisitedAt: number | null;
  lastVisitedAt: number;
}

export interface PageSearchQuery {
  search?: string;
  url?: string;
  domain?: string;
  dateFrom?: number;
  dateTo?: number;
  minCount?: number;
  maxCount?: number;
  storageSource?: string;
  sortField: SortField;
  sortDirection: SortDirection;
  offset: number;
  limit: number;
}

export interface PageSearchResult {
  records: PageVisitRecord[];
  total: number;
}

export interface VisitStatistics {
  totalTrackedPages: number;
  totalVisits: number;
  pagesVisitedToday: number;
  mostVisitedDomain: { hostname: string; visits: number } | null;
  mostVisitedPage: PageVisitRecord | null;
  perDayVisitTotals: Array<{ date: string; visits: number }>;
}

export interface ExportBundle {
  schemaVersion: 1;
  exportedAt: number;
  storageMode: StorageMode;
  pages: PageVisitRecord[];
  visits: VisitEvent[];
  settings?: ExtensionSettings;
}

export interface ImportPreview {
  pages: number;
  visits: number;
  malformedPages: number;
  malformedVisits: number;
}

export interface ImportResult extends ImportPreview {
  importedPages: number;
  importedVisits: number;
  skippedPages: number;
  skippedVisits: number;
  backupPath?: string;
}

export interface DatabaseConfig {
  directory: string;
  filename: string;
}

export interface DatabaseStatus {
  available: boolean;
  path: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  journalMode?: string;
}

export interface ExtensionSettings {
  trackingEnabled: boolean;
  seenTagEnabled: boolean;
  tagPosition: TagPosition;
  tagOpacity: number;
  tagSize: TagSize;
  tagDismissible: boolean;
  showVisitDetails: boolean;
  dateFormat: DateFormat;
  includeIncognitoVisits: boolean;
  countReloads: boolean;
  countSpaRoutes: boolean;
  includeFragments: boolean;
  ignoreTrackingParameters: boolean;
  unifyHttpHttps: boolean;
  unifyWww: boolean;
  ignoreQueryStrings: boolean;
  excludedDomains: string[];
  excludedPages: string[];
  excludedUrlPatterns: string[];
  neverStoreTitles: boolean;
  retentionDays: number;
  storageMode: StorageMode;
  sharedDatabase: DatabaseConfig;
  badgeNewPageBehavior: "zero" | "hidden";
  enableFileUrls: boolean;
}

export interface TabPageState {
  tabId: number;
  originalUrl: string;
  normalizedUrl: string;
  hostname: string;
  title: string | null;
  wasSeen: boolean;
  previousVisitCount: number;
  visitCount: number;
  firstVisitedAt: number | null;
  previousLastVisitedAt: number | null;
  currentVisitTime: number;
  storageMode: StorageMode;
  storageStatus: DatabaseStatus;
  error?: string;
}
