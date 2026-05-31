// Transcription engine: ffmpeg.wasm audio extraction + Groq transcription/cleanup + formats.
import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { fetchFile, toBlobURL } from "./vendor/util/index.js";

const CORE = "./vendor/core";
const GROQ_TX = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_CHAT = "https://api.groq.com/openai/v1/chat/completions";
const CLEAN_MODEL = "llama-3.3-70b-versatile";
const SEGMENT_SEC = 600;
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
    const args = (out, seg) => {
      const a = ["-i", inName, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k"];
      if (seg) a.push("-f", "segment", "-segment_time", String(SEGMENT_SEC), "-reset_timestamps", "1");
      return a.concat(out);
    };

    await f.exec(args("out.m4a"));
    const data = await f.readFile("out.m4a");
    const duration = ref.dur || 0;

    if (data.length <= MAX_SINGLE_BYTES) {
      await f.deleteFile(inName).catch(() => {});
      await f.deleteFile("out.m4a").catch(() => {});
      return { duration, chunks: [{ blob: new Blob([data], { type: "audio/mp4" }), offset: 0 }] };
    }
    await f.deleteFile("out.m4a").catch(() => {});
    await f.exec(args("seg%03d.m4a", true));
    const files = (await f.listDir("/")).filter((e) => /^seg\d+\.m4a$/.test(e.name)).map((e) => e.name).sort();
    const chunks = [];
    for (let i = 0; i < files.length; i++) {
      const d = await f.readFile(files[i]);
      chunks.push({ blob: new Blob([d], { type: "audio/mp4" }), offset: i * SEGMENT_SEC });
      await f.deleteFile(files[i]).catch(() => {});
    }
    await f.deleteFile(inName).catch(() => {});
    return { duration, chunks };
  }
}

export async function groqTranscribe({ blob, key, model, lang, glossary }) {
  const fd = new FormData();
  fd.append("file", blob, "audio.m4a");
  fd.append("model", model);
  fd.append("language", lang);
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  if (glossary) fd.append("prompt", glossary);
  const res = await fetch(GROQ_TX, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
  if (!res.ok) {
    let msg = `Groq ${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    if (res.status === 401) msg = "Ungültiger Groq-Key.";
    if (res.status === 429) msg = "Groq-Limit erreicht — kurz warten.";
    if (res.status === 413) msg = "Audio-Stück zu groß für Groq.";
    const e = new Error(msg); e.status = res.status; e.headers = res.headers; throw e;
  }
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
  if (!res.ok) throw new Error("cleanup " + res.status);
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
export async function cleanupAll(rawText, lang, key, onProg) {
  const parts = batchText(rawText);
  const out = [];
  for (let i = 0; i < parts.length; i++) { out.push(await groqCleanup(parts[i], lang, key)); onProg && onProg((i + 1) / parts.length); }
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
