// TONSPUR app wiring: state, transcribe pool, history, rendering, cost panel, auth UI.
import { FFmpegSlot, groqTranscribe, cleanupAll, retry429, mergeSegments, buildTxt, buildSrt, buildVtt, buildJson, tc } from "./engine.js?v=19";
import { estimate, estimateTime, fmtMoney, fmtDur, recordRun, getUsage, usdToEur, getSpendUsd, addSpend, resetSpend } from "./cost.js?v=19";
import * as auth from "./auth.js?v=19";
import * as history from "./history.js?v=19";

const $ = (s) => document.querySelector(s);
const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PREFS_KEY = "tonspur_prefs";
const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; } })();

const state = {
  mode: "transcribe",      // transcribe | history | calc
  lang: prefs.lang || "en",
  model: prefs.model || "whisper-large-v3",
  formats: new Set(prefs.formats?.length ? prefs.formats : ["txt", "srt"]),
  clean: prefs.clean !== undefined ? prefs.clean : true,
  glossary: "",
  concurrency: prefs.concurrency || 1,
  billing: prefs.billing === "paid" ? "paid" : "free",   // free (rate-limited, 0 €) | paid (full speed, costs)
  budgetEur: prefs.budgetEur > 0 ? prefs.budgetEur : 8,  // local budget guard for paid mode
  key: lsGet("groq_key"), keyStored: true,
  account: null,          // { email } when signed in
};
const savePrefs = () => lsSet(PREFS_KEY, JSON.stringify({ lang: state.lang, model: state.model, formats: [...state.formats], clean: state.clean, concurrency: state.concurrency, billing: state.billing, budgetEur: state.budgetEur }));
const effConc = () => state.concurrency;

const queue = [];
let jobSeq = 0, active = 0;
const idleSlots = [];
const acquireSlot = () => idleSlots.pop() || new FFmpegSlot();
const releaseSlot = (s) => { if (idleSlots.length < state.concurrency) idleSlots.push(s); };

/* ---------------- runner pool ---------------- */
function updatePulse() { window.__pulse = active > 0 ? 0.9 : 0.15; }
function pump() {
  while (active < effConc()) {
    const job = queue.find((j) => j.status === "queued");
    if (!job) break;
    job.status = "run"; active++;
    runJob(job).finally(() => { active--; updatePulse(); pump(); });
  }
  updatePulse();
}

