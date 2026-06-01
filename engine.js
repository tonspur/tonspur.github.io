// Transcription engine: ffmpeg.wasm audio extraction + Groq transcription/cleanup + formats.
import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { fetchFile, toBlobURL } from "./vendor/util/index.js";

const CORE = "./vendor/core";
const GROQ_TX = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_CHAT = "https://api.groq.com/openai/v1/chat/completions";
const CLEAN_MODEL = "llama-3.3-70b-versatile";
const SEGMENT_SEC = 480;            // chunk length (s) — FLAC 16k mono ≈ 10 MB / 480 s (< Groq 25 MB)
const CHUNK_OVERLAP = 5;            // s of overlap so boundary words aren't cut mid-word
const MAX_SINGLE_BYTES = 22 * 1024 * 1024;
const CLEAN_BATCH = 6000;

// One ffmpeg.wasm instance — the pool creates several of these for parallel extraction.
export class FFmpegSlot {
  constructor() { this.ff = null; this.loading = null; }
  async ensure(onLog) {
    if (this.ff) { if (onLog) this._log = onLog; return this.ff; }
    if (!this.loading) {
      this.loading = (async () => {
        const f = new FFmpeg();
        f.on("log", ({ message }) => this._log && this._log(message));
        await f.load({
          coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, "text/javascript"),
          wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, "application/wasm"),
        });
        this.ff = f;
        return f;
      })();
    }
    this._log = onLog;
    return this.loading;
  }

  async extract(file, onProgress) {
    const ref = { dur: 0, time: 0 };
    const f = await this.ensure((line) => {
      const m = line.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (m) ref.dur = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
      const t = line.match(/time=\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (t) ref.time = +t[1] * 3600 + +t[2] * 60 + parseFloat(t[3]);
      if (ref.dur && onProgress) onProgress(Math.min(1, ref.time / ref.dur), ref.dur);
    });

    const inName = "in" + (file.name.match(/\.[a-z0-9]+$/i)?.[0] || ".bin");
    await f.writeFile(inName, await fetchFile(file));

    // 1) decode once → lossless 16 kHz mono FLAC (no codec smear; Whisper's native rate)
    await f.exec(["-i", inName, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", "out.flac"]);
    await f.deleteFile(inName).catch(() => {});
    const full = await f.readFile("out.flac");
    const duration = ref.dur || 0;
    const mk = (d, offset) => ({ blob: new Blob([d], { type: "audio/flac" }), offset });

    // small enough → one request
    if (full.length <= MAX_SINGLE_BYTES) {
      await f.deleteFile("out.flac").catch(() => {});
      return { duration, chunks: [mk(full, 0)] };
    }

    // 2) overlapping slices via fast stream-copy (instant). Each chunk = [start, start+len+overlap].
    const total = duration || Math.ceil((full.length / MAX_SINGLE_BYTES) * SEGMENT_SEC);
    const chunks = [];
    for (let start = 0, i = 0; start < total; start += SEGMENT_SEC, i++) {
      const name = `seg${String(i).padStart(3, "0")}.flac`;
      const len = SEGMENT_SEC + CHUNK_OVERLAP;
      await f.exec(["-ss", String(start), "-t", String(len), "-i", "out.flac", "-c", "copy", name]);
      const d = await f.readFile(name);
      await f.deleteFile(name).catch(() => {});
      if (d && d.length) chunks.push(mk(d, start));
    }
    await f.deleteFile("out.flac").catch(() => {});
    return { duration, chunks };
  }
}

// Merge per-chunk segments into one timeline; drop overlap duplicates (start within a kept segment).
export function mergeSegments(all) {
  const segs = all.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let lastEnd = -1;
  for (const s of segs) {
    if (s.start < lastEnd - 0.1) continue;  // duplicated overlap region → skip
    out.push(s);
    lastEnd = Math.max(lastEnd, s.end);
  }
  return out;
}

// Build a rich error from a failed Groq response. Parses the rate-limit wait time
// from the JSON body (the only readable signal — the x-ratelimit-* headers are CORS-blocked).
async function groqError(res) {
  let raw = `Groq ${res.status}`;
  try { raw = (await res.json()).error?.message || raw; } catch {}
  let msg = raw;
  if (res.status === 401) msg = "Ungültiger Groq-Key.";
  else if (res.status === 429) msg = "Groq-Limit erreicht — kurz warten.";
  else if (res.status === 413) msg = "Audio-Stück zu groß für Groq.";
  const e = new Error(msg); e.status = res.status;
  // "Please try again in 1m23.4s" / "...in 9.6s" → seconds
  const m = raw.match(/try again in (?:(\d+)m)?\s*([\d.]+)s/i);
  if (m) e.retryAfter = (+m[1] || 0) * 60 + parseFloat(m[2]);
  return e;
}

// Retry a Groq call on 429 (rate limit). `onWait(seconds, attempt)` must update the UI
// AND resolve after that many seconds (owns the countdown + the actual sleep).
export async function retry429(fn, onWait, max = 20) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (e.status !== 429 || attempt >= max) throw e;
      const wait = Math.min(60, e.retryAfter || 8 * Math.min(2 ** attempt, 8));
      if (onWait) await onWait(Math.ceil(wait), attempt + 1);
    }
  }
}

