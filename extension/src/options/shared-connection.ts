import type { DatabaseConfig, DatabaseStatus, ExtensionSettings } from "../types/models.js";

interface TextTarget {
  textContent: string | null;
}

interface DisableTarget {
  disabled: boolean;
}

export interface SharedConnectionUi {
  testButton: DisableTarget;
  nativeStatus: TextTarget;
  resolvedPath: TextTarget;
}

export interface SharedConnectionTestOptions {
  config: DatabaseConfig;
  send(config: DatabaseConfig): Promise<DatabaseStatus>;
  ui: SharedConnectionUi;
  onStatus?(message: string): void;
  onFailure?(status: DatabaseStatus): void | Promise<void>;
}

function errorDetails(error: unknown): { code: string; message: string } {
  const value = error as { code?: unknown; message?: unknown } | null;
  return {
    code: typeof value?.code === "string" ? value.code : "CONNECTION_FAILED",
    message: typeof value?.message === "string" ? value.message : String(error)
  };
}

export async function runSharedConnectionTest(
  options: SharedConnectionTestOptions
): Promise<DatabaseStatus> {
  const { ui } = options;
  ui.testButton.disabled = true;
  ui.nativeStatus.textContent = "Testing…";
  ui.resolvedPath.textContent = "Not tested";
  try {
    const status = await options.send(options.config);
    if (!status || typeof status.available !== "boolean") {
      throw Object.assign(new Error("The native host returned an invalid database status."), {
        code: "INVALID_NATIVE_RESPONSE"
      });
    }
    if (!status.available || !status.path) {
      const failed: DatabaseStatus = {
        available: false,
        path: null,
        errorCode: status.errorCode ?? "CONNECTION_FAILED",
        errorMessage: status.errorMessage ?? "The native host/database connection failed."
      };
      ui.nativeStatus.textContent = failed.errorMessage;
      ui.resolvedPath.textContent = "Unavailable";
      options.onStatus?.("Connection failed");
      await options.onFailure?.(failed);
      return failed;
    }
    ui.nativeStatus.textContent = status.journalMode
      ? `Connected (${status.journalMode})`
      : "Connected";
    ui.resolvedPath.textContent = status.path;
    options.onStatus?.("Connection successful");
    return status;
  } catch (error) {
    const details = errorDetails(error);
    const failed: DatabaseStatus = {
      available: false,
      path: null,
      errorCode: details.code,
      errorMessage: details.message
    };
    ui.nativeStatus.textContent = details.message;
    ui.resolvedPath.textContent = "Unavailable";
    options.onStatus?.("Connection failed");
    await options.onFailure?.(failed);
    return failed;
  } finally {
    ui.testButton.disabled = false;
  }
}

export async function saveSettingsAfterConnectionTest(
  next: ExtensionSettings,
  testConnection: () => Promise<DatabaseStatus>,
  persist: (settings: ExtensionSettings) => Promise<void>
): Promise<boolean> {
  if (next.storageMode === "shared") {
    const status = await testConnection();
    if (!status.available) return false;
  }
  await persist(next);
  return true;
}