async function runJob(job) {
  const slot = acquireSlot();
  job.ui.startTimer();
  try {
    if (!state.key) throw new Error("Kein Groq-Key. Oben rechts auf 🔑 (oder anmelden).");
    job.ui.setState("run");
    job.ui.phase("ffmpeg lädt …", 0.03);

    const { duration, chunks } = await slot.extract(job.file, (p) =>
      job.ui.phase(`Tonspur extrahieren … ${Math.round(p * 100)}%`, 0.05 + 0.25 * p));
    job.duration = duration;

    // Paid-mode budget guard: block BEFORE any Groq call (no charge yet) if it would exceed the cap.
    if (state.billing === "paid") {
      const estUsd = estimate(duration, state.model, job.clean).total;
      if (usdToEur(getSpendUsd() + estUsd) > state.budgetEur + 1e-9) {
        const e = new Error(`Budget-Limit (${state.budgetEur} €) würde überschritten — Job nicht gestartet. Limit im Rechner erhöhen oder Datei kürzen.`);
        e.budget = true; throw e;
      }
    }

    // Persist a "running" record now → survives a refresh/crash (shows up as interrupted with partial text).
    await putHist(job, [], null, "running", 0.3);

    // Transient Groq failures (429 / 5xx / timeout): count down + retry, don't fail.
    const waitFn = (label) => async (sec, attempt, reason) => {
      const why = reason === "server" ? "Groq überlastet / Aussetzer" : "wartet auf Gratis-Kontingent";
      for (let left = sec; left > 0; left--) { job.ui.phase(`${label} · ${why} — neuer Versuch in ${left}s …`); await sleep(1000); }
    };

    let requests = 0, prevTail = "";
    const segs = [];
    for (let i = 0; i < chunks.length; i++) {
      const label = chunks.length > 1 ? `Transkribieren … Stück ${i + 1}/${chunks.length}` : "Transkribieren …";
      const prog = 0.35 + 0.5 * (i / chunks.length);
      job.ui.phase(label, prog);
      const prompt = (job.glossary + " " + prevTail).trim();   // glossary + tail of prev chunk → continuity
      const { segments } = await retry429(
        () => groqTranscribe({ blob: chunks[i].blob, key: state.key, model: state.model, lang: job.lang, prompt }),
        waitFn(label));
      requests++;
      for (const s of segments) segs.push({ start: s.start + chunks[i].offset, end: s.end + chunks[i].offset, text: s.text });
      if (segments.length) prevTail = segments.map((s) => s.text).join(" ").slice(-200);
      await putHist(job, mergeSegments(segs), null, "running", prog);   // checkpoint after each chunk
    }
    const merged = mergeSegments(segs);   // stitch timeline + drop overlap duplicates
    if (!merged.length) throw new Error("Keine Sprache erkannt.");
    job.segs = merged;

    job.cleanText = null;
    if (job.clean) {
      try {
        const raw = merged.map((s) => s.text).join(" ");
        job.ui.phase("KI-Aufräumen …", 0.9);
        job.cleanText = await cleanupAll(raw, job.lang, state.key,
          (p) => job.ui.phase(`KI-Aufräumen … ${Math.round(p * 100)}%`, 0.9 + 0.09 * p),
          waitFn("KI-Aufräumen"));
        requests += Math.max(1, Math.ceil(raw.length / 6000));
      } catch { job.cleanText = null; }
    }
    // record local usage (Groq doesn't expose live quota to the browser)
    const jobUsd = estimate(job.duration, state.model, !!job.cleanText).total;
    recordRun({ requests, seconds: job.duration, usd: jobUsd });
    if (state.billing === "paid") addSpend(jobUsd);   // cumulative spend for the budget meter
    renderUsage();

    job.ui.phase("Fertig", 1);
    job.ui.stopTimer();
    job.ui.setState("done");
    job.ui.renderResult(job);
    await putHist(job, merged, job.cleanText, "done", 1, true);   // finalize (+prune)
    toast(`„${truncName(job.file?.name)}" fertig transkribiert`, "ok");
    updateStats();
  } catch (e) {
    job.status = "error";
    job.ui.stopTimer();
    job.ui.setState("err");
    const msg = e.status === 429
      ? "Groq Free-Tier Stundenlimit (7.200 s Audio/h) erreicht — später erneut oder weniger / kürzere Dateien gleichzeitig."
      : (e.status >= 500
        ? `Groq-Server antwortet mehrfach mit einem Fehler (${e.status}) — meist nur ein kurzer Aussetzer. Bitte in 1–2 Minuten erneut versuchen.`
        : (e.message || String(e)));
    job.ui.error(msg);
    if (e.budget) {
      toast(`Budget-Limit (${state.budgetEur} €) erreicht — nicht gestartet`, "err");
      try { await history.deleteTranscript(job.histId); } catch {}   // no junk entry for a blocked job
    } else {
      // keep whatever was transcribed so far (don't lose partial work)
      try { await putHist(job, mergeSegments(job._segs || []), null, "error", job._prog || 0); } catch {}
      toast("Transkription fehlgeschlagen", "err");
    }
  } finally {
    releaseSlot(slot);
  }
}

const truncName = (n) => !n ? "Datei" : (n.length > 36 ? n.slice(0, 33) + "…" : n);
// One history record per job (stable id) — written repeatedly as the job progresses.
async function putHist(job, segs, cleanText, status, progress, finalize) {
  job.histId = job.histId || ("t" + Date.now() + "_" + job.id);
  job.dateMs = job.dateMs || Date.now();
  job._segs = segs; job._prog = progress;   // remembered for the error path
  const rec = {
    id: job.histId, name: job.file?.name || "transkript", dateMs: job.dateMs,
    lang: job.lang, model: state.model, duration: job.duration || 0,
    segCount: segs.length, segs, cleanText: cleanText || null, status, progress,
  };
  try { await (finalize ? history.saveTranscript(rec) : history.putTranscript(rec)); }
  catch (e) { console.warn("history write failed", e); }
}

