// Animated audio-waveform FX. Renders a glowing oscilloscope line into any
// <canvas class="wavefx"> — one shared rAF loop drives all instances.
// data-hue1 / data-hue2 (pink→violet gradient), data-amp (0..1), data-speed.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dpr = Math.min(devicePixelRatio || 1, 2);

  function setup(canvas) {
    const ctx = canvas.getContext("2d");
    const o = {
      canvas, ctx,
      hue1: +(canvas.dataset.hue1 ?? 300),   // pink/magenta
      hue2: +(canvas.dataset.hue2 ?? 262),   // violet
      amp: +(canvas.dataset.amp ?? 0.7),
      speed: +(canvas.dataset.speed ?? 1),
      seed: Math.random() * 1000,
      w: 0, h: 0,
    };
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      o.w = canvas.width = Math.max(1, Math.round(r.width * dpr));
      o.h = canvas.height = Math.max(1, Math.round(r.height * dpr));
    };
    resize();
    if ("ResizeObserver" in window) new ResizeObserver(resize).observe(canvas);
    else addEventListener("resize", resize);
    return o;
  }

  function draw(o, t) {
    const { ctx, w, h } = o;
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, `hsla(${o.hue1},90%,65%,0)`);
    grad.addColorStop(0.5, `hsla(${(o.hue1 + o.hue2) / 2},95%,68%,1)`);
    grad.addColorStop(1, `hsla(${o.hue2},90%,62%,0)`);

    // two passes: soft glow + crisp line
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      const step = Math.max(2, 3 * dpr);
      for (let x = 0; x <= w; x += step) {
        const nx = x / w;
        // edge taper so the wave fades in/out at the sides
        const taper = Math.sin(nx * Math.PI);
        const ph = t * 0.0014 * o.speed + o.seed;
        const y = mid + taper * o.amp * mid * (
          0.55 * Math.sin(nx * 16 + ph * 2.1) +
          0.30 * Math.sin(nx * 33 - ph * 1.3) +
          0.18 * Math.sin(nx * 7 + ph * 0.7)
        );
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = grad;
      ctx.lineWidth = (pass === 0 ? 5 : 1.8) * dpr;
      ctx.globalAlpha = pass === 0 ? 0.35 : 1;
      ctx.shadowBlur = (pass === 0 ? 18 : 6) * dpr;
      ctx.shadowColor = `hsla(${o.hue1},95%,60%,.8)`;
      ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }

  function init() {
    const insts = [...document.querySelectorAll("canvas.wavefx")].map(setup);
    if (!insts.length) return;
    if (reduce) { insts.forEach((o) => draw(o, 1200)); return; }
    const loop = (now) => { for (const o of insts) draw(o, now); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", init);
  else init();
})();
