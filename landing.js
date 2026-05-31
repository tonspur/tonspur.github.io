// Landing interactions: nav blur on scroll, staggered reveals, mock equalizer.
(() => {
  // gentle background pulse for the veins on the landing
  window.__pulse = 0.28;

  // nav blur
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

  // staggered scroll reveals
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const items = [...document.querySelectorAll(".reveal")];
  if (reduce || !("IntersectionObserver" in window)) {
    items.forEach((el) => el.classList.add("in"));
    return;
  }
  // Above-the-fold elements reveal immediately (never hide hero content).
  items.forEach((el) => { if (el.getBoundingClientRect().top < innerHeight * 0.92) el.classList.add("in"); });

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        const sibs = [...e.target.parentElement.children].filter((c) => c.classList.contains("reveal"));
        e.target.style.transitionDelay = (sibs.indexOf(e.target) % 4) * 80 + "ms";
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.12 });
  items.forEach((el) => { if (!el.classList.contains("in")) io.observe(el); });

  // Safety net: never leave content hidden (e.g. throttled tabs).
  setTimeout(() => items.forEach((el) => el.classList.add("in")), 1500);
})();
