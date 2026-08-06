// sketch.js — the parametric 2D sketch: entities, constraints, solving, and the
// closed profile that feeds a feature (extrude / revolve).
//
// This is the piece that makes CADence parametric rather than merely editable.
// A sketch is not a frozen list of coordinates; it is a set of entities plus the
// *rules* relating them. Change a dimension and the solver moves the geometry to
// obey the rules again, which is exactly what "driven by dimensions" means.
//
// Coordinates are millimetres in the sketch plane. Nothing here imports THREE or
// touches the DOM, so the whole engine is testable headless.

import { solveLM, numericJacobian, matrixRank } from './solver.js';

export const TESS_SEGMENTS = 48;   // default tessellation for circles and arcs

// ---------------------------------------------------------------- document

let _uid = 0;
const nid = (p) => `${p}${(++_uid).toString(36)}`;

/** A fresh, empty sketch on a plane, carrying a fixed origin point. */
export function createSketch(plane = 'XZ') {
  return {
    plane,                                   // 'XY' | 'XZ' | 'YZ'
    points: [{ id: 'origin', x: 0, y: 0, fixed: true }],
    entities: [],
    constraints: [],
  };
}

export function addPoint(sk, x, y, fixed = false) {
  const p = { id: nid('p'), x, y, fixed };
  sk.points.push(p);
  return p;
}

export function addLine(sk, p1, p2) {
  const e = { id: nid('e'), type: 'line', p1, p2 };
  sk.entities.push(e);
  return e;
}

export function addCircle(sk, c, r) {
  const e = { id: nid('e'), type: 'circle', c, r };
  sk.entities.push(e);
  return e;
}

/** Arc from p1 to p2 about centre c. Radius is derived, not a free variable. */
export function addArc(sk, c, p1, p2, ccw = true) {
  const e = { id: nid('e'), type: 'arc', c, p1, p2, ccw };
  sk.entities.push(e);
  return e;
}

export function addConstraint(sk, con) {
  const c = { id: nid('c'), ...con };
  sk.constraints.push(c);
  return c;
}

export function removeConstraint(sk, id) {
  const i = sk.constraints.findIndex((c) => c.id === id);
  if (i >= 0) sk.constraints.splice(i, 1);
  return i >= 0;
}

/** A rectangle as four lines plus the constraints that make it a rectangle. */
export function addRectangle(sk, x1, y1, x2, y2) {
  const a = addPoint(sk, x1, y1);
  const b = addPoint(sk, x2, y1);
  const c = addPoint(sk, x2, y2);
  const d = addPoint(sk, x1, y2);
  const l1 = addLine(sk, a.id, b.id);
  const l2 = addLine(sk, b.id, c.id);
  const l3 = addLine(sk, c.id, d.id);
  const l4 = addLine(sk, d.id, a.id);
  addConstraint(sk, { type: 'horizontal', e: l1.id, auto: true });
  addConstraint(sk, { type: 'horizontal', e: l3.id, auto: true });
  addConstraint(sk, { type: 'vertical', e: l2.id, auto: true });
  addConstraint(sk, { type: 'vertical', e: l4.id, auto: true });
  return { points: [a, b, c, d], lines: [l1, l2, l3, l4] };
}

// ---------------------------------------------------------------- variables

// The variable vector is every non-fixed point coordinate followed by every
// circle radius. Fixed points are left out entirely rather than pinned with a
// residual, which keeps the system smaller and the degree-of-freedom count
// honest.
function buildVarMap(sk) {
  const idx = new Map();
  const x0 = [];
  for (const p of sk.points) {
    if (p.fixed) continue;
    idx.set(`${p.id}.x`, x0.length); x0.push(p.x);
    idx.set(`${p.id}.y`, x0.length); x0.push(p.y);
  }
  for (const e of sk.entities) {
    if (e.type === 'circle') { idx.set(`${e.id}.r`, x0.length); x0.push(e.r); }
  }
  return { idx, x0 };
}

