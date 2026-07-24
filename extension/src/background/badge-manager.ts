import type { ExtensionSettings, TabPageState } from "../types/models.js";

export async function updateBadge(tabId: number, state: TabPageState | null, settings: ExtensionSettings): Promise<void> {
  try {
    if (!state) {
      await chrome.action.setBadgeText({ tabId, text: "" });
      return;
    }
    if (state.error || !state.storageStatus.available) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#b91c1c" });
      await chrome.action.setBadgeText({ tabId, text: "!" });
      await chrome.action.setTitle({ tabId, title: `Visited Page Tracker: ${state.error ?? state.storageStatus.errorMessage ?? "storage unavailable"}` });
      return;
    }
    const text = state.wasSeen
      ? (state.visitCount > 999 ? "999+" : String(state.visitCount))
      : (settings.badgeNewPageBehavior === "zero" ? "0" : "");
    await chrome.action.setBadgeBackgroundColor({ tabId, color: state.wasSeen ? "#dc2626" : "#64748b" });
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setTitle({
      tabId,
      title: state.wasSeen
        ? `Visited Page Tracker: seen ${state.visitCount} times`
        : "Visited Page Tracker: new page"
    });
  } catch {
    // The tab may have closed while a storage operation was in flight.
  }
}
