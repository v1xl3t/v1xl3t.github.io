// profile.js — turning what you drew into something extrudable.
//
// A sketch loop is whatever the user actually drew, and people draw shapes that
// cross themselves. A raw self-crossing outline cannot be triangulated: the
// tessellator has no answer for "which side is inside", so you get the thin
// slivers and inverted facets that look like the model is torn.
//
// The fix is to run the outline through a polygon boolean union with itself.
// Union resolves every self-intersection into a set of simple, non-overlapping
// rings with consistent winding, and it gives holes back as inner rings for
// free. That single operation is what lets a scribble become a solid.
//
// Everything here is plain arrays of [x, y], no THREE, so it tests headless.

import polygonClipping from './vendor/polygon-clipping.js';

const clipper = () => polygonClipping || null;

const EPS = 1e-9;

/** Signed area of a ring. Positive is counter-clockwise. */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Drop consecutive duplicate points, which upset both the clipper and earcut. */
function dedupe(ring) {
  const out = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > EPS || Math.abs(last[1] - p[1]) > EPS) out.push([p[0], p[1]]);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS) out.pop();
    else break;
  }
  return out;
}

/** Does this ring cross itself? Cheap enough at sketch sizes, and it lets us
 *  skip the clipper entirely for the common, well-behaved case. */
export function selfIntersects(ring) {
  const n = ring.length;
  if (n < 4) return false;
  const seg = (i) => [ring[i], ring[(i + 1) % n]];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const straddles = (p1, p2, p3, p4) => {
    const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
    const d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
    return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
           ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (i === j) continue;
      if ((j + 1) % n === i || (i + 1) % n === j) continue;   // neighbours share a point
      const [a1, a2] = seg(i), [b1, b2] = seg(j);
      if (straddles(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/**
 * Normalise a drawn outline into extrudable regions.
 *
 * @param {number[][]} points  the closed loop as drawn, [[x, y], ...]
 * @returns {{regions: {outer:number[][], holes:number[][][]}[], repaired:boolean, reason:string}}
 *          `regions` is one entry per separate piece of solid. A bowtie comes
 *          back as two regions; a shape drawn around a void comes back as one
 *          region with a hole.
 */
export function normalizeProfile(points) {
  const ring = dedupe(points || []);
  if (ring.length < 3) return { regions: [], repaired: false, reason: 'a profile needs at least three points' };

  const crossed = selfIntersects(ring);
  const pc = clipper();

  // The clean, ordinary case: one simple ring, no clipper needed.
  if (!crossed) {
    const outer = ringArea(ring) < 0 ? [...ring].reverse() : ring;
    return { regions: [{ outer, holes: [] }], repaired: false, reason: 'simple loop' };
  }

  if (!pc) {
    // Should not happen (the bundle is vendored), but never fail silently on
    // geometry: say the shape is unrepairable rather than emit a torn solid.
    return { regions: [], repaired: false, reason: 'the outline crosses itself and the repair library is unavailable' };
  }

  let result;
  try {
    result = pc.union([[...ring, ring[0]]]);
  } catch (e) {
    return { regions: [], repaired: false, reason: `the outline crosses itself and could not be repaired (${e.message})` };
  }

  const regions = [];
  for (const poly of result || []) {
    if (!poly || !poly.length) continue;
    const rings = poly.map(dedupe).filter((r) => r.length >= 3);
    if (!rings.length) continue;
    const outer = ringArea(rings[0]) < 0 ? [...rings[0]].reverse() : rings[0];
    const holes = rings.slice(1).map((h) => (ringArea(h) > 0 ? [...h].reverse() : h));
    regions.push({ outer, holes });
  }

  if (!regions.length) {
    return { regions: [], repaired: false, reason: 'the outline crosses itself and encloses no area' };
  }
  return {
    regions, repaired: true,
    reason: regions.length > 1
      ? `the outline crossed itself, so it became ${regions.length} separate pieces`
      : 'the outline crossed itself and was repaired',
  };
}

/** Total enclosed area across every region, holes subtracted. */
export function profileArea(regions) {
  let a = 0;
  for (const r of regions) {
    a += Math.abs(ringArea(r.outer));
    for (const h of r.holes) a -= Math.abs(ringArea(h));
  }
  return a;
}

/** Bounding box of a drawn loop, used to scale sensible defaults. */
export function profileBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points || []) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  if (!Number.isFinite(minX)) return { w: 0, h: 0, cx: 0, cy: 0 };
  return { w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/**
 * A depth that looks deliberate for the size of thing you drew.
 *
 * A 20mm default is right for a 30mm bracket and looks like foil on a 400mm
 * plate, which is exactly what happened the first time a big sketch was
 * extruded. Scaling to the drawing keeps the first result readable, and the
 * number stays fully editable afterwards.
 */
export function suggestedDepth(points) {
  const { w, h } = profileBounds(points);
  const span = Math.max(w, h);
  if (!span) return 20;
  const d = span * 0.35;
  // Round to something a human would have typed.
  const mag = Math.pow(10, Math.floor(Math.log10(d)));
  const snapped = Math.round(d / (mag / 2)) * (mag / 2);
  return Math.max(1, Math.min(500, snapped || 20));
}
