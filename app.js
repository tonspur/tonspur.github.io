// TONSPUR — client-side audio extraction (ffmpeg.wasm) + Groq transcription + AI cleanup.
// No backend. The user's Groq key lives only in localStorage.

import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { fetchFile, toBlobURL } from "./vendor/util/index.js";

const GROQ_TX = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_CHAT = "https://api.groq.com/openai/v1/chat/completions";
const CLEAN_MODEL = "llama-3.3-70b-versatile";
const CORE = "./vendor/core";
const SEGMENT_SEC = 600;
const MAX_SINGLE_BYTES = 22 * 1024 * 1024;
const CLEAN_BATCH = 6000;

const $ = (s) => document.querySelector(s);
function lsGet(k){try{return localStorage.getItem(k)||""}catch{return""}}
function lsSet(k,v){try{localStorage.setItem(k,v);return true}catch{return false}}
function lsDel(k){try{localStorage.removeItem(k)}catch{}}

const state = {
  lang: "de",
  model: "whisper-large-v3",
  formats: new Set(["txt", "srt"]),
  clean: true,
  glossary: "",
  key: lsGet("groq_key"),
  stored: true,
};

let ffmpeg = null, ffmpegLoading = null;
const queue = [];
let busy = false, jobSeq = 0;

/* ---------- ffmpeg ---------- */
async function getFFmpeg(onLog) {
  if (ffmpeg) return ffmpeg;
  if (!ffmpegLoading) {
    ffmpegLoading = (async () => {
      const f = new FFmpeg();
      if (onLog) f.on("log", ({ message }) => onLog(message));
      await f.load({
        coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, "application/wasm"),
      });
      ffmpeg = f;
      return f;
    })();
  }
  return ffmpegLoading;
}
function parseDuration(log, ref) {
  const m = log.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (m) ref.dur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  const t = log.match(/time=\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (t) ref.time = (+t[1]) * 3600 + (+t[2]) * 60 + parseFloat(t[3]);
}

/* ---------- pipeline ---------- */
async function extractAudio(job, file) {
  const ref = { dur: 0, time: 0 };
  const f = await getFFmpeg((line) => {
    parseDuration(line, ref);
    if (ref.dur) job.ui.phase(`Tonspur extrahieren … ${Math.min(99, Math.round(ref.time / ref.dur * 100))}%`,
      0.05 + 0.25 * Math.min(1, ref.time / ref.dur));
  });
  const inName = "in" + (file.name.match(/\.[a-z0-9]+$/i)?.[0] || ".bin");
  await f.writeFile(inName, await fetchFile(file));

  // 64k mono AAC: transparent for 16 kHz speech, far cleaner on fast passages than 24k.
  const args = (out, seg) => {
    const a = ["-i", inName, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k"];
    if (seg) a.push("-f", "segment", "-segment_time", String(SEGMENT_SEC), "-reset_timestamps", "1");
    return a.concat(out);
  };

  await f.exec(args("out.m4a"));
  let data = await f.readFile("out.m4a");
  job.duration = ref.dur || 0;

  if (data.length <= MAX_SINGLE_BYTES) {
    await f.deleteFile(inName).catch(() => {});
    return [{ blob: new Blob([data], { type: "audio/mp4" }), offset: 0 }];
  }
  job.ui.phase("Große Datei → in Stücke teilen …", 0.3);
  await f.deleteFile("out.m4a").catch(() => {});
  await f.exec(args("seg%03d.m4a", true));
  const files = (await f.listDir("/")).filter((e) => /^seg\d+\.m4a$/.test(e.name))
    .map((e) => e.name).sort();
  const chunks = [];
  for (let i = 0; i < files.length; i++) {
    const d = await f.readFile(files[i]);
    chunks.push({ blob: new Blob([d], { type: "audio/mp4" }), offset: i * SEGMENT_SEC });
    await f.deleteFile(files[i]).catch(() => {});
  }
  await f.deleteFile(inName).catch(() => {});
  return chunks;
}

async function groqChunk(blob, job) {
  const fd = new FormData();
  fd.append("file", blob, "audio.m4a");
  fd.append("model", state.model);
  fd.append("language", job.lang);
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  if (job.glossary) fd.append("prompt", job.glossary);
  const res = await fetch(GROQ_TX, {
    method: "POST", headers: { Authorization: `Bearer ${state.key}` }, body: fd });
  if (!res.ok) {
    let msg = `Groq ${res.status}`;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
    if (res.status === 401) msg = "Ungültiger Groq-Key. Oben rechts auf 🔑 klicken.";
    if (res.status === 429) msg = "Groq-Limit erreicht. Kurz warten und erneut.";
    if (res.status === 413) msg = "Audio-Stück zu groß für Groq.";
    throw new Error(msg);
  }
  const data = await res.json();
  return (data.segments || []).map((s) => ({ start: s.start, end: s.end, text: (s.text || "").trim() }))
    .filter((s) => s.text);
}

// Conservative proofreading: fix punctuation/casing/contractions/obvious errors, never invent.
async function groqCleanup(text, lang) {
  const sys = lang === "de"
    ? "Du bist Transkript-Korrektor. Korrigiere NUR Zeichensetzung, Groß-/Kleinschreibung, Abstände, Apostrophe und offensichtliche Versprecher/Erkennungsfehler. Füge sinnvolle Absätze ein. Ändere, ergänze oder kürze KEINE Inhalte, fasse NICHTS zusammen, paraphrasiere NICHT. Behalte jedes gesprochene Wort. Gib nur den korrigierten Text zurück."
    : "You are a transcript proofreader. Fix ONLY punctuation, capitalization, spacing, apostrophes/contractions and obvious speech-recognition errors. Add sensible paragraph breaks. Do NOT add, remove, summarize or paraphrase content. Keep every spoken word. Return only the corrected text.";
  const res = await fetch(GROQ_CHAT, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: CLEAN_MODEL, temperature: 0,
      messages: [{ role: "system", content: sys }, { role: "user", content: text }] }),
  });
  if (!res.ok) throw new Error("cleanup " + res.status);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
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
async function cleanupAll(rawText, lang, onProg) {
  const parts = batchText(rawText);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(await groqCleanup(parts[i], lang));
    onProg && onProg((i + 1) / parts.length);
  }
  return out.join("\n\n");
}

