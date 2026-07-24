(() => {
  const marker = "__visitedPageTrackerPatched__";
  const historyObject = history as History & Record<string, unknown>;
  if (historyObject[marker]) return;
  Object.defineProperty(historyObject, marker, { value: true, enumerable: false });

  let lastUrl = location.href;
  const emit = (navigationType: string) => {
    const nextUrl = location.href;
    if (nextUrl === lastUrl) return;
    lastUrl = nextUrl;
    window.dispatchEvent(new CustomEvent("vpt-route-change", {
      detail: { url: nextUrl, navigationType }
    }));
  };

  const originalPush = history.pushState.bind(history);
  history.pushState = function (...args: Parameters<History["pushState"]>): void {
    originalPush(...args);
    queueMicrotask(() => emit("pushState"));
  };

  const originalReplace = history.replaceState.bind(history);
  history.replaceState = function (...args: Parameters<History["replaceState"]>): void {
    originalReplace(...args);
    queueMicrotask(() => emit("replaceState"));
  };

  addEventListener("popstate", () => emit("popstate"));
  addEventListener("hashchange", () => emit("popstate"));
})();
