import test from "node:test";
import assert from "node:assert/strict";
import storageModule from "../.test-build/src/storage/indexeddb-storage.js";
import { FakeIndexedDBFactory } from "./fake-indexeddb.mjs";

const { IndexedDbStorage } = storageModule;
const input = (url, at, hostname="example.com") => ({ normalizedUrl:url, originalUrl:url, hostname, title:"Title", visitedAt:at, transitionType:"link", tabId:1, incognito:false, storageSource:"per-profile" });

test("IndexedDB first and repeat visits increment atomically and record timestamps", async () => {
  const storage = new IndexedDbStorage(new FakeIndexedDBFactory());
  const first = await storage.recordVisit(input("https://example.com/", 1000));
  const second = await storage.recordVisit(input("https://example.com/", 2000));
  assert.equal(first.wasSeen, false);
  assert.equal(first.visitCount, 1);
  assert.equal(second.wasSeen, true);
  assert.equal(second.previousVisitCount, 1);
  assert.equal(second.visitCount, 2);
  assert.equal(second.previousLastVisitedAt, 1000);
  const events = await storage.getVisitEvents("https://example.com/");
  assert.deepEqual(events.map((event) => event.visitedAt), [2000, 1000]);
});

test("IndexedDB suppressTitle removes an existing title", async () => {
  const storage = new IndexedDbStorage(new FakeIndexedDBFactory());
  await storage.recordVisit(input("https://example.com/", 1000));
  await storage.recordVisit({ ...input("https://example.com/", 2000), title: null, suppressTitle: true });
  assert.equal((await storage.getPage("https://example.com/")).title, null);
});

test("IndexedDB search, delete page, delete domain, and clear history", async () => {
  const storage = new IndexedDbStorage(new FakeIndexedDBFactory());
  await storage.recordVisit(input("https://example.com/a", 1000));
  await storage.recordVisit(input("https://example.com/b", 2000));
  await storage.recordVisit(input("https://other.test/", 3000, "other.test"));
  const found = await storage.searchPages({ domain:"example.com", sortField:"count", sortDirection:"desc", offset:0, limit:25 });
  assert.equal(found.total, 2);
  await storage.deletePage("https://example.com/a");
  assert.equal(await storage.getPage("https://example.com/a"), null);
  assert.equal(await storage.deleteDomain("example.com"), 1);
  assert.equal((await storage.getStatistics()).totalTrackedPages, 1);
  await storage.clearHistory();
  assert.equal((await storage.getStatistics()).totalVisits, 0);
});
