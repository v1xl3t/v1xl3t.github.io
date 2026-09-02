

import {
  ACTIVE, NEEDS_VI, isActive, context, score, ranked, reason, todayList,
  todayStamp, prettyDate, daysBetween, daysUntil,
} from "./rank.js";

import { store } from "./store.js";

const ROW      = 58;
const PAD_TOP  = 150;
const PAD_BOT  = 220;
const WAVE     = 620;
const BUFFER   = 8;
const JOINT    = 7;
const NOW_MAX  = 8;
const GAP      = 1.5;

const ZMIN     = 0.10;
const ZMAX     = 2.0;
const ZSTEP    = 1.3;
const RUN_MIN  = 2;

const FOLD_FLOOR = 24;
const SPAN_ROW = 2;
const SOON     = 14;

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SVGNS = "http://www.w3.org/2000/svg";

const S = {
  doc: null,
  items: [],
  byId: new Map(),
  ctx: null,
  nodes: [],
  nodeById: new Map(),
  height: 0,
  window: [-1, -1],
  open: null,
  lit: null,
  shift: 0,
  order: null,
  tipIds: null,
  tipOrder: null,
  hold: new Set(),
  divY: null,
  zoom: 1,
  preFit: null,
  spans: new Set(),
  folded: 0,
  lens: "all",
  query: "",
  skin: localStorage.getItem("ivy.skin") || "light",

  autofall: localStorage.getItem("ivy.autofall") === "1",
  ground: false,
  falling: new Set(),
  drafts: JSON.parse(localStorage.getItem("ivy.drafts") || "{}"),
  saving: false,
};

const LENSES = [
  { id: "all",     name: "All growth",   hint: "Everything, living and woody", test: () => true },
  { id: "you",     name: "Needs you",    hint: "Decisions, errands, things to eyeball", test: (i) => NEEDS_VI.includes(i.status) },
  { id: "mine",    name: "Yours to do",  hint: "Only you can physically do it", test: (i) => i.status === "mine" },
  { id: "ready",  name: "Ready to work",     hint: "Ready to work on right now", test: (i) => i.status === "open" },
  { id: "waiting", name: "Waiting",      hint: "On hold, or on the outside world", test: (i) => i.status === "parked" || i.status === "blocked-ext" },
  { id: "due",     name: "Has a date",   hint: "A real deadline, soonest first", test: (i) => !!i.due && isActive(i) },
  { id: "living",  name: "Living only",  hint: "Hide everything finished", test: (i) => isActive(i) },
  { id: "woody",   name: "Finished",     hint: "Done and dropped, the history", test: (i) => !isActive(i) },
];

document.documentElement.dataset.skin = S.skin;
load().catch((e) => toast(String(e.message || e), true));

async function load() {
  adopt(await store.load());
  S.zoom = clampZ(Number(localStorage.getItem("ivy.zoom")) || 1);
  wire();
  layout();
  paint(true);

  window.scrollTo(0, 0);
}

function adopt(doc) {
  S.doc = doc;
  S.items = doc.items;
  S.byId = new Map(S.items.map((i) => [i.id, i]));
  S.ctx = context(S.items.filter(isActive));
}

function grown(it) {

  let d = it.created || "";
  for (const l of it.log || []) if (l.date > d) d = l.date;
  if (it.closed && it.closed > d) d = it.closed;
  return d || "2026-08-05";
}

function matches(it, lens, q) {
  if (!lens.test(it)) return false;
  if (!q) return true;
  const hay = [it.title, it.why, it.question, it.blockedBy, it.id, it.project]
    .concat(it.detail || [])
    .concat((it.log || []).map((l) => l.text))
    .join(" ").toLowerCase();
  return hay.includes(q);
}

function visibleSet() {
  const lens = realLens();
  const q = S.query.trim().toLowerCase();

  return S.items.filter((it) =>
    (!onGround(it) || S.falling.has(it.id)) && (S.hold.has(it.id) || matches(it, lens, q)));
}

const onGround = (it) => it.archived && !isActive(it);

const litter = () => S.items.filter((it) => onGround(it) && !S.falling.has(it.id));

const readyToFall = () => S.items.filter((it) => !it.archived && !isActive(it));

function layout(keep) {
  const vis = visibleSet();
  const inSet = new Set(vis.map((i) => i.id));


  const kids = new Map();
  const roots = [];
  for (const it of vis) {
    const p = it.parent && inSet.has(it.parent) ? it.parent : null;
    if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(it); }
    else roots.push(it);
  }


  const famDate = new Map();
  const famStamp = (it, seen = new Set()) => {
    if (seen.has(it.id)) return grown(it);
    seen.add(it.id);
    let d = grown(it);
    for (const k of kids.get(it.id) || []) { const c = famStamp(k, seen); if (c > d) d = c; }
    return d;
  };
  for (const r of roots) famDate.set(r.id, famStamp(r));


  let tipIds;
  if (keep && S.tipIds) {

    tipIds = new Set([...S.tipIds].filter((id) => inSet.has(id)));
  } else if (S.query.trim()) {
    tipIds = new Set();
  } else {
    const t = todayList(vis.filter(isActive), NOW_MAX);
    const picks = (t.picks.length ? t.picks : t.ready).map((x) => x.item || x);
    tipIds = new Set();
    for (const it of picks) {
      let r = it, guard = 0;
      while (r && r.parent && inSet.has(r.parent) && guard++ < 12) r = S.byId.get(r.parent);
      if (r) tipIds.add(r.id);
    }
    S.tipIds = tipIds;
    S.tipOrder = null;
  }
  const tipRoots = roots.filter((r) => tipIds.has(r.id));
  const rest = roots.filter((r) => !tipIds.has(r.id));

  if (keep && S.tipOrder) {
    tipRoots.sort((a, b) => (S.tipOrder.get(a.id) ?? 1e9) - (S.tipOrder.get(b.id) ?? 1e9));
  } else {
    tipRoots.sort((a, b) => score(b, S.ctx) - score(a, S.ctx) || a.id.localeCompare(b.id));
    S.tipOrder = new Map(tipRoots.map((r, i) => [r.id, i]));
  }

  if (keep && S.order) {

    rest.sort((a, b) => {
      const ia = S.order.has(a.id) ? S.order.get(a.id) : -1;
      const ib = S.order.has(b.id) ? S.order.get(b.id) : -1;
      return ia - ib;
    });
  } else {
    rest.sort((a, b) => {
      const d = (famDate.get(b.id) || "").localeCompare(famDate.get(a.id) || "");
      if (d) return d;
      return score(b, S.ctx) - score(a, S.ctx);
    });
    S.order = new Map(rest.map((r, i) => [r.id, i]));
  }
  for (const [, list] of kids) list.sort((a, b) => score(b, S.ctx) - score(a, S.ctx) || a.id.localeCompare(b.id));


  const loudOne = (it) => {
    if (!isActive(it)) return false;
    if (NEEDS_VI.includes(it.status)) return true;
    if (it.pinned === todayStamp()) return true;
    if (it.priority === "p1" || it.priority === "p2") return true;
    if (it.due && daysUntil(it.due, todayStamp()) <= SOON) return true;
    return false;
  };
  const famList = (it, seen = new Set()) => {
    if (seen.has(it.id)) return [];
    seen.add(it.id);
    const out = [it];
    for (const k of kids.get(it.id) || []) out.push(...famList(k, seen));
    return out;
  };

  const famLoud = (r) => famList(r).some((it) => loudOne(it) || S.hold.has(it.id) || it.id === S.open);


  const folding = !S.query.trim() && roots.length > FOLD_FLOOR;
  const record = [];
  const spanKeys = [];
  let folded = 0;
  let run = [];
  const flushRun = () => {
    if (!run.length) return;
    const key = "span:" + run[0].id;

    const members = run.flatMap((r) => famList(r));
    const lo = run.map((r) => famDate.get(r.id) || grown(r)).sort()[0];
    const hi = run.map((r) => famDate.get(r.id) || grown(r)).sort().pop();
    const stretch = {
      span: true, key, roots: run.slice(),
      count: members.length,
      done: members.filter((x) => !isActive(x)).length,
      lo, hi,
    };
    if (folding && run.length >= RUN_MIN) {
      const open = S.spans.has(key);
      spanKeys.push(key);

      record.push({ ...stretch, open });
      if (open) for (const r of run) record.push({ root: r });
      else folded += members.length;
    } else {
      for (const r of run) record.push({ root: r });
    }
    run = [];
  };
  for (const r of rest) {
    if (famLoud(r)) { flushRun(); record.push({ root: r }); }
    else run.push(r);
  }
  flushRun();
  S.folded = folded;
  S.spanKeys = spanKeys;


  const vw = Math.max(320, window.innerWidth);
  const narrow = vw < 720;
  const cx = narrow ? 34 : Math.round(vw * 0.44);
  const amp = narrow ? 13 : Math.min(74, vw * 0.062);
  const out0 = narrow ? 44 : Math.max(52, Math.min(vw * 0.15, 108));
  const outD = narrow ? 26 : Math.max(34, Math.min(vw * 0.10, 76));

  const nodes = [];
  let row = 0;
  let side = 1;
  let lastDay = "";

  const walk = (it, depth, s, parentNode, isTip) => {
    const y = PAD_TOP + row * ROW;
    row += 1;
    const sx = cx + amp * Math.sin(y / WAVE);
    const d = Math.min(depth, 4);

    const jitter = ((hashId(it.id) % 100) / 100 - 0.5);
    const x = sx + s * (out0 + d * outD + jitter * 22);

    const lift = 20 + Math.abs(jitter) * 16 + d * 3;
    const n = {
      it,
      id: it.id,
      depth: d,
      side: s,
      x,
      lift,
      y: y + jitter * 9 - lift,
      row: y + jitter * 9,
      sx,
      alive: isActive(it),
      from: parentNode ? { x: parentNode.x, y: parentNode.y } : { x: sx, y },
      attachY: y,
      rooted: !parentNode,
      day: parentNode ? "" : (famDate.get(it.id) || grown(it)),
      needsVi: NEEDS_VI.includes(it.status),
      tip: false,
      held: S.hold.has(it.id),

      pinned: it.pinned === todayStamp(),
      over: it.due && isActive(it) ? daysUntil(it.due, todayStamp()) < 0 : false,
      newDay: false,
    };
    if (n.rooted && n.day !== lastDay) { n.newDay = true; lastDay = n.day; }
    nodes.push(n);
    n.tip = !!isTip;
    if (n.tip) n.newDay = false;
    for (const k of kids.get(it.id) || []) walk(k, depth + 1, s, n, isTip);
  };


  for (const r of tipRoots) { walk(r, 0, narrow ? 1 : side, null, true); side = -side; }
  S.tipCount = nodes.length;
  if (nodes.length && rest.length) {
    S.divY = PAD_TOP + (row + GAP / 2) * ROW;
    row += GAP;
  } else {
    S.divY = null;
  }
  lastDay = "";
  for (const e of record) {
    if (e.span) {

      const y = PAD_TOP + row * ROW;
      row += SPAN_ROW;
      const mid = y + ((SPAN_ROW - 1) * ROW) / 2;
      nodes.push({
        span: true, open: !!e.open, key: e.key, id: e.key, roots: e.roots,
        count: e.count, done: e.done, lo: e.lo, hi: e.hi,
        y: mid, row: y, sx: cx + amp * Math.sin(mid / WAVE),
        x: cx + amp * Math.sin(mid / WAVE),
        top: y - ROW * 0.42, bot: y + (SPAN_ROW - 0.58) * ROW,
        depth: 0, side: narrow ? 1 : side, alive: false, rooted: true,
        day: e.hi, newDay: false, tip: false, held: false,
        needsVi: false, pinned: false, over: false, lift: 0,
      });

      lastDay = "";
      continue;
    }
    walk(e.root, 0, narrow ? 1 : side, null, false);
    side = -side;
  }

  S.nodes = nodes;
  S.nodeById = new Map(nodes.map((n) => [n.id, n]));
  S.cx = cx; S.amp = amp;
  S.height = PAD_TOP + row * ROW + PAD_BOT;

  applyReach();
  S.window = [-1, -1];
  drawRail();
  countLine(vis);
}

