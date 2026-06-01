// Account + zero-knowledge Groq-key storage.
// Supabase = email/password auth + a `profiles` row holding only CIPHERTEXT of the key.
// The key is encrypted/decrypted client-side (crypto.js). Server never sees plaintext.
import { SUPABASE } from "./config.js?v=18";
import { deriveKey, encryptString, decryptString, randomSaltB64, cacheKey, loadCachedKey, clearCachedKeys } from "./crypto.js?v=18";

let client = null;
let clientLoading = null;

export function authEnabled() { return !!(SUPABASE.url && SUPABASE.anon); }

// Load the Supabase client. jsDelivr's "+esm" is ONE self-contained bundle (robust);
// esm.sh splits into ~6 sub-imports and dies if any one hiccups → used only as fallback.
const SUPABASE_CDNS = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
  "https://esm.sh/@supabase/supabase-js@2",
];
async function loadCreateClient() {
  let lastErr;
  for (const url of SUPABASE_CDNS) {
    try { const m = await import(/* @vite-ignore */ url); if (m && m.createClient) return m.createClient; lastErr = new Error("kein createClient: " + url); }
    catch (e) { lastErr = e; }
  }
  console.warn("Supabase load failed:", lastErr);
  throw new Error("Login-Dienst laedt nicht (Netzwerk/CDN). Internet pruefen und erneut auf Anmelden tippen.");
}

async function getClient() {
  if (!authEnabled()) return null;
  if (client) return client;
  if (!clientLoading) {
    clientLoading = (async () => {
      const createClient = await loadCreateClient();
      client = createClient(SUPABASE.url, SUPABASE.anon, { auth: { persistSession: true, autoRefreshToken: true } });
      return client;
    })().catch((e) => { clientLoading = null; throw e; });   // reset so the next attempt retries
  }
  return clientLoading;
}

export async function getSession() {
  const c = await getClient(); if (!c) return null;
  const { data } = await c.auth.getSession();
  return data.session || null;
}
export async function onChange(cb) {
  const c = await getClient(); if (!c) return;
  c.auth.onAuthStateChange((_e, session) => cb(session));
}
export async function signUp(email, password) {
  const c = await getClient(); if (!c) throw new Error("Cloud-Login nicht konfiguriert.");
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw new Error(error.message);
  return data; // session may be null if email confirmation is on
}
export async function signIn(email, password) {
  const c = await getClient(); if (!c) throw new Error("Cloud-Login nicht konfiguriert.");
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data;
}
export async function signOut() {
  const c = await getClient(); if (!c) return;
  await c.auth.signOut();
  await clearCachedKeys();
}
export async function resetPassword(email) {
  const c = await getClient(); if (!c) throw new Error("Cloud-Login nicht konfiguriert.");
  const { error } = await c.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) throw new Error(error.message);
}

async function fetchProfile(c, uid) {
  const { data, error } = await c.from("profiles").select("enc_key,enc_iv,kdf_salt").eq("id", uid).maybeSingle();
  if (error) throw new Error(error.message);
  return data || {};
}

// Called right after sign-in/sign-up while the password is in memory:
// derive the AES key, cache it, decrypt any stored Groq key.
export async function unlock(password) {
  const c = await getClient(); const session = await getSession();
  if (!c || !session) throw new Error("Nicht angemeldet.");
  const uid = session.user.id;
  let prof = await fetchProfile(c, uid);
  let salt = prof.kdf_salt;
  if (!salt) {
    salt = randomSaltB64();
    const { error } = await c.from("profiles").upsert({ id: uid, kdf_salt: salt });
    if (error) throw new Error(error.message);
  }
  const key = await deriveKey(password, salt);
  await cacheKey(uid, key);
  if (prof.enc_key && prof.enc_iv) {
    try { return { groqKey: await decryptString(key, prof.enc_key, prof.enc_iv) }; }
    catch { return { groqKey: null, badPassword: true }; } // wrong pw or rotated -> re-enter key
  }
  return { groqKey: null };
}

// Called on reload (no password): use cached CryptoKey + stored ciphertext.
export async function loadFromCache() {
  const c = await getClient(); const session = await getSession();
  if (!c || !session) return { signedIn: false };
  const uid = session.user.id;
  const key = await loadCachedKey(uid);
  if (!key) return { signedIn: true, needsPassword: true, email: session.user.email };
  const prof = await fetchProfile(c, uid);
  if (!prof.enc_key) return { signedIn: true, email: session.user.email, groqKey: null };
  try { return { signedIn: true, email: session.user.email, groqKey: await decryptString(key, prof.enc_key, prof.enc_iv) }; }
  catch { return { signedIn: true, email: session.user.email, needsPassword: true }; }
}

export async function saveKey(groqKey) {
  const c = await getClient(); const session = await getSession();
  if (!c || !session) throw new Error("Nicht angemeldet.");
  const uid = session.user.id;
  const key = await loadCachedKey(uid);
  if (!key) throw new Error("Bitte zuerst mit Passwort entsperren.");
  const { ct, iv } = await encryptString(key, groqKey);
  const { error } = await c.from("profiles").upsert({ id: uid, enc_key: ct, enc_iv: iv });
  if (error) throw new Error(error.message);
}
