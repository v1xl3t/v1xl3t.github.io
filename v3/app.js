/* v3, selected work.
 *
 * Three things worth knowing before changing anything here.
 *
 * 1. THE BACKGROUND IS A CONTINUOUS FUNCTION OF SCROLL, not a per-section class.
 *    Every project carries its own color and the page lerps between them, the
 *    same way hackingparadise.com moves its palette with depth. Section classes
 *    would snap; this slides.
 *
 * 2. BECAUSE THE BACKGROUND MOVES, FIXED INK IS A BUG. Halfway between two
 *    surfaces the background can pass straight through the luminance of a fixed
 *    text color and land at 1.2:1, which is invisible rather than low contrast.
 *    safeInk() pushes a color toward black or white by the SMALLEST amount that
 *    clears the ratio against whatever the background actually is right now, so
 *    the designed color is untouched everywhere except the band where it would
 *    have failed. This is why the contrast gate has to sample several scroll
 *    depths and not just the top of the page.
 *
 * 3. The three navs are one filter and one jump list rendered three ways. They
 *    are a choice being presented, not a prototype toggle, so each is complete.
 */
(function () {
  "use strict";
  var D = JSON.parse(document.getElementById("data").textContent);
  var P = D.projects, LANES = D.lanes, SURF = D.surfaces;
  var html = document.documentElement;
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var fine = matchMedia("(pointer: fine)").matches;

  try { history.scrollRestoration = "manual"; } catch (e) {}

  /* ================= colour ================= */
  function srgb(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lumOf(c) { return 0.2126 * srgb(c[0]) + 0.7152 * srgb(c[1]) + 0.0722 * srgb(c[2]); }
  function ratio(a, b) { return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
  function mixTo(c, p, t) { return [Math.round(c[0] + (p[0] - c[0]) * t), Math.round(c[1] + (p[1] - c[1]) * t), Math.round(c[2] + (p[2] - c[2]) * t)]; }
  var inkMemo = {};
  function safeInk(c, bgL, need) {
    var key = c.join(",") + "|" + bgL.toFixed(3) + "|" + need;
    if (inkMemo[key]) return inkMemo[key];
    var out = null;
    if (ratio(lumOf(c), bgL) >= need) out = c;
    else {
      var poles = [[0, 0, 0], [255, 255, 255]], bestT = 2, best = c, bestR = ratio(lumOf(c), bgL);
      for (var p = 0; p < 2; p++) {
        for (var t = 0.02; t <= 1.0001; t += 0.02) {
          var cc = mixTo(c, poles[p], t), r = ratio(lumOf(cc), bgL);
          if (r >= need) { if (t < bestT) { bestT = t; out = cc; } break; }
          if (r > bestR) { bestR = r; best = cc; }
        }
      }
      if (!out) out = best;
    }
    var css = "rgb(" + out[0] + "," + out[1] + "," + out[2] + ")";
    inkMemo[key] = css;
    return css;
  }
  /* The designed inks per skin, before safety. */
  var INK = { standard: [25, 20, 25], pastel: [68, 48, 82], cyber: [168, 255, 214] };
  var MUT = { standard: [74, 68, 80], pastel: [104, 84, 120], cyber: [126, 206, 172] };

  /* ================= scroll -> surface ================= */
  /* NO PRECOMPUTED STOPS. The first version measured every section once and
     lerped across the cached offsets. The hero images load lazily, so every
     image that arrived moved the sections underneath the cache and the colour
     drifted out of step with the work it was supposed to belong to. The first
     measurement of that said four of five projects were wrong, which overstated
     it: part of that reading was the test scrolling smoothly and sampling before
     the scroll had settled. The staleness was real, the number was not.

     So the colour is read from live geometry on the frame it is painted. The
     anchor is a line a third of the way down the viewport; whichever project
     has crossed it owns the page, and the surface slides toward the next one
     across the gap between them. Nothing to invalidate, nothing to go stale. */
  var ANCHOR = 0.33;
  function skin() { return html.getAttribute("data-skin"); }
  function visible() {
    return P.filter(function (p) { var e = document.getElementById(p.id); return e && !e.hidden; });
  }
  function surfaceNow() {
    var s = skin(), vis = visible();
    if (!vis.length) return [243, 238, 228];
    var line = window.innerHeight * ANCHOR;
    var tops = vis.map(function (p) { return document.getElementById(p.id).getBoundingClientRect().top; });
    var i = 0;
    for (var k = 0; k < tops.length; k++) if (tops[k] <= line) i = k;
    var a = SURF[vis[i].id][s];
    if (i >= vis.length - 1) return a;
    var b = SURF[vis[i + 1].id][s];
    var span = tops[i + 1] - tops[i];
    var t = span > 0 ? Math.min(1, Math.max(0, (line - tops[i]) / span)) : 0;
    /* ease so the change reads as a drift rather than a linear wipe */
    t = t * t * (3 - 2 * t);
    return [Math.round(a[0] + (b[0] - a[0]) * t),
            Math.round(a[1] + (b[1] - a[1]) * t),
            Math.round(a[2] + (b[2] - a[2]) * t)];
  }
  function buildStops() { /* kept as a no-op so callers stay readable */ }

  function scrollFrac() {
    var h = document.documentElement;
    var d = h.scrollHeight - h.clientHeight;
    return d > 0 ? Math.min(1, Math.max(0, h.scrollTop / d)) : 0;
  }
  /* Which project owns the viewport right now. Its accent is the colour pulled
     out of that project's own hero image, so the furniture around the work is
     coloured by the work. */
  function currentProject() {
    var vis = visible(), cur = vis[0] || null, line = window.innerHeight * ANCHOR;
    for (var i = 0; i < vis.length; i++) {
      if (document.getElementById(vis[i].id).getBoundingClientRect().top <= line) cur = vis[i];
    }
    return cur;
  }
  /* MARGIN, not the bare threshold. The background is a continuous function of
     scroll, so between the frame that computes a colour and the frame that
     paints it the background has already moved a little. Targeting exactly 3.0
     put the big numbers at 2.93 to 2.96 against the background they actually
     landed on, which the gate caught. Raising it to 3.35 left one case sitting
     at exactly 3.00, which is a rounding hair from failing, so the margin is
     wider again. The cost of aiming high is a slightly stronger colour. The
     cost of aiming low is text nobody can read, on a page about being able to
     read things. */
  var NEED_INK = 7, NEED_MUTED = 4.9, NEED_ACCENT = 3.6;
  function paint() {
    var c = surfaceNow();
    var bgL = lumOf(c), s = skin(), rs = html.style;
    rs.setProperty("--surface", "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")");
    rs.setProperty("--ink", safeInk(INK[s], bgL, NEED_INK));
    rs.setProperty("--muted", safeInk(MUT[s], bgL, NEED_MUTED));
    /* 3:1, the large-text and non-text bar. The accent only ever paints the big
       numbers, a rule and a 1px tag border, never body copy.

       PER SECTION, not one global value. A single --accent was wrong the moment
       two projects were on screen at once, because the neighbour's number got
       the current project's colour and the gate caught it at 2.59:1. Each
       section now carries its own, corrected against the background actually
       behind it right now. safeInk memoises, so this is a map lookup per
       section after the first frame at a given background. */
    var cp = currentProject();
    rs.setProperty("--accent", safeInk((cp && SURF[cp.id] && SURF[cp.id].accent) || INK[s], bgL, NEED_ACCENT));
    for (var i = 0; i < P.length; i++) {
      var el = document.getElementById(P[i].id);
      if (!el || el.hidden) continue;
      var r = el.getBoundingClientRect();
      if (r.bottom < -800 || r.top > window.innerHeight + 800) continue;  // generous: a section repainted late keeps a stale accent
      el.style.setProperty("--accent", safeInk(SURF[P[i].id].accent, bgL, NEED_ACCENT));
    }
  }

  /* ================= build the lists ================= */
  var counts = { all: P.length };
  Object.keys(LANES).forEach(function (l) {
    counts[l] = P.filter(function (p) { return p.lanes.indexOf(l) > -1; }).length;
  });
  var order = ["all"].concat(Object.keys(LANES));
  function label(l) { return l === "all" ? "All work" : LANES[l]; }

  document.querySelectorAll("[data-filters]").forEach(function (box) {
    var two = box.getAttribute("data-filters") === "draw";
    order.forEach(function (l) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("data-lane", l);
      b.setAttribute("aria-pressed", l === "all" ? "true" : "false");
      b.innerHTML = two
        ? "<span>" + label(l) + "</span><span>" + counts[l] + "</span>"
        : label(l) + " " + counts[l];
      b.addEventListener("click", function () { setLane(l); });
      box.appendChild(b);
    });
  });

  var lists = [
    { ol: document.getElementById("docklist") },
    { ol: document.getElementById("drawlist") }
  ];
  lists.forEach(function (L) {
    P.forEach(function (p, i) {
      var li = document.createElement("li");
      li.innerHTML = '<a href="#' + p.id + '">' + String(i + 1).padStart(2, "0") + " · " + p.t + "</a>";
      L.ol.appendChild(li);
    });
    L.ol.addEventListener("click", function (e) { if (e.target.closest("a")) { closeDock(); closeDraw(); } });
  });

  var rail = document.getElementById("rail");
  P.forEach(function (p) {
    var a = document.createElement("a");
    a.href = "#" + p.id;
    a.setAttribute("aria-label", p.t);
    rail.appendChild(a);
  });

  /* ================= filtering ================= */
  var countEl = document.getElementById("count"), emptyEl = document.getElementById("empty");
  function setLane(l) {
    html.setAttribute("data-lane", l);
    var shown = 0;
    P.forEach(function (p, i) {
      var on = l === "all" || p.lanes.indexOf(l) > -1;
      if (on) shown++;
      var sec = document.getElementById(p.id);
      if (sec) sec.hidden = !on;
      lists.forEach(function (L) { if (L.ol.children[i]) L.ol.children[i].hidden = !on; });
      if (rail.children[i]) rail.children[i].hidden = !on;
    });
    document.querySelectorAll("[data-filters] button").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-lane") === l ? "true" : "false");
    });
    countEl.textContent = shown + " of " + P.length + " projects · " + label(l);
    document.getElementById("tabcount").textContent = shown;
    emptyEl.hidden = shown > 0;
    buildStops(); paint(); sync();
  }

  /* ================= where am I ================= */
  var dockpos = document.getElementById("dockpos"), docknow = document.getElementById("docknow");
  function sync() {
    var vis = P.filter(function (p) { var e = document.getElementById(p.id); return e && !e.hidden; });
    var cur = null, idx = 0;
    vis.forEach(function (p, i) {
      var r = document.getElementById(p.id).getBoundingClientRect();
      if (r.top <= window.innerHeight * 0.4) { cur = p; idx = i + 1; }
    });
    for (var i = 0; i < rail.children.length; i++) {
      rail.children[i].setAttribute("aria-current", cur && rail.children[i].getAttribute("href") === "#" + cur.id ? "true" : "false");
    }
    dockpos.textContent = String(idx).padStart(2, "0") + "/" + String(vis.length).padStart(2, "0");
    docknow.textContent = cur ? cur.t : "Start";
  }

  /* ================= navs ================= */
  var dock = document.getElementById("dock"), dockbar = document.getElementById("dockbar");
  function openDock() { html.classList.add("dockopen"); dockbar.setAttribute("aria-expanded", "true"); }
  function closeDock() { html.classList.remove("dockopen"); dockbar.setAttribute("aria-expanded", "false"); }
  dockbar.addEventListener("click", function () { html.classList.contains("dockopen") ? closeDock() : openDock(); });

  var tabbtn = document.getElementById("tabbtn");
  function openDraw(focus) {
    html.classList.add("drawopen", "hinted");
    tabbtn.setAttribute("aria-expanded", "true");
    if (focus !== false) document.getElementById("drawclose").focus();
  }
  function closeDraw() { html.classList.remove("drawopen"); tabbtn.setAttribute("aria-expanded", "false"); }
  tabbtn.addEventListener("click", function () { html.classList.contains("drawopen") ? closeDraw() : openDraw(); });
  document.getElementById("drawclose").addEventListener("click", closeDraw);
  document.getElementById("scrim").addEventListener("click", closeDraw);

  function measure() {
    html.style.setProperty("--dockh", html.getAttribute("data-nav") === "dock" ? dockbar.offsetHeight + "px" : "0px");
    var tb = document.getElementById("topbar");
    html.style.setProperty("--topbar", (tb ? tb.offsetHeight : 0) + "px");
  }
  function setNav(id) {
    html.setAttribute("data-nav", id);
    closeDock(); closeDraw();
    document.querySelectorAll(".opttry").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-nav") === id ? "true" : "false");
    });
    try { localStorage.setItem("vi-v3-nav", id); } catch (e) {}
    measure(); buildStops(); sync();
  }
  document.querySelectorAll(".opttry").forEach(function (b) {
    b.addEventListener("click", function () { setNav(b.getAttribute("data-nav")); });
  });

  var optbtn = document.getElementById("optbtn");
  optbtn.addEventListener("click", function () {
    var open = html.classList.toggle("optsopen");
    optbtn.setAttribute("aria-expanded", open ? "true" : "false");
    optbtn.textContent = open ? "Navigation ▴" : "Navigation ▾";
    measure();
  });

  /* ================= skins and the collect game ================= */
  var SKINS = ["standard", "pastel", "cyber"];
  var SKINLABEL = { standard: "Skin · Standard", pastel: "Skin · Pastel 🦋", cyber: "Skin · Cyber 🛸" };
  var skinbtn = document.getElementById("skinbtn"), hud = document.getElementById("hud");
  var pickups = [].slice.call(document.querySelectorAll(".pickup"));
  var TOTAL = pickups.length, gotP = 0, gotC = 0;
  var critter = document.getElementById("critter"), ufo = document.getElementById("ufo");

  function updateHud() {
    var s = skin();
    hud.textContent = s === "pastel" ? "🍓 " + gotP + "/" + TOTAL
                    : s === "cyber" ? "✦ " + gotC + "/" + TOTAL : "";
  }
  function setSkin(s) {
    html.setAttribute("data-skin", s);
    skinbtn.textContent = SKINLABEL[s];
    skinbtn.setAttribute("aria-label", "Change skin, currently " + s);
    try { localStorage.setItem("vi-v3-skin", s); } catch (e) {}
    updateHud(); buildStops(); paint();
  }
  skinbtn.addEventListener("click", function () {
    var i = SKINS.indexOf(skin());
    setSkin(SKINS[(i + 1) % SKINS.length]);
    resetPickups();
  });

  var actx = null;
  function beep(freqs, dur, type, vol) {
    if (reduce) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      freqs.forEach(function (f, i) {
        var o = actx.createOscillator(), g = actx.createGain();
        o.type = type; o.frequency.value = f;
        g.gain.setValueAtTime(vol, actx.currentTime + i * dur * 0.5);
        g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + i * dur * 0.5 + dur);
        o.connect(g); g.connect(actx.destination);
        o.start(actx.currentTime + i * dur * 0.5);
        o.stop(actx.currentTime + i * dur * 0.5 + dur);
      });
    } catch (e) {}
  }
  var winmodal = document.getElementById("winmodal");
  function showWin(s) {
    document.getElementById("win-emoji").textContent = s === "pastel" ? "🦋" : "🛸";
    document.getElementById("win-msg").textContent = s === "pastel"
      ? "Full belly. The little one grew up on your watch, all " + TOTAL + " found."
      : "Full kit. Saucer complete, all " + TOTAL + " collected.";
    winmodal.classList.add("show");
    winmodal.setAttribute("aria-hidden", "false");
    document.getElementById("winok").focus();
  }
  function hideWin() { winmodal.classList.remove("show"); winmodal.setAttribute("aria-hidden", "true"); }
  document.getElementById("winok").addEventListener("click", hideWin);
  document.getElementById("winclose").addEventListener("click", hideWin);
  winmodal.addEventListener("click", function (e) { if (e.target === winmodal) hideWin(); });

  function collect(el) {
    var s = skin();
    if (s === "pastel") {
      if (el.classList.contains("got-p")) return;
      el.classList.add("got-p"); gotP++;
      beep([660, 880], 0.12, "sine", 0.06);
      critter.classList.add(gotP === TOTAL ? "dance" : "hop");
      setTimeout(function () { critter.classList.remove("hop", "dance"); }, gotP === TOTAL ? 2500 : 450);
      if (gotP === TOTAL) { beep([523, 659, 784], 0.18, "sine", 0.07); showWin("pastel"); }
    } else if (s === "cyber") {
      if (el.classList.contains("got-c")) return;
      el.classList.add("got-c"); gotC++;
      beep([440, 620], 0.1, "square", 0.05);
      ufo.setAttribute("data-lv", Math.min(3, gotC));
      ufo.classList.add("tract");
      setTimeout(function () { ufo.classList.remove("tract"); }, 520);
      if (gotC === TOTAL) { beep([523, 659, 784, 1047], 0.2, "square", 0.07); showWin("cyber"); }
    }
    updateHud();
  }
  function resetPickups() {
    gotP = 0; gotC = 0;
    pickups.forEach(function (p) { p.classList.remove("got-p", "got-c"); });
    if (ufo) ufo.setAttribute("data-lv", "0");
    stage = 1;
    if (critter) critter.setAttribute("data-stage", "1");
    hideWin(); updateHud();
  }
  pickups.forEach(function (p) {
    p.addEventListener("click", function () { collect(p); });
    p.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); collect(p); }
    });
  });

  /* the critter grows with how far down the page you are, and never shrinks */
  var stage = 1;
  function checkStage() {
    var f = scrollFrac();
    var want = f > 0.66 ? 3 : f > 0.33 ? 2 : 1;
    if (want > stage) {
      stage = want;
      critter.setAttribute("data-stage", stage);
      critter.classList.add("pop");
      setTimeout(function () { critter.classList.remove("pop"); }, 360);
    }
  }

  /* ================= try-it modal ================= */
  var modal = document.getElementById("appmodal"), frame = document.getElementById("appframe");
  document.addEventListener("click", function (e) {
    var b = e.target.closest("button.run");
    if (!b) return;
    var u = b.getAttribute("data-app");
    document.getElementById("apptitle").textContent = b.getAttribute("data-title");
    document.getElementById("appopen").href = u;
    frame.src = u;
    if (modal.showModal) modal.showModal(); else window.open(u, "_blank", "noopener");
  });
  document.getElementById("appclose").addEventListener("click", function () { modal.close(); });
  modal.addEventListener("close", function () { frame.src = "about:blank"; });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeDraw(); closeDock(); hideWin(); }
  });

  /* ================= scroll loop ================= */
  var last = window.scrollY, ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      var y = window.scrollY;
      if (html.getAttribute("data-nav") === "dock" && !html.classList.contains("dockopen")) {
        html.classList.toggle("hidedock", y > last + 6 && y > 260);
      }
      last = y; ticking = false;
      paint(); sync(); checkStage();
    });
  }
  addEventListener("scroll", onScroll, { passive: true });
  /* A hero arriving changes the geometry the colour is read from, so repaint. */
  document.querySelectorAll(".shot img").forEach(function (img) {
    if (img.complete) return;
    img.addEventListener("load", function () { paint(); sync(); }, { once: true });
  });
  addEventListener("resize", function () { measure(); buildStops(); paint(); sync(); }, { passive: true });

  /* ================= start ================= */
  var qs = new URLSearchParams(location.search);
  var wantNav = qs.get("nav");
  if (!/^(rail|dock|drawer)$/.test(wantNav || "")) {
    try { var sv = localStorage.getItem("vi-v3-nav"); if (/^(rail|dock|drawer)$/.test(sv || "")) wantNav = sv; } catch (e) {}
  }
  setNav(/^(rail|dock|drawer)$/.test(wantNav || "") ? wantNav : "rail");

  var wantSkin = qs.get("skin");
  if (!/^(standard|pastel|cyber)$/.test(wantSkin || "")) {
    try { var sk = localStorage.getItem("vi-v3-skin"); if (/^(standard|pastel|cyber)$/.test(sk || "")) wantSkin = sk; } catch (e) {}
  }
  setSkin(/^(standard|pastel|cyber)$/.test(wantSkin || "") ? wantSkin : "standard");

  var wantLane = qs.get("lane");
  setLane(wantLane === "all" || LANES[wantLane] ? wantLane : "all");
  if (qs.get("opts") === "1") optbtn.click();
  if (qs.get("open") === "1") {
    if (html.getAttribute("data-nav") === "dock") openDock();
    if (html.getAttribute("data-nav") === "drawer") openDraw(false);
  }
  measure(); buildStops(); paint(); sync();
  setTimeout(function () { html.classList.add("hinted"); }, 6000);

  /* ================= cursor companions ================= */
  if (reduce) return;
  if (!fine) { html.classList.add("mz"); return; }
  html.classList.add("fx");

  var butterfly = document.getElementById("butterfly"), cross = document.getElementById("cross");
  var canvas = document.getElementById("trailc"), ctx = canvas.getContext("2d");
  function fit() { canvas.width = innerWidth; canvas.height = innerHeight; }
  fit(); addEventListener("resize", fit);

  var mx = innerWidth / 2, my = innerHeight / 2, cx = mx, cy = my, ux = mx, uy = my;
  addEventListener("pointermove", function (e) { mx = e.clientX; my = e.clientY; }, { passive: true });

  (function flap() {
    setTimeout(function () {
      butterfly.classList.add("flap");
      setTimeout(function () { butterfly.classList.remove("flap"); }, 640);
      flap();
    }, 1500 + Math.random() * 2000);
  })();

  var pts = [], lastSample = 0, sparks = [], lmx = mx, lmy = my;
  var SPARK = ["#ffffff", "#a9def9", "#f7bcd4"];
  (function frameLoop(t) {
    var s = skin();
    butterfly.style.transform = "translate(" + (mx - 16) + "px," + (my - 15) + "px)";
    cross.style.transform = "translate(" + (mx - 15) + "px," + (my - 15) + "px)";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (s === "pastel") {
      var tx = mx - 36, ty = my + 16;
      cx += (tx - cx) * 0.06; cy += (ty - cy) * 0.06;
      critter.style.transform = "translate(" + cx + "px," + cy + "px)" + (tx < cx - 4 ? " scaleX(-1)" : "");
      if (Math.hypot(mx - lmx, my - lmy) > 5) {
        sparks.push({ x: mx + (Math.random() * 10 - 5), y: my + (Math.random() * 10 - 5), life: 1,
                      r: 1 + Math.random() * 1.8, c: SPARK[(Math.random() * SPARK.length) | 0] });
        lmx = mx; lmy = my;
      }
      for (var i = sparks.length - 1; i >= 0; i--) {
        var sp = sparks[i]; sp.life -= 0.05;
        if (sp.life <= 0) { sparks.splice(i, 1); continue; }
        var rr = sp.r * (0.6 + sp.life * 0.7);
        ctx.globalAlpha = sp.life * 0.85; ctx.fillStyle = sp.c;
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y - rr * 2); ctx.lineTo(sp.x + rr, sp.y);
        ctx.lineTo(sp.x, sp.y + rr * 2); ctx.lineTo(sp.x - rr, sp.y);
        ctx.closePath(); ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (s === "cyber") {
      var hover = Math.sin(t / 420) * 5;
      ux += (mx - 46 - ux) * 0.045; uy += (my - 96 - uy) * 0.045;
      ufo.style.transform = "translate(" + ux + "px," + (uy + hover) + "px)";
      if (t - lastSample > 83) { pts.push({ x: mx, y: my, t: t }); lastSample = t; }
      while (pts.length && t - pts[0].t > 500) pts.shift();
      for (var pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (var k = 0; k < pts.length; k++) {
          var q = pts[k], j = 2.2;
          var x = q.x + (Math.random() * 2 - 1) * j, y = q.y + (Math.random() * 2 - 1) * j;
          k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.strokeStyle = "rgba(141,240,194," + (pass ? 0.16 : 0.36) + ")";
        ctx.lineWidth = pass ? 2.4 : 1.1;
        ctx.stroke();
      }
    }
    requestAnimationFrame(frameLoop);
  })(0);
})();
