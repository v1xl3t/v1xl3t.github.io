

export const ACTIVE = ["open", "mine", "blocked-vi", "blocked-ext", "review", "triage", "parked"];

export const NEEDS_VI = ["blocked-vi", "mine", "review"];

export const WEIGHTS = {

  priority: {
    p1: 1500,
    p2: 700,
    p3: 0,
    p4: -700,
    "": 0,
  },
  status: {
    "blocked-vi": 1000,



    mine: 900,
    review: 600,
    open: 300,
    "blocked-ext": 120,
    parked: 40,
    triage: 10,
    done: 0,
    dropped: 0,
  },




  pinned: 2000,
  perUnblock: 60,
  unblockCap: 240,
  perDay: 2,
  ageCap: 60,
  unmetPrereq: -200,
  askHelp: 90,




  dueCurve: [
    [-1, 1600],
    [0, 1400],
    [1, 1150],
    [3, 850],
    [7, 550],
    [14, 320],
    [30, 160],
    [Infinity, 60],
  ],
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function todayStamp() {
  return new Date().toLocaleDateString("en-CA");
}

export function prettyDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ""))) return "";
  const [, m, day] = d.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(day)}`;
}

export function daysBetween(from, to) {
  if (!from) return 0;
  const a = new Date(from + "T12:00:00").getTime();
  const b = new Date(to + "T12:00:00").getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

export function daysUntil(due, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due || ""))) return null;
  const a = new Date(today + "T12:00:00").getTime();
  const b = new Date(due + "T12:00:00").getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

export function dueBoost(it, ctx) {
  if (!it.due || !isActive(it)) return 0;
  const left = daysUntil(it.due, ctx.today);
  if (left === null) return 0;
  for (const [limit, boost] of WEIGHTS.dueCurve) if (left <= limit) return boost;
  return 0;
}

export function lastTouched(it) {
  const dates = (it.log || [])
    .filter((l) => String(l.author || "").toLowerCase() !== "ready")
    .map((l) => (l.at ? String(l.at).slice(0, 10) : l.date))
    .filter(Boolean);
  if (dates.length) return dates.sort().pop();
  return it.created || null;
}

export function context(items, today = todayStamp()) {
  const live = items.filter((i) => !i.archived);
  const byId = new Map(items.map((i) => [i.id, i]));
  const unblocks = new Map();
  for (const it of live) {
    for (const dep of it.needs || []) unblocks.set(dep, (unblocks.get(dep) || 0) + 1);
  }
  return { items: live, byId, unblocks, today };
}

export const isActive = (it) => ACTIVE.includes(it.status);
export const unblockCount = (it, ctx) => ctx.unblocks.get(it.id) || 0;
export const unmetPrereqs = (it, ctx) =>
  (it.needs || []).map((id) => ctx.byId.get(id)).filter((d) => d && isActive(d)).length;

export function score(it, ctx) {
  const w = WEIGHTS;
  let s = w.status[it.status] ?? 0;
  s += w.priority[it.priority || ""] ?? 0;
  s += Math.min(w.unblockCap, unblockCount(it, ctx) * w.perUnblock);
  s += Math.min(w.ageCap, daysBetween(lastTouched(it), ctx.today) * w.perDay);
  s += dueBoost(it, ctx);

  if (it.pinned && it.pinned === ctx.today && isActive(it)) s += w.pinned;
  if (unmetPrereqs(it, ctx)) s += w.unmetPrereq;
  if (it.askHelp) s += w.askHelp;

  s -= Math.min(9, Number(it.rank) || 0) * 0.1;
  return s;
}

export function reason(it, ctx) {
  const parts = [];
  const touched = lastTouched(it);
  const age = daysBetween(touched, ctx.today);
  const since = age === 0 ? "as of today" : age === 1 ? "since yesterday" : `since ${prettyDate(touched)}`;




  const left = it.due && isActive(it) ? daysUntil(it.due, ctx.today) : null;
  if (left !== null) {
    if (left < 0) parts.push(`OVERDUE by ${-left} day${left === -1 ? "" : "s"}, was due ${prettyDate(it.due)}`);
    else if (left === 0) parts.push("DUE TODAY");
    else if (left === 1) parts.push("due tomorrow");
    else parts.push(`due in ${left} days, ${prettyDate(it.due)}`);
  }



  if (it.priority === "p1") parts.push("CRITICAL");
  else if (it.priority === "p2") parts.push("high priority");

  if (it.status === "blocked-vi") parts.push(`blocked on you ${since}`);
  else if (it.status === "mine") parts.push(`yours to do, sitting ${since}`);
  else if (it.status === "review") parts.push(`needs review, live ${since}`);
  else if (it.status === "triage") parts.push(`needs triage, imported ${it.source?.file ? `from ${it.source.file}` : "from an older file"}`);
  else if (it.status === "parked") parts.push(`on hold ${since}`);
  else if (it.status === "blocked-ext") parts.push(`waiting on the outside world ${since}`);
  else if (it.status === "open") parts.push(it.askHelp ? "you asked Ready to look into this" : `open for Ready ${since}`);
  else parts.push(`${it.status} ${since}`);

  const pend = unmetPrereqs(it, ctx);
  const un = unblockCount(it, ctx);
  if (pend) parts.push(`waiting on ${pend} other item${pend > 1 ? "s" : ""} first`);
  else if (un) parts.push(`unblocks ${un} other${un > 1 ? "s" : ""}`);
  return parts.slice(0, 2).join(", ");
}

export function ranked(list, ctx) {
  return [...list]
    .map((it) => ({ item: it, score: score(it, ctx), why: reason(it, ctx) }))
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
}

export function todayList(items, max = 3, today = todayStamp()) {
  const ctx = context(items, today);
  const mine = ctx.items.filter((i) => NEEDS_VI.includes(i.status));

  const pinnedToday = mine.filter((i) => i.pinned === today).length;
  const picks = ranked(mine, ctx).slice(0, Math.max(max, pinnedToday));
  const ready = picks.length ? [] : ranked(ctx.items.filter((i) => i.status === "open"), ctx).slice(0, max);
  return {
    mode: picks.length ? "yours" : "ready",
    picks,
    ready,
    waiting: mine.length,
    more: Math.max(0, mine.length - picks.length),
    triage: ctx.items.filter((i) => i.status === "triage").length,
    summary: summary(items, today),
    ctx,
  };
}

export function summary(items, today = todayStamp()) {
  const live = items.filter((i) => !i.archived);
  const active = live.filter(isActive).length;
  const decide = live.filter((i) => i.status === "blocked-vi").length;
  const review = live.filter((i) => i.status === "review").length;
  const triage = live.filter((i) => i.status === "triage").length;
  const text = `${active} active, ${decide} to decide, ${review} to review, ${triage} to triage`;
  return { active, needVi: decide + review, decide, review, triage, text, today };
}
