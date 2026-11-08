// Offline queue in IndexedDB: a capture made while the engine is down is kept and retried.
const DB_NAME = "aether-queue";
const STORE = "captures";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const add = (entry) => run("readwrite", (s) => s.add({ ...entry, queuedAt: Date.now() }));
export const all = () => run("readonly", (s) => s.getAll());
export const remove = (id) => run("readwrite", (s) => s.delete(id));
export const count = () => run("readonly", (s) => s.count());