const hashId = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const stemX = (y) => S.cx + S.amp * Math.sin(y / WAVE);

let raf = 0;
function onScroll() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; paint(false); });
}

function rowAt(y) {
  let lo = 0, hi = S.nodes.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (S.nodes[m].row < y) lo = m + 1; else hi = m; }
  return lo;
}

function paint(force) {
  const top = window.scrollY;
  const z = S.zoom;
  const wTop = top / z;
  const wBot = (top + window.innerHeight) / z;
  const i0 = Math.max(0, rowAt(wTop) - BUFFER);
  const i1 = Math.min(S.nodes.length, rowAt(wBot) + BUFFER);

  if (!force && i0 >= S.window[0] && i1 <= S.window[1]) { slide(top); return; }
  S.window = [i0, i1];
  build(i0, i1, wTop, wBot);
  slide(top);
  gripTo(top);
}

function slide(top) {

  if (S.world) S.world.setAttribute("transform", `translate(${camX()}, ${-top}) scale(${S.zoom})`);
  if (S.hitWorld) S.hitWorld.style.transform = `translateY(${-top}px)`;
  if (S.open) drawLeaders();
}

const zFloor = () => Math.min(ZMIN, (window.innerHeight - 40) / Math.max(1, S.height));
const clampZ = (z) => Math.min(ZMAX, Math.max(zFloor(), Number(z) || 1));

function camX() {
  const vw = Math.max(320, window.innerWidth);
  const t = Math.min(1, Math.max(0, (1 - S.zoom) / 0.75));
  return (S.cx + (vw * 0.16 - S.cx) * t) - S.cx * S.zoom;
}

function labelBudget(i0, i1) {
  const z = S.zoom;
  const far = z < 0.72;

  const MINGAP = 21;

  const taken = { "-1": [], "1": [] };
  const keep = new Set();
  const ask = (n) => {
    const y = n.y * z;
    const col = taken[n.span || n.side > 0 ? "1" : "-1"];
    if (!col.every((t) => Math.abs(t - y) >= MINGAP)) return;
    col.push(y);
    keep.add(n.id);
  };
  const win = [];
  for (let i = i0; i < i1; i++) win.push(S.nodes[i]);
  for (const n of win) if (n.span) ask(n);

  for (const n of win) if (!n.span && (n.needsVi || n.over || n.tip || n.pinned)) ask(n);
  for (const n of win) if (!n.span && !keep.has(n.id) && (!far || n.alive)) ask(n);
  return keep;
}

function applyReach() {
  $("#reach").style.height = Math.round(S.height * S.zoom) + "px";
  document.documentElement.dataset.zoom = S.zoom < 0.34 ? "far" : S.zoom < 0.72 ? "mid" : "near";
  const v = $("#zoomval");
  if (v) v.textContent = Math.round(S.zoom * 100) + "%";
}

const fitZoom = () => clampZ((window.innerHeight - 40) / Math.max(1, S.height));

function setZoom(z, anchorY) {
  const z2 = clampZ(z);
  if (Math.abs(z2 - S.zoom) < 0.0005) return;
  const a = anchorY == null ? window.innerHeight * 0.35 : anchorY;
  const world = (window.scrollY + a) / S.zoom;
  S.zoom = z2;
  localStorage.setItem("ivy.zoom", String(z2));
  applyReach();
  const max = Math.max(0, S.height * z2 - window.innerHeight);
  window.scrollTo(0, Math.min(max, Math.max(0, world * z2 - a)));
  drawRail();
  paint(true);
  if (S.open) panToOpen();
}

function build(i0, i1, wTop, wBot) {
  const svg = $("#vine");
  svg.innerHTML = DEFS;
  const world = el("g");
  svg.appendChild(world);
  S.world = world;

  const hits = $("#hits");
  hits.innerHTML = "";
  const hw = document.createElement("div");
  hw.style.position = "absolute";
  hw.style.inset = "0";
  hw.style.transformOrigin = "0 0";
  hits.appendChild(hw);
  S.hitWorld = hw;



  const yA = Math.min(wTop ?? 0, S.nodes[i0]?.row ?? 0) - 260;
  const yB = Math.max(wBot ?? S.height, S.nodes[i1 - 1]?.row ?? S.height) + 260;
  const spine = [];
  for (let y = yA; y <= yB; y += 11) spine.push([stemX(y), y]);
  const tw = (y) => 5.5 + 8.5 * Math.min(1, Math.max(0, y / Math.max(1, S.height)));

  const age = Math.min(1, Math.max(0, ((yA + yB) / 2) / Math.max(1, S.height)));
  const mix = (a, b) => `color-mix(in srgb, var(${b}) ${(age * 100).toFixed(0)}%, var(${a}))`;
  const trunk = el("g", { class: "trunk", filter: "url(#float)" });
  trunk.appendChild(el("path", { d: ribbon(spine, tw), style: `fill:${mix("--ivy", "--wood")};stroke:none` }));
  trunk.appendChild(el("path", { d: ribbon(spine, tw), style: `fill:none;stroke:${mix("--ivy-dark", "--wood-dark")};stroke-width:1.2;stroke-linejoin:round` }));
  trunk.appendChild(el("path", { d: edge(spine, (y) => tw(y) * 0.44), style: `fill:none;stroke:${mix("--ivy-rim", "--wood-rim")};stroke-width:1.4;opacity:.4` }));

  trunk.appendChild(el("path", { class: "stem-groove", d: edge(spine, (y) => -tw(y) * 0.1) }));
  trunk.appendChild(el("path", { class: "stem-cool", d: edge(spine, (y) => -tw(y) * 0.6) }));


  for (let i = 6; i < spine.length - 6; i += 5) {
    const [rx, ry] = spine[i];
    const [px, py] = spine[i - 1];
    const ra = Math.atan2(ry - py, rx - px) + Math.PI / 2;
    const half = tw(ry) / 2;
    const rs = hashId("r" + Math.round(ry));
    let rd = "";
    for (let k = 0; k < 3; k++) {
      const wob = ((rs >> (k * 4)) % 100) / 100 - 0.5;
      const a2 = ra + wob * 0.9 + 0.35;
      const len = 4 + Math.abs(wob) * 4;
      const bx = rx + Math.cos(ra) * half, byy = ry + Math.sin(ra) * half + (k - 1) * 4;
      rd += `M${bx.toFixed(1)},${byy.toFixed(1)} l${(Math.cos(a2) * len).toFixed(1)},${(Math.sin(a2) * len).toFixed(1)}`;
    }
    trunk.appendChild(el("path", { class: "rootlet", d: rd, style: `opacity:${(0.55 * (1 - age * 0.7)).toFixed(2)}` }));
  }
  world.appendChild(trunk);


  const scan = el("g");
  const scan0 = Math.ceil(yA / 90) * 90;
  for (let sy = scan0; sy <= yB; sy += 90) {
    const sx = stemX(sy);
    const big = Math.round(sy / 90) % 4 === 0;
    const len = big ? 13 : 7;
    scan.appendChild(el("line", { class: "scan" + (big ? " big" : ""), x1: sx + 15, y1: sy, x2: sx + 15 + len, y2: sy }));
    scan.appendChild(el("line", { class: "scan" + (big ? " big" : ""), x1: sx - 15, y1: sy, x2: sx - 15 - len, y2: sy }));
  }
  world.appendChild(scan);


  if (i0 === 0 && S.tipCount) {
    const y = PAD_TOP - 42;
    const x = Math.max(20, stemX(y) - 150);
    const g = el("g");
    g.appendChild(el("line", { class: "nowline", x1: x, y1: y, x2: stemX(y) + 150, y2: y }));
    g.appendChild(el("text", { class: "nowmark", x, y: y - 9 }, "Now"));
    world.appendChild(g);
  }
  if (S.divY != null && S.divY > yA && S.divY < yB) {
    const g = el("g");
    g.appendChild(el("line", { class: "divline", x1: 16, y1: S.divY, x2: Math.max(24, stemX(S.divY) + 210), y2: S.divY }));
    g.appendChild(el("text", { class: "divmark", x: 16, y: S.divY - 8 }, "The record, newest first"));
    world.appendChild(g);
  }


  const keep = labelBudget(i0, i1);
  for (let i = i0; i < i1; i++) {
    const n = S.nodes[i];
    if (n.span) stretch(n, world, hw, keep.has(n.id)); else branch(n, world, hw, keep.has(n.id));
  }


  if (S.lit) {
    const g = world.querySelector(`.branch[data-id="${S.lit}"]`);
    const h = hw.querySelector(`.hit[data-id="${S.lit}"]`);
    if (g) { g.classList.add("lit"); world.appendChild(g); }
    if (h) h.classList.add("lit");
  }
}

