import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = { runtime: {} };
const runtimeModule = await import("../.test-build/src/shared/runtime.js");
const { RuntimeRequestError, sendRequest } = runtimeModule.default ?? runtimeModule;
const request = { type: "GET_STATISTICS" };

test("runtime request resolves a callback response", async () => {
  chrome.runtime.sendMessage = (_request, callback) => callback({ ok: true, result: { totalVisits: 3 } });
  assert.equal((await sendRequest(request, 100)).totalVisits, 3);
});

test("runtime request consumes chrome.runtime.lastError", async () => {
  chrome.runtime.sendMessage = (_request, callback) => {
    chrome.runtime.lastError = { message: "The message port closed before a response was received." };
    callback(undefined);
    delete chrome.runtime.lastError;
  };
  await assert.rejects(
    sendRequest(request, 100),
    (error) => error instanceof RuntimeRequestError && error.code === "EXTENSION_RUNTIME_ERROR"
  );
});

test("runtime request has a finite timeout", async () => {
  chrome.runtime.sendMessage = () => undefined;
  await assert.rejects(
    sendRequest(request, 10),
    (error) => error.code === "EXTENSION_REQUEST_TIMEOUT"
  );
});
