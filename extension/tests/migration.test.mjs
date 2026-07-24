import test from "node:test";
import assert from "node:assert/strict";
import migration from "../.test-build/src/storage/migration.js";

const { mergeExportBundles, validateExportBundle, inspectImportBundle } = migration;
const page = (count, first, last, source="per-profile") => ({ normalizedUrl:"https://example.com/", lastOriginalUrl:"https://example.com/", hostname:"example.com", title:"Example", visitCount:count, firstVisitedAt:first, lastVisitedAt:last, createdAt:first, updatedAt:last, storageSource:source });
const visit = (id, at, source="per-profile") => ({ id, normalizedUrl:"https://example.com/", originalUrl:"https://example.com/", visitedAt:at, transitionType:"link", tabId:1, incognito:false, storageSource:source });

test("migration merge deduplicates event ids and rebuilds counts/history", () => {
  const existing = { schemaVersion:1, exportedAt:1, storageMode:"perProfile", pages:[page(2,10,20)], visits:[visit("a",10),visit("b",20)] };
  const incoming = { schemaVersion:1, exportedAt:2, storageMode:"shared", pages:[page(2,20,30,"shared")], visits:[visit("b",20,"shared"),visit("c",30,"shared")] };
  const merged = mergeExportBundles(existing, incoming, "shared", "shared");
  assert.equal(merged.visits.length, 3);
  assert.equal(merged.pages[0].visitCount, 3);
  assert.equal(merged.pages[0].firstVisitedAt, 10);
  assert.equal(merged.pages[0].lastVisitedAt, 30);
});

test("import validation reports malformed records and rejects invalid bundle", () => {
  const raw = { schemaVersion:1, exportedAt:1, storageMode:"shared", pages:[{}], visits:[] };
  assert.equal(inspectImportBundle(raw).malformedPages, 1);
  assert.throws(() => validateExportBundle(raw), /malformed/i);
});