async function runJob(job) {
  try {
    if (!state.key) throw new Error("Kein Groq-Key gesetzt. Oben rechts auf 🔑 klicken.");
    job.ui.setState("run");
    window.__pulse = 0.9;
    job.ui.phase("ffmpeg lädt …", 0.03);

    const chunks = await extractAudio(job, job.file);
    const segs = [];
    for (let i = 0; i < chunks.length; i++) {
      job.ui.phase(`Transkribieren (Groq) … Stück ${i + 1}/${chunks.length}`, 0.35 + 0.5 * (i / chunks.length));
      const part = await groqChunk(chunks[i].blob, job);
      for (const s of part) segs.push({ start: s.start + chunks[i].offset, end: s.end + chunks[i].offset, text: s.text });
    }
    segs.sort((a, b) => a.start - b.start);
    if (!segs.length) throw new Error("Keine Sprache erkannt.");
    job.segs = segs;

    // AI cleanup → only the reading text. Timestamps stay verbatim.
    job.cleanText = null;
    if (job.clean && job.formats.has("txt")) {
      try {
        const raw = segs.map((s) => s.text).join(" ");
        job.ui.phase("KI-Aufräumen …", 0.9);
        job.cleanText = await cleanupAll(raw, job.lang, (p) => job.ui.phase(`KI-Aufräumen … ${Math.round(p * 100)}%`, 0.9 + 0.09 * p));
      } catch (e) { job.cleanText = null; }   // fall back to verbatim
    }

    job.ui.phase("Fertig", 1);
    job.ui.setState("done");
    job.ui.renderResult(job);
    updateStats();
  } catch (e) {
    job.ui.setState("err");
    job.ui.error(e.message || String(e));
  } finally {
    busy = false;
    window.__pulse = queue.some((j) => j.status === "run") ? 0.9 : 0.15;
    pump();
  }
}
function pump() {
  if (busy) return;
  const next = queue.find((j) => j.status === "queued");
  if (!next) { window.__pulse = 0.15; return; }
  busy = true; next.status = "run";
  runJob(next);
}