function branch(n, world, hw, labelled = true) {
  const g = el("g", {
    class: "branch" + (n.alive ? "" : " wood") + (n.tip ? " tip" : "") + (n.held ? " held" : ""),
    "data-id": n.id,
    filter: "url(#float)",
  });


  const fx = n.from.x, fy = n.rooted ? n.attachY : n.from.y;
  const dx = n.x - fx, dy = n.y - fy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const ax = fx + ux * JOINT, ay = fy + uy * JOINT;
  const P = [
    [ax, ay],
    [ax + dx * 0.26, ay + dy * 0.88],
    [ax + dx * 0.66, ay + dy * 1.06],
    [n.x, n.y],
  ];
  const pts = curve(P, 22);


  const w0 = (n.alive ? 7.6 : 5.4) - n.depth * 0.9;
  const w1 = w0 * 0.42;
  const wf = (i, m) => (w0 + (w1 - w0) * Math.pow(i / m, 0.7));

  const cls = n.alive ? "" : "wood-";
  g.appendChild(el("path", { class: n.alive ? "stem-fill" : "wood-fill", d: ribbonI(pts, wf) }));
  g.appendChild(el("path", { class: n.alive ? "stem-edge" : "wood-edge", d: ribbonI(pts, wf) }));
  g.appendChild(el("path", { class: n.alive ? "stem-lit"  : "wood-lit",  d: edgeI(pts, (i, m) => wf(i, m) * 0.4) }));

  if (n.alive) g.appendChild(el("path", { class: "stem-groove", d: edgeI(pts, (i, m) => -wf(i, m) * 0.12) }));
  g.appendChild(el("path", { class: "stem-cool", d: edgeI(pts, (i, m) => -wf(i, m) * 0.62) }));


  const jx = fx + ux * (JOINT / 2), jy = fy + uy * (JOINT / 2);
  const pa = Math.atan2(uy, ux);
  const jointD = arc(jx, jy, 7, pa + 2.2, pa + 4.1) + arc(jx, jy, 7, pa - 0.95, pa + 0.95);

  const tick = (ang, r0, r1) =>
    `M${(jx + Math.cos(ang) * r0).toFixed(1)},${(jy + Math.sin(ang) * r0).toFixed(1)}` +
    `L${(jx + Math.cos(ang) * r1).toFixed(1)},${(jy + Math.sin(ang) * r1).toFixed(1)}`;
  g.appendChild(el("path", { class: "joint-rest", d: jointD + tick(pa + Math.PI / 2, 8.5, 12) + tick(pa - Math.PI / 2, 8.5, 12) }));


  const capW = w0 * 0.5;
  g.appendChild(el("ellipse", {
    class: n.alive ? "stem-cap" : "wood-cap",
    cx: ax.toFixed(1), cy: ay.toFixed(1), rx: (capW * 0.34).toFixed(1), ry: capW.toFixed(1),
    transform: `rotate(${(pa * 180 / Math.PI).toFixed(1)} ${ax.toFixed(1)} ${ay.toFixed(1)})`,
  }));
  g.appendChild(el("path", {
    class: "joint", d: jointD,
    style: `transform-origin:${jx.toFixed(1)}px ${jy.toFixed(1)}px`,
  }));



  const tip = 34 - n.depth * 3.4 + (n.it.priority === "p1" ? 6 : 0);
  const autumn = !n.alive;
  leafAt(g, pts, 1, tip, n.side, 0, n.id, autumn);
  if (n.depth === 0) {
    leafAt(g, pts, 0.46, tip * 0.44, -n.side, 0.5, n.id + "a", autumn);
    leafAt(g, pts, 0.74, tip * 0.36, n.side, -0.4, n.id + "b", autumn);
  } else if (n.depth === 1) {
    leafAt(g, pts, 0.6, tip * 0.4, -n.side, 0.4, n.id + "a", autumn);
  }


  if (n.pinned && n.alive) {
    const bl = el("g", { transform: `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})` });
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + 0.4;
      bl.appendChild(el("ellipse", {
        class: "bloom", cx: 0, cy: -11, rx: 5.4, ry: 9,
        transform: `rotate(${(a * 180 / Math.PI).toFixed(1)})`,
      }));
    }
    bl.appendChild(el("circle", { class: "bloom-eye", cx: 0, cy: 0, r: 3.4 }));
    g.appendChild(bl);
  }


  if (n.needsVi) {
    const b = pts[Math.floor(pts.length * 0.82)];
    const k = n.over ? " overdue" : "";
    g.appendChild(el("circle", { class: "bud-ring pulse" + k, cx: b[0], cy: b[1], r: 5.5, "stroke-width": 1.2 }));
    g.appendChild(el("circle", { class: "bud" + k, cx: b[0], cy: b[1], r: 3.1 }));
  }


  const spine = "M" + pts.map((q) => q[0].toFixed(1) + "," + q[1].toFixed(1)).join("L");
  const tr = el("path", { class: "trace", d: spine, "stroke-width": Math.max(1.8, w0 * 0.55) });
  g.appendChild(tr);
  const ang = Math.atan2(pts.at(-1)[1] - pts.at(-3)[1], pts.at(-1)[0] - pts.at(-3)[0]);
  for (let k = 0; k < 3; k++) {
    const a = ang + (k - 1) * 0.8;
    g.appendChild(el("path", {
      class: "spark",
      d: `M${n.x.toFixed(1)},${n.y.toFixed(1)} l${(Math.cos(a) * 8).toFixed(1)},${(Math.sin(a) * 8).toFixed(1)}`,
      style: `--sx:${(Math.cos(a) * 17).toFixed(1)}px; --sy:${(Math.sin(a) * 17).toFixed(1)}px`,
    }));
  }
  world.appendChild(g);
  const L = tr.getTotalLength();
  tr.style.strokeDasharray = L;
  tr.style.setProperty("--len", L);
  tr.style.strokeDashoffset = L;


  if (n.newDay) {
    const yy = n.attachY - ROW / 2;
    const dl = el("g");
    dl.appendChild(el("line", { class: "dayline", x1: 16, y1: yy, x2: Math.max(24, stemX(yy) - 30), y2: yy }));
    dl.appendChild(el("text", { class: "daymark", x: 16, y: yy - 7 }, dayLabel(n.day)));
    world.appendChild(dl);
  }


  const b = document.createElement("button");
  b.className = "hit" + (n.side > 0 ? " right" : " left") + (n.alive ? "" : " spent")
    + (n.held ? " held" : "") + (n.needsVi ? " yours" : "") + (n.over ? " over" : "")
    + (labelled ? "" : " dot");
  b.dataset.id = n.id;
  b.type = "button";

  const z = S.zoom, cX = camX();
  const off = (n.alive ? 26 : 11) + 7;
  b.style.top = (n.y * z - 13) + "px";
  const anchor = (n.side > 0 ? n.x + off : n.x - off) * z + cX;
  if (n.side > 0) b.style.left = anchor + "px";
  else b.style.right = `calc(100% - ${anchor}px)`;
  b.style.height = "26px";
  const lab = document.createElement("span");
  lab.className = "hit-label";

  lab.style.maxWidth = `min(34ch, ${Math.max(58, (n.side > 0 ? window.innerWidth - anchor : anchor) - 14).toFixed(0)}px)`;

  b.title = plainTitle(n.it.title);
  if (labelled) lab.textContent = plainTitle(n.it.title);
  b.appendChild(lab);
  if (n.held) {
    const k = document.createElement("i");
    k.className = "kept";
    k.textContent = "kept";
    k.title = "This no longer matches the lens you are on. It stays until you change the lens yourself.";
    b.appendChild(k);
  }
  b.setAttribute("aria-label", `${plainTitle(n.it.title)}. ${S.doc.statuses[n.it.status].label}. ${n.it.project}.`);
  hw.appendChild(b);
}

