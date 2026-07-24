class NameList {
  constructor(values) { this.values = values; }
  contains(name) { return this.values.has(name); }
}

class FakeRequest {
  constructor(transaction, executor) {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    transaction?._begin();
    queueMicrotask(() => {
      try {
        this.result = executor();
        this.onsuccess?.({ target: this });
        transaction?._finish();
      } catch (error) {
        this.error = error;
        this.onerror?.({ target: this });
        transaction?._fail(error);
      }
    });
  }
}

class FakeIndex {
  constructor(store, keyPath) { this.store = store; this.keyPath = keyPath; }
  getAll(value) {
    return new FakeRequest(this.store.transaction, () => [...this.store.data.values()].filter((item) => item[this.keyPath] === value).map((item) => structuredClone(item)));
  }
  getAllKeys(value) {
    return new FakeRequest(this.store.transaction, () => [...this.store.data.entries()].filter(([, item]) => item[this.keyPath] === value).map(([key]) => key));
  }
}

class FakeObjectStore {
  constructor(definition, transaction) {
    this.definition = definition;
    this.transaction = transaction;
    this.data = definition.data;
    this.keyPath = definition.keyPath;
    this.indexNames = new NameList(definition.indexes);
  }
  createIndex(name, keyPath) { this.definition.indexes.add(name); this.definition.indexPaths.set(name, keyPath); return this.index(name); }
  index(name) {
    const keyPath = this.definition.indexPaths.get(name);
    if (!keyPath) throw new Error(`Unknown index ${name}`);
    return new FakeIndex(this, keyPath);
  }
  get(key) { return new FakeRequest(this.transaction, () => structuredClone(this.data.get(key))); }
  getAll() { return new FakeRequest(this.transaction, () => [...this.data.values()].map((item) => structuredClone(item))); }
  put(value) { return new FakeRequest(this.transaction, () => { const key = value[this.keyPath]; this.data.set(key, structuredClone(value)); return key; }); }
  add(value) { return new FakeRequest(this.transaction, () => { const key = value[this.keyPath]; if (this.data.has(key)) throw new Error("ConstraintError"); this.data.set(key, structuredClone(value)); return key; }); }
  delete(key) { return new FakeRequest(this.transaction, () => this.data.delete(key)); }
  clear() { return new FakeRequest(this.transaction, () => { this.data.clear(); return undefined; }); }
}

class FakeTransaction {
  constructor(db, names, mode) {
    this.db = db;
    this.names = Array.isArray(names) ? names : [names];
    this.mode = mode;
    this.pending = 0;
    this.completeScheduled = false;
    this.failed = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._schedule();
  }
  objectStore(name) {
    const definition = this.db.stores.get(name);
    if (!definition) throw new Error(`Unknown object store ${name}`);
    return new FakeObjectStore(definition, this);
  }
  _begin() { this.pending += 1; }
  _finish() { this.pending -= 1; this._schedule(); }
  _fail(error) { this.failed = true; this.error = error; this.onerror?.({ target: this }); this.onabort?.({ target: this }); }
  _schedule() {
    if (this.completeScheduled || this.failed) return;
    this.completeScheduled = true;
    setTimeout(() => {
      this.completeScheduled = false;
      if (!this.failed && this.pending === 0) this.oncomplete?.({ target: this });
      else if (!this.failed) this._schedule();
    }, 0);
  }
}

class FakeDatabase {
  constructor() {
    this.stores = new Map();
    this.objectStoreNames = { contains: (name) => this.stores.has(name) };
    this.onversionchange = null;
  }
  createObjectStore(name, options) {
    const definition = { keyPath: options.keyPath, data: new Map(), indexes: new Set(), indexPaths: new Map() };
    this.stores.set(name, definition);
    return new FakeObjectStore(definition, this._upgradeTransaction);
  }
  transaction(names, mode) { return new FakeTransaction(this, names, mode); }
  close() {}
}

export class FakeIndexedDBFactory {
  constructor() { this.db = null; }
  open() {
    const request = { result: undefined, error: null, transaction: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
    queueMicrotask(() => {
      try {
        if (!this.db) {
          this.db = new FakeDatabase();
          const upgrade = new FakeTransaction(this.db, [], "versionchange");
          this.db._upgradeTransaction = upgrade;
          request.result = this.db;
          request.transaction = upgrade;
          request.onupgradeneeded?.({ target: request });
          this.db._upgradeTransaction = null;
        } else {
          request.result = this.db;
        }
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
      }
    });
    return request;
  }
}