/* ---------------- job UI ---------------- */
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
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
    <div class="timing"></div>
    <div class="body"></div>`;
  el.querySelector(".nm").textContent = job.file ? job.file.name : job.name;
  $("#jobs").prepend(el);
  requestAnimationFrame(() => el.classList.add("in"));
  const q = (s) => el.querySelector(s);
  let cur = 0, startMs = 0, timer = 0;
  const renderTiming = () => {
    if (!startMs) return;
    const el2 = q(".timing");
    const elapsed = (Date.now() - startMs) / 1000;
    let txt = `⏱ ${fmtDur(elapsed)}`;
    if (cur > 0.04 && cur < 0.99) txt += ` · noch ca. ${fmtDur(elapsed * (1 - cur) / cur)}`;
    el2.textContent = txt;
  };
  return {
    startTimer() { startMs = Date.now(); clearInterval(timer); timer = setInterval(renderTiming, 1000); renderTiming(); },
    stopTimer() { clearInterval(timer); timer = 0; if (startMs) q(".timing").textContent = `⏱ ${fmtDur((Date.now() - startMs) / 1000)} gesamt`; },
    setState(kind) {
      const m = { run: ["run", "in Arbeit"], done: ["done", "fertig"], err: ["err", "Fehler"] };
      const st = q(".state"); st.className = "state " + m[kind][0]; st.textContent = m[kind][1];
    },
    phase(txt, pct) {
      q(".phase").textContent = txt;
      if (pct != null) { cur = pct; const r = q(".ring"); r.style.setProperty("--p", Math.round(pct * 100)); r.querySelector("b").textContent = Math.round(pct * 100) + "%"; renderTiming(); }
    },
    error(msg) { q(".phase").style.display = "none"; q(".timing").style.display = "none"; q(".ring-wrap").style.display = "none"; q(".body").innerHTML = `<div class="errbox">${esc(msg)}</div>`; },
    renderResult(j) {
      const rec = { name: j.file?.name || "transkript", lang: j.lang, model: state.model, duration: j.duration, segs: j.segs, cleanText: j.cleanText };
      const { dls, preview } = buildOutputs(rec);
      q(".phase").textContent = `${rec.model} · ${Math.round(j.duration / 60)} min · ${j.segs.length} Segmente${j.cleanText ? " · ✨ veredelt" : ""}`;
      q(".body").innerHTML = `<div class="dls">${dls}<button class="read-btn" type="button">📖 Lesen</button></div><div class="preview">${esc(preview.slice(0, 1200))}${preview.length > 1200 ? " …" : ""}</div>`;
      q(".read-btn").onclick = () => openReader(rec);
    },
  };
}

// Build download links + preview text for a transcript record { name, lang, model, duration, segs, cleanText }.
function buildOutputs(rec, fmtsSet) {
  const meta = { model: rec.model, lang: rec.lang, duration: rec.duration, segments: rec.segs.length, clean: !!rec.cleanText };
  const outs = {
    txt: { l: "TXT", d: buildTxt(rec.segs, rec.cleanText, meta), t: "text/plain" },
    srt: { l: "SRT", d: buildSrt(rec.segs), t: "application/x-subrip" },
    vtt: { l: "VTT", d: buildVtt(rec.segs), t: "text/vtt" },
    json: { l: "JSON", d: buildJson(rec.segs, meta), t: "application/json" },
  };
  const base = rec.name.replace(/\.[^.]+$/, "").slice(0, 60) || "transkript";
  const fmts = fmtsSet ? [...fmtsSet] : ["txt", "srt", "vtt", "json"];
  const dls = fmts.map((f) => { const o = outs[f]; const url = URL.createObjectURL(new Blob([o.d], { type: o.t })); return `<a href="${url}" download="${esc(base)}.${f}">⬇ ${o.l}</a>`; }).join("");
  const preview = rec.cleanText || (outs.txt.d.split("---\n\n")[1] || outs.txt.d);
  return { dls, preview, base };
}
function updateStats() {
  const q = $("#qcount"); if (q) q.textContent = queue.length;
  document.body.classList.toggle("has-many", queue.length > 1);
}
function addFile(file) {
  const job = { id: ++jobSeq, file, lang: state.lang, clean: state.clean, glossary: state.glossary, status: "queued", segs: [], duration: 0 };
  job.ui = jobUI(job);
  queue.push(job);
  updateStats(); pump();
}

/* ---------------- cost panel ---------------- */
function renderUsage() {
  const u = getUsage();
  const usedMin = Math.round((u.secondsThisHour || 0) / 60);
  const limitMin = Math.round(u.hourLimitSec / 60); // 120 (= 7200 s)
  $("#quotaVal").textContent = `${usedMin} / ${limitMin} min`;
  const dayMin = Math.round(u.seconds / 60);
  $("#quotaSub").textContent = u.requests
    ? `Tag: ${u.requests} / ${u.reqLimit} Anfragen · ~${dayMin} min Audio · ≈ ${fmtMoney(u.usd)} (auf diesem Gerät)`
    : `Tag: 0 / ${u.reqLimit} Anfragen — heute noch nichts verarbeitet`;
  const note = $("#quotaNote");
  if (note) note.textContent = "Groq Free-Tier limitiert Audio pro Stunde (~2 h/Std), nicht pro Tag. Große Stapel drosselt der Runner automatisch — er wartet und versucht erneut.";
}
function renderCalc() {
  const min = Math.max(0, parseFloat($("#calcMin").value) || 0);
  const sec = min * 60;
  const paid = state.billing === "paid";
  const c = estimate(sec, state.model, state.clean);
  $("#calcCost").textContent = paid ? (min ? fmtMoney(c.total) : "—") : "0 €";
  const sub = $("#calcCostSub");
  if (sub) sub.textContent = paid ? "Bezahlt-Modus · echte Schätzung (large-v3 + Veredelung)" : "Gratis-Modus — du zahlst nichts (dafür rate-limitiert).";
  const dur = $("#calcDur"); if (dur) dur.textContent = min ? `ca. ${fmtDur(estimateTime(sec, state.clean).lowSec)}–${fmtDur(estimateTime(sec, state.clean).highSec)}` : "—";
  renderBudget();
}
function renderBudget() {
  const spentEur = usdToEur(getSpendUsd());
  const cap = state.budgetEur || 0;
  const sp = $("#budgetSpent"); if (sp) sp.textContent = `${spentEur.toFixed(2)} € / ${cap} €`;
  const bar = $("#budgetBar"); if (bar) bar.style.width = (cap > 0 ? Math.min(100, spentEur / cap * 100) : 0).toFixed(1) + "%";
  const over = cap > 0 && spentEur >= cap;
  if (bar) bar.classList.toggle("full", over);
}

/* ---------------- key handling ---------------- */
function refreshKeyChip() {
  const chip = $("#keyBtn");
  chip.classList.toggle("ok", !!state.key);
  chip.classList.toggle("no", !state.key);
  $("#keyState").textContent = state.key ? (state.keyStored ? "Key aktiv" : "Key (Sitzung)") : "Key fehlt";
}
async function setKey(k, { persistLocal = true, syncProfile = false } = {}) {
  state.key = (k || "").trim();
  if (persistLocal) state.keyStored = state.key ? lsSet("groq_key", state.key) : (lsDel("groq_key"), true);
  if (syncProfile && state.account) { try { await auth.saveKey(state.key); } catch (e) { console.warn("profile save failed", e); } }
  refreshKeyChip(); pump();
}

let openKeyModal = () => {};
function initKeyModal() {
  const modal = $("#keyModal");
  const close = () => { modal.hidden = true; modal.style.display = "none"; };
  const open = () => { $("#keyInput").value = state.key; modal.hidden = false; modal.style.display = "flex"; };
  openKeyModal = open;
  $("#keyBtn").onclick = open;
  $("#keySave").onclick = async () => { const v = $("#keyInput").value; close(); await setKey(v, { persistLocal: true, syncProfile: true }); };
  $("#keyClear").onclick = async () => { $("#keyInput").value = ""; await setKey("", { persistLocal: true, syncProfile: true }); };
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  refreshKeyChip();
}

/* ---------------- controls wiring ---------------- */
function initControls() {
  const eq = $("#eq");
  for (let i = 0; i < 18; i++) { const s = document.createElement("span"); s.style.animationDuration = (0.8 + (i % 5) * 0.18) + "s"; s.style.animationDelay = (i * 0.06) + "s"; eq.appendChild(s); }

  // reflect a saved value onto a segmented control's buttons
  const applySeg = (id, val) => $(id)?.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === String(val)));
  const seg = (id, set) => $(id).addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; $(id).querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); set(b.dataset.v); savePrefs(); });
  seg("#lang", (v) => state.lang = v);
  seg("#model", (v) => { state.model = v; renderCalc(); });
  seg("#conc", (v) => { state.concurrency = +v; pump(); });
  seg("#billing", (v) => { state.billing = v; document.body.classList.toggle("paid", v === "paid"); renderCalc(); });
  applySeg("#lang", state.lang); applySeg("#model", state.model); applySeg("#conc", state.concurrency); applySeg("#billing", state.billing);
  document.body.classList.toggle("paid", state.billing === "paid");

  const budgetInput = $("#budgetEur");
  if (budgetInput) { budgetInput.value = state.budgetEur; budgetInput.addEventListener("input", () => { state.budgetEur = Math.max(0, parseFloat(budgetInput.value) || 0); renderBudget(); savePrefs(); }); }
  const budgetReset = $("#budgetReset");
  if (budgetReset) budgetReset.onclick = () => { resetSpend(); renderBudget(); toast("Verbrauch zurückgesetzt", "ok"); };

  const ct = $("#cleanToggle");
  const applyClean = () => { ct.classList.toggle("on", state.clean); ct.setAttribute("aria-checked", String(state.clean)); };
  applyClean();
  ct.addEventListener("click", () => { state.clean = !state.clean; applyClean(); renderCalc(); savePrefs(); });
  $("#glossary").addEventListener("input", (e) => state.glossary = e.target.value.trim());
  $("#calcMin").addEventListener("input", renderCalc);
  renderCalc();

  const drop = $("#drop"), input = $("#file");
  drop.onclick = () => input.click();
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.onchange = () => { confirmFiles([...input.files]); input.value = ""; };
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
  drop.addEventListener("drop", (e) => confirmFiles([...e.dataTransfer.files]));
}

/* ---------------- start confirmation (always confirm before transcribing) ---------------- */
let pendingFiles = [];
const fmtSize = (b) => b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? Math.round(b / 1e6) + " MB" : Math.round(b / 1e3) + " KB";
function confirmFiles(files) {
  files = (files || []).filter((f) => f && f.size);
  if (!files.length) return;
  pendingFiles = files;
  $("#startTitle").textContent = files.length > 1 ? `${files.length} Dateien transkribieren?` : "Transkription starten?";
  $("#startList").innerHTML = files.map((f) => `<li><span class="sf-nm">${esc(f.name)}</span><span class="sf-sz">${fmtSize(f.size)}</span></li>`).join("");
  const modelTxt = state.model.includes("turbo") ? "turbo" : "large-v3";
  const parts = [`Sprache ${state.lang.toUpperCase()}`, `Modell ${modelTxt}`, `Veredelung ${state.clean ? "ein" : "aus"}`, "alle Formate"];
  if (files.length > 1) parts.push(`Parallel ${state.concurrency}`);
  $("#startSummary").textContent = parts.join("  ·  ");
  const m = $("#startModal"); m.hidden = false; m.style.display = "flex";
}
function initStartModal() {
  const modal = $("#startModal");
  const close = () => { pendingFiles = []; modal.hidden = true; modal.style.display = "none"; };
  $("#startCancel").onclick = close;
  $("#startGo").onclick = () => { const fs = pendingFiles; pendingFiles = []; modal.hidden = true; modal.style.display = "none"; fs.forEach(addFile); };
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
}

/* ---------------- auth gate (login required) ---------------- */
function initAuthUI() {
  const acct = $("#acctBtn");
  const unlockModal = $("#unlockModal");
  const mark = $("#gateMark");
  const bars = mark ? [...mark.querySelectorAll("span")] : [];
  const rest = [0.45, 0.7, 1, 0.7, 0.45];
  bars.forEach((b, i) => b.style.setProperty("--h", rest[i] ?? 0.6));
  let settleT = 0;
  let mode = "login";

  const renderAcct = () => {
    acct.textContent = state.account ? `👤 ${state.account.email.split("@")[0]}` : "Anmelden";
    acct.classList.toggle("ok", !!state.account);
  };
  const ungate = () => document.body.classList.remove("gated");
  const showGate = () => { document.body.classList.add("gated"); setTimeout(() => $("#gEmail").focus?.(), 50); };

  const setMode = (m) => {
    mode = m;
    $("#gateTitle").textContent = m === "login" ? "Im Studio anmelden" : "Konto erstellen";
    $("#gSubmit").textContent = m === "login" ? "Anmelden" : "Konto erstellen";
    $("#gToggle").textContent = m === "login" ? "Konto erstellen" : "Anmelden";
    const foot = $(".gate-foot"); if (foot.firstChild) foot.firstChild.textContent = m === "login" ? "Noch kein Konto? " : "Schon ein Konto? ";
    $("#gPass").autocomplete = m === "login" ? "current-password" : "new-password";
    $("#gErr").textContent = "";
  };

  // TONSPUR mark reacts to EVERY keystroke (Web Animations API → always replays)
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pop = () => {
    if (reduce || !mark) return;
    mark.animate(
      [{ transform: "translateY(0) scale(1)" }, { transform: "translateY(-7px) scale(1.07)" }, { transform: "translateY(0) scale(1)" }],
      { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
    bars.forEach((b) => b.style.setProperty("--h", (0.28 + Math.random() * 0.72).toFixed(2)));
    clearTimeout(settleT);
    settleT = setTimeout(() => bars.forEach((b, i) => b.style.setProperty("--h", rest[i] ?? 0.6)), 520);
  };
  $("#gEmail").addEventListener("keydown", pop);
  $("#gPass").addEventListener("keydown", pop);

  $("#gToggle").onclick = () => setMode(mode === "login" ? "signup" : "login");
  $("#gForgot").onclick = async () => {
    const email = $("#gEmail").value.trim();
    if (!email) { $("#gErr").textContent = "Bitte zuerst deine E-Mail eingeben."; return; }
    try { await auth.resetPassword(email); $("#gNote").textContent = "Falls ein Konto existiert, kommt eine E-Mail zum Zurücksetzen."; }
    catch (ex) { $("#gErr").textContent = ex.message; }
  };

  $("#gateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#gEmail").value.trim(), pass = $("#gPass").value;
    const err = $("#gErr"); err.textContent = ""; $("#gNote").textContent = "";
    if (!email || pass.length < 8) { err.textContent = "E-Mail eingeben und Passwort ≥ 8 Zeichen."; return; }
    const btn = $("#gSubmit"); const lbl = btn.textContent; btn.disabled = true; btn.textContent = "…";
    try {
      if (mode === "signup") {
        const d = await auth.signUp(email, pass);
        if (!d.session) { $("#gNote").textContent = "Fast fertig — bitte bestätige die E-Mail, dann melde dich an."; setMode("login"); return; }
      } else {
        await auth.signIn(email, pass);
      }
      const res = await auth.unlock(pass);
      state.account = { email }; renderAcct(); ungate();
      if (res.groqKey) await setKey(res.groqKey, { persistLocal: false });
      else if (!state.key) openKeyModal();   // need a Groq key (badPassword or first time)
    } catch (ex) { err.textContent = ex.message || "Anmeldung fehlgeschlagen."; }
    finally { btn.disabled = false; btn.textContent = lbl; }
  });

  // unlock modal (same-device cache-miss)
  const closeUnlock = () => { unlockModal.hidden = true; unlockModal.style.display = "none"; };
  $("#unlockCancel").onclick = () => { closeUnlock(); openKeyModal(); };
  $("#unlockSubmit").onclick = async () => {
    const pass = $("#unlockPass").value; const err = $("#unlockErr"); err.textContent = "";
    try { const res = await auth.unlock(pass); if (res.groqKey) { await setKey(res.groqKey, { persistLocal: false }); closeUnlock(); } else if (res.badPassword) err.textContent = "Falsches Passwort."; else { closeUnlock(); openKeyModal(); } }
    catch (ex) { err.textContent = ex.message; }
  };

  acct.onclick = async () => {
    if (state.account) { if (confirm(`Abmelden (${state.account.email})?`)) { await auth.signOut(); state.account = null; await setKey("", { persistLocal: true }); renderAcct(); showGate(); } }
  };

  setMode("login"); renderAcct();

  // boot: restore session or require login
  if (auth.authEnabled()) {
    auth.loadFromCache().then((r) => {
      if (r.signedIn) {
        state.account = { email: r.email }; renderAcct(); ungate();
        if (r.groqKey) setKey(r.groqKey, { persistLocal: false });
        else if (r.needsPassword) { unlockModal.hidden = false; unlockModal.style.display = "flex"; }
        else openKeyModal();
      } else showGate();
    }).catch(() => showGate());
    auth.onChange((session) => { state.account = session ? { email: session.user.email } : null; renderAcct(); });
  } else {
    ungate(); // no cloud config → open (local-key mode)
  }
}

/* ---------------- modes / views ---------------- */
function setMode(m) {
  state.mode = m;
  ["transcribe", "history", "calc"].forEach((x) => document.body.classList.toggle("mode-" + x, x === m));
  $("#modeSwitch").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
  if (m === "calc") { renderCalc(); renderUsage(); }
  else if (m === "history") renderHistory();
  else pump();
}
function initModes() {
  $("#modeSwitch").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setMode(b.dataset.m); });
}

/* ---------------- history view ---------------- */
const fmtDate = (ms) => { try { return new Date(ms).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
async function renderHistory() {
  const wrap = $("#historyList"); if (!wrap) return;
  let items = [];
  try { items = await history.listTranscripts(); } catch (e) { console.warn(e); }
  const clearBtn = $("#histClear"); if (clearBtn) clearBtn.style.display = items.length ? "" : "none";
  if (!items.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-mark">📂</div><h3>Noch keine Transkripte</h3><p>Transkribiere eine Datei — sie landet automatisch hier, lokal auf diesem Gerät.</p></div>`;
    return;
  }
  const badge = (st) => st === "incomplete" ? `<span class="hbadge warn">unterbrochen</span>`
    : st === "error" ? `<span class="hbadge err">Fehler</span>`
    : st === "running" ? `<span class="hbadge warn">läuft …</span>` : "";
  wrap.innerHTML = items.map((it) => `
    <article class="hcard" data-id="${esc(it.id)}">
      <div class="hc-main">
        <div class="hc-nm">${esc(it.name)} ${badge(it.status)}</div>
        <div class="hc-meta">${fmtDate(it.dateMs)} · ${Math.round((it.duration || 0) / 60)} min · ${it.lang.toUpperCase()} · ${it.model.includes("turbo") ? "turbo" : "large-v3"} · ${it.segCount || 0} Segmente${it.cleanText ? " · ✨" : ""}${it.status === "incomplete" ? " · Teil-Transkript" : ""}</div>
      </div>
      <div class="hc-actions">
        <button class="hc-open" type="button"${it.segCount ? "" : " disabled"}>Öffnen</button>
        <button class="hc-del" type="button" aria-label="Löschen" title="Löschen">✕</button>
      </div>
    </article>`).join("");
  wrap.querySelectorAll(".hcard").forEach((card) => {
    const id = card.dataset.id;
    const open = card.querySelector(".hc-open");
    if (!open.disabled) open.onclick = async () => { const r = await history.getTranscript(id); if (r) openReader(r); };
    card.querySelector(".hc-del").onclick = async () => { await history.deleteTranscript(id); renderHistory(); toast("Transkript gelöscht", "ok"); };
  });
}
function initHistory() {
  const clearBtn = $("#histClear");
  if (clearBtn) clearBtn.onclick = async () => { if (confirm("Alle lokalen Transkripte löschen?")) { await history.clearAll(); renderHistory(); toast("Verlauf geleert", "ok"); } };
}