function readerFor(sk, idx, x) {
  const pts = new Map(sk.points.map((p) => [p.id, p]));
  const ents = new Map(sk.entities.map((e) => [e.id, e]));
  const P = (id) => {
    const p = pts.get(id);
    if (!p) throw new Error(`sketch: unknown point ${id}`);
    if (p.fixed) return { x: p.x, y: p.y };
    return { x: x[idx.get(`${id}.x`)], y: x[idx.get(`${id}.y`)] };
  };
  const E = (id) => {
    const e = ents.get(id);
    if (!e) throw new Error(`sketch: unknown entity ${id}`);
    return e;
  };
  const R = (id) => {
    const e = E(id);
    if (e.type === 'circle') return x[idx.get(`${e.id}.r`)];
    if (e.type === 'arc') { const c = P(e.c), a = P(e.p1); return Math.hypot(a.x - c.x, a.y - c.y); }
    throw new Error(`sketch: ${id} has no radius`);
  };
  return { P, E, R };
}

// ---------------------------------------------------------------- constraints

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const len = (a) => Math.hypot(a.x, a.y);

// Each entry returns its residuals. A residual of zero means satisfied. Where a
// choice exists, prefer a formulation whose magnitude is in millimetres so the
// solver weights every constraint comparably.
export const CONSTRAINTS = {
  coincident: {
    label: () => 'Coincident',
    f: ({ P }, c) => { const d = sub(P(c.a), P(c.b)); return [d.x, d.y]; },
  },
  horizontal: {
    label: () => 'Horizontal',
    f: ({ P, E }, c) => { const e = E(c.e); return [P(e.p1).y - P(e.p2).y]; },
  },
  vertical: {
    label: () => 'Vertical',
    f: ({ P, E }, c) => { const e = E(c.e); return [P(e.p1).x - P(e.p2).x]; },
  },
  parallel: {
    label: () => 'Parallel',
    f: ({ P, E }, c) => {
      const a = E(c.a), b = E(c.b);
      const d1 = sub(P(a.p2), P(a.p1)), d2 = sub(P(b.p2), P(b.p1));
      const s = Math.max(len(d1), 1e-9) * Math.max(len(d2), 1e-9);
      return [cross(d1, d2) / s * Math.max(len(d1), len(d2))];
    },
  },
  perpendicular: {
    label: () => 'Perpendicular',
    f: ({ P, E }, c) => {
      const a = E(c.a), b = E(c.b);
      const d1 = sub(P(a.p2), P(a.p1)), d2 = sub(P(b.p2), P(b.p1));
      const s = Math.max(len(d1), 1e-9) * Math.max(len(d2), 1e-9);
      return [dot(d1, d2) / s * Math.max(len(d1), len(d2))];
    },
  },
  equal: {
    label: () => 'Equal',
    f: ({ P, E, R }, c) => {
      const a = E(c.a), b = E(c.b);
      const la = a.type === 'line' ? len(sub(P(a.p2), P(a.p1))) : R(a.id);
      const lb = b.type === 'line' ? len(sub(P(b.p2), P(b.p1))) : R(b.id);
      return [la - lb];
    },
  },
  distance: {
    label: (c) => `Distance ${fmt(c.value)}`,
    dim: true,
    f: ({ P }, c) => [len(sub(P(c.b), P(c.a))) - c.value],
  },
  distanceX: {
    label: (c) => `Horizontal distance ${fmt(c.value)}`,
    dim: true,
    f: ({ P }, c) => [(P(c.b).x - P(c.a).x) - c.value],
  },
  distanceY: {
    label: (c) => `Vertical distance ${fmt(c.value)}`,
    dim: true,
    f: ({ P }, c) => [(P(c.b).y - P(c.a).y) - c.value],
  },
  radius: {
    label: (c) => `Radius ${fmt(c.value)}`,
    dim: true,
    f: ({ R }, c) => [R(c.e) - c.value],
  },
  diameter: {
    label: (c) => `Diameter ${fmt(c.value)}`,
    dim: true,
    f: ({ R }, c) => [2 * R(c.e) - c.value],
  },
  angle: {
    // Signed angle between two line directions, in degrees, wrapped to the
    // nearest turn so the solver never fights a 359 vs -1 discontinuity.
    label: (c) => `Angle ${fmt(c.value)}°`,
    dim: true,
    f: ({ P, E }, c) => {
      const a = E(c.a), b = E(c.b);
      const d1 = sub(P(a.p2), P(a.p1)), d2 = sub(P(b.p2), P(b.p1));
      let deg = (Math.atan2(cross(d1, d2), dot(d1, d2)) * 180) / Math.PI;
      let err = deg - c.value;
      while (err > 180) err -= 360;
      while (err < -180) err += 360;
      return [err * 0.05];   // degrees scaled toward millimetre magnitudes
    },
  },
  pointOnLine: {
    label: () => 'Point on line',
    f: ({ P, E }, c) => {
      const e = E(c.e);
      const d = sub(P(e.p2), P(e.p1));
      const v = sub(P(c.p), P(e.p1));
      return [cross(d, v) / Math.max(len(d), 1e-9)];
    },
  },
  concentric: {
    label: () => 'Concentric',
    f: ({ P, E }, c) => { const d = sub(P(E(c.a).c), P(E(c.b).c)); return [d.x, d.y]; },
  },
  tangent: {
    // Line tangent to a circle or arc: the perpendicular distance from the
    // centre to the line equals the radius.
    label: () => 'Tangent',
    f: ({ P, E, R }, c) => {
      const line = E(c.e), circ = E(c.c);
      const d = sub(P(line.p2), P(line.p1));
      const v = sub(P(circ.c), P(line.p1));
      const dist = Math.abs(cross(d, v)) / Math.max(len(d), 1e-9);
      return [dist - R(circ.id)];
    },
  },
  symmetric: {
    // Two points mirrored about a line: their midpoint lies on the line and the
    // segment joining them is perpendicular to it.
    label: () => 'Symmetric',
    f: ({ P, E }, c) => {
      const e = E(c.e);
      const a = P(c.a), b = P(c.b);
      const l1 = P(e.p1), d = sub(P(e.p2), l1);
      const dl = Math.max(len(d), 1e-9);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const onLine = cross(d, sub(mid, l1)) / dl;
      const perp = dot(d, sub(b, a)) / dl;
      return [onLine, perp];
    },
  },
  fix: {
    label: () => 'Fixed',
    f: ({ P }, c) => { const p = P(c.p); return [p.x - c.x, p.y - c.y]; },
  },
};

