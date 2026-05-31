// Cost estimation + local daily usage tracking.
// (Groq returns x-ratelimit-* headers but does NOT expose them via CORS, so a browser
//  cannot read live remaining quota. We therefore track usage locally per day.)
import { PRICING, CLEANUP_PRICE, USD_EUR } from "./config.js";

const FREE_REQ_PER_DAY = 2000; // Groq free-tier whisper requests/day (reference)
const USAGE_KEY = "tonspur_usage";

// Estimate USD for transcribing `sec` seconds of audio with a model (+ optional cleanup).
export function estimate(sec, model, withCleanup) {
  const hours = sec / 3600;
  const transcription = (PRICING[model] || PRICING["whisper-large-v3"]) * hours;
  // ~ words/min * minutes -> tokens (rough: 150 wpm, ~1.3 tok/word, in+out similar)
  const minutes = sec / 60;
  const tok = minutes * 150 * 1.3;
  const cleanup = withCleanup ? (tok * CLEANUP_PRICE.in + tok * CLEANUP_PRICE.out) / 1e6 : 0;
  return { transcription, cleanup, total: transcription + cleanup };
}

export function fmtMoney(usd) {
  const eur = usd * USD_EUR;
  if (eur < 1) return `${(eur * 100).toFixed(eur < 0.1 ? 1 : 0)} ct`;
  return `${eur.toFixed(2)} €`;
}

// ---- local daily usage ----
function today() { return new Date().toISOString().slice(0, 10); }
function read() {
  try { const u = JSON.parse(localStorage.getItem(USAGE_KEY) || "{}"); if (u.date === today()) return u; } catch {}
  return { date: today(), requests: 0, seconds: 0, usd: 0 };
}
function write(u) { try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch {} }

// Record one finished job: number of Groq requests (chunks + cleanup batches), audio seconds, cost.
export function recordRun({ requests, seconds, usd }) {
  const u = read();
  u.requests += requests || 0; u.seconds += seconds || 0; u.usd += usd || 0;
  write(u); return u;
}
export function getUsage() {
  const u = read();
  return { ...u, freeLimit: FREE_REQ_PER_DAY, freeLeft: Math.max(0, FREE_REQ_PER_DAY - u.requests) };
}