/* ---------- output formats ---------- */
function pad(n, w = 2) { return String(n).padStart(w, "0"); }
function tc(sec, sep) {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}
function metaHead(meta) {
  return `---\nmodell: ${meta.model}\nsprache: ${meta.lang}\ndauer: ${Math.round(meta.duration / 60)} min\nsegmente: ${meta.segments}\nveredelt: ${meta.clean ? "ja" : "nein"}\n---\n\n`;
}
function buildTxt(job, meta) {
  if (job.cleanText) return metaHead(meta) + job.cleanText + "\n";
  const segs = job.segs; const paras = []; let cur = [];
  segs.forEach((s, i) => {
    cur.push(s.text);
    const gap = i + 1 < segs.length ? segs[i + 1].start - s.end : 0;
    if (gap > 2) { paras.push(cur.join(" ")); cur = []; }
  });
  if (cur.length) paras.push(cur.join(" "));
  return metaHead(meta) + paras.join("\n\n") + "\n";
}
const buildSrt = (segs) => segs.map((s, i) => `${i + 1}\n${tc(s.start, ",")} --> ${tc(s.end, ",")}\n${s.text}\n`).join("\n");
const buildVtt = (segs) => "WEBVTT\n\n" + segs.map((s) => `${tc(s.start, ".")} --> ${tc(s.end, ".")}\n${s.text}\n`).join("\n");
const buildJson = (segs, meta) => JSON.stringify({ meta, segments: segs }, null, 2);

/* ---------- UI ---------- */
function updateStats() {
  $("#statJobs").textContent = queue.length;
  const min = queue.filter((j) => j.status === "done").reduce((a, j) => a + (j.duration || 0), 0) / 60;
  $("#statMin").textContent = Math.round(min);
}
function jobUI(job) {
  const el = document.createElement("div");
  el.className = "job panel";
  el.innerHTML = `
    <div class="head">
      <div class="ring-wrap"><div class="ring"><b>0%</b></div></div>
      <div class="nm"></div>
      <div class="state run">in Arbeit</div>
    </div>
    <div class="phase">in Warteschlange …</div>
    <div class="body"></div>`;
  el.querySelector(".nm").textContent = job.file ? job.file.name : job.name;
  $("#jobs").prepend(el);
  const q = (s) => el.querySelector(s);
  return {
    setState(kind) {
      const map = { run: ["run", "in Arbeit"], done: ["done", "fertig"], err: ["err", "Fehler"] };
      const st = q(".state"); st.className = "state " + map[kind][0]; st.textContent = map[kind][1];
    },
    phase(txt, pct) {
      q(".phase").textContent = txt;
      if (pct != null) { const r = q(".ring"); r.style.setProperty("--p", Math.round(pct * 100)); r.querySelector("b").textContent = Math.round(pct * 100) + "%"; }
    },
    error(msg) { q(".phase").style.display = "none"; q(".ring-wrap").style.display = "none"; q(".body").innerHTML = `<div class="errbox">${msg}</div>`; },
    renderResult(j) {
      const meta = { model: state.model, lang: j.lang, duration: j.duration, segments: j.segs.length, clean: !!j.cleanText };
      const outs = {
        txt: { label: "TXT", data: buildTxt(j, meta), type: "text/plain" },
        srt: { label: "SRT", data: buildSrt(j.segs), type: "application/x-subrip" },
        vtt: { label: "VTT", data: buildVtt(j.segs), type: "text/vtt" },
        json: { label: "JSON", data: buildJson(j.segs, meta), type: "application/json" },
      };
      const base = (j.file ? j.file.name.replace(/\.[^.]+$/, "") : "transkript").slice(0, 60);
      const dls = [...j.formats].map((fmt) => {
        const o = outs[fmt]; const url = URL.createObjectURL(new Blob([o.data], { type: o.type }));
        return `<a href="${url}" download="${base}.${fmt}">⬇ ${o.label}</a>`;
      }).join("");
      const preview = (j.cleanText || outs.txt.data.split("---\n\n")[1] || outs.txt.data);
      q(".phase").textContent = `${meta.model} · ${Math.round(j.duration / 60)} min · ${j.segs.length} Segmente${j.cleanText ? " · ✨ veredelt" : ""}`;
      q(".body").innerHTML = `<div class="dls">${dls}</div><div class="preview"><span class="copy">kopieren</span>${escapeHtml(preview)}</div>`;
      q(".copy").onclick = () => { navigator.clipboard.writeText(preview); q(".copy").textContent = "kopiert ✓"; };
    },
  };
}
function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

