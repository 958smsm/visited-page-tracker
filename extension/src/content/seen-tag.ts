interface ContentSettings {
  seenTagEnabled: boolean;
  tagPosition: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  tagOpacity: number;
  tagSize: "small" | "medium" | "large";
  tagDismissible: boolean;
  showVisitDetails: boolean;
  dateFormat: "locale" | "iso" | "relative";
}
interface ContentState {
  normalizedUrl: string;
  previousVisitCount: number;
  visitCount: number;
  firstVisitedAt: number | null;
  previousLastVisitedAt: number | null;
  storageMode: "perProfile" | "shared";
}
type ContentCommand =
  | { type: "SHOW_SEEN_TAG"; state: ContentState; settings: ContentSettings }
  | { type: "HIDE_SEEN_TAG" };

(() => {
const TAG_VISIBLE_DURATION_MS = 5_000;
const HOST_ID = `visited-page-tracker-seen-tag-host-${chrome.runtime.id}`;
let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let currentUrl = "";
let dismissedUrl = "";
let observer: MutationObserver | null = null;
let stylesheetText = "";
let hideTimer: number | null = null;
let renderToken = 0;

function clearHideTimer(): void {
  if (hideTimer === null) return;
  window.clearTimeout(hideTimer);
  hideTimer = null;
}

function scheduleHide(token: number): void {
  clearHideTimer();
  hideTimer = window.setTimeout(() => {
    hideTimer = null;
    if (token === renderToken) hide();
  }, TAG_VISIBLE_DURATION_MS);
}

async function loadStyles(): Promise<string> {
  if (stylesheetText) return stylesheetText;
  try {
    stylesheetText = await fetch(chrome.runtime.getURL("src/content/seen-tag.css")).then((response) => response.text());
  } catch {
    stylesheetText = ":host{all:initial}#vpt-container{position:fixed;top:12px;right:12px;z-index:2147483000}#vpt-tag{background:#dc2626;color:white;font:bold 12px sans-serif;padding:7px 10px;border-radius:7px}";
  }
  return stylesheetText;
}

async function ensureHost(): Promise<ShadowRoot> {
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    host = existing;
    shadow = existing.shadowRoot;
    if (shadow) return shadow;
  }
  host = document.createElement("div");
  host.id = HOST_ID;
  host.style.setProperty("all", "initial", "important");
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("z-index", "2147483000", "important");
  shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = await loadStyles();
  shadow.append(style);
  (document.documentElement ?? document).append(host);
  observer ??= new MutationObserver(() => {
    if (host && !host.isConnected) (document.documentElement ?? document).append(host);
  });
  observer.observe(document.documentElement, { childList: true });
  return shadow;
}

function format(timestamp: number | null, settings: ContentSettings): string {
  if (!timestamp) return "—";
  if (settings.dateFormat === "iso") return new Date(timestamp).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  if (settings.dateFormat === "relative") {
    const minutes = Math.round((timestamp - Date.now()) / 60_000);
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(minutes, "minute");
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

async function show(state: ContentState, settings: ContentSettings): Promise<void> {
  const token = ++renderToken;
  clearHideTimer();
  currentUrl = state.normalizedUrl;
  if (!settings.seenTagEnabled || dismissedUrl === currentUrl) return hide();
  const root = await ensureHost();
  if (token !== renderToken) return;
  root.querySelector("#vpt-container")?.remove();
  const container = document.createElement("div");
  container.id = "vpt-container";
  container.className = `${settings.tagPosition} ${settings.tagSize}`;
  container.style.opacity = String(Math.min(1, Math.max(0.2, settings.tagOpacity)));

  const tag = document.createElement("div");
  tag.id = "vpt-tag";
  tag.tabIndex = 0;
  tag.setAttribute("role", "status");
  tag.textContent = `SEEN ${state.visitCount} times`;
  tag.setAttribute("aria-label", `SEEN ${state.visitCount} times.`);
  tag.setAttribute("aria-describedby", "vpt-tooltip");

  const tooltip = document.createElement("div");
  tooltip.id = "vpt-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.textContent = settings.showVisitDetails
    ? `Visited ${state.visitCount} times (${state.previousVisitCount} before this visit)\nFirst seen: ${format(state.firstVisitedAt, settings)}\nLast seen: ${format(state.previousLastVisitedAt, settings)}\nStorage: ${state.storageMode === "shared" ? "Shared" : "Per Profile"}`
    : `Visited ${state.visitCount} times`;

  container.append(tag, tooltip);
  if (settings.tagDismissible) {
    const dismiss = document.createElement("button");
    dismiss.id = "vpt-dismiss";
    dismiss.type = "button";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "Dismiss SEEN tag for this page");
    dismiss.addEventListener("click", () => {
      dismissedUrl = currentUrl;
      hide();
    });
    container.append(dismiss);
  }
  root.append(container);
  scheduleHide(token);
}

function hide(): void {
  renderToken += 1;
  clearHideTimer();
  shadow?.querySelector("#vpt-container")?.remove();
}

function sendReady(): void {
  void chrome.runtime.sendMessage({ type: "CONTENT_READY", url: location.href, title: document.title }).catch(() => undefined);
}

window.addEventListener("vpt-route-change", (event: Event) => {
  const detail = (event as CustomEvent).detail as { url?: unknown; navigationType?: unknown } | undefined;
  if (!detail || detail.url !== location.href || !["pushState", "replaceState", "popstate"].includes(String(detail.navigationType))) return;
  void chrome.runtime.sendMessage({
    type: "SPA_NAVIGATION",
    url: location.href,
    title: document.title,
    navigationType: detail.navigationType
  }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message: ContentCommand) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "SHOW_SEEN_TAG") void show(message.state, message.settings);
  if (message.type === "HIDE_SEEN_TAG") hide();
});

if (document.readyState === "complete") {
  sendReady();
} else {
  window.addEventListener("load", sendReady, { once: true });
}
})();
