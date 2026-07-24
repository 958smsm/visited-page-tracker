import type {
  DatabaseConfig,
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
import type { VisitStorage } from "./storage-interface.js";

export const NATIVE_HOST_NAME = "com.visited_page_tracker.host";
export const DEFAULT_NATIVE_REQUEST_TIMEOUT_MS = 10_000;

interface NativeResponse<T> {
  id: string;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

export class NativeHostError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "NativeHostError";
  }
}

interface NativePortEvent<T> {
  addListener(listener: T): void;
  removeListener?(listener: T): void;
}

interface NativePort {
  onMessage: NativePortEvent<(message: unknown) => void>;
  onDisconnect: NativePortEvent<() => void>;
  postMessage(message: unknown): void;
  disconnect(): void;
}

type TimeoutHandle = ReturnType<typeof setTimeout>;
type SetTimer = (callback: () => void, milliseconds: number) => TimeoutHandle;
type ClearTimer = (handle: TimeoutHandle) => void;

export interface NativeClientOptions {
  requestTimeoutMs?: number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
}

interface PendingNativeRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeoutHandle: TimeoutHandle;
}

export class NativeMessagingClient {
  private readonly port: NativePort;
  private readonly pending = new Map<string, PendingNativeRequest>();
  private readonly timeoutMs: number;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private disconnectedError: NativeHostError | null = null;
  private closed = false;

  constructor(
    private readonly hostName: string,
    private readonly database: DatabaseConfig,
    options: NativeClientOptions = {}
  ) {
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_NATIVE_REQUEST_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new NativeHostError("INVALID_NATIVE_TIMEOUT", "The native messaging timeout must be a positive number.");
    }
    try {
      this.port = chrome.runtime.connectNative(this.hostName) as NativePort;
      this.port.onMessage.addListener(this.handleMessage);
      this.port.onDisconnect.addListener(this.handleDisconnect);
    } catch (error) {
      throw new NativeHostError(
        "NATIVE_HOST_UNAVAILABLE",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private settle(id: string, callback: (item: PendingNativeRequest) => void): void {
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    this.clearTimer(item.timeoutHandle);
    callback(item);
  }

  private rejectAll(error: NativeHostError): void {
    for (const [id, item] of this.pending) {
      this.pending.delete(id);
      this.clearTimer(item.timeoutHandle);
      item.reject(error);
    }
  }

  private failProtocol(message: string): void {
    const error = new NativeHostError("INVALID_NATIVE_RESPONSE", message);
    this.disconnectedError = error;
    this.rejectAll(error);
    this.disconnectPort();
  }

  private readonly handleMessage = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      this.failProtocol("The native host returned a non-object response.");
      return;
    }
    const response = value as Partial<NativeResponse<unknown>>;
    if (typeof response.id !== "string") {
      this.failProtocol("The native host response did not contain a request ID.");
      return;
    }
    if (!this.pending.has(response.id)) {
      if (this.pending.size > 0) {
        this.failProtocol(`The native host returned an unexpected request ID: ${response.id}.`);
      }
      return;
    }
    if (typeof response.ok !== "boolean") {
      this.failProtocol("The native host response did not contain a valid ok flag.");
      return;
    }
    if (response.ok) {
      this.settle(response.id, (item) => item.resolve(response.result));
      return;
    }
    if (!response.error || typeof response.error.code !== "string" || typeof response.error.message !== "string") {
      this.failProtocol("The native host returned an invalid error response.");
      return;
    }
    this.settle(response.id, (item) => item.reject(
      new NativeHostError(response.error?.code ?? "NATIVE_HOST_ERROR", response.error?.message ?? "Native host operation failed.")
    ));
  };

  private readonly handleDisconnect = (): void => {
    const lastError = chrome.runtime.lastError as { message?: string } | undefined;
    if (this.closed && this.pending.size === 0) return;
    const error = this.disconnectedError ?? new NativeHostError(
      "NATIVE_HOST_DISCONNECTED",
      lastError?.message ?? "The native messaging host disconnected before responding."
    );
    this.disconnectedError = error;
    this.rejectAll(error);
  };