function fmt(v) {
  return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '?';
}

/** Human label for a constraint, used by the inspector list. */
export function constraintLabel(c) {
  return CONSTRAINTS[c.type]?.label(c) ?? c.type;
}

/** Dimensional constraints are the ones carrying an editable driving value. */
export function isDimension(c) {
  return !!CONSTRAINTS[c.type]?.dim;
}

// ---------------------------------------------------------------- solving

function buildResidualFn(sk, idx) {
  // Arcs need their two endpoints equidistant from the centre, otherwise the
  // "arc" is not an arc. The user never sees this one, so it is implicit.
  const implicit = sk.entities
    .filter((e) => e.type === 'arc')
    .map((e) => ({ type: '_arcRadius', e: e.id }));

  const all = [...sk.constraints, ...implicit];

  return (x) => {
    const ctx = readerFor(sk, idx, x);
    const out = [];
    for (const c of all) {
      if (c.type === '_arcRadius') {
        const e = ctx.E(c.e);
        const cc = ctx.P(e.c);
        out.push(len(sub(ctx.P(e.p1), cc)) - len(sub(ctx.P(e.p2), cc)));
        continue;
      }
      const def = CONSTRAINTS[c.type];
      if (!def) continue;
      const r = def.f(ctx, c);
      for (const v of r) out.push(Number.isFinite(v) ? v : 1e6);
    }
    return out;
  };
}

