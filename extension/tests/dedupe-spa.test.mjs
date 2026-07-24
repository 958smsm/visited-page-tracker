import test from "node:test";
import assert from "node:assert/strict";
import dedupeModule from "../.test-build/src/background/dedupe.js";
import navigationModule from "../.test-build/src/background/navigation-tracker.js";
import settingsModule from "../.test-build/src/shared/settings.js";

const { NavigationDeduper, MemoryDedupeStore, navigationDedupeKey } = dedupeModule;
const { shouldCountNavigation } = navigationModule;
const { DEFAULT_SETTINGS } = settingsModule;

test("dedupe key contains tab, frame, document, URL, and timestamp bucket", () => {
  const key = navigationDedupeKey({ tabId: 7, frameId: 0, documentId: "doc", normalizedUrl: "https://example.com/", timestamp: 4001 });
  assert.match(key, /^7\|0\|doc\|https:\/\/example\.com\/\|2$/);
});

test("duplicate event suppression expires after TTL", async () => {
  const deduper = new NavigationDeduper(new MemoryDedupeStore(), 4000);
  const identity = { tabId: 1, frameId: 0, documentId: "d", normalizedUrl: "https://example.com/", timestamp: 1000 };
  assert.equal(await deduper.shouldProcess(identity), true);
  assert.equal(await deduper.shouldProcess({ ...identity, timestamp: 1100 }), false);
  assert.equal(await deduper.shouldProcess({ ...identity, timestamp: 6000 }), true);
});

test("SPA and reload settings control counting", () => {
  assert.equal(shouldCountNavigation("pushState", true, { ...DEFAULT_SETTINGS, countSpaRoutes: false }), false);
  assert.equal(shouldCountNavigation("reload", false, { ...DEFAULT_SETTINGS, countReloads: false }), false);
  assert.equal(shouldCountNavigation("link", false, DEFAULT_SETTINGS), true);
});
