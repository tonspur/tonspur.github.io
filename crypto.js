// Zero-knowledge crypto for the Groq key.
// Key derived from the account password (PBKDF2) -> AES-GCM. The server only ever
// stores ciphertext. The derived CryptoKey is cached non-extractable in IndexedDB so
// reloads/sessions decrypt without re-asking for the password.

const PBKDF2_ITERATIONS = 210000;
const DB_NAME = "tonspur";
const STORE = "keys";

const enc = new TextEncoder();
const dec = new TextDecoder();

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

export function randomSaltB64() {
  return bufToB64(crypto.getRandomValues(new Uint8Array(16)));
}

// Derive a non-extractable AES-GCM key from password + salt.
export async function deriveKey(password, saltB64) {
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64ToBuf(saltB64), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,                              // non-extractable
    ["encrypt", "decrypt"]);
}

export async function encryptString(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return { ct: bufToB64(ct), iv: bufToB64(iv) };
}

export async function decryptString(key, ctB64, ivB64) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(b64ToBuf(ivB64)) }, key, b64ToBuf(ctB64));
  return dec.decode(pt);
}

// ---- IndexedDB cache for the (non-extractable) CryptoKey ----
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbOp(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const r = fn(store);
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
  });
}
export const cacheKey = (userId, cryptoKey) => idbOp("readwrite", (s) => s.put(cryptoKey, userId));
export const loadCachedKey = (userId) => idbOp("readonly", (s) => s.get(userId));
export const clearCachedKeys = () => idbOp("readwrite", (s) => s.clear()).catch(() => {});