function stretch(n, world, hw, labelled = true) {
  const g = el("g", { class: "span" + (n.open ? " open" : ""), "data-id": n.id });
  const x0 = stemX(n.top), x1 = stemX(n.bot);
  const w = 13;


  g.appendChild(el("line", { class: "span-tick", x1: x0 - w, y1: n.top, x2: x0 + w, y2: n.top }));
  g.appendChild(el("line", { class: "span-tick", x1: x1 - w, y1: n.bot, x2: x1 + w, y2: n.bot }));
  const rule = [];
  for (let y = n.top; y <= n.bot; y += 7) rule.push([stemX(y) + w, y]);
  g.appendChild(el("path", { class: "span-rule", d: "M" + join(rule) }));

  if (!n.open) {

    const many = Math.min(6, n.roots.length);
    for (let k = 0; k < many; k++) {
      const t = (k + 0.9) / (many + 0.8);
      const y = n.top + (n.bot - n.top) * t;
      const sx = stemX(y);
      const sd = k % 2 ? -1 : 1;
      const seed = hashId(n.key + k);
      const len = 5 + (seed % 5);
      g.appendChild(el("path", {
        class: "span-nub",
        d: `M${(sx + sd * 5).toFixed(1)},${y.toFixed(1)} l${(sd * len).toFixed(1)},${(-2 - (seed % 3)).toFixed(1)}`,
      }));
    }
  }
  world.appendChild(g);


  const z = S.zoom;
  const b = document.createElement("button");
  b.className = "hit span-hit" + (n.open ? " open" : "") + (labelled ? "" : " dot");
  b.dataset.id = n.id;
  b.type = "button";
  b.style.top = (n.y * z - 13) + "px";
  const anchor = (stemX(n.y) + w + 8) * z + camX();
  b.style.left = anchor + "px";
  b.style.height = "26px";
  const lab = document.createElement("span");
  lab.className = "hit-label";
  lab.style.maxWidth = `min(40ch, ${Math.max(58, window.innerWidth - anchor - 14).toFixed(0)}px)`;
  const range = n.hi === n.lo ? dayLabel(n.hi) : `${dayLabel(n.hi)} to ${dayLabel(n.lo)}`;
  const what = n.done === n.count ? `${n.count} finished`
    : n.done ? `${n.count} quiet, ${n.done} finished`
    : `${n.count} quiet`;
  const words = n.open ? `Fold these ${n.count} back in` : `${what} · ${range}`;
  b.title = words;
  if (labelled) lab.textContent = words;
  b.appendChild(lab);
  b.setAttribute("aria-label", n.open
    ? `Fold ${n.count} items back into one stretch, ${range}.`
    : `${what}, ${range}. Unfold this stretch.`);
  b.setAttribute("aria-expanded", n.open ? "true" : "false");
  hw.appendChild(b);
}

function leafAt(g, pts, t, size, side, tilt, seed, fallen) {
  const i = Math.min(pts.length - 2, Math.max(1, Math.round(t * (pts.length - 1))));
  const [x, y] = pts[i];
  const [px, py] = pts[i - 1];
  const base = Math.atan2(y - py, x - px);
  const wob = ((hashId(seed) % 100) / 100 - 0.5) * 0.45;

  const a = base + side * 0.62 + tilt + wob;
  const deg = (a * 180) / Math.PI + 90;

  const nx = -Math.sin(base) * side * 2.5, ny = Math.cos(base) * side * 2.5;
  const lg = el("g", {
    class: fallen ? "leafg fallen" : "leafg",
    transform: `translate(${(x + nx).toFixed(1)},${(y + ny).toFixed(1)}) rotate(${deg.toFixed(1)})`,
  });
  if (size >= 22) lg.setAttribute("filter", "url(#bark)");

  const tone = ["", "2", "3"][hashId(seed + "t") % 3];
  lg.appendChild(el("path", { class: "leaf", d: leafPath(size), fill: `url(#${fallen ? "af" : "lf"}${side > 0 ? "r" : "l"}${tone})` }));
  lg.appendChild(el("path", { class: "leaf-vein", d: veinPath(size) }));
  if (size >= 18) lg.appendChild(el("path", { class: "leaf-fine", d: finePath(size, seed) }));

  const blade = leafPath(size);
  lg.appendChild(el("path", {
    class: "leaf-spec", fill: "url(#spec)",
    d: specPath(size),
    style: `clip-path:path('${blade}')`,
  }));
  g.appendChild(lg);
}

function curve(P, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
      u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1],
    ]);
  }
  return out;
}

function sides(pts, halfAt) {
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const m = Math.hypot(dx, dy) || 1;
    const nx = -dy / m, ny = dx / m;
    const h = halfAt(i, pts.length - 1, pts[i]) / 2;
    L.push([pts[i][0] + nx * h, pts[i][1] + ny * h]);
    R.push([pts[i][0] - nx * h, pts[i][1] - ny * h]);
  }
  return [L, R];
}
const join = (a) => a.map((q) => q[0].toFixed(1) + "," + q[1].toFixed(1)).join("L");
function ribbonI(pts, wf) {
  const [L, R] = sides(pts, (i, m, q) => wf(i, m, q));
  return "M" + join(L) + "L" + join(R.slice().reverse()) + "Z";
}
function edgeI(pts, wf) {
  const [L] = sides(pts, (i, m, q) => wf(i, m, q));
  return "M" + join(L);
}
const ribbon = (pts, wy) => ribbonI(pts, (i, m, p) => wy(p ? p[1] : 0));
const edge   = (pts, wy) => edgeI(pts, (i, m, p) => wy(p ? p[1] : 0));

function leafPath(s) {
  const p = (x, y) => `${(x * s).toFixed(1)},${(y * s).toFixed(1)}`;
  return `M${p(0, 0)}`
    + `C${p(-.16, -.10)} ${p(-.50, -.08)} ${p(-.62, -.27)}`
    + `C${p(-.71, -.42)} ${p(-.45, -.43)} ${p(-.43, -.55)}`
    + `C${p(-.41, -.70)} ${p(-.26, -.65)} ${p(-.20, -.80)}`
    + `C${p(-.14, -.94)} ${p(-.05, -.96)} ${p(0, -1)}`
    + `C${p(.05, -.96)} ${p(.14, -.94)} ${p(.20, -.80)}`
    + `C${p(.26, -.65)} ${p(.41, -.70)} ${p(.43, -.55)}`
    + `C${p(.45, -.43)} ${p(.71, -.42)} ${p(.62, -.27)}`
    + `C${p(.50, -.08)} ${p(.16, -.10)} ${p(0, 0)}Z`;
}
function veinPath(s) {
  const p = (x, y) => `${(x * s).toFixed(1)},${(y * s).toFixed(1)}`;
  return `M${p(0, -.04)}L${p(0, -.86)}`
    + `M${p(0, -.34)}L${p(-.47, -.44)}M${p(0, -.34)}L${p(.47, -.44)}`
    + `M${p(0, -.55)}L${p(-.25, -.76)}M${p(0, -.55)}L${p(.25, -.76)}`;
}

function specPath(sz) {
  const k = 0.66, dx = -0.05 * sz, dy = -0.16 * sz;
  const p = (x, y) => `${(x * sz * k + dx).toFixed(1)},${(y * sz * k + dy).toFixed(1)}`;
  return `M${p(0, 0)}`
    + `C${p(-.16, -.10)} ${p(-.50, -.08)} ${p(-.62, -.27)}`
    + `C${p(-.71, -.42)} ${p(-.45, -.43)} ${p(-.43, -.55)}`
    + `C${p(-.41, -.70)} ${p(-.26, -.65)} ${p(-.20, -.80)}`
    + `C${p(-.14, -.94)} ${p(-.05, -.96)} ${p(0, -1)}`
    + `C${p(.05, -.96)} ${p(.14, -.94)} ${p(.20, -.80)}`
    + `C${p(.26, -.65)} ${p(.41, -.70)} ${p(.43, -.55)}`
    + `C${p(.45, -.43)} ${p(.71, -.42)} ${p(.62, -.27)}`
    + `C${p(.50, -.08)} ${p(.16, -.10)} ${p(0, 0)}Z`;
}

function finePath(sz, seed) {
  const p = (x, y) => `${(x * sz).toFixed(1)},${(y * sz).toFixed(1)}`;
  const h = hashId(seed);
  let d = "";
  for (let i = 0; i < 5; i++) {
    const t = 0.18 + i * 0.15;
    const w = 0.1 + ((h >> (i * 3)) % 7) / 42;
    const s2 = i % 2 ? 1 : -1;
    d += `M${p(0, -t)}L${p(s2 * w, -(t + 0.09))}`;
  }
  return d;
}