/**
 * Solve the sketch in place. Points and circle radii are updated to the solved
 * values. Returns a report the UI can show without further work.
 *
 * @returns {{ok:boolean, reason:string, dof:number, status:string, residual:number, iters:number}}
 */
export function solveSketch(sk, opts = {}) {
  const { idx, x0 } = buildVarMap(sk);
  const residualFn = buildResidualFn(sk, idx);

  if (!x0.length) {
    return { ok: true, reason: 'nothing to solve', dof: 0, status: 'fully', residual: 0, iters: 0 };
  }

  const res = solveLM(x0, residualFn, opts);
  writeBack(sk, idx, res.x);

  // Degree of freedom read-out, measured at the solution. The rank of the
  // Jacobian is how many independent constraints actually bite; anything left
  // over is free movement the user can still drag.
  const m = residualFn(res.x).length;
  let dof = x0.length;
  let status = 'under';
  if (m > 0) {
    const J = numericJacobian(res.x, residualFn, m);
    const rank = matrixRank(J);
    dof = x0.length - rank;
    if (!res.ok) status = 'conflict';
    else if (dof > 0) status = 'under';
    else if (m > rank) status = 'over';       // satisfied, but with redundancy
    else status = 'fully';
  }

  return { ok: res.ok, reason: res.reason, dof: Math.max(0, dof), status, residual: res.residual, iters: res.iters };
}

function writeBack(sk, idx, x) {
  for (const p of sk.points) {
    if (p.fixed) continue;
    p.x = x[idx.get(`${p.id}.x`)];
    p.y = x[idx.get(`${p.id}.y`)];
  }
  for (const e of sk.entities) {
    if (e.type === 'circle') e.r = x[idx.get(`${e.id}.r`)];
  }
}

/** Set a dimension's driving value and re-solve. This is the parametric edit. */
export function setDimension(sk, constraintId, value) {
  const c = sk.constraints.find((k) => k.id === constraintId);
  if (!c || !isDimension(c)) return null;
  const prev = c.value;
  c.value = value;
  const report = solveSketch(sk);
  if (!report.ok) c.value = prev;   // a value the sketch cannot reach is rejected
  return report;
}

// ---------------------------------------------------------------- profile

// Points that a constraint (or sheer proximity after solving) has welded
// together are one node as far as loop-walking is concerned.
function unionFind(sk) {
  const parent = new Map(sk.points.map((p) => [p.id, p.id]));
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const c of sk.constraints) if (c.type === 'coincident') union(c.a, c.b);
  // Positional welding catches endpoints the user dropped on top of each other
  // without an explicit constraint.
  for (let i = 0; i < sk.points.length; i++) {
    for (let j = i + 1; j < sk.points.length; j++) {
      const a = sk.points[i], b = sk.points[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) union(a.id, b.id);
    }
  }
  return find;
}

function arcPoints(c, p1, p2, ccw, segments) {
  const r = Math.hypot(p1.x - c.x, p1.y - c.y);
  let a0 = Math.atan2(p1.y - c.y, p1.x - c.x);
  let a1 = Math.atan2(p2.y - c.y, p2.x - c.x);
  let sweep = a1 - a0;
  if (ccw) { while (sweep <= 0) sweep += Math.PI * 2; }
  else { while (sweep >= 0) sweep -= Math.PI * 2; }
  const n = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * segments));
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    out.push([c.x + r * Math.cos(t), c.y + r * Math.sin(t)]);
  }
  return out;   // excludes the start point, which the walker already emitted
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Walk the entities into a single closed loop and tessellate it into the flat
 * [[x, y], ...] profile the feature builder consumes.
 *
 * @returns {{profile:number[][]|null, closed:boolean, reason:string}}
 */
