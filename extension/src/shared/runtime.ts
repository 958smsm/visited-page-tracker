import type { RuntimeRequest, RuntimeResponse } from "./messages.js";

export const DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS = 60_000;

export class RuntimeRequestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeRequestError";
  }
}

function isRuntimeResponse<T>(value: unknown): value is RuntimeResponse<T> {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { ok?: unknown }).ok === "boolean";
}

export function sendRequest<T>(
  request: RuntimeRequest,
  timeoutMs = DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      callback();
    };
    timeoutHandle = setTimeout(() => {
      finish(() => reject(new RuntimeRequestError(
        "EXTENSION_REQUEST_TIMEOUT",
        `The extension service worker did not respond within ${Math.ceil(timeoutMs / 1_000)} seconds.`
      )));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(request, (value: unknown) => {
        const lastError = chrome.runtime.lastError as { message?: string } | undefined;
        if (lastError) {
          finish(() => reject(new RuntimeRequestError(
            "EXTENSION_RUNTIME_ERROR",
            lastError.message ?? "The extension service worker could not receive the request."
          )));
          return;
        }
        if (!isRuntimeResponse<T>(value)) {
          finish(() => reject(new RuntimeRequestError(
            "INVALID_EXTENSION_RESPONSE",
            "The extension service worker returned an invalid response."
          )));
          return;
        }
        if (!value.ok) {
          finish(() => reject(new RuntimeRequestError(
            value.error?.code ?? "EXTENSION_REQUEST_FAILED",
            value.error?.message ?? "Extension request failed."
          )));
          return;
        }
        finish(() => resolve(value.result as T));
      });
    } catch (error) {
      finish(() => reject(new RuntimeRequestError(
        "EXTENSION_RUNTIME_ERROR",
        error instanceof Error ? error.message : String(error)
      )));
    }
  });
}
