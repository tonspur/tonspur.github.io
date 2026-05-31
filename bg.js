// Calm flowing "veins" + occasional signal impulses.
// The veins drift slowly. Now and then a single bright impulse glides along ONE vein
// like a signal — a clean comet head with a soft trailing glow. Sparse and elegant,
// a touch livelier while a job runs. Honors prefers-reduced-motion.

(() => {
  const canvas = document.getElementById("bg");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rnd = (a, b) => a + Math.random() * (b - a);

  let W = 0, H = 0;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  function resize() {
    W = canvas.width = innerWidth * dpr;
    H = canvas.height = innerHeight * dpr;
    canvas.style.width = innerWidth + "px";
    canvas.style.height = innerHeight + "px";
  }
  resize();
  addEventListener("resize", resize);

  window.__pulse = window.__pulse || 0;
  let energy = 0;

  const LINES = 6;
  const veins = Array.from({ length: LINES }, (_, i) => ({
    yBase: 0.16 + (i / (LINES - 1)) * 0.68,
    amp: 0.016 + Math.sin(i * 1.7) * 0.010 + 0.018,
    freq: 1.0 + (i % 3) * 0.45,
    speed: 0.05 + (i % 4) * 0.018,
    phase: i * 0.9,
    hue: i % 2 ? 262 : 250,
    width: 1 + (i % 3) * 0.5,
    alpha: 0.07 + (i % 3) * 0.03,
  }));

  function veinY(v, nx, t) {
    const y0 = v.yBase * H;
    const amp = v.amp * H * (1 + energy * 1.2);
    const sp = v.speed * (1 + energy * 1.6);
    return y0 +
      Math.sin(nx * Math.PI * 2 * v.freq + t * sp + v.phase) * amp +
      Math.sin(nx * Math.PI * 2 * (v.freq * 1.9) + t * sp * 0.6) * amp * 0.32;
  }

  function drawVein(v, t) {
    ctx.beginPath();
    const step = 16 * dpr;
    for (let x = -step; x <= W + step; x += step) {
      const nx = x / W, y = veinY(v, nx, t);
      x === -step ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, `hsla(${v.hue},90%,55%,0)`);
    g.addColorStop(0.5, `hsla(${v.hue},92%,60%,${v.alpha + energy * 0.05})`);
    g.addColorStop(1, `hsla(${v.hue},90%,55%,0)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = v.width * dpr;
    ctx.shadowBlur = (7 + energy * 8) * dpr;
    ctx.shadowColor = `hsla(${v.hue},92%,55%,.35)`;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // ---- sparse signal impulses (global pool) ----
  const impulses = [];
  let nextSpawn = 1.5;

  function spawn() {
    const v = veins[Math.floor(Math.random() * veins.length)];
    const dir = Math.random() < 0.5 ? 1 : -1;
    impulses.push({ v, dir, pos: dir === 1 ? -0.05 : 1.05, speed: rnd(0.11, 0.18) });
  }

  function drawImpulse(p, t) {
    const nx = p.pos;
    const x = nx * W, y = veinY(p.v, nx, t);
    // edge fade so it appears/disappears softly
    const edge = Math.min(1, nx / 0.12, (1 - nx) / 0.12);
    const a = Math.max(0, Math.min(1, edge));
    if (a <= 0) return;

    // soft trailing glow behind the head
    ctx.beginPath();
    const span = 0.10;
    for (let k = 0; k <= 14; k++) {
      const sx = nx - p.dir * span * (k / 14);
      ctx.lineTo(sx * W, veinY(p.v, sx, t));
    }
    const tg = ctx.createLinearGradient(x, 0, (nx - p.dir * span) * W, 0);
    tg.addColorStop(0, `hsla(275,100%,85%,${0.55 * a})`);
    tg.addColorStop(1, `hsla(265,100%,70%,0)`);
    ctx.strokeStyle = tg;
    ctx.lineWidth = (p.v.width + 0.8) * dpr;
    ctx.shadowBlur = 10 * dpr;
    ctx.shadowColor = "hsla(270,100%,72%,.7)";
    ctx.stroke();

    // comet head
    const r = 6 * dpr;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `hsla(280,100%,95%,${0.95 * a})`);
    rg.addColorStop(0.5, `hsla(268,100%,80%,${0.5 * a})`);
    rg.addColorStop(1, `hsla(262,100%,65%,0)`);
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function frame(now) {
    const t = now / 1000;
    energy += ((window.__pulse || 0) - energy) * 0.04;
    ctx.clearRect(0, 0, W, H);

    for (const v of veins) drawVein(v, t);

    // spawn rarely: idle ~5–8s, working ~2–3s; cap 1 idle / 3 working
    const cap = energy > 0.4 ? 3 : 1;
    nextSpawn -= 1 / 60;
    if (nextSpawn <= 0 && impulses.length < cap) {
      spawn();
      nextSpawn = energy > 0.4 ? rnd(2, 3) : rnd(5, 8);
    }
    ctx.globalCompositeOperation = "lighter";
    for (let i = impulses.length - 1; i >= 0; i--) {
      const p = impulses[i];
      p.pos += p.dir * p.speed * (1 / 60);
      drawImpulse(p, t);
      if (p.pos < -0.08 || p.pos > 1.08) impulses.splice(i, 1);
    }
    ctx.globalCompositeOperation = "source-over";

    if (!reduce) requestAnimationFrame(frame);
  }

  if (reduce) { energy = 0.1; frame(0); }
  else requestAnimationFrame(frame);
})();