export async function groqTranscribe({ blob, key, model, lang, prompt }) {
  const fd = new FormData();
  fd.append("file", blob, "audio.flac");
  fd.append("model", model);
  fd.append("language", lang);
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  // Whisper conditions on `prompt` (glossary + tail of previous chunk) → continuity + consistent spelling.
  if (prompt) fd.append("prompt", prompt.slice(-900));
  const res = await fetch(GROQ_TX, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
  if (!res.ok) throw await groqError(res);
  const data = await res.json();
  const segments = (data.segments || [])
    .map((s) => ({ start: s.start, end: s.end, text: (s.text || "").trim() }))
    .filter((s) => s.text);
  return { segments, headers: res.headers };
}

async function groqCleanup(text, lang, key) {
  const sys = lang === "de"
    ? "Du bist Transkript-Korrektor. Korrigiere NUR Zeichensetzung, Groß-/Kleinschreibung, Abstände, Apostrophe und offensichtliche Versprecher/Erkennungsfehler. Füge sinnvolle Absätze ein. Ändere, ergänze oder kürze KEINE Inhalte, fasse NICHTS zusammen, paraphrasiere NICHT. Behalte jedes gesprochene Wort. Gib nur den korrigierten Text zurück."
    : "You are a transcript proofreader. Fix ONLY punctuation, capitalization, spacing, apostrophes/contractions and obvious speech-recognition errors. Add sensible paragraph breaks. Do NOT add, remove, summarize or paraphrase content. Keep every spoken word. Return only the corrected text.";
  const res = await fetch(GROQ_CHAT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: CLEAN_MODEL, temperature: 0, messages: [{ role: "system", content: sys }, { role: "user", content: text }] }),
  });
  if (!res.ok) throw await groqError(res);
  return ((await res.json()).choices?.[0]?.message?.content || "").trim();
}

function batchText(text) {
  const parts = []; let buf = "";
  for (const sent of text.split(/(?<=[.!?…])\s+/)) {
    if ((buf + " " + sent).length > CLEAN_BATCH && buf) { parts.push(buf); buf = sent; }
    else buf = buf ? buf + " " + sent : sent;
  }
  if (buf) parts.push(buf);
  return parts;
}
export async function cleanupAll(rawText, lang, key, onProg, onWait) {
  const parts = batchText(rawText);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(await retry429(() => groqCleanup(parts[i], lang, key), onWait));
    onProg && onProg((i + 1) / parts.length);
  }
  return out.join("\n\n");
}

// ---- output formats ----
const pad = (n, w = 2) => String(n).padStart(w, "0");
export function tc(sec, sep) {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(Math.round((sec - Math.floor(sec)) * 1000), 3)}`;
}
function metaHead(meta) {
  return `---\nmodell: ${meta.model}\nsprache: ${meta.lang}\ndauer: ${Math.round(meta.duration / 60)} min\nsegmente: ${meta.segments}\nveredelt: ${meta.clean ? "ja" : "nein"}\n---\n\n`;
}
export function buildTxt(segs, cleanText, meta) {
  if (cleanText) return metaHead(meta) + cleanText + "\n";
  const paras = []; let cur = [];
  segs.forEach((s, i) => { cur.push(s.text); const gap = i + 1 < segs.length ? segs[i + 1].start - s.end : 0; if (gap > 2) { paras.push(cur.join(" ")); cur = []; } });
  if (cur.length) paras.push(cur.join(" "));
  return metaHead(meta) + paras.join("\n\n") + "\n";
}
export const buildSrt = (segs) => segs.map((s, i) => `${i + 1}\n${tc(s.start, ",")} --> ${tc(s.end, ",")}\n${s.text}\n`).join("\n");
export const buildVtt = (segs) => "WEBVTT\n\n" + segs.map((s) => `${tc(s.start, ".")} --> ${tc(s.end, ".")}\n${s.text}\n`).join("\n");
export const buildJson = (segs, meta) => JSON.stringify({ meta, segments: segs }, null, 2);