function arc(cx, cy, r, a0, a1) {
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  return `M${x0.toFixed(1)},${y0.toFixed(1)}A${r},${r} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
}

function hel(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

function el(tag, attrs = {}, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

const DEFS = `
<defs>
  ${[["lf", "", "--leaf-a", "--leaf-b"], ["lf", "2", "--leaf-a2", "--leaf-b2"], ["lf", "3", "--leaf-a3", "--leaf-b3"],
     ["af", "", "--fall-a", "--fall-b"], ["af", "2", "--fall-a2", "--fall-b2"], ["af", "3", "--fall-a3", "--fall-b3"]]
    .flatMap(([pre, n, a, b]) => [["r", "0", "1", "1", "0"], ["l", "1", "1", "0", "0"]].map(([side, x1, y1, x2, y2]) => `
  <linearGradient id="${pre}${side}${n}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
    <stop offset="0" style="stop-color:var(${a})"/>
    <stop offset=".52" style="stop-color:var(${b})"/>
    <stop offset="1" style="stop-color:var(${a})"/>
  </linearGradient>`)).join("")}

  <!-- The waxy highlight. Soft at the edge or it reads as a sticker. -->
  <radialGradient id="spec" cx="50%" cy="50%" r="50%">
    <stop offset="0"   style="stop-color:rgb(var(--spec));stop-opacity:var(--spec-o)"/>
    <stop offset=".55" style="stop-color:rgb(var(--spec));stop-opacity:calc(var(--spec-o) * .45)"/>
    <stop offset="1"   style="stop-color:rgb(var(--spec));stop-opacity:0"/>
  </radialGradient>

  <!-- Two shadows, not one. A tight contact shadow says how far above the
       slab the thing floats, the wide ambient one says the room is lit. One
       shadow alone always reads as a sticker with a drop shadow. -->
  <filter id="float" x="-45%" y="-45%" width="200%" height="220%">
    <feDropShadow dx="2" dy="4" stdDeviation="2" style="flood-color:var(--shadow)" flood-opacity="1" result="near"/>
    <feDropShadow in="near" dx="7" dy="13" stdDeviation="7" style="flood-color:var(--shadow)" flood-opacity=".5"/>
  </filter>

  <!-- Leaf skin. Roughens the edge AND mottles the surface in one pass, so
       no two leaves are identical and none of them is flat. -->
  <filter id="bark" x="-25%" y="-25%" width="150%" height="150%">
    <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="3" seed="5" result="t"/>
    <feDisplacementMap in="SourceGraphic" in2="t" scale="2.4" xChannelSelector="R" yChannelSelector="G" result="d"/>
    <feTurbulence type="fractalNoise" baseFrequency="0.34 0.42" numOctaves="4" seed="17" result="m"/>
    <feColorMatrix in="m" type="matrix" result="mm"
      values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  .40 .40 .40 0 -.17"/>
    <feComposite in="mm" in2="d" operator="in" result="mask"/>
    <feBlend in="d" in2="mask" mode="multiply"/>
  </filter>

  <filter id="glow" x="-120%" y="-120%" width="340%" height="340%">
    <feGaussianBlur stdDeviation="3.4" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>`;

function light(id) {
  if (S.lit === id) return;
  unlight();
  S.lit = id;
  const g = $(`#vine .branch[data-id="${id}"]`);
  const h = $(`#hits .hit[data-id="${id}"]`);
  if (g) { g.classList.remove("lit"); void g.getBoundingClientRect(); g.classList.add("lit"); g.parentNode.appendChild(g); }
  if (h) h.classList.add("lit");
}
function unlight() {
  if (!S.lit) return;
  $$(`#vine .branch.lit`).forEach((g) => g.classList.remove("lit"));
  $$(`#hits .hit.lit`).forEach((h) => h.classList.remove("lit"));
  S.lit = null;
}

function toggleSpan(key) {
  if (S.spans.has(key)) S.spans.delete(key); else S.spans.add(key);
  const before = S.nodeById.get(key);
  const anchor = before ? before.row * S.zoom - window.scrollY : null;
  layout(true);
  const after = S.nodeById.get(key);
  if (after && anchor != null) {
    const max = Math.max(0, S.height * S.zoom - window.innerHeight);
    window.scrollTo(0, Math.min(max, Math.max(0, after.row * S.zoom - anchor)));
  }
  paint(true);
  S.lit = null;
  light(key);
}

function openPlate(id) {

  if (typeof id === "string" && id.startsWith("span:")) return toggleSpan(id);
  const it = S.byId.get(id);
  if (!it) return;
  S.open = id;
  const n = S.nodeById.get(id);
  if (n) {
    const want = n.y * S.zoom - window.innerHeight * 0.42;
    if (Math.abs(window.scrollY - want) > window.innerHeight * 0.34) {
      window.scrollTo({ top: Math.max(0, Math.min(want, S.height * S.zoom - window.innerHeight)), behavior: "smooth" });
    }
  }
  panToOpen();

  $("#platewrap").hidden = false;
  renderPlate(it);

  const t0 = performance.now();
  const follow = () => { drawLeaders(); if (S.open === id && performance.now() - t0 < 480) requestAnimationFrame(follow); };
  requestAnimationFrame(follow);
  light(id);
  $("#plate").focus();
}

function panToOpen() {
  const n = S.open && S.open !== "__new" && S.nodeById.get(S.open);
  if (!n || window.innerWidth <= 720) return pan(0);
  const want = Math.max(0, n.x * S.zoom + camX() - window.innerWidth * 0.2);
  pan(Math.min(want, Math.max(0, window.innerWidth * 0.42)));
}

function pan(px) {
  S.shift = px;
  $("#vine").style.transform = `translateX(${-px}px)`;
  $("#hits").style.transform = `translateX(${-px}px)`;
}

function keepTheOpenOne() {
  S.hold.clear();
  if (S.open && S.open !== "__new" && S.byId.has(S.open)) S.hold.add(S.open);
}

function shutPlate() {
  S.open = null;
  $("#platewrap").hidden = true;
  $("#leaders").innerHTML = "";
  pan(0);
  unlight();
}

function drawLeaders() {
  const sv = $("#leaders");
  const n = S.nodeById.get(S.open);
  const plate = $("#plate");
  if (!n || !plate || window.innerWidth <= 720) { sv.innerHTML = ""; return; }
  const r = plate.getBoundingClientRect();
  const z = S.zoom;
  const cx = n.x * z + camX() - S.shift, cy = n.y * z - window.scrollY;

  const R = Math.max(15, Math.min(34, 34 * z));
  const ex = n.side > 0 ? r.left : r.right;
  const dir = n.side > 0 ? -1 : 1;

  const y1 = cy - R * 0.7, y2 = cy + R * 0.7;
  const x0 = cx - dir * R * 0.72;

  const t = r.top + 14, bm = Math.min(r.top + 190, r.bottom - 14);
  const line = (ax, ay, bx, by) =>
    `<path class="halo" d="M${ax.toFixed(1)},${ay.toFixed(1)} L${bx.toFixed(1)},${by.toFixed(1)}"/>` +
    `<path d="M${ax.toFixed(1)},${ay.toFixed(1)} L${bx.toFixed(1)},${by.toFixed(1)}"/>`;
  sv.innerHTML =
    `<circle class="halo" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${R}"/>` +
    line(x0, y1, ex, t) +
    line(x0, y2, ex, bm) +
    `<circle class="hot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${R}"/>` +
    `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(R + 6).toFixed(1)}" stroke-dasharray="1.5 4" opacity=".6"/>` +

    `<text class="fig" x="${(cx + dir * (R + 15)).toFixed(1)}" y="${(cy - R - 9).toFixed(1)}">FIG.</text>`;
}

