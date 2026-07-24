import type { ExtensionSettings } from "../types/models.js";
import { IndexedDbStorage } from "./indexeddb-storage.js";
import { NativeStorage } from "./native-storage.js";
import type { VisitStorage } from "./storage-interface.js";

let indexedDbInstance: IndexedDbStorage | null = null;

export function createStorage(settings: ExtensionSettings): VisitStorage {
  if (settings.storageMode === "shared") return new NativeStorage(settings.sharedDatabase);
  indexedDbInstance ??= new IndexedDbStorage();
  return indexedDbInstance;
}
