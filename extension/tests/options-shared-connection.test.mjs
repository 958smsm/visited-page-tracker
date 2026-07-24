import test from "node:test";
import assert from "node:assert/strict";
import optionsModule from "../.test-build/src/options/shared-connection.js";
import settingsModule from "../.test-build/src/shared/settings.js";

const { runSharedConnectionTest, saveSettingsAfterConnectionTest } = optionsModule;
const { DEFAULT_SETTINGS } = settingsModule;
const config = { directory: "C:\\shared", filename: "visited.sqlite3" };

function createUi() {
  return {
    testButton: { disabled: false },
    nativeStatus: { textContent: "Not tested" },
    resolvedPath: { textContent: "Not tested" }
  };
}

const connected = {
  available: true,
  path: "C:\\shared\\visited.sqlite3",
  errorCode: null,
  errorMessage: null,
  journalMode: "WAL"
};

test("Options test button exits Testing on success", async () => {
  const ui = createUi();
  const status = await runSharedConnectionTest({
    config,
    ui,
    send: async () => {
      assert.equal(ui.testButton.disabled, true);
      assert.equal(ui.nativeStatus.textContent, "Testing…");
      return connected;
    }
  });
  assert.equal(status.available, true);
  assert.equal(ui.testButton.disabled, false);
  assert.equal(ui.nativeStatus.textContent, "Connected (WAL)");
  assert.equal(ui.resolvedPath.textContent, connected.path);
});

test("Options test button exits Testing on failure and preserves the error", async () => {
  const ui = createUi();
  let preserved;
  const status = await runSharedConnectionTest({
    config,
    ui,
    send: async () => { throw Object.assign(new Error("Host is forbidden."), { code: "NATIVE_HOST_DISCONNECTED" }); },
    onFailure: (failure) => { preserved = failure; }
  });
  assert.equal(status.available, false);
  assert.equal(ui.testButton.disabled, false);
  assert.equal(ui.nativeStatus.textContent, "Host is forbidden.");
  assert.equal(ui.resolvedPath.textContent, "Unavailable");
  assert.equal(preserved.errorCode, "NATIVE_HOST_DISCONNECTED");
});

test("Options test button exits Testing on timeout", async () => {
  const ui = createUi();
  const status = await runSharedConnectionTest({
    config,
    ui,
    send: async () => { throw Object.assign(new Error("The native messaging host did not respond within 10 seconds."), { code: "NATIVE_HOST_TIMEOUT" }); }
  });
  assert.equal(status.errorCode, "NATIVE_HOST_TIMEOUT");
  assert.equal(ui.testButton.disabled, false);
  assert.notEqual(ui.nativeStatus.textContent, "Testing…");
});

test("Shared mode is not saved after a failed connection", async () => {
  let persistCount = 0;
  const next = { ...DEFAULT_SETTINGS, storageMode: "shared", sharedDatabase: config };
  const saved = await saveSettingsAfterConnectionTest(
    next,
    async () => ({ available: false, path: null, errorCode: "NATIVE_HOST_TIMEOUT", errorMessage: "Timed out." }),
    async () => { persistCount += 1; }
  );
  assert.equal(saved, false);
  assert.equal(persistCount, 0);
});

test("Shared mode is saved after a successful connection", async () => {
  let persisted;
  const next = { ...DEFAULT_SETTINGS, storageMode: "shared", sharedDatabase: config };
  const saved = await saveSettingsAfterConnectionTest(next, async () => connected, async (value) => { persisted = value; });
  assert.equal(saved, true);
  assert.equal(persisted.storageMode, "shared");
});
