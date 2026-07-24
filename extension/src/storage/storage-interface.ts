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

export interface VisitStorage {
  readonly sourceName: string;
  getStatus(): Promise<DatabaseStatus>;
  recordVisit(input: RecordVisitInput): Promise<RecordVisitResult>;
  getPage(normalizedUrl: string): Promise<PageVisitRecord | null>;
  searchPages(query: PageSearchQuery): Promise<PageSearchResult>;
  getVisitEvents(normalizedUrl: string, offset?: number, limit?: number): Promise<VisitEvent[]>;
  deletePage(normalizedUrl: string): Promise<void>;
  deleteDomain(hostname: string): Promise<number>;
  clearHistory(): Promise<void>;
  getStatistics(): Promise<VisitStatistics>;
  exportData(): Promise<ExportBundle>;
  importData(bundle: ExportBundle, mode: "merge" | "replace"): Promise<ImportResult>;
  removeVisitsOlderThan(cutoff: number): Promise<number>;
}