function renderPlate(it) {
  const p = $("#plate");
  const st = S.doc.statuses[it.status];
  const proj = S.doc.projects.find((x) => x.id === it.project);
  const kids = S.items.filter((x) => x.parent === it.id);
  const parent = it.parent ? S.byId.get(it.parent) : null;
  const needs = (it.needs || []).map((n) => S.byId.get(n)).filter(Boolean);
  const unlocks = S.items.filter((x) => (x.needs || []).includes(it.id));
  const why = reason(it, S.ctx);
  const draft = S.drafts[it.id] || "";

  const sec = (cls, title, body) => body ? `<section class="sec ${cls}"><h3>${title}</h3>${body}</section>` : "";

  p.innerHTML = `
  <button class="plate-shut" id="shut" type="button" aria-label="Close">
    <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>
  </button>

  <div class="plate-head">
    <p class="plate-eyebrow">
      <span class="dot" style="background:${it.status === "done" || it.status === "dropped" ? "var(--wood)" : "var(--ivy)"}"></span>
      <span>${esc(proj ? proj.name : it.project)}</span>
      <span>·</span>
      <span>${esc(st.label.replace("Blocked on Vi", "Blocked on you"))}</span>
      <span class="grow">${esc(it.id)}</span>
    </p>
    <h2 id="plate-title">${md(it.title)}</h2>
  </div>

  ${sec("", "Why it is on the vine", (it.why ? `<p>${md(it.why)}</p>` : "") + (why ? `<p style="color:var(--ink-3)">${esc(why)}</p>` : ""))}

  ${it.question || it.status === "blocked-vi" || it.status === "review" || it.status === "mine" ? `
  <section class="sec ask">
    <h3>${it.question ? "The one question" : "Your move"}</h3>
    ${it.question ? `<p class="askline">${md(it.question)}</p>` : ""}
    ${it.blockedBy ? `<p>Waiting on ${md(it.blockedBy)}</p>` : ""}
    <label class="reply">
      <textarea id="reply" placeholder="Answer in your own words. Posting moves the status by itself.">${esc(draft)}</textarea>
    </label>
    <div class="replyrow">
      <button class="act" id="post" type="button">Post and unblock</button>
      <button class="act ghost" id="postonly" type="button">Post, leave the status</button>
      <span class="note" id="postnote"></span>
    </div>
  </section>` : `
  <section class="sec">
    <h3>Add to the log</h3>
    <label class="reply">
      <textarea id="reply" placeholder="Anything worth keeping about this one.">${esc(draft)}</textarea>
    </label>
    <div class="replyrow">
      <button class="act ghost" id="postonly" type="button">Post</button>
      <span class="note" id="postnote"></span>
    </div>
  </section>`}

  ${it.image ? `<section class="sec"><h3>Picture</h3><img class="thumb" src="${esc(it.image)}" alt=""></section>` : ""}

  ${sec("", "Detail", (it.detail || []).length ? `<ul>${it.detail.map((d) => `<li>${md(d)}</li>`).join("")}</ul>` : "")}

  <section class="sec">
    <h3>Status</h3>
    <div class="chips" id="statuschips">
      ${S.doc.statusOrder.filter((s) => S.doc.statuses[s].pickable !== false).map((s) => `
        <button class="chip${S.doc.statuses[s].tier === 2 ? " tier2" : ""}" data-status="${s}" type="button"
          aria-pressed="${s === it.status}" title="${esc(S.doc.statuses[s].hint)}">${esc(S.doc.statuses[s].label.replace("Blocked on Vi", "Blocked on you"))}</button>`).join("")}
    </div>
  </section>

  ${!isActive(it) || it.archived ? `
  <section class="sec">
    <h3>The fall</h3>
    <div class="pinrow">
      <button class="chip" id="fallbtn" type="button">${it.archived ? "Put it back on the vine" : "Let it fall"}</button>
      <span class="note">${it.archived
        ? "It is on the ground. Putting it back regrows the leaf where it was."
        : "Finished growth can drop to the ground, which is the archive. Nothing is deleted."}</span>
    </div>
  </section>` : ""}

  <section class="sec">
    <h3>Priority${it.due ? " and date" : ""}</h3>
    <div class="chips" id="priochips">
      ${["p1", "p2", "p3", "p4"].map((k) => `
        <button class="chip" data-prio="${k}" type="button" aria-pressed="${it.priority === k}"
          title="${esc(S.doc.priorities[k].hint)}">${esc(S.doc.priorities[k].label)}</button>`).join("")}
      <button class="chip tier2" data-prio="" type="button" aria-pressed="${!it.priority}">Unset</button>
    </div>
    ${it.due ? `<p style="margin-top:9px">Due ${esc(prettyDate(it.due))}${dueWord(it)}</p>` : ""}
  </section>

  <section class="sec">
    <h3>Today</h3>
    <div class="pinrow">
      <button class="chip" id="pinbtn" type="button" aria-pressed="${pinnedToday(it)}">
        ${pinnedToday(it) ? "Pinned to today" : "Pin to today"}
      </button>
      <span class="note">${pinnedToday(it)
        ? "It sits at the top of the vine until the day is over."
        : it.pinned
          ? `Pinned to ${esc(prettyDate(it.pinned) || it.pinned)}, which has passed, so it counts for nothing now.`
          : "A pin is you naming today. It outranks a deadline, and only on the day it names."}</span>
    </div>
  </section>

  ${sec("", "Its place on the vine",
    (parent || kids.length || needs.length || unlocks.length) ? `<div class="kin">
      ${parent ? row2("Grows from", parent) : ""}
      ${kids.map((k) => row2("Branch", k)).join("")}
      ${needs.map((k) => row2("Waits for", k)).join("")}
      ${unlocks.map((k) => row2("Unblocks", k)).join("")}
    </div>` : "")}

  ${sec("", `History, ${(it.log || []).length} entr${(it.log || []).length === 1 ? "y" : "ies"}`,
    (it.log || []).length ? `<ul class="log">${[...it.log].reverse().map((l) => `
      <li><span class="who${l.author === me() ? " vi" : ""}"><b>${esc(l.author)}</b>${esc(prettyDate(l.date) || l.date)}</span>
      <span class="what">${md(l.text)}</span></li>`).join("")}</ul>` : "")}

  ${it.link ? `<section class="sec"><h3>Link</h3><p><a href="${esc(it.link)}" target="_blank" rel="noreferrer">${esc(it.link)}</a></p></section>` : ""}
  `;


  $("#shut", p).onclick = shutPlate;
  const ta = $("#reply", p);
  if (ta) {
    ta.addEventListener("input", () => {
      S.drafts[it.id] = ta.value;
      localStorage.setItem("ivy.drafts", JSON.stringify(S.drafts));
    });
  }
  const post = $("#post", p);
  if (post) post.onclick = () => reply(it, true);
  const only = $("#postonly", p);
  if (only) only.onclick = () => reply(it, false);

  $$("#statuschips .chip", p).forEach((c) => {
    c.onclick = () => {
      const to = c.dataset.status;
      const note = `${plainTitle(it.title).slice(0, 34)} is now ${S.doc.statuses[to].label.toLowerCase().replace("blocked on vi", "blocked on you")}`;

      const finishing = S.autofall && !it.archived && !ACTIVE.includes(to);

      const reviving = it.archived && ACTIVE.includes(to);
      const fields = { status: to };
      if (finishing) fields.archived = true;
      if (reviving) fields.archived = false;
      const ops = [{ type: "patch", id: it.id, fields }];
      const said = finishing ? note + ", and it fell"
        : reviving ? note + ", and it grew back onto the vine"
        : note;

      if (finishing && !S.falling.has(it.id)) {
        const ms = dropVisual(it.id);
        if (ms) {
          S.falling.add(it.id);
          setTimeout(() => { S.falling.delete(it.id); send(ops, said); }, ms);
          return;
        }
      }
      send(ops, said);
    };
  });

  const fell = $("#fallbtn", p);
  if (fell) fell.onclick = () => (it.archived ? regrow(it) : letFall(it));
  const pin = $("#pinbtn", p);
  if (pin) pin.onclick = () => send(
    [{ type: "patch", id: it.id, fields: { pinned: pinnedToday(it) ? "" : todayStamp() } }],
    pinnedToday(it) ? "Unpinned" : "Pinned to today, it is at the top of the vine");

  $$("#priochips .chip", p).forEach((c) => {
    c.onclick = () => send([{ type: "patch", id: it.id, fields: { priority: c.dataset.prio } }],
      c.dataset.prio ? `Banded ${S.doc.priorities[c.dataset.prio].label}` : "Priority cleared");
  });
  $$(".kin button", p).forEach((b) => { b.onclick = () => openPlate(b.dataset.go); });
}

const me = () => (S.doc.authors && S.doc.authors[0]) || "Vi";

const pinnedToday = (it) => it.pinned === todayStamp();

const row2 = (rel, it) =>
  `<button type="button" data-go="${esc(it.id)}"><span class="rel">${esc(rel)}</span><span>${esc(plainTitle(it.title))}</span></button>`;

function dueWord(it) {
  const n = daysUntil(it.due, todayStamp());
  if (n < 0) return `, overdue by ${-n} day${-n === 1 ? "" : "s"}`;
  if (n === 0) return ", today";
  return `, in ${n} day${n === 1 ? "" : "s"}`;
}

function reply(it, unblock) {
  const ta = $("#reply");
  const text = (ta?.value || "").replace(/\s+/g, " ").trim();
  if (!text) { $("#postnote").textContent = "Nothing typed yet."; ta?.focus(); return; }

  const ops = [{ type: "addLog", id: it.id, author: me(), text, date: todayStamp() }];
  if (unblock) {

    const next = it.status === "blocked-vi" ? "open" : (it.status === "mine" || it.status === "review") ? "done" : it.status;
    if (next !== it.status) ops.push({ type: "patch", id: it.id, fields: { status: next } });
  }
  delete S.drafts[it.id];
  localStorage.setItem("ivy.drafts", JSON.stringify(S.drafts));
  send(ops, unblock ? "Posted, and the status moved with it" : "Posted");
}

async function send(ops, note) {
  if (S.saving) return;
  S.saving = true;
  try {
    const res = await store.ops(S.doc.revision, ops);
    if (!res.ok) { toast(res.message, true); return; }
    const j = res.doc;

    const wasOn = S.nodes.map((n) => n.id);
    adopt(j);
    const lens = realLens();
    const q = S.query.trim().toLowerCase();
    for (const id of wasOn) {
      const it = S.byId.get(id);
      if (it && !matches(it, lens, q)) S.hold.add(id);
    }
    const open = S.open;
    layout(true);
    paint(true);
    if (open && S.byId.has(open)) { renderPlate(S.byId.get(open)); drawLeaders(); }
    else if (open) shutPlate();
    else { $("#platewrap").hidden = true; }
    if (S.ground) renderGround();
    toast(note || "Saved");
  } catch (e) {
    toast("could not reach the board, " + e.message, true);
  } finally {
    S.saving = false;
  }
}

let toastT = 0;
function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("bad", !!bad);
  t.classList.add("up");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("up"), bad ? 6000 : 2600);
}

function drawRail() {
  const rail = $("#railticks");
  const H = rail.clientHeight || (window.innerHeight - 120);
  const z = S.zoom;
  const room = S.height * z - window.innerHeight;

  const scrub = room > 1;
  const at = scrub
    ? (y) => Math.min(1, Math.max(0, (y * z - window.innerHeight * 0.4) / room)) * H
    : (y) => Math.min(1, Math.max(0, y / Math.max(1, S.height))) * H;
  let html = "";
  let lastLabel = -99;
  let lastWord = "";
  const first = S.nodes.find((x) => x.newDay)?.day;
  if (S.tipCount) { html += `<i class="month" style="top:0"></i><b style="top:0">Now</b>`; lastLabel = 0; }
  for (const n of S.nodes) {
    if (n.span && !n.open) {
      const a = at(n.top), b = at(n.bot);
      html += `<s style="top:${a.toFixed(1)}px;height:${Math.max(2, b - a).toFixed(1)}px"></s>`;
      continue;
    }
    if (n.needsVi || n.over) html += `<u class="${n.over ? "over" : ""}" style="top:${at(n.y).toFixed(1)}px"></u>`;
    if (!n.newDay) continue;
    const top = at(n.y);
    const isMonthish = n.day.endsWith("-01") || n.day === first;
    html += `<i class="${isMonthish ? "month" : ""}" style="top:${top.toFixed(1)}px"></i>`;

    const word = dayLabel(n.day);
    if (top - lastLabel > 34 && word !== lastWord) {
      html += `<b style="top:${top.toFixed(1)}px">${esc(word)}</b>`;
      lastLabel = top; lastWord = word;
    }
  }
  rail.innerHTML = html;
}

