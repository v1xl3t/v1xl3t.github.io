// clip.js — the polygon algebra every other file in the slicer stands on.
//
// A slicer is, underneath the printer talk, one data structure repeated a few
// hundred times: the set of 2D regions that are solid at a given height. Walls
// are that set inset. Skins are that set differenced against the layer above.
// Supports are a union accumulated downward. Brims are an outset. So the whole
// machine reduces to offset, union, difference and intersect, done fast and
// done without ever producing a self-crossing ring.
//
// Clipper is the reference implementation of those four, so it does the work.
// This file is the boundary between Clipper's world and CADence's: Clipper
// wants integers and its own point objects, everything else here speaks
// millimetres as plain [x, y] arrays, exactly like src/profile.js does.
//
// TERMS used throughout the slicer:
//   ring    a closed loop, [[x, y], ...], no repeated last point.
//           Positive signed area means outer boundary, negative means hole.
//   region  an array of rings. Holes are simply rings with negative area that
//           happen to sit inside a positive one. Nothing tracks the nesting,
//           because none of the operations need it and Clipper re-derives it.
//   line    an open polyline, [[x, y], ...]. Infill and support ribs are lines.
//
// No THREE, no DOM, no printer knowledge. Runs headless under Bun.

import ClipperLib from './vendor/clipper.js';

const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType } = ClipperLib;

// One integer unit per micron. Clipper is exact on integers, so the only
// precision question is where we round, and a micron is two orders of magnitude
// finer than a 0.4mm nozzle can place plastic. Coordinates stay far inside the
// safe range: a 300mm bed is 3e5 units, and Clipper's limit is ~4.6e18.
export const SCALE = 1000;

// How far an offset arc may deviate from the true circle, in Clipper units.
// 10 = 0.01mm, a quarter of the finest layer this printer will ever run and far
// below what a 0.4mm nozzle can place, so the flattening is not visible in
// plastic. It still matters that it is bounded rather than exact: a rounded
// corner is emitted as chords, so an outset region's area always comes in a
// hair UNDER the true circle-cornered value, and tests have to expect that.
//
// Clipper internally caps this at 0.25 * |delta|, so small offsets get
// proportionally coarser arcs. That is the right behaviour: the arc on a 0.2mm
// bead radius does not deserve the same vertex budget as a 5mm brim.
const ARC_TOLERANCE = 10;

// Miter joins on a very sharp corner grow a spike toward infinity. Clipper caps
// it at this multiple of the offset distance and squares off beyond.
const MITER_LIMIT = 2;

// Rings whose area is under this (mm^2) are noise from an offset that has almost
// eaten itself. Keeping them produces zero-length extrusions and stutter.
const MIN_AREA = 1e-4;

const JOIN = { round: JoinType.jtRound, miter: JoinType.jtMiter, square: JoinType.jtSquare };

// ---------------------------------------------------------------------------
// conversion
// ---------------------------------------------------------------------------

const toPath = (ring) => {
  const path = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) {
    path[i] = { X: Math.round(ring[i][0] * SCALE), Y: Math.round(ring[i][1] * SCALE) };
  }
  return path;
};

const fromPath = (path) => {
  const ring = new Array(path.length);
  for (let i = 0; i < path.length; i++) ring[i] = [path[i].X / SCALE, path[i].Y / SCALE];
  return ring;
};

export const toPaths = (region) => (region || []).filter((r) => r && r.length >= 3).map(toPath);
export const fromPaths = (paths) => (paths || []).map(fromPath).filter((r) => r.length >= 3);

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

/** Signed area of one ring, mm^2. Positive is counter-clockwise (outer). */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Net enclosed area of a region, mm^2. Holes subtract because their rings
 *  carry negative area, so the plain sum is already the answer. */
export function area(region) {
  let a = 0;
  for (const ring of region || []) a += ringArea(ring);
  return a;
}

/** Perimeter of one ring, mm. Used for time estimates and seam placement. */
export function ringLength(ring) {
  let L = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    L += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return L;
}

/** Length of an open polyline, mm. */
export function lineLength(line) {
  let L = 0;
  for (let i = 1; i < line.length; i++) L += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return L;
}