  private disconnectPort(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.port.disconnect();
    } catch {
      // The port may already have been disconnected by Chrome.
    }
  }

  request<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.disconnectedError) {
        reject(this.disconnectedError);
        return;
      }
      if (this.closed) {
        reject(new NativeHostError("NATIVE_HOST_DISCONNECTED", "The native messaging port is closed."));
        return;
      }
      const id = crypto.randomUUID();
      const timeoutHandle = this.setTimer(() => {
        const seconds = Math.ceil(this.timeoutMs / 1_000);
        const error = new NativeHostError(
          "NATIVE_HOST_TIMEOUT",
          `The native messaging host did not respond within ${seconds} seconds.`
        );
        this.disconnectedError = error;
        this.rejectAll(error);
        this.disconnectPort();
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeoutHandle
      });
      try {
        this.port.postMessage({ id, action, database: this.database, payload });
      } catch (error) {
        this.settle(id, (item) => item.reject(new NativeHostError(
          "NATIVE_HOST_UNAVAILABLE",
          error instanceof Error ? error.message : String(error)
        )));
        this.disconnectPort();
      }
    });
  }

  close(): void {
    if (this.pending.size > 0) {
      this.rejectAll(new NativeHostError(
        "NATIVE_HOST_DISCONNECTED",
        "The native messaging request was cancelled because the port was closed."
      ));
    }
    this.disconnectPort();
  }
}

export class NativeStorage implements VisitStorage {
  readonly sourceName: string;

  constructor(
    private readonly config: DatabaseConfig,
    private readonly clientOptions: NativeClientOptions = {}
  ) {
    this.sourceName = "shared";
  }

