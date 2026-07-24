import { inspectImportBundle, validateExportBundle } from "../storage/migration.js";
import { sendRequest } from "../shared/runtime.js";
import { getSettings } from "../shared/settings.js";
import { bundleToCsv, downloadText, formatDateTime } from "../shared/utils.js";
import type { ExportBundle, PageSearchQuery, PageSearchResult, PageVisitRecord, VisitEvent, VisitStatistics } from "../types/models.js";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const value = (id: string): string => (byId<HTMLInputElement | HTMLSelectElement>(id)).value;
const PAGE_DEFAULT = 25;
let offset = 0;
let total = 0;
let records: PageVisitRecord[] = [];
let selected = new Set<string>();
let detailRecord: PageVisitRecord | null = null;
let importBundle: ExportBundle | null = null;
let loadTimer: number | null = null;

function numberOrUndefined(id: string): number | undefined {
  const text = value(id).trim();
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

function dateStart(id: string): number | undefined {
  const text = value(id);
  return text ? new Date(`${text}T00:00:00`).getTime() : undefined;
}
function dateEnd(id: string): number | undefined {
  const text = value(id);
  return text ? new Date(`${text}T23:59:59.999`).getTime() : undefined;
}

function query(): PageSearchQuery {
  const result: PageSearchQuery = {
    sortField: value("sortField") as PageSearchQuery["sortField"],
    sortDirection: value("sortDirection") as PageSearchQuery["sortDirection"],
    offset,
    limit: Number(value("pageSize")) || PAGE_DEFAULT
  };
  const optional: Array<[keyof PageSearchQuery, string | number | undefined]> = [
    ["search", value("search").trim() || undefined], ["url", value("urlFilter").trim() || undefined],
    ["domain", value("domainFilter").trim() || undefined], ["dateFrom", dateStart("dateFrom")],
    ["dateTo", dateEnd("dateTo")], ["minCount", numberOrUndefined("minCount")],
    ["maxCount", numberOrUndefined("maxCount")], ["storageSource", value("storageSource") || undefined]
  ];
  for (const [key, item] of optional) if (item !== undefined) (result as unknown as Record<string, unknown>)[key] = item;
  return result;
}

function scheduleLoad(): void {
  if (loadTimer != null) clearTimeout(loadTimer);
  loadTimer = window.setTimeout(() => { offset = 0; void loadRecords(); }, 250);
}

async function loadRecords(): Promise<void> {
  const result = await sendRequest<PageSearchResult>({ type: "SEARCH_PAGES", query: query() });
  records = result.records;
  total = result.total;
  renderTable();
}

function renderTable(): void {
  const body = byId<HTMLTableSectionElement>("recordsBody");
  body.replaceChildren();
  for (const record of records) {
    const row = document.createElement("tr");
    row.dataset.url = record.normalizedUrl;
    const selectCell = document.createElement("td");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = selected.has(record.normalizedUrl);
    check.setAttribute("aria-label", `Select ${record.normalizedUrl}`);
    check.addEventListener("click", (event) => event.stopPropagation());
    check.addEventListener("change", () => {
      if (check.checked) selected.add(record.normalizedUrl); else selected.delete(record.normalizedUrl);
      updateSelection();
    });
    selectCell.append(check);

    const pageCell = document.createElement("td");
    pageCell.className = "page-cell";
    const title = document.createElement("strong");
    title.textContent = record.title || "Untitled page";
    const url = document.createElement("span");
    url.textContent = record.normalizedUrl;
    pageCell.append(title, url);
    const cells = [
      selectCell, pageCell, simpleCell(record.hostname), simpleCell(String(record.visitCount)),
      simpleCell(formatDateTime(record.firstVisitedAt)), simpleCell(formatDateTime(record.lastVisitedAt)),
      simpleCell(record.storageSource)
    ];
    row.append(...cells);
    row.addEventListener("click", () => void showDetails(record));
    body.append(row);
  }
  byId("resultCount").textContent = `${total.toLocaleString()} record${total === 1 ? "" : "s"}`;
  const pageSize = Number(value("pageSize"));
  const page = Math.floor(offset / pageSize) + 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  byId("pageInfo").textContent = `Page ${page} of ${pages}`;
  byId<HTMLButtonElement>("previousPage").disabled = offset === 0;
  byId<HTMLButtonElement>("nextPage").disabled = offset + pageSize >= total;
  const allCurrent = records.length > 0 && records.every((record) => selected.has(record.normalizedUrl));
  byId<HTMLInputElement>("selectPage").checked = allCurrent;
  updateSelection();
}

function simpleCell(text: string): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

function updateSelection(): void {
  byId("selectionCount").textContent = `${selected.size} selected`;
  byId<HTMLButtonElement>("deleteSelected").disabled = selected.size === 0;
  byId<HTMLButtonElement>("deleteDomain").disabled = !detailRecord && selected.size === 0;
}

async function showDetails(record: PageVisitRecord): Promise<void> {
  detailRecord = record;
  byId("detailsPanel").classList.remove("hidden");
  byId("detailTitle").textContent = record.title || record.hostname;
  byId("detailUrl").textContent = record.normalizedUrl;
  byId("visitEvents").textContent = "Loading complete visit-time history…";
  updateSelection();
  const events = await sendRequest<VisitEvent[]>({ type: "GET_VISIT_EVENTS", normalizedUrl: record.normalizedUrl, offset: 0, limit: 100_000 });
  const list = byId<HTMLOListElement>("visitEvents");
  list.replaceChildren();
  for (const event of events) {
    const item = document.createElement("li");
    const time = document.createElement("strong");
    time.textContent = formatDateTime(event.visitedAt);
    const metadata = document.createElement("span");
    metadata.textContent = `${event.transitionType ?? "unknown transition"} · ${event.incognito ? "incognito" : "normal"} · ${event.originalUrl}`;
    item.append(time, metadata);
    list.append(item);
  }
  if (events.length === 0) list.textContent = "No individual visit events are stored for this page.";
}

async function loadStats(): Promise<void> {
  const stats = await sendRequest<VisitStatistics>({ type: "GET_STATISTICS" });
  byId("statPages").textContent = stats.totalTrackedPages.toLocaleString();
  byId("statVisits").textContent = stats.totalVisits.toLocaleString();
  byId("statToday").textContent = stats.pagesVisitedToday.toLocaleString();
  byId("statDomain").textContent = stats.mostVisitedDomain ? `${stats.mostVisitedDomain.hostname} (${stats.mostVisitedDomain.visits})` : "—";
  byId("statPage").textContent = stats.mostVisitedPage ? `${stats.mostVisitedPage.hostname} (${stats.mostVisitedPage.visitCount})` : "—";
  const chart = byId("dailyChart");
  chart.replaceChildren();
  const recent = stats.perDayVisitTotals.slice(-31);
  const max = Math.max(1, ...recent.map((day) => day.visits));
  for (const day of recent) {
    const bar = document.createElement("div");
    bar.className = "chart-bar";
    bar.title = `${day.date}: ${day.visits} visits`;
    const fill = document.createElement("i");
    fill.style.height = `${Math.max(3, day.visits / max * 90)}px`;
    const label = document.createElement("span");
    label.textContent = day.date.slice(5);
    bar.append(fill, label);
    chart.append(bar);
  }
  if (recent.length === 0) chart.textContent = "No visit data yet.";
}

async function exportBundle(format: "json" | "csv"): Promise<void> {
  const bundle = await sendRequest<ExportBundle>({ type: "EXPORT_DATA" });
  if (format === "json") {
    if (byId<HTMLInputElement>("includeSettings").checked) bundle.settings = await getSettings();
    downloadText(`visited-page-tracker-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(bundle, null, 2), "application/json");
  } else {
    downloadText(`visited-page-tracker-${new Date().toISOString().slice(0,10)}.csv`, bundleToCsv(bundle), "text/csv;charset=utf-8");
  }
}

byId("applyFilters").addEventListener("click", () => { offset = 0; void loadRecords(); });
for (const id of ["search","urlFilter","domainFilter"]) byId<HTMLInputElement>(id).addEventListener("input", scheduleLoad);
for (const id of ["dateFrom","dateTo","minCount","maxCount","storageSource","sortField","sortDirection"]) byId(id).addEventListener("change", () => { offset = 0; void loadRecords(); });
byId("resetFilters").addEventListener("click", () => {
  for (const id of ["search","urlFilter","domainFilter","dateFrom","dateTo","minCount","maxCount"]) byId<HTMLInputElement>(id).value = "";
  byId<HTMLSelectElement>("storageSource").value = "";
  byId<HTMLSelectElement>("sortField").value = "lastVisit";
  byId<HTMLSelectElement>("sortDirection").value = "desc";
  offset = 0;
  void loadRecords();
});
byId("previousPage").addEventListener("click", () => { offset = Math.max(0, offset - Number(value("pageSize"))); void loadRecords(); });
byId("nextPage").addEventListener("click", () => { offset += Number(value("pageSize")); void loadRecords(); });
byId("pageSize").addEventListener("change", () => { offset = 0; void loadRecords(); });
byId<HTMLInputElement>("selectPage").addEventListener("change", (event) => {
  const checked = (event.currentTarget as HTMLInputElement).checked;
  for (const record of records) checked ? selected.add(record.normalizedUrl) : selected.delete(record.normalizedUrl);
  renderTable();
});
byId("deleteSelected").addEventListener("click", async () => {
  if (!confirm(`Delete ${selected.size} selected page record(s) and all their visit timestamps?`)) return;
  for (const normalizedUrl of selected) await sendRequest({ type: "DELETE_PAGE", normalizedUrl });
  selected.clear();
  await Promise.all([loadRecords(), loadStats()]);
});
byId("deleteDomain").addEventListener("click", async () => {
  const record = detailRecord ?? records.find((item) => selected.has(item.normalizedUrl));
  if (!record) return;
  if (!confirm(`Delete all records for ${record.hostname}?`)) return;
  await sendRequest({ type: "DELETE_DOMAIN", hostname: record.hostname });
  selected.clear();
  detailRecord = null;
  byId("detailsPanel").classList.add("hidden");
  await Promise.all([loadRecords(), loadStats()]);
});
byId("clearAll").addEventListener("click", async () => {
  if (!confirm("Clear every tracked page and visit timestamp in the current storage?")) return;
  if (prompt('Type CLEAR ALL to confirm:') !== "CLEAR ALL") return;
  await sendRequest({ type: "CLEAR_HISTORY" });
  selected.clear();
  await Promise.all([loadRecords(), loadStats()]);
});
byId("closeDetails").addEventListener("click", () => { detailRecord = null; byId("detailsPanel").classList.add("hidden"); updateSelection(); });
byId("openSettings").addEventListener("click", () => void chrome.runtime.openOptionsPage());
byId("exportJson").addEventListener("click", () => void exportBundle("json"));
byId("exportCsv").addEventListener("click", () => void exportBundle("csv"));
byId("chooseImport").addEventListener("click", () => byId<HTMLInputElement>("importFile").click());
byId<HTMLInputElement>("importFile").addEventListener("change", async (event) => {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!file) return;
  byId("importPanel").classList.remove("hidden");
  byId("importStatus").textContent = "";
  try {
    const raw: unknown = JSON.parse(await file.text());
    const preview = inspectImportBundle(raw);
    byId("importPreview").textContent = `${preview.pages} pages and ${preview.visits} visits. Malformed: ${preview.malformedPages} pages, ${preview.malformedVisits} visits.`;
    importBundle = validateExportBundle(raw);
    byId<HTMLButtonElement>("confirmImport").disabled = false;
  } catch (error) {
    importBundle = null;
    byId<HTMLButtonElement>("confirmImport").disabled = true;
    byId("importStatus").textContent = `Import validation failed: ${error instanceof Error ? error.message : String(error)}`;
  }
});
byId("confirmImport").addEventListener("click", async () => {
  if (!importBundle) return;
  const mode = document.querySelector<HTMLInputElement>('input[name="importMode"]:checked')?.value as "merge" | "replace";
  if (mode === "replace" && !confirm("Replace the current storage? Shared storage will be backed up first. No invalid import is applied partially.")) return;
  byId("importStatus").textContent = "Importing…";
  try {
    const result = await sendRequest<{ importedPages: number; importedVisits: number; backupPath?: string }>({ type: "IMPORT_DATA", bundle: importBundle, mode });
    byId("importStatus").textContent = `Imported ${result.importedPages} pages and ${result.importedVisits} visits.${result.backupPath ? ` Backup: ${result.backupPath}` : ""}`;
    await Promise.all([loadRecords(), loadStats()]);
  } catch (error) {
    byId("importStatus").textContent = `Import failed without partial application: ${error instanceof Error ? error.message : String(error)}`;
  }
});
byId("cancelImport").addEventListener("click", () => {
  importBundle = null;
  byId("importPanel").classList.add("hidden");
  byId<HTMLInputElement>("importFile").value = "";
});

void Promise.all([loadRecords(), loadStats()]).catch((error) => {
  byId("recordsBody").textContent = error instanceof Error ? error.message : String(error);
});
