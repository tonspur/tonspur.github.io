// TONSPUR app wiring: state, parallel runner pool, rendering, cost panel, auth UI.
import { FFmpegSlot, groqTranscribe, cleanupAll, buildTxt, buildSrt, buildVtt, buildJson } from "./engine.js";
import { estimate, fmtMoney, recordRun, getUsage } from "./cost.js";
import * as auth from "./auth.js";

const $ = (s) => document.querySelector(s);
const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch {} };

const state = {
  mode: "single",          // single | runner | calc
  lang: "de", model: "whisper-large-v3", formats: new Set(["txt", "srt"]),
  clean: true, glossary: "", concurrency: 2,
  key: lsGet("groq_key"), keyStored: true,
  account: null,          // { email } when signed in
};
const effConc = () => (state.mode === "single" ? 1 : state.concurrency);

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
  try {
    if (!state.key) throw new Error("Kein Groq-Key. Oben rechts auf 🔑 (oder anmelden).");
    job.ui.setState("run");
    job.ui.phase("ffmpeg lädt …", 0.03);

    const { duration, chunks } = await slot.extract(job.file, (p) =>
      job.ui.phase(`Tonspur extrahieren … ${Math.round(p * 100)}%`, 0.05 + 0.25 * p));
    job.duration = duration;

    let requests = 0;
    const segs = [];
    for (let i = 0; i < chunks.length; i++) {
      job.ui.phase(`Transkribieren (Groq) … Stück ${i + 1}/${chunks.length}`, 0.35 + 0.5 * (i / chunks.length));
      const { segments } = await groqTranscribe({ blob: chunks[i].blob, key: state.key, model: state.model, lang: job.lang, glossary: job.glossary });
      requests++;
      for (const s of segments) segs.push({ start: s.start + chunks[i].offset, end: s.end + chunks[i].offset, text: s.text });
    }
    segs.sort((a, b) => a.start - b.start);
    if (!segs.length) throw new Error("Keine Sprache erkannt.");
    job.segs = segs;

    job.cleanText = null;
    if (job.clean && job.formats.has("txt")) {
      try {
        const raw = segs.map((s) => s.text).join(" ");
        job.ui.phase("KI-Aufräumen …", 0.9);
        job.cleanText = await cleanupAll(raw, job.lang, state.key, (p) => job.ui.phase(`KI-Aufräumen … ${Math.round(p * 100)}%`, 0.9 + 0.09 * p));
        requests += Math.max(1, Math.ceil(raw.length / 6000));
      } catch { job.cleanText = null; }
    }
    // record local daily usage (Groq doesn't expose live quota to the browser)
    recordRun({ requests, seconds: job.duration, usd: estimate(job.duration, state.model, !!job.cleanText).total });
    renderUsage();

    job.ui.phase("Fertig", 1);
    job.ui.setState("done");
    job.ui.renderResult(job);
    updateStats();
  } catch (e) {
    job.status = "error";
    job.ui.setState("err");
    job.ui.error(e.message || String(e));
  } finally {
    releaseSlot(slot);
  }
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
    <div class="body"></div>`;
  el.querySelector(".nm").textContent = job.file ? job.file.name : job.name;
  $("#jobs").prepend(el);
  const q = (s) => el.querySelector(s);
  return {
    setState(kind) {
      const m = { run: ["run", "in Arbeit"], done: ["done", "fertig"], err: ["err", "Fehler"] };
      const st = q(".state"); st.className = "state " + m[kind][0]; st.textContent = m[kind][1];
    },
    phase(txt, pct) {
      q(".phase").textContent = txt;
      if (pct != null) { const r = q(".ring"); r.style.setProperty("--p", Math.round(pct * 100)); r.querySelector("b").textContent = Math.round(pct * 100) + "%"; }
    },
    error(msg) { q(".phase").style.display = "none"; q(".ring-wrap").style.display = "none"; q(".body").innerHTML = `<div class="errbox">${esc(msg)}</div>`; },
    renderResult(j) {
      const meta = { model: state.model, lang: j.lang, duration: j.duration, segments: j.segs.length, clean: !!j.cleanText };
      const outs = {
        txt: { l: "TXT", d: buildTxt(j.segs, j.cleanText, meta), t: "text/plain" },
        srt: { l: "SRT", d: buildSrt(j.segs), t: "application/x-subrip" },
        vtt: { l: "VTT", d: buildVtt(j.segs), t: "text/vtt" },
        json: { l: "JSON", d: buildJson(j.segs, meta), t: "application/json" },
      };
      const base = (j.file ? j.file.name.replace(/\.[^.]+$/, "") : "transkript").slice(0, 60);
      const dls = [...j.formats].map((f) => { const o = outs[f]; const url = URL.createObjectURL(new Blob([o.d], { type: o.t })); return `<a href="${url}" download="${base}.${f}">⬇ ${o.l}</a>`; }).join("");
      const preview = j.cleanText || (outs.txt.d.split("---\n\n")[1] || outs.txt.d);
      q(".phase").textContent = `${meta.model} · ${Math.round(j.duration / 60)} min · ${j.segs.length} Segmente${j.cleanText ? " · ✨ veredelt" : ""}`;
      q(".body").innerHTML = `<div class="dls">${dls}</div><div class="preview"><span class="copy">kopieren</span>${esc(preview)}</div>`;
      q(".copy").onclick = () => { navigator.clipboard.writeText(preview); q(".copy").textContent = "kopiert ✓"; };
    },
  };
}
function updateStats() { const q = $("#qcount"); if (q) q.textContent = queue.length; renderCalc(); }
function addFile(file) {
  const job = { id: ++jobSeq, file, lang: state.lang, formats: new Set(state.formats), clean: state.clean, glossary: state.glossary, status: "queued", segs: [], duration: 0 };
  job.ui = jobUI(job);
  queue.push(job);
  updateStats(); pump();
}

/* ---------------- cost panel ---------------- */
function renderUsage() {
  const u = getUsage();
  $("#quotaVal").textContent = `${u.freeLeft} / ${u.freeLimit} frei`;
  const min = Math.round(u.seconds / 60);
  $("#quotaSub").textContent = u.requests
    ? `heute ${u.requests} Anfragen · ~${min} min Audio · ≈ ${fmtMoney(u.usd)} (auf diesem Gerät)`
    : `Groq Free-Tier: ~${u.freeLimit} Anfragen/Tag — reicht für sehr viele Transkripte`;
}
function renderCalc() {
  const min = Math.max(0, parseFloat($("#calcMin").value) || 0);
  const c = estimate(min * 60, state.model, state.clean);
  $("#calcCost").textContent = min ? fmtMoney(c.total) : "—";
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

  const seg = (id, set) => $(id).addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; $(id).querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); set(b.dataset.v); });
  seg("#lang", (v) => state.lang = v);
  seg("#model", (v) => { state.model = v; renderCalc(); });
  seg("#conc", (v) => { state.concurrency = +v; pump(); });

  $("#fmts").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (b.classList.contains("on") && state.formats.size === 1) return; b.classList.toggle("on"); b.classList.contains("on") ? state.formats.add(b.dataset.f) : state.formats.delete(b.dataset.f); });
  const ct = $("#cleanToggle");
  ct.addEventListener("click", () => { state.clean = !state.clean; ct.classList.toggle("on", state.clean); ct.setAttribute("aria-checked", String(state.clean)); renderCalc(); });
  $("#glossary").addEventListener("input", (e) => state.glossary = e.target.value.trim());
  $("#calcMin").addEventListener("input", renderCalc);
  renderCalc();

  const drop = $("#drop"), input = $("#file");
  drop.onclick = () => input.click();
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.onchange = () => { [...input.files].forEach(addFile); input.value = ""; };
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
  drop.addEventListener("drop", (e) => [...e.dataTransfer.files].forEach(addFile));
}

/* ---------------- auth gate (login required) ---------------- */
function initAuthUI() {
  const acct = $("#acctBtn");
  const unlockModal = $("#unlockModal");
  const crystal = $("#gateCrystal");
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

  // crystal reacts to every keystroke
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pop = () => { if (reduce) return; crystal.classList.remove("pop"); void crystal.offsetWidth; crystal.classList.add("pop"); };
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

/* ---------------- boot ---------------- */
function initModes() {
  const sw = $("#modeSwitch");
  sw.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    sw.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    state.mode = b.dataset.m;
    document.body.className = "mode-" + state.mode;
    if (state.mode === "calc") { renderCalc(); renderUsage(); }
    else pump();
  });
}

initControls();
initKeyModal();
initAuthUI();
initModes();
updateStats();
renderUsage();