function gripTo(top) {
  const rail = $("#rail");
  const H = rail.clientHeight - 26;
  const room = S.height * S.zoom - window.innerHeight;
  const grip = $("#railgrip");

  grip.hidden = room <= 1;
  if (room <= 1) return;
  const f = Math.min(1, Math.max(0, top / room));
  grip.style.top = (f * H).toFixed(1) + "px";
  const w = (top + window.innerHeight * 0.45) / S.zoom;
  const here = [...S.nodes].reverse().find((n) => n.newDay && n.y <= w);
  $("#gripdate").textContent = here ? dayLabel(here.day) : "now";
}

function railDrag(e) {
  const rail = $("#rail");
  const r = rail.getBoundingClientRect();
  const H = r.height - 26;
  const f = Math.min(1, Math.max(0, (e.clientY - r.top - 13) / H));
  window.scrollTo(0, f * Math.max(1, S.height * S.zoom - window.innerHeight));
}

function wire() {
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => { layout(true); paint(true); });


  const hits = $("#hits");
  hits.addEventListener("pointerover", (e) => {
    const b = e.target.closest(".hit");
    if (b) light(b.dataset.id);
  });
  hits.addEventListener("pointerout", (e) => {
    const b = e.target.closest(".hit");
    if (b && !S.open) unlight();
  });
  hits.addEventListener("focusin", (e) => {
    const b = e.target.closest(".hit");
    if (b) light(b.dataset.id);
  });
  hits.addEventListener("click", (e) => {
    const b = e.target.closest(".hit");
    if (b) openPlate(b.dataset.id);
  });


  $("#zoomin").onclick = () => setZoom(S.zoom * ZSTEP);
  $("#zoomout").onclick = () => setZoom(S.zoom / ZSTEP);

  $("#zoomfit").onclick = () => {
    const f = fitZoom();
    if (Math.abs(S.zoom - f) < 0.01) {
      const back = S.preFit || { zoom: 1, scroll: 0 };
      S.preFit = null;
      setZoom(back.zoom);
      window.scrollTo(0, back.scroll);
      return;
    }
    S.preFit = { zoom: S.zoom, scroll: window.scrollY };
    setZoom(f);
  };


  window.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(S.zoom * Math.exp(-e.deltaY * 0.0022), e.clientY);
  }, { passive: false });


  $("#count").addEventListener("click", (e) => {
    if (!e.target.closest("#unfold")) return;
    if (S.spans.size) S.spans.clear();
    else for (const k of S.spanKeys) S.spans.add(k);
    layout(true);
    paint(true);
  });

  $("#platescrim").onclick = shutPlate;
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
    if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "+" || e.key === "=") { e.preventDefault(); return setZoom(S.zoom * ZSTEP); }
      if (e.key === "-" || e.key === "_") { e.preventDefault(); return setZoom(S.zoom / ZSTEP); }
      if (e.key === "0")                  { e.preventDefault(); return setZoom(1); }
      if (e.key === "f" || e.key === "F") { e.preventDefault(); return setZoom(fitZoom()); }
    }
    if (e.key === "Escape") {
      if (!$("#lens").hidden) return closeLens();
      if (S.ground) return shutGround();
      if (S.open) return shutPlate();
    }
    if (e.key === "/" && document.activeElement?.tagName !== "TEXTAREA" && document.activeElement?.tagName !== "INPUT") {
      e.preventDefault(); $("#q").focus();
    }

    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && document.activeElement?.id === "reply") {
      e.preventDefault();
      ($("#post") || $("#postonly"))?.click();
    }
  });


  let qT = 0;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(qT);
    qT = setTimeout(() => {
      S.query = e.target.value;
      keepTheOpenOne();
      layout(); paint(true); window.scrollTo(0, 0);
      panToOpen();
    }, 160);
  });


  $("#lensbtn").onclick = () => ($("#lens").hidden ? openLens() : closeLens());
  document.addEventListener("click", (e) => {
    if ($("#lens").hidden) return;
    if (e.target.closest("#lens") || e.target.closest("#lensbtn")) return;
    closeLens();
  });

  $("#themebtn").onclick = () => {
    S.skin = S.skin === "dark" ? "light" : "dark";
    document.documentElement.dataset.skin = S.skin;
    localStorage.setItem("ivy.skin", S.skin);
  };

  $("#newbtn").onclick = plant;


  if (store.local) {
    $("#closebtn").hidden = true;
    const share = $("#sharebtn");
    share.hidden = false;
    share.onclick = async () => {
      const url = await store.shareLink();
      if (!url) { toast("Plant something first, an empty vine has nothing to share", true); return; }
      try {
        await navigator.clipboard.writeText(url);
        toast(`Link copied, ${url.length.toLocaleString()} characters. It carries the whole board and touches no server`);
      } catch {

        window.prompt("Copy this link", url);
      }
    };
  }


  $("#groundbtn").onclick = () => (S.ground ? shutGround() : openGround());
  $("#groundshut").onclick = shutGround;
  let gT = 0;
  $("#gq").addEventListener("input", () => {
    clearTimeout(gT);
    gT = setTimeout(renderGround, 160);
  });
  const af = $("#autofall");
  af.checked = S.autofall;
  af.onchange = () => {
    S.autofall = af.checked;
    localStorage.setItem("ivy.autofall", S.autofall ? "1" : "0");
    toast(S.autofall
      ? "Finished growth will fall by itself from now on"
      : "Finished growth stays on the vine until you drop it");
  };

  $("#nothing-back").onclick = showWholeVine;

  $("#closebtn").onclick = async () => {
    await store.close();
    toast("Board closed. You can shut this tab.");
    window.close();
  };


  const grip = $("#railgrip");
  const rail = $("#rail");
  grip.addEventListener("pointerdown", (e) => {
    grip.setPointerCapture(e.pointerId);
    rail.classList.add("dragging");
    const move = (ev) => railDrag(ev);
    const up = () => {
      rail.classList.remove("dragging");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
  rail.addEventListener("click", (e) => { if (e.target === grip || grip.contains(e.target)) return; railDrag(e); });
}

function openLens() {
  const vis = S.items;
  const box = $("#lens");
  box.innerHTML =
    `<h4>Lens</h4>` +
    LENSES.map((l) => {
      const n = vis.filter(l.test).length;
      return `<button type="button" data-lens="${l.id}" aria-pressed="${S.lens === l.id}" title="${esc(l.hint)}">
        <svg class="tick" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 6.4 4.6 9 10 3.2"/></svg>
        <span>${esc(l.name)}</span><span class="n">${n}</span></button>`;
    }).join("") +
    `<hr><h4>Project</h4>` +
    S.doc.projects.map((p) => {
      const n = vis.filter((i) => i.project === p.id).length;
      if (!n) return "";
      return `<button type="button" data-proj="${p.id}" aria-pressed="${S.lens === "proj:" + p.id}">
        <svg class="tick" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 6.4 4.6 9 10 3.2"/></svg>
        <span>${esc(p.name)}</span><span class="n">${n}</span></button>`;
    }).join("");
  box.hidden = false;
  $("#lensbtn").setAttribute("aria-expanded", "true");
  $$("#lens button").forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.lens || ("proj:" + b.dataset.proj);
      S.lens = id;
      $("#lenslabel").textContent = b.querySelector("span").textContent;
      closeLens();
      keepTheOpenOne();
      layout(); paint(true); window.scrollTo(0, 0);
      panToOpen();
    };
  });
}
function closeLens() { $("#lens").hidden = true; $("#lensbtn").setAttribute("aria-expanded", "false"); }

function realLens() {
  if (S.lens.startsWith("proj:")) {
    const p = S.lens.slice(5);
    return { id: S.lens, test: (i) => i.project === p };
  }
  return LENSES.find((l) => l.id === S.lens) || LENSES[0];
}

function plant() {
  S.open = "__new";
  pan(0);
  $("#platewrap").hidden = false;
  $("#leaders").innerHTML = "";
  const p = $("#plate");
  p.innerHTML = `
  <button class="plate-shut" id="shut" type="button" aria-label="Close">
    <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>
  </button>
  <div class="plate-head">
    <p class="plate-eyebrow"><span class="dot"></span><span>New growth</span></p>
    <h2 id="plate-title">Plant something</h2>
  </div>
  <section class="sec">
    <h3>What is it</h3>
    <label class="reply"><textarea id="newtitle" rows="2" placeholder="One line. The thing itself, not the plan for it."></textarea></label>
  </section>
  <section class="sec">
    <h3>Why it matters</h3>
    <label class="reply"><textarea id="newwhy" rows="2" placeholder="Optional. One line of context, so future you never has to ask what this was."></textarea></label>
  </section>
  <section class="sec">
    <h3>Which vine</h3>
    <div class="chips" id="newproj">
      ${S.doc.projects.map((x) => `<button class="chip" type="button" data-p="${x.id}" aria-pressed="${x.id === "misc"}">${esc(x.name)}</button>`).join("")}
    </div>
  </section>
  <section class="sec">
    <h3>Whose</h3>
    <div class="chips" id="newstatus">
      ${["open", "mine", "blocked-vi"].map((k, i) => `<button class="chip" type="button" data-s="${k}" aria-pressed="${i === 0}">${esc(S.doc.statuses[k].label.replace("Blocked on Vi", "Blocked on you"))}</button>`).join("")}
    </div>
    <div class="replyrow">
      <button class="act" id="doplant" type="button">Plant it</button>
      <span class="note" id="postnote"></span>
    </div>
  </section>`;
  let proj = "misc", status = "open";
  const pick = (sel, set) => $$(sel + " .chip", p).forEach((c) => {
    c.onclick = () => {
      $$(sel + " .chip", p).forEach((o) => o.setAttribute("aria-pressed", "false"));
      c.setAttribute("aria-pressed", "true");
      set(c.dataset.p || c.dataset.s);
    };
  });
  pick("#newproj", (v) => (proj = v));
  pick("#newstatus", (v) => (status = v));
  $("#shut", p).onclick = shutPlate;
  $("#doplant", p).onclick = () => {
    const title = $("#newtitle", p).value.replace(/\s+/g, " ").trim();
    if (!title) { $("#postnote", p).textContent = "It needs a name."; $("#newtitle", p).focus(); return; }
    const why = $("#newwhy", p).value.replace(/\s+/g, " ").trim();
    const ops = [{ type: "add", title, project: proj, status, why }];
    S.open = null;

    S.order = null;
    send(ops, "Planted at the top of the vine");
    $("#platewrap").hidden = true;
  };
  $("#newtitle", p).focus();
}

