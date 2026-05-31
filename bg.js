// Flowing "veins" background — undulating sound-wave lines on canvas.
// Motion conveys state: calmer at rest, livelier while a job runs.
// Respects prefers-reduced-motion (renders one static frame).

(() => {
  const canvas = document.getElementById("bg");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let W = 0, H = 0, dpr = Math.min(devicePixelRatio || 1, 2);
  function resize() {
    W = canvas.width = innerWidth * dpr;
    H = canvas.height = innerHeight * dpr;
    canvas.style.width = innerWidth + "px";
    canvas.style.height = innerHeight + "px";
  }
  resize();
  addEventListener("resize", resize);

  // energy 0..1 — nudged up while transcribing (set via window.__pulse)
  window.__pulse = 0;
  let energy = 0;

  const LINES = 7;
  const veins = Array.from({ length: LINES }, (_, i) => ({
    yBase: 0.16 + (i / (LINES - 1)) * 0.68,   // spread across height
    amp: 0.018 + Math.sin(i * 1.7) * 0.012 + 0.02,
    freq: 1.1 + (i % 3) * 0.5,
    speed: 0.06 + (i % 4) * 0.02,
    phase: i * 0.9,
    hue: i % 2 ? 262 : 250,                     // Obsidian violet range
    width: 1 + (i % 3) * 0.6,
    alpha: 0.10 + (i % 3) * 0.05,
  }));

  function drawVein(v, t, glow) {
    const y0 = v.yBase * H;
    const amp = v.amp * H * (1 + energy * 1.6);
    const speed = v.speed * (1 + energy * 2.2);
    ctx.beginPath();
    const step = 14 * dpr;
    for (let x = -step; x <= W + step; x += step) {
      const nx = x / W;
      const y =
        y0 +
        Math.sin(nx * Math.PI * 2 * v.freq + t * speed + v.phase) * amp +
        Math.sin(nx * Math.PI * 2 * (v.freq * 1.9) + t * speed * 0.6) * amp * 0.35;
      x === -step ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, `hsla(${v.hue}, 90%, 55%, 0)`);
    grad.addColorStop(0.5, `hsla(${v.hue}, 95%, 60%, ${v.alpha + energy * 0.12})`);
    grad.addColorStop(1, `hsla(${v.hue}, 90%, 55%, 0)`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = v.width * dpr;
    ctx.shadowBlur = glow * dpr;
    ctx.shadowColor = `hsla(${v.hue}, 95%, 55%, 0.5)`;
    ctx.stroke();
  }

  function frame(now) {
    const t = now / 1000;
    // ease energy toward target
    energy += ((window.__pulse || 0) - energy) * 0.04;
    ctx.clearRect(0, 0, W, H);
    const glow = 10 + energy * 22;
    for (const v of veins) drawVein(v, t, glow);
    ctx.shadowBlur = 0;
    if (!reduce) requestAnimationFrame(frame);
  }

  if (reduce) { energy = 0.2; frame(0); }
  else requestAnimationFrame(frame);
})();
