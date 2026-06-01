// Cost estimation + local daily usage tracking.
// (Groq returns x-ratelimit-* headers but does NOT expose them via CORS, so a browser
//  cannot read live remaining quota. We therefore track usage locally per day.)
import { PRICING, CLEANUP_PRICE, USD_EUR } from "./config.js?v=17";

// Groq free-tier whisper-large-v3 limits (reference): 2000 requests/day, 7200 audio-seconds/hour.
// The HOURLY audio cap is what actually throttles big batches — not the daily request count.
const FREE_REQ_PER_DAY = 2000;
const FREE_SEC_PER_HOUR = 7200; // ~2 h of audio per clock-hour
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

// Rough wall-clock estimate (seconds) for a job of `sec` audio: local FLAC extraction
// (device-bound, the slow part) + Groq transcription (fast) + optional cleanup. Returns a band.
export function estimateTime(sec, withCleanup) {
  const extract = sec * 0.12;                 // ffmpeg.wasm decode/encode, ~0.12× realtime (rough)
  const transcribe = Math.max(3, sec * 0.03); // Groq large-v3 is very fast vs realtime
  const cleanup = withCleanup ? Math.max(2, (sec / 60) * 1.2) : 0;
  const mid = extract + transcribe + cleanup;
  return { lowSec: mid * 0.6, highSec: mid * 1.5, midSec: mid };
}

export function fmtDur(sec) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = sec / 60;
  return m < 10 ? `${m.toFixed(1)} min` : `${Math.round(m)} min`;
}

export function fmtMoney(usd) {
  const eur = usd * USD_EUR;
  if (eur < 1) return `${(eur * 100).toFixed(eur < 0.1 ? 1 : 0)} ct`;
  return `${eur.toFixed(2)} €`;
}

// ---- local usage tracking (day bucket for requests/cost, rolling hour bucket for audio) ----
function today() { return new Date().toISOString().slice(0, 10); }
function thisHour() { return new Date().toISOString().slice(0, 13); } // YYYY-MM-DDTHH
function read() {
  let u = {};
  try { u = JSON.parse(localStorage.getItem(USAGE_KEY) || "{}"); } catch {}
  if (u.date !== today()) u = { date: today(), requests: 0, seconds: 0, usd: 0, hour: thisHour(), secondsThisHour: 0 };
  if (u.hour !== thisHour()) { u.hour = thisHour(); u.secondsThisHour = 0; }
  return u;
}
function write(u) { try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch {} }

// Record one finished job: Groq requests (chunks + cleanup batches), audio seconds, cost.
export function recordRun({ requests, seconds, usd }) {
  const u = read();
  u.requests += requests || 0; u.seconds += seconds || 0; u.usd += usd || 0;
  u.secondsThisHour += seconds || 0;
  write(u); return u;
}
export function getUsage() {
  const u = read();
  return {
    ...u,
    reqLimit: FREE_REQ_PER_DAY, reqLeft: Math.max(0, FREE_REQ_PER_DAY - u.requests),
    hourLimitSec: FREE_SEC_PER_HOUR, hourLeftSec: Math.max(0, FREE_SEC_PER_HOUR - (u.secondsThisHour || 0)),
  };
}