/* ---------------- reading mode ---------------- */
let readerRec = null;
function renderReadBody(text, query) {
  const body = $("#readBody");
  const q = (query || "").trim();
  const re = q ? new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi") : null;
  const hl = (s) => { const e = esc(s); return re ? e.replace(re, "<mark>$1</mark>") : e; };
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  body.innerHTML = paras.length ? paras.map((p) => `<p>${hl(p)}</p>`).join("") : `<p class="muted">—</p>`;
  if (re) { const first = body.querySelector("mark"); if (first) first.scrollIntoView({ block: "center", behavior: "smooth" }); }
}
function updateReader() {
  if (!readerRec) return;
  const ts = $("#readTs")?.checked;
  const text = ts
    ? readerRec.segs.map((s) => `[${tc(s.start, ".").slice(0, 8)}]  ${s.text}`).join("\n\n")
    : (readerRec.cleanText || readerRec.segs.map((s) => s.text).join(" "));
  renderReadBody(text, $("#readSearch")?.value);
}
function openReader(rec) {
  readerRec = rec;
  const { dls } = buildOutputs(rec);
  $("#readTitle").textContent = rec.name;
  $("#readMeta").textContent = `${Math.round(rec.duration / 60)} min · ${rec.lang.toUpperCase()} · ${rec.model.includes("turbo") ? "turbo" : "large-v3"} · ${rec.segs.length} Segmente${rec.cleanText ? " · ✨ veredelt" : ""}`;
  $("#readDls").innerHTML = dls;
  if ($("#readSearch")) $("#readSearch").value = "";
  if ($("#readTs")) $("#readTs").checked = false;
  updateReader();
  const m = $("#readModal"); m.hidden = false; m.style.display = "flex";
  setTimeout(() => $("#readSearch")?.focus?.(), 60);
}
function initReadModal() {
  const modal = $("#readModal"); if (!modal) return;
  const close = () => { modal.hidden = true; modal.style.display = "none"; readerRec = null; };
  $("#readClose").onclick = close;
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
  $("#readSearch").addEventListener("input", updateReader);
  $("#readTs").addEventListener("change", updateReader);
  $("#readCopy").onclick = () => {
    const text = readerRec ? (readerRec.cleanText || readerRec.segs.map((s) => s.text).join(" ")) : "";
    navigator.clipboard.writeText(text); toast("Transkript kopiert", "ok");
  };
}

/* ---------------- toasts ---------------- */
function toast(msg, kind = "ok") {
  const wrap = $("#toasts"); if (!wrap) return;
  const t = document.createElement("div");
  t.className = "toast " + kind; t.textContent = msg;
  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 320); }, 3200);
}

/* ---------------- boot ---------------- */
// Warn before leaving while a job is running (refresh/close would lose the in-memory job).
addEventListener("beforeunload", (e) => { if (active > 0) { e.preventDefault(); e.returnValue = ""; return ""; } });
// Any record left "running" from a previous (refreshed/crashed) session → flag as interrupted.
history.markInterrupted().catch(() => {});

initControls();
initStartModal();
initKeyModal();
initReadModal();
initHistory();
initAuthUI();
initModes();
updateStats();
renderUsage();