function litterLeaf(seed) {
  const svg = el("svg", { viewBox: "-15 -20 30 26", "aria-hidden": "true" });
  const g = el("g");
  const tilt = ((hashId(seed + "f") % 100) / 100 - 0.5) * 1.5;

  leafAt(g, [[0, 9], [0, 6], [0, 3], [0, 0]], 1, 15, hashId(seed) % 2 ? 1 : -1, tilt, seed, true);
  svg.appendChild(g);
  return svg;
}

function openGround() {
  S.ground = true;
  $("#ground").hidden = false;
  $("#groundbtn").setAttribute("aria-expanded", "true");
  document.body.style.overflow = "hidden";
  renderGround();
  $("#groundshut").focus();
}

function shutGround() {
  S.ground = false;
  $("#ground").hidden = true;
  $("#groundbtn").setAttribute("aria-expanded", "false");
  document.body.style.overflow = "";
  $("#groundbtn").focus();
}

function renderGround() {
  const q = ($("#gq").value || "").trim().toLowerCase();
  const all = litter();
  const shown = q
    ? all.filter((it) => (it.title + " " + (it.why || "") + " " + it.id).toLowerCase().includes(q))
    : all;

  shown.sort((a, b) => (grown(b) || "").localeCompare(grown(a) || ""));

  $("#ground-sub").innerHTML = all.length
    ? `<b>${all.length}</b> fallen${q ? ` · <b>${shown.length}</b> match` : ""}. Nothing here is deleted, and anything can go back on the vine.`
    : "Nothing has fallen yet. Finished growth lands here.";


  const ready = readyToFall();
  const sweep = $("#groundsweep");
  if (ready.length) {
    sweep.hidden = false;
    sweep.innerHTML = `<p><b>${ready.length}</b> finished item${ready.length === 1 ? " is" : "s are"} still on the vine.
      Letting ${ready.length === 1 ? "it" : "them"} fall shortens the vine by that much and changes nothing else.</p>
      <button class="act ghost" id="sweepbtn" type="button">Let ${ready.length === 1 ? "it" : "them"} fall</button>`;
    $("#sweepbtn").onclick = () => {
      send(ready.map((it) => ({ type: "patch", id: it.id, fields: { archived: true } })),
        `${ready.length} fell to the ground`);
    };
  } else {
    sweep.hidden = true;
    sweep.innerHTML = "";
  }

  const priv = $("#groundprivacy");
  if (store.local) {
    priv.hidden = false;
    priv.innerHTML = `<h3>Where this board lives</h3>
      <p>In this browser, and nowhere else. There is no account, no server and no copy of it anywhere
      but here, which also means clearing this site's data clears the board. A share link carries the
      whole thing inside the part of a URL that browsers never send to a server.</p>
      <div class="ground-acts">
        ${store.hasBackup() ? `<button class="act ghost" id="restorebtn" type="button">Put my own board back</button>` : ""}
        <button class="act ghost danger" id="forgetbtn" type="button">Erase everything</button>
      </div>`;
    const rb = $("#restorebtn");
    if (rb) rb.onclick = () => { store.restoreBackup(); location.reload(); };
    $("#forgetbtn").onclick = () => {

      const b = $("#forgetbtn");
      if (b.dataset.sure !== "1") {
        b.dataset.sure = "1";
        b.textContent = "Erase everything, really";
        setTimeout(() => { b.dataset.sure = ""; b.textContent = "Erase everything"; }, 5000);
        return;
      }
      store.forget();
      location.reload();
    };
  }

  const bed = $("#litter");
  bed.textContent = "";
  if (!shown.length) {
    const p = hel("p", { class: "ground-empty" });
    p.textContent = q ? `Nothing in the litter matches "${q}".` : "The ground is bare.";
    bed.appendChild(p);
    return;
  }

  let month = "";
  for (const it of shown) {
    const d = grown(it);
    const m = d.slice(0, 7);
    if (m !== month) {
      month = m;
      const h = hel("div", { class: "drift-when" });
      h.appendChild(hel("span", {}, monthLabel(m)));
      const wrap = hel("div", { class: "drift" });
      wrap.appendChild(h);
      bed.appendChild(wrap);
    }
    const row = hel("button", { class: "fell", type: "button", "data-id": it.id });
    row.appendChild(litterLeaf(it.id));
    row.appendChild(hel("span", { class: "what" }, plainTitle(it.title)));
    row.appendChild(hel("span", { class: "when" }, prettyDate(d) || d));
    row.onclick = () => { shutGround(); openPlate(it.id); };
    bed.lastChild.appendChild(row);
  }
}

function monthLabel(m) {
  const [y, mo] = m.split("-");
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${names[Number(mo) - 1] || m} ${y}`;
}

function dropVisual(id) {
  const g = $(`#vine .branch[data-id="${CSS.escape(id)}"]`);
  if (!g) return 0;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    g.classList.add("dropping-fast");
    return 320;
  }

  const leaves = $$(".leafg", g);
  let after = 0;
  if (leaves.length) {
    leaves.forEach((l, i) => {
      l.style.animationDelay = (i * 90) + "ms";
      l.classList.add("dropping");
    });
    after = leaves.length * 90 + 320;
  }
  g.style.animationDelay = after + "ms";
  g.classList.add("dropping-branch");
  return after + 1100;
}

function letFall(it, note) {

  if (S.falling.has(it.id)) return;
  const write = () => {
    S.falling.delete(it.id);
    send([{ type: "patch", id: it.id, fields: { archived: true } }],
      note || `${plainTitle(it.title).slice(0, 34)} fell to the ground`);
  };
  const ms = dropVisual(it.id);
  if (!ms) { write(); return; }
  S.falling.add(it.id);
  setTimeout(write, ms);
}

function regrow(it) {
  send([{ type: "patch", id: it.id, fields: { archived: false } }],
    `${plainTitle(it.title).slice(0, 34)} is back on the vine`);
}

function showWholeVine() {
  S.query = "";
  $("#q").value = "";
  S.lens = "all";
  $("#lenslabel").textContent = "All growth";
  keepTheOpenOne();
  layout(); paint(true); window.scrollTo(0, 0);
  panToOpen();
}

function countLine(vis) {
  const active = S.items.filter(isActive).length;
  const you = S.items.filter((i) => NEEDS_VI.includes(i.status)).length;
  const shown = vis.length;
  const lens = S.lens === "all" && !S.query ? "" : ` · showing <b>${shown}</b>`;
  const held = S.hold.size ? ` · <b>${S.hold.size}</b> kept` : "";

  const canFold = (S.spanKeys || []).length > 0;
  const fold = (S.folded ? ` · <b>${S.folded}</b> folded` : "")
    + (canFold ? ` · <button type="button" class="linky" id="unfold">${S.spans.size ? "fold it all back" : "show every one"}</button>` : "");

  const down = litter().length;
  const ground = down ? ` · <b>${down}</b> <button type="button" class="linky" id="togr">on the ground</button>` : "";
  $("#count").innerHTML =
    `<b>${active}</b> living · <b>${you}</b> need you · <b>${S.items.length - active}</b> woody${lens}${held}${fold}${ground}`;
  const gr = $("#togr");
  if (gr) gr.onclick = openGround;


  const box = $("#nothing");
  if (shown) { box.hidden = true; return; }


  if (store.local && !S.items.length && !S.query.trim()) {
    $("#nothing-what").innerHTML =
      `<b>This is Ivy.</b> Your work as one vine, newest growth at the top, older growth further down.
       Finish something and its leaf falls to the ground, which is the archive.
       Everything stays in this browser.`;
    $("#nothing-back").textContent = "Plant the first thing";
    $("#nothing-back").onclick = plant;
    box.hidden = false;
    return;
  }

  $("#nothing-back").textContent = "Show the whole vine";
  $("#nothing-back").onclick = showWholeVine;
  const lensName = (LENSES.find((l) => l.id === S.lens) || {}).name
    || (S.doc.projects.find((x) => "proj:" + x.id === S.lens) || {}).name
    || "this lens";
  $("#nothing-what").innerHTML = S.query.trim()
    ? `Nothing on the vine matches <b>${esc(S.query.trim())}</b>.`
    : `<b>${esc(lensName)}</b> is empty. Nothing here is growing.`;
  box.hidden = false;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function md(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\bhttps?:\/\/[^\s<)]+/g, (u) => `<a href="${u}" target="_blank" rel="noreferrer">${u}</a>`);
}
const plainTitle = (t) => String(t || "").replace(/[*`_]/g, "").trim();
function dayLabel(d) {
  if (!d) return "";
  const [, m, day] = d.split("-");
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1] || m;
  return `${M} ${Number(day)}`;
}

window.__ivy = S;
window.__ivyLayout = layout;

window.__ivyOpen = openPlate;