function addFile(file) {
  const job = { id: ++jobSeq, file, lang: state.lang, formats: new Set(state.formats),
    clean: state.clean, glossary: state.glossary, status: "queued", segs: [], duration: 0 };
  job.ui = jobUI(job);
  queue.push(job);
  updateStats();
  pump();
}

/* ---------- wiring ---------- */
function initControls() {
  // EQ bars
  const eq = $("#eq");
  if (eq) { for (let i = 0; i < 18; i++) { const s = document.createElement("span"); s.style.animationDuration = (0.8 + (i % 5) * 0.18) + "s"; s.style.animationDelay = (i * 0.06) + "s"; eq.appendChild(s); } }

  $("#lang").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; $("#lang").querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); state.lang = b.dataset.v; });
  $("#model").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; $("#model").querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); state.model = b.dataset.v; });
  $("#fmts").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.classList.contains("on") && state.formats.size === 1) return;
    b.classList.toggle("on");
    b.classList.contains("on") ? state.formats.add(b.dataset.f) : state.formats.delete(b.dataset.f);
  });
  const ct = $("#cleanToggle");
  ct.addEventListener("click", () => { state.clean = !state.clean; ct.classList.toggle("on", state.clean); ct.setAttribute("aria-checked", String(state.clean)); });
  $("#glossary").addEventListener("input", (e) => { state.glossary = e.target.value.trim(); });

  const drop = $("#drop"), input = $("#file");
  drop.onclick = () => input.click();
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.onchange = () => { [...input.files].forEach(addFile); input.value = ""; };
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
  drop.addEventListener("drop", (e) => [...e.dataTransfer.files].forEach(addFile));
}

function initKey() {
  const modal = $("#keyModal"), chip = $("#keyBtn");
  const refresh = () => {
    chip.classList.toggle("ok", !!state.key);
    chip.classList.toggle("no", !state.key);
    $("#keyState").textContent = state.key ? (state.stored ? "Key aktiv" : "Key (Sitzung)") : "Key fehlt";
  };
  const close = () => { modal.hidden = true; modal.style.display = "none"; };
  const open = () => { $("#keyInput").value = state.key; modal.hidden = false; modal.style.display = "flex"; };
  chip.onclick = open;
  $("#keySave").onclick = () => {
    state.key = ($("#keyInput").value || "").trim();
    close();
    state.stored = state.key ? lsSet("groq_key", state.key) : (lsDel("groq_key"), true);
    refresh(); pump();
  };
  $("#keyClear").onclick = () => { state.key = ""; lsDel("groq_key"); $("#keyInput").value = ""; state.stored = true; refresh(); };
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  refresh();
  if (!state.key) open();
}

initControls();
initKey();
updateStats();
