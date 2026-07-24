import test from "node:test";
import assert from "node:assert/strict";

const connectedHosts = [];
const postedRequests = [];

function makePort(onPost) {
  const messageListeners = [];
  const disconnectListeners = [];
  const port = {
    disconnectCount: 0,
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
    postMessage(request) {
      postedRequests.push(request);
      onPost?.(request, port);
    },
    disconnect() { port.disconnectCount += 1; },
    emitMessage(value) { for (const listener of messageListeners) listener(value); },
    emitDisconnect() { for (const listener of disconnectListeners) listener(); }
  };
  return port;
}

let nextPort;
globalThis.chrome = {
  runtime: {
    connectNative(host) {
      connectedHosts.push(host);
      if (!nextPort) throw new Error("No mock native port was configured.");
      return nextPort;
    }
  }
};

const nativeModule = await import("../.test-build/src/storage/native-storage.js");
const settingsModule = await import("../.test-build/src/shared/settings.js");
const factoryModule = await import("../.test-build/src/storage/storage-factory.js");
const { NativeHostError, NativeStorage, NATIVE_HOST_NAME } = nativeModule.default ?? nativeModule;
const { DEFAULT_SETTINGS } = settingsModule.default ?? settingsModule;
const { createStorage } = factoryModule.default ?? factoryModule;
const config = { directory: "C:\\shared", filename: "visited.sqlite3" };

function validStatus(path = "C:\\shared\\visited.sqlite3") {
  return { available: true, path, errorCode: null, errorMessage: null, journalMode: "WAL" };
}

test.beforeEach(() => {
  connectedHosts.length = 0;
  postedRequests.length = 0;
  delete chrome.runtime.lastError;
  nextPort = undefined;
});

test("native request resolves on a valid matching response", async () => {
  nextPort = makePort((request, port) => {
    queueMicrotask(() => port.emitMessage({ id: request.id, ok: true, result: validStatus() }));
  });
  const result = await new NativeStorage(config).configureDatabase();
  assert.equal(result.available, true);
  assert.equal(connectedHosts[0], NATIVE_HOST_NAME);
  assert.equal(postedRequests[0].action, "configureDatabase");
  assert.deepEqual(postedRequests[0].database, config);
  assert.equal(typeof postedRequests[0].id, "string");
});

test("native request rejects when the port disconnects", async () => {
  nextPort = makePort((_request, port) => queueMicrotask(() => port.emitDisconnect()));
  await assert.rejects(
    new NativeStorage(config).configureDatabase(),
    (error) => error instanceof NativeHostError && error.code === "NATIVE_HOST_DISCONNECTED"
  );
});

test("native request consumes chrome.runtime.lastError on disconnect", async () => {
  nextPort = makePort((_request, port) => queueMicrotask(() => {
    chrome.runtime.lastError = { message: "Access to the specified native messaging host is forbidden." };
    port.emitDisconnect();
    delete chrome.runtime.lastError;
  }));
  await assert.rejects(
    new NativeStorage(config).configureDatabase(),
    (error) => error.code === "NATIVE_HOST_DISCONNECTED" && /forbidden/i.test(error.message)
  );
});

test("native request times out and disconnects the port", async () => {
  nextPort = makePort();
  await assert.rejects(
    new NativeStorage(config, { requestTimeoutMs: 15 }).configureDatabase(),
    (error) => error.code === "NATIVE_HOST_TIMEOUT" && /within 1 seconds/i.test(error.message)
  );
  assert.equal(nextPort.disconnectCount, 1);
});

function fakeTimers() {
  const state = { callback: null, cleared: [] };
  return {
    state,
    options: {
      requestTimeoutMs: 10_000,
      setTimer(callback) { state.callback = callback; return 123; },
      clearTimer(handle) { state.cleared.push(handle); }
    }
  };
}

test("timeout handle is cleared after a successful response", async () => {
  const timers = fakeTimers();
  nextPort = makePort((request, port) => {
    queueMicrotask(() => port.emitMessage({ id: request.id, ok: true, result: validStatus() }));
  });
  await new NativeStorage(config, timers.options).configureDatabase();
  assert.deepEqual(timers.state.cleared, [123]);
});

test("timeout handle is cleared after disconnect", async () => {
  const timers = fakeTimers();
  nextPort = makePort((_request, port) => queueMicrotask(() => port.emitDisconnect()));
  await assert.rejects(new NativeStorage(config, timers.options).configureDatabase());
  assert.deepEqual(timers.state.cleared, [123]);
});

test("mismatched request IDs reject safely and close the port", async () => {
  nextPort = makePort((_request, port) => {
    queueMicrotask(() => port.emitMessage({ id: "wrong-id", ok: true, result: validStatus() }));
  });
  await assert.rejects(
    new NativeStorage(config).configureDatabase(),
    (error) => error.code === "INVALID_NATIVE_RESPONSE" && /unexpected request ID/i.test(error.message)
  );
  assert.equal(nextPort.disconnectCount, 1);
});

test("invalid native responses reject and close the port", async () => {
  nextPort = makePort((_request, port) => queueMicrotask(() => port.emitMessage(null)));
  await assert.rejects(
    new NativeStorage(config).configureDatabase(),
    (error) => error.code === "INVALID_NATIVE_RESPONSE"
  );
  assert.equal(nextPort.disconnectCount, 1);
});

test("structured native errors preserve their code and message", async () => {
  nextPort = makePort((request, port) => queueMicrotask(() => port.emitMessage({
    id: request.id,
    ok: false,
    error: { code: "PERMISSION_DENIED", message: "Directory is read-only." }
  })));
  await assert.rejects(
    new NativeStorage(config).configureDatabase(),
    (error) => error.code === "PERMISSION_DENIED" && /read-only/i.test(error.message)
  );
});

test("storage mode selection never falls back from shared to IndexedDB", () => {
  const shared = createStorage({ ...DEFAULT_SETTINGS, storageMode: "shared", sharedDatabase: config });
  const profile = createStorage({ ...DEFAULT_SETTINGS, storageMode: "perProfile" });
  assert.equal(shared.constructor.name, "NativeStorage");
  assert.equal(profile.constructor.name, "IndexedDbStorage");
});