  private async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    let client: NativeMessagingClient;
    try {
      client = new NativeMessagingClient(NATIVE_HOST_NAME, this.config, this.clientOptions);
    } catch (error) {
      if (error instanceof NativeHostError) throw error;
      throw new NativeHostError("NATIVE_HOST_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    }
    try {
      return await client.request<T>(action, payload);
    } finally {
      client.close();
    }
  }

  async configureDatabase(): Promise<DatabaseStatus> {
    return this.call<DatabaseStatus>("configureDatabase");
  }

  async openStorageDirectory(): Promise<void> {
    await this.call("openStorageDirectory");
  }

  async getStatus(): Promise<DatabaseStatus> {
    try {
      return await this.call<DatabaseStatus>("getDatabaseStatus");
    } catch (error) {
      const native = error instanceof NativeHostError ? error : new NativeHostError("NATIVE_HOST_ERROR", String(error));
      return { available: false, path: null, errorCode: native.code, errorMessage: native.message };
    }
  }

  recordVisit(input: RecordVisitInput): Promise<RecordVisitResult> {
    return this.call("recordVisit", input as unknown as Record<string, unknown>);
  }

  getPage(normalizedUrl: string): Promise<PageVisitRecord | null> {
    return this.call("getPage", { normalizedUrl });
  }

  searchPages(query: PageSearchQuery): Promise<PageSearchResult> {
    return this.call("searchPages", { query });
  }

  async getVisitEvents(normalizedUrl: string, offset = 0, limit = 200): Promise<VisitEvent[]> {
    const events: VisitEvent[] = [];
    let cursor = Math.max(0, offset);
    let remaining = Math.max(0, limit);
    while (remaining > 0) {
      const chunkSize = Math.min(200, remaining);
      const chunk = await this.call<VisitEvent[]>("getVisitEvents", { normalizedUrl, offset: cursor, limit: chunkSize });
      events.push(...chunk);
      cursor += chunk.length;
      remaining -= chunk.length;
      if (chunk.length < chunkSize) break;
    }
    return events;
  }

  async deletePage(normalizedUrl: string): Promise<void> {
    await this.call("deletePage", { normalizedUrl });
  }

  async deleteDomain(hostname: string): Promise<number> {
    const result = await this.call<{ deleted: number }>("deleteDomain", { hostname });
    return result.deleted;
  }

  async clearHistory(): Promise<void> {
    await this.call("clearHistory");
  }

  getStatistics(): Promise<VisitStatistics> {
    return this.call("getStatistics");
  }

  async exportData(): Promise<ExportBundle> {
    interface ExportChunk {
      schemaVersion: 1;
      exportedAt: number;
      storageMode: "shared";
      pages: ExportBundle["pages"];
      visits: ExportBundle["visits"];
      nextPageOffset: number;
      nextVisitOffset: number;
      totalPages: number;
      totalVisits: number;
      done: boolean;
    }
    const pages: ExportBundle["pages"] = [];
    const visits: ExportBundle["visits"] = [];
    let pageOffset = 0;
    let visitOffset = 0;
    let exportedAt = Date.now();
    for (let requestCount = 0; requestCount < 100_000; requestCount += 1) {
      const chunk = await this.call<ExportChunk>("exportData", {
        chunked: true,
        pageOffset,
        visitOffset,
        maxBytes: 450_000
      });
      if (chunk.schemaVersion !== 1 || !Array.isArray(chunk.pages) || !Array.isArray(chunk.visits)) {
        throw new NativeHostError("INVALID_NATIVE_RESPONSE", "The native host returned an invalid export chunk.");
      }
      if (requestCount === 0) exportedAt = chunk.exportedAt;
      pages.push(...chunk.pages);
      visits.push(...chunk.visits);
      if (chunk.done) {
        return { schemaVersion: 1, exportedAt, storageMode: "shared", pages, visits };
      }
      if (chunk.nextPageOffset === pageOffset && chunk.nextVisitOffset === visitOffset) {
        throw new NativeHostError("INVALID_NATIVE_RESPONSE", "The native export cursor did not advance.");
      }
      pageOffset = chunk.nextPageOffset;
      visitOffset = chunk.nextVisitOffset;
    }
    throw new NativeHostError("EXPORT_TOO_LARGE", "The shared export exceeded the maximum number of chunks.");
  }

  async importData(bundle: ExportBundle, mode: "merge" | "replace"): Promise<ImportResult> {
    const client = new NativeMessagingClient(NATIVE_HOST_NAME, this.config, this.clientOptions);
    const request = <T>(payload: Record<string, unknown>): Promise<T> =>
      client.request<T>("importData", payload);
    const sessionId = crypto.randomUUID();
    try {
      await request({
        phase: "begin",
        sessionId,
        mode,
        metadata: { schemaVersion: 1, exportedAt: bundle.exportedAt, storageMode: bundle.storageMode },
        totalPages: bundle.pages.length,
        totalVisits: bundle.visits.length
      });
      const maxChunkBytes = 450_000;
      let pages: ExportBundle["pages"] = [];
      let visits: ExportBundle["visits"] = [];
      let approximateBytes = 0;
      const flush = async (): Promise<void> => {
        if (pages.length === 0 && visits.length === 0) return;
        await request({ phase: "chunk", sessionId, pages, visits });
        pages = [];
        visits = [];
        approximateBytes = 0;
      };
      for (const page of bundle.pages) {
        const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
        if (approximateBytes > 0 && approximateBytes + bytes > maxChunkBytes) await flush();
        pages.push(page);
        approximateBytes += bytes;
      }
      for (const visit of bundle.visits) {
        const bytes = new TextEncoder().encode(JSON.stringify(visit)).byteLength;
        if (approximateBytes > 0 && approximateBytes + bytes > maxChunkBytes) await flush();
        visits.push(visit);
        approximateBytes += bytes;
      }
      await flush();
      return await request<ImportResult>({ phase: "commit", sessionId });
    } catch (error) {
      try { await request({ phase: "abort", sessionId }); } catch { /* host may already be disconnected */ }
      throw error;
    } finally {
      client.close();
    }
  }

  async removeVisitsOlderThan(cutoff: number): Promise<number> {
    const result = await this.call<{ removed: number }>("migrateData", { operation: "retention", cutoff });
    return result.removed;
  }
}
