import type { DateFormat, ExportBundle, PageVisitRecord } from "../types/models.js";

export function formatDateTime(timestamp: number | null | undefined, format: DateFormat = "locale"): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (format === "iso") return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  if (format === "relative") {
    const delta = timestamp - Date.now();
    const abs = Math.abs(delta);
    const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
      [86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"], [1_000, "second"]
    ];
    const [size, unit] = units.find(([size]) => abs >= size) ?? [1_000, "second"];
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(delta / size), unit);
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

export function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "export";
}

export function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function bundleToCsv(bundle: ExportBundle): string {
  const header = [
    "normalized_url", "last_original_url", "hostname", "title", "visit_count",
    "first_visited_at", "last_visited_at", "created_at", "updated_at", "storage_source",
    "visit_timestamps"
  ];
  const eventsByUrl = new Map<string, number[]>();
  for (const event of bundle.visits) {
    const list = eventsByUrl.get(event.normalizedUrl) ?? [];
    list.push(event.visitedAt);
    eventsByUrl.set(event.normalizedUrl, list);
  }
  const rows = bundle.pages.map((page: PageVisitRecord) => [
    page.normalizedUrl, page.lastOriginalUrl, page.hostname, page.title ?? "", page.visitCount,
    page.firstVisitedAt, page.lastVisitedAt, page.createdAt, page.updatedAt, page.storageSource,
    (eventsByUrl.get(page.normalizedUrl) ?? []).sort((a, b) => a - b).join(";")
  ].map(csvCell).join(","));
  return [header.map(csvCell).join(","), ...rows].join("\r\n");
}

export function parseLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
