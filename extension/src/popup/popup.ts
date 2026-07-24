import { sendRequest } from "../shared/runtime.js";
import { formatDateTime } from "../shared/utils.js";
import type { TabPageState } from "../types/models.js";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
let tabId: number | null = null;
let state: TabPageState | null = null;

function text(id: string, value: string): void { byId(id).textContent = value; }

async function load(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = typeof tab?.id === "number" ? tab.id : null;
  state = tabId == null ? null : await sendRequest<TabPageState | null>({ type: "GET_ACTIVE_PAGE_STATE", tabId });
  render();
}

function render(): void {
  const status = byId<HTMLHeadingElement>("status");
  const errorPanel = byId("errorPanel");
  const buttons = ["forgetPage", "disablePage", "disableDomain"].map((id) => byId<HTMLButtonElement>(id));
  if (!state) {
    status.textContent = "Not tracked";
    status.className = "status neutral";
    text("countPill", "—");
    text("normalizedUrl", "This tab is not a trackable HTTP, HTTPS, or enabled file page.");
    for (const id of ["visitCount", "firstVisit", "lastVisit", "currentVisit", "storageMode", "databaseStatus"]) text(id, "—");
    buttons.forEach((button) => { button.disabled = true; });
    return;
  }
  buttons.forEach((button) => { button.disabled = false; });
  if (state.error || !state.storageStatus.available) {
    status.textContent = "Storage error";
    status.className = "status error";
    errorPanel.textContent = state.error ?? state.storageStatus.errorMessage ?? "The selected storage is unavailable.";
    errorPanel.classList.remove("hidden");
  } else {
    status.textContent = state.wasSeen ? "SEEN" : "NEW";
    status.className = `status ${state.wasSeen ? "seen" : "new"}`;
    errorPanel.classList.add("hidden");
  }
  text("countPill", String(state.visitCount));
  text("normalizedUrl", state.normalizedUrl);
  text("visitCount", String(state.visitCount));
  text("firstVisit", formatDateTime(state.firstVisitedAt));
  text("lastVisit", formatDateTime(state.previousLastVisitedAt));
  text("currentVisit", formatDateTime(state.currentVisitTime));
  text("storageMode", state.storageMode === "shared" ? "Shared SQLite" : "Per Profile IndexedDB");
  text("databaseStatus", state.storageStatus.available ? (state.storageStatus.path ?? "Connected") : "Unavailable");
}

byId("openHistory").addEventListener("click", () => void chrome.tabs.create({ url: chrome.runtime.getURL("src/history/history.html") }));
byId("openSettings").addEventListener("click", () => void chrome.runtime.openOptionsPage());
byId("forgetPage").addEventListener("click", async () => {
  if (tabId == null || !state) return;
  if (!confirm(`Forget all visits for ${state.normalizedUrl}?`)) return;
  await sendRequest({ type: "FORGET_CURRENT_PAGE", tabId });
  await load();
});
byId("disablePage").addEventListener("click", async () => {
  if (tabId == null || !state) return;
  if (!confirm(`Disable tracking for this exact page?\n\n${state.normalizedUrl}`)) return;
  await sendRequest({ type: "DISABLE_CURRENT_PAGE", tabId });
  window.close();
});
byId("disableDomain").addEventListener("click", async () => {
  if (tabId == null || !state) return;
  if (!confirm(`Disable tracking for ${state.hostname} and its subdomains?`)) return;
  await sendRequest({ type: "DISABLE_CURRENT_DOMAIN", tabId });
  window.close();
});

chrome.tabs.onActivated.addListener(() => { void load(); });
chrome.tabs.onUpdated.addListener((id: number, info: any) => {
  if (id === tabId && (info.status === "complete" || info.url)) void load();
});
void load().catch((error) => {
  byId("status").textContent = "Error";
  const panel = byId("errorPanel");
  panel.textContent = error instanceof Error ? error.message : String(error);
  panel.classList.remove("hidden");
});
