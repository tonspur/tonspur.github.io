// Flowing "veins" + LED signal pulses on canvas.
// Veins undulate slowly; bright lilac signal packets travel along them (fwd/back)
// and bloom where they pass — like signals being sent across a network.
// Motion intensifies while a job runs (window.__pulse). Honors prefers-reduced-motion.

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

  const LINES = 7;
  const veins = Array.from({ length: LINES }, (_, i) => ({
    yBase: 0.14 + (i / (LINES - 1)) * 0.72,
    amp: 0.018 + Math.sin(i * 1.7) * 0.012 + 0.02,
    freq: 1.1 + (i % 3) * 0.5,
    speed: 0.06 + (i % 4) * 0.02,
    phase: i * 0.9,
    hue: i % 2 ? 262 : 250,
    width: 1 + (i % 3) * 0.6,
    alpha: 0.10 + (i % 3) * 0.05,
    pulses: [],
    nextSpawn: rnd(0, 3),
  }));

  function veinY(v, nx, t) {
    const y0 = v.yBase * H;
    const amp = v.amp * H * (1 + energy * 1.5);
    const sp = v.speed * (1 + energy * 2.0);
    return y0 +
      Math.sin(nx * Math.PI * 2 * v.freq + t * sp + v.phase) * amp +
      Math.sin(nx * Math.PI * 2 * (v.freq * 1.9) + t * sp * 0.6) * amp * 0.35;
  }

  function drawVein(v, t, glow) {
    ctx.beginPath();
    const step = 14 * dpr;
    for (let x = -step; x <= W + step; x += step) {
      const nx = x / W, y = veinY(v, nx, t);
      x === -step ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, `hsla(${v.hue},90%,55%,0)`);
    g.addColorStop(0.5, `hsla(${v.hue},95%,60%,${v.alpha + energy * 0.10})`);
    g.addColorStop(1, `hsla(${v.hue},90%,55%,0)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = v.width * dpr;
    ctx.shadowBlur = glow * dpr;
    ctx.shadowColor = `hsla(${v.hue},95%,55%,.5)`;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawPulse(v, p, t) {
    const nx = p.pos;
    if (nx < -0.05 || nx > 1.05) return;
    const x = nx * W, y = veinY(v, nx, t);
    const fade = Math.min(1, p.life * 2) * Math.min(1, (1 - Math.abs(nx - 0.5) * 0.4));
    const r = (10 + energy * 8) * dpr;

    // bright bloom blob (additive)
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `hsla(276,100%,92%,${0.9 * fade})`);
    rg.addColorStop(0.4, `hsla(265,100%,78%,${0.5 * fade})`);
    rg.addColorStop(1, `hsla(260,100%,60%,0)`);
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // bright trailing segment along the vein
    ctx.beginPath();
    const span = 0.06, dirSign = p.dir;
    for (let k = 0; k <= 10; k++) {
      const sx = nx - dirSign * span * (k / 10);
      const px = sx * W, py = veinY(v, sx, t);
      k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.strokeStyle = `hsla(276,100%,88%,${0.7 * fade})`;
    ctx.lineWidth = (v.width + 1.2) * dpr;
    ctx.shadowBlur = 14 * dpr;
    ctx.shadowColor = "hsla(270,100%,75%,.9)";
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function frame(now) {
    const t = now / 1000;
    energy += ((window.__pulse || 0) - energy) * 0.04;
    ctx.clearRect(0, 0, W, H);

    const glow = 9 + energy * 18;
    for (const v of veins) drawVein(v, t, glow);

    // signal pulses (additive blending for LED glow)
    ctx.globalCompositeOperation = "lighter";
    const dt = 1 / 60;
    const spawnEvery = 2.6 - energy * 1.6;     // faster spawns while working
    for (const v of veins) {
      v.nextSpawn -= dt;
      if (v.nextSpawn <= 0 && v.pulses.length < 2) {
        const dir = Math.random() < 0.5 ? 1 : -1;
        v.pulses.push({ pos: dir === 1 ? -0.04 : 1.04, dir, speed: rnd(0.10, 0.22) * (1 + energy), life: 0 });
        v.nextSpawn = rnd(spawnEvery * 0.6, spawnEvery * 1.6);
      }
      for (let i = v.pulses.length - 1; i >= 0; i--) {
        const p = v.pulses[i];
        p.pos += p.dir * p.speed * dt;
        p.life += dt;
        drawPulse(v, p, t);
        if (p.pos < -0.06 || p.pos > 1.06) v.pulses.splice(i, 1);
      }
    }
    ctx.globalCompositeOperation = "source-over";

    if (!reduce) requestAnimationFrame(frame);
  }

  if (reduce) { energy = 0.15; frame(0); }
  else requestAnimationFrame(frame);
})();
