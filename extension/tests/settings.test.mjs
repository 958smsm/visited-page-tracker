import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SHARED_DIRECTORY, mergeSettings } from "../.test-build/src/shared/settings.js";

test("legacy username placeholder migrates to LOCALAPPDATA default", () => {
  const settings = mergeSettings({
    sharedDatabase: {
      directory: "C:\\Users\\%username%\\AppData\\Local\\Google\\Chrome\\User Data\\Global\\VisitedPageTracker",
      filename: "visited_page_tracker.sqlite3"
    }
  });
  assert.equal(settings.sharedDatabase.directory, DEFAULT_SHARED_DIRECTORY);
});

test("blank shared directory uses the safe Windows default", () => {
  const settings = mergeSettings({ sharedDatabase: { directory: "   ", filename: "" } });
  assert.equal(settings.sharedDatabase.directory, DEFAULT_SHARED_DIRECTORY);
  assert.equal(settings.sharedDatabase.filename, "visited_page_tracker.sqlite3");
});
