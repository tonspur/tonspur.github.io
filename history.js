// Local transcript history — IndexedDB, private, free, on-device only.
// Own database (separate from crypto.js's "tonspur"/"keys") to avoid version coordination.
const DB_NAME = "tonspur_history";
const STORE = "items";
const MAX_ITEMS = 100;

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id" });
        s.createIndex("dateMs", "dateMs");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; }).catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const req2promise = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// rec: { id, name, dateMs, lang, model, duration, segCount, segs, cleanText }
export async function saveTranscript(rec) {
  await tx("readwrite", (s) => s.put(rec));
  // prune oldest beyond MAX_ITEMS
  const all = await listTranscripts();
  if (all.length > MAX_ITEMS) {
    const drop = all.slice(MAX_ITEMS); // listTranscripts is newest-first
    await tx("readwrite", (s) => { drop.forEach((d) => s.delete(d.id)); });
  }
  return rec;
}
export async function listTranscripts() {
  const all = await tx("readonly", (s) => req2promise(s.getAll()));
  return (all || []).sort((a, b) => b.dateMs - a.dateMs);
}
export const getTranscript = (id) => tx("readonly", (s) => req2promise(s.get(id)));
export const deleteTranscript = (id) => tx("readwrite", (s) => s.delete(id));
export const clearAll = () => tx("readwrite", (s) => s.clear());

// Incremental write during a running job (no prune — cheap, called per chunk).
export const putTranscript = (rec) => tx("readwrite", (s) => s.put(rec));

// On boot: any record still flagged "running" is a leftover from a refresh/crash → mark interrupted.
export async function markInterrupted() {
  const all = await listTranscripts();
  const stale = all.filter((r) => r.status === "running");
  if (stale.length) await tx("readwrite", (s) => { stale.forEach((r) => s.put({ ...r, status: "incomplete" })); });
  return stale.length;
}