export function sketchProfile(sk, segments = TESS_SEGMENTS) {
  const curves = sk.entities.filter((e) => e.type === 'line' || e.type === 'arc' || e.type === 'circle');
  if (!curves.length) return { profile: null, closed: false, reason: 'the sketch is empty' };

  // A lone circle is already a closed profile.
  const circles = curves.filter((e) => e.type === 'circle');
  if (circles.length === 1 && curves.length === 1) {
    const e = circles[0];
    const c = sk.points.find((p) => p.id === e.c);
    const pts = [];
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      pts.push([c.x + e.r * Math.cos(t), c.y + e.r * Math.sin(t)]);
    }
    return { profile: orient(pts), closed: true, reason: 'circle' };
  }
  if (circles.length) {
    return { profile: null, closed: false, reason: 'a circle cannot be chained with other curves yet' };
  }

  const find = unionFind(sk);
  const P = new Map(sk.points.map((p) => [p.id, p]));
  const nodeOf = (pid) => find(pid);

  // Adjacency over welded nodes.
  const adj = new Map();
  for (const e of curves) {
    const a = nodeOf(e.p1), b = nodeOf(e.p2);
    if (a === b) return { profile: null, closed: false, reason: 'a curve starts and ends at the same point' };
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push({ e, to: b });
    adj.get(b).push({ e, to: a });
  }

  for (const [node, list] of adj) {
    if (list.length !== 2) {
      return {
        profile: null, closed: false,
        reason: list.length < 2 ? 'the loop is open, an endpoint is unconnected' : 'more than two curves meet at a point',
      };
    }
  }

  // Walk it.
  const startNode = adj.keys().next().value;
  const used = new Set();
  const out = [];
  let node = startNode;
  let guard = 0;

  do {
    const step = adj.get(node).find((s) => !used.has(s.e.id));
    if (!step) break;
    used.add(step.e.id);
    const e = step.e;
    const fromPid = nodeOf(e.p1) === node ? e.p1 : e.p2;
    const toPid = fromPid === e.p1 ? e.p2 : e.p1;
    const from = P.get(fromPid), to = P.get(toPid);
    out.push([from.x, from.y]);
    if (e.type === 'arc') {
      const c = P.get(e.c);
      // Walking the arc backwards flips its sweep direction.
      const ccw = fromPid === e.p1 ? e.ccw : !e.ccw;
      const seg = arcPoints(c, from, to, ccw, segments);
      seg.pop();                        // the endpoint is the next curve's start
      for (const s of seg) out.push(s);
    }
    node = step.to;
  } while (node !== startNode && ++guard < curves.length + 2);

  if (used.size !== curves.length || node !== startNode) {
    return { profile: null, closed: false, reason: 'the curves do not form one closed loop' };
  }
  if (out.length < 3) return { profile: null, closed: false, reason: 'a profile needs at least three points' };

  return { profile: orient(out), closed: true, reason: 'closed' };
}

// Extrusion wants a consistent winding; counter-clockwise keeps normals outward.
function orient(pts) {
  return signedArea(pts) < 0 ? [...pts].reverse() : pts;
}

// ---------------------------------------------------------------- helpers

/** Every dimensional constraint, in a shape the inspector can render directly. */
export function dimensionList(sk) {
  return sk.constraints
    .filter(isDimension)
    .map((c) => ({ id: c.id, type: c.type, value: c.value, label: constraintLabel(c) }));
}

/** Deep copy, used when a recipe snapshot must not alias the live sketch. */
export function cloneSketch(sk) {
  return JSON.parse(JSON.stringify(sk));
}

/**
 * Build a sketch from a plain polygon, so the freehand tool and the constrained
 * sketcher produce the same kind of object. Consecutive points share ids, which
 * is what makes the loop closed by construction.
 */
export function sketchFromPolygon(profile, plane = 'XZ') {
  const sk = createSketch(plane);
  const ids = profile.map((p) => addPoint(sk, p[0], p[1]).id);
  for (let i = 0; i < ids.length; i++) addLine(sk, ids[i], ids[(i + 1) % ids.length]);
  return sk;
}
