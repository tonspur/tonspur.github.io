// Landing interactions: nav blur, staggered reveals, mock equalizer, count-up stats.
(() => {
  window.__pulse = 0.24; // calm veins on the landing

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // nav blur on scroll
  const nav = document.getElementById("nav");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 24);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // mock equalizer bars
  const eq = document.getElementById("mockEq");
  if (eq) for (let i = 0; i < 22; i++) {
    const s = document.createElement("span");
    s.style.animationDuration = (0.8 + (i % 5) * 0.16) + "s";
    s.style.animationDelay = (i * 0.05) + "s";
    eq.appendChild(s);
  }

  // count-up (with optional thousands separators + suffix)
  const fmt = (n, sep) => sep ? Math.round(n).toLocaleString("de-DE") : String(Math.round(n));
  function countUp(el) {
    const target = parseFloat(el.dataset.count || "0");
    const suffix = el.dataset.suffix || "";
    const prefix = el.dataset.prefix || "";
    const sep = el.dataset.sep === "1";
    if (reduce || target === 0) { el.textContent = prefix + fmt(target, sep) + suffix; return; }
    const dur = 1800, t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 4); // ease-out quart — dramatic climb
      el.textContent = prefix + fmt(target * e, sep) + suffix;
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = prefix + fmt(target, sep) + suffix;
    };
    requestAnimationFrame(tick);
  }

  const items = [...document.querySelectorAll(".reveal")];
  const fire = (el) => {
    el.classList.add("in");
    el.querySelectorAll?.(".num[data-count]").forEach(countUp);
  };

  if (reduce || !("IntersectionObserver" in window)) { items.forEach(fire); return; }

  // above-the-fold reveals immediately
  items.forEach((el) => { if (el.getBoundingClientRect().top < innerHeight * 0.92) fire(el); });

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        const sibs = [...e.target.parentElement.children].filter((c) => c.classList.contains("reveal"));
        e.target.style.transitionDelay = (sibs.indexOf(e.target) % 4) * 80 + "ms";
        fire(e.target);
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.18 });
  items.forEach((el) => { if (!el.classList.contains("in")) io.observe(el); });

  setTimeout(() => items.forEach((el) => { if (!el.classList.contains("in")) fire(el); }), 2000);
})();
