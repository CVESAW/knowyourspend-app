// KnowYourSpend website. No cookies and no requests to other sites unless the visitor accepts.
(() => {
  const body = document.body;
  const pixelId = body.dataset.pixel || "";
  const KEY = "kys-consent";
  const YEAR = 365 * 24 * 3600 * 1000;

  // 1. Pass ad campaign tags through to the store links, so installs can be counted per campaign.
  const q = new URLSearchParams(location.search);
  const utm = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
    const v = q.get(k);
    if (v) utm[k] = v.slice(0, 100);
  }
  if (Object.keys(utm).length) {
    for (const a of document.querySelectorAll("a[data-store]")) {
      const url = new URL(a.href);
      if (a.dataset.store === "android") url.searchParams.set("referrer", new URLSearchParams(utm).toString());
      if (a.dataset.store === "ios" && utm.utm_campaign) url.searchParams.set("ct", utm.utm_campaign.slice(0, 40));
      if (a.dataset.store === "web") for (const [k, v] of Object.entries(utm)) url.searchParams.set(k, v);
      a.href = url.toString();
    }
  }

  // Show the visitor's own store first; hide the other one on phones.
  const ua = navigator.userAgent;
  const hide = /iPhone|iPad|iPod/.test(ua) ? "android" : /Android/.test(ua) ? "ios" : null;
  if (hide) for (const a of document.querySelectorAll(`a[data-store="${hide}"]`)) a.remove();

  // 2. The statement strip: each line finds its owner in turn, then the split fills. Once only.
  const strip = document.querySelector(".strip");
  if (strip) {
    const lines = strip.querySelectorAll(".lines .o");
    lines.forEach((o, i) => (o.style.transitionDelay = `${0.25 + i * 0.22}s`));
    strip.querySelectorAll(".seg").forEach((s) => (s.style.transitionDelay = `${0.45 + lines.length * 0.22}s`));
    const play = () => requestAnimationFrame(() => strip.classList.add("played"));
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) play();
    else {
      const io = new IntersectionObserver((es) => {
        if (es.some((e) => e.isIntersecting)) { play(); io.disconnect(); }
      }, { threshold: 0.35 });
      io.observe(strip);
    }
  }

  // 3. On phones, keep the two buttons in reach once the hero's have scrolled away (hidden again
  //    when the closing buttons are on screen, so they're never shown twice).
  const sticky = document.getElementById("sticky");
  const ctaBlocks = document.querySelectorAll(".hero .ctas, .end .ctas");
  if (sticky && ctaBlocks.length && "IntersectionObserver" in window) {
    const onScreen = new Set();
    let seen = false;
    const io = new IntersectionObserver((es) => {
      for (const e of es) e.isIntersecting ? onScreen.add(e.target) : onScreen.delete(e.target);
      seen = true;
      const show = seen && onScreen.size === 0;
      sticky.classList.toggle("show", show);
      sticky.setAttribute("aria-hidden", show ? "false" : "true");
      for (const a of sticky.querySelectorAll("a")) a.tabIndex = show ? 0 : -1;
    });
    ctaBlocks.forEach((b) => io.observe(b));
  }

  // 4. Cookie choice and the Meta Pixel (only if a pixel is configured, and only after "Accept").
  if (!pixelId) return;
  const banner = document.getElementById("consent");
  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || "null");
      return v && Date.now() - v.at < YEAR ? v.choice : null;
    } catch { return null; }
  };
  const save = (choice) => {
    try { localStorage.setItem(KEY, JSON.stringify({ choice, at: Date.now() })); } catch {}
  };
  let loaded = false;
  const loadPixel = () => {
    if (loaded) return;
    loaded = true;
    const f = (window.fbq = function () { f.callMethod ? f.callMethod.apply(f, arguments) : f.queue.push(arguments); });
    if (!window._fbq) window._fbq = f;
    f.push = f; f.loaded = true; f.version = "2.0"; f.queue = [];
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://connect.facebook.net/en_US/fbevents.js";
    document.head.appendChild(s);
    window.fbq("set", "autoConfig", false, pixelId); // no automatic button/form events
    window.fbq("init", pixelId);
    window.fbq("track", "PageView");
  };
  const choose = (choice) => {
    save(choice);
    banner.hidden = true;
    if (choice === "yes") loadPixel();
    else if (loaded) location.reload(); // withdrawing consent: reload without the pixel
  };
  banner.querySelector("[data-yes]").addEventListener("click", () => choose("yes"));
  banner.querySelector("[data-no]").addEventListener("click", () => choose("no"));
  for (const b of document.querySelectorAll("[data-cookie-settings]")) b.addEventListener("click", () => (banner.hidden = false));
  const c = read();
  if (c === "yes") loadPixel();
  else if (c === null) banner.hidden = false;

  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[data-store]");
    if (a && loaded) window.fbq("trackCustom", "StoreClick", { store: a.dataset.store, cta: a.dataset.cta || "" });
  });
})();