/** Axis-aligned bounds of a region or a list of lines. Returns null when empty. */
export function bounds(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths || []) {
    for (const pt of p) {
      if (pt[0] < minX) minX = pt[0];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[1] > maxY) maxY = pt[1];
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Even-odd ray cast against a whole region, holes included. */
export function pointInRegion(pt, region) {
  let inside = false;
  for (const ring of region || []) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

/** Drop rings that enclose nothing worth extruding, and normalise winding so a
 *  ring's sign is the truth about whether it is material or void. */
export function prune(region, minArea = MIN_AREA) {
  const out = [];
  for (const ring of region || []) {
    if (!ring || ring.length < 3) continue;
    if (Math.abs(ringArea(ring)) < minArea) continue;
    out.push(ring);
  }
  return out;
}

/**
 * Resolve a set of possibly self-crossing, possibly overlapping rings into a
 * clean region. This is the single most load-bearing call in the slicer: raw
 * contours off the mesh are only as clean as the mesh was, and every downstream
 * operation assumes simple, correctly-wound rings.
 */
export function normalize(region) {
  const paths = toPaths(region);
  if (!paths.length) return [];
  const simple = Clipper.SimplifyPolygons(paths, PolyFillType.pftNonZero);
  const cleaned = Clipper.CleanPolygons(simple, SCALE * 0.001);
  return prune(fromPaths(cleaned));
}

// ---------------------------------------------------------------------------
// boolean operations
// ---------------------------------------------------------------------------

function boolean(clipType, subject, clip) {
  const subj = toPaths(subject);
  const clp = toPaths(clip);
  if (!subj.length) return clipType === ClipType.ctUnion ? prune(fromPaths(clp)) : [];
  if (!clp.length) return clipType === ClipType.ctIntersection ? [] : prune(fromPaths(subj));

  const c = new Clipper();
  c.AddPaths(subj, PolyType.ptSubject, true);
  c.AddPaths(clp, PolyType.ptClip, true);
  const solution = new ClipperLib.Paths();
  c.Execute(clipType, solution, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return prune(fromPaths(Clipper.CleanPolygons(solution, SCALE * 0.001)));
}

export const union = (a, b) => boolean(ClipType.ctUnion, a, b || []);
export const difference = (a, b) => boolean(ClipType.ctDifference, a, b);
export const intersect = (a, b) => boolean(ClipType.ctIntersection, a, b);
export const xorRegions = (a, b) => boolean(ClipType.ctXor, a, b);

/** Union a list of regions into one. Doing it in a single Clipper pass rather
 *  than folding pairwise matters: the sweep line is O(n log n) once, and
 *  pairwise folding over 300 support layers is where a naive slicer dies. */
export function unionAll(regions) {
  const all = [];
  for (const r of regions || []) for (const ring of toPaths(r)) all.push(ring);
  if (!all.length) return [];
  const c = new Clipper();
  c.AddPaths(all, PolyType.ptSubject, true);
  const solution = new ClipperLib.Paths();
  c.Execute(ClipType.ctUnion, solution, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return prune(fromPaths(Clipper.CleanPolygons(solution, SCALE * 0.001)));
}

// ---------------------------------------------------------------------------
// offset
// ---------------------------------------------------------------------------

/**
 * Grow (positive delta) or shrink (negative delta) a region by `delta` mm.
 *
 * Holes take care of themselves: a hole ring is wound the other way, so the
 * same signed delta that shrinks the outside grows the hole inward, which is
 * what "the wall got thicker" physically means.
 *
 * @param {number[][][]} region
 * @param {number} delta mm, positive grows
 * @param {{join?: 'round'|'miter'|'square'}} [opts]
 */
export function offset(region, delta, opts = {}) {
  const paths = toPaths(region);
  if (!paths.length) return [];
  if (Math.abs(delta) < 1e-9) return prune(region.map((r) => r.map((p) => [p[0], p[1]])));

  const co = new ClipperOffset(MITER_LIMIT, ARC_TOLERANCE);
  co.AddPaths(paths, JOIN[opts.join] ?? JoinType.jtRound, EndType.etClosedPolygon);
  const solution = new ClipperLib.Paths();
  co.Execute(solution, delta * SCALE);
  return prune(fromPaths(Clipper.CleanPolygons(solution, SCALE * 0.001)));
}

/**
 * Thicken open polylines into closed regions, `width` mm wide, centred on the
 * line. Used to turn a support rib or a bridge path back into an area, and to
 * work out what a bead of plastic actually covers.
 */
export function offsetLines(lines, width, cap = 'round', join = 'round') {
  const paths = (lines || []).filter((l) => l && l.length >= 2).map(toPath);
  if (!paths.length) return [];
  // 'closed' treats the path as a loop rather than a stroke with two ends. It
  // matters for wall coverage: a wall is a loop, and capping it as if it had
  // ends leaves a nozzle-sized notch at the seam that then reads as an
  // uncovered gap on every layer of every part.
  const endType = cap === 'closed' ? EndType.etClosedLine
    : cap === 'butt' ? EndType.etOpenButt
    : cap === 'square' ? EndType.etOpenSquare
    : EndType.etOpenRound;
  const co = new ClipperOffset(MITER_LIMIT, ARC_TOLERANCE);
  co.AddPaths(paths, JOIN[join] ?? JoinType.jtRound, endType);
  const solution = new ClipperLib.Paths();
  co.Execute(solution, (width / 2) * SCALE);
  return prune(fromPaths(solution));
}

// ---------------------------------------------------------------------------
// clipping open lines against a region
// ---------------------------------------------------------------------------

/**
 * Trim open polylines to the inside of a region. This is how every infill
 * pattern is made: generate an infinite-ish family of lines across the bounding
 * box, hand them here, and get back exactly the pieces that land on material.
 *
 * Clipper's open-path support does the work, and it is worth using rather than
 * rolling a scanline intersector, because the honest cases are the hard ones:
 * a line that runs exactly along an edge, or clips a single vertex, or crosses
 * a hole at a tangent.
 */
export function clipLines(lines, region) {
  const subj = (lines || []).filter((l) => l && l.length >= 2).map(toPath);
  const clp = toPaths(region);
  if (!subj.length || !clp.length) return [];

  const c = new Clipper();
  c.AddPaths(subj, PolyType.ptSubject, false);
  c.AddPaths(clp, PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipType.ctIntersection, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  const open = Clipper.OpenPathsFromPolyTree(tree);
  const out = [];
  for (const p of open) {
    const line = fromPath(p);
    if (line.length >= 2 && lineLength(line) > 1e-6) out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ring helpers used by the toolpath stages
// ---------------------------------------------------------------------------

/** Force a ring counter-clockwise (outer) or clockwise (hole). */
export function orient(ring, ccw = true) {
  return ringArea(ring) < 0 === ccw ? [...ring].reverse() : ring;
}

/** Split a region into its outer rings and its holes. Some stages (seam choice,
 *  wall ordering) genuinely care which is which. */
export function split(region) {
  const outers = [], holes = [];
  for (const ring of region || []) (ringArea(ring) >= 0 ? outers : holes).push(ring);
  return { outers, holes };
}

/**
 * Rotate a closed ring so it starts at the point nearest `target`, then close it
 * by repeating the first point. Toolpaths are emitted as open polylines that
 * happen to end where they started, and where that seam sits is the single most
 * visible quality decision in a print.
 */
export function ringToLoop(ring, target = null) {
  if (!ring || ring.length < 3) return null;
  let start = 0;
  if (target) {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const d = (ring[i][0] - target[0]) ** 2 + (ring[i][1] - target[1]) ** 2;
      if (d < best) { best = d; start = i; }
    }
  }
  const loop = [];
  for (let i = 0; i < ring.length; i++) loop.push(ring[(start + i) % ring.length]);
  loop.push(loop[0]);
  return loop;
}

/** Drop vertices that sit within `tol` mm of the straight line between their
 *  neighbours. Fewer G1 moves means a smaller file and a printer whose planner
 *  is not starved by 0.02mm segments. */
export function simplifyLine(line, tol = 0.01) {
  if (!line || line.length <= 2) return line;
  const keep = [line[0]];
  for (let i = 1; i < line.length - 1; i++) {
    const a = keep[keep.length - 1], b = line[i], c = line[i + 1];
    const dx = c[0] - a[0], dy = c[1] - a[1];
    const len = Math.hypot(dx, dy);
    const dev = len < 1e-9
      ? Math.hypot(b[0] - a[0], b[1] - a[1])
      : Math.abs((b[0] - a[0]) * dy - (b[1] - a[1]) * dx) / len;
    if (dev > tol) keep.push(b);
  }
  keep.push(line[line.length - 1]);
  return keep;
}
