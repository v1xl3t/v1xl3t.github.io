// supports.js — holding up the parts that would otherwise print into air.
//
// The whole problem starts with one physical fact: a bead of plastic can be
// laid with roughly half its width hanging off the edge of the bead below it
// and still stick. Repeat that per layer and it becomes an angle. If a layer
// steps outward by more than layerHeight * tan(angle) beyond the layer under
// it, the new bead has nothing to grab and it droops.
//
//   overhang at layer i = (this layer) minus (the layer below, grown by
//                          layerHeight * tan(supportAngle))
//
// That is the entire detection rule, and it is exact rather than heuristic.
// Everything else in this file is about what to do with the answer.
//
// TWO SHAPES OF SUPPORT
//
//   NORMAL  the overhang is projected straight down as a column, unioned with
//           everything above it, and clipped away from the model. Reliable,
//           dumb, and uses a lot of plastic.
//   TREE    the overhang is sampled into points, and those points walk down the
//           stack leaning at most treeAngle per layer, merging as they meet,
//           thickening as they merge, until they reach the plate or land on the
//           model. Touches the part in far fewer places, so it marks the
//           surface less and peels off in one piece.
//
// GAPS ARE THE WHOLE GAME. Support that is fused to the part is not support,
// it is a permanent feature you now have to cut off. Three separate clearances
// keep it detachable: sideways from the model (supportXYGap), under the model's
// overhang (supportZGapTop), and above whatever the support stands on
// (supportZGapBottom).

import {
  offset, difference, union, unionAll, intersect, prune, area, bounds,
  pointInRegion, ringArea,
} from './clip.js';

const RAD = Math.PI / 180;

/**
 * The parts of each layer that have nothing adequate underneath them.
 *
 * @param {{polys:number[][][], height:number}[]} layers
 * @param {number} angleDeg overhang measured from vertical; 0 supports
 *        everything, 90 supports nothing
 * @returns {number[][][][]} an overhang region per layer
 */
export function findOverhangs(layers, angleDeg) {
  const out = new Array(layers.length);
  const t = Math.tan(Math.max(0, Math.min(89, angleDeg)) * RAD);
  for (let i = 0; i < layers.length; i++) {
    if (i === 0) { out[i] = []; continue; }   // the bed holds up the first layer
    const reach = layers[i].height * t;
    const supported = offset(layers[i - 1].polys, reach);
    out[i] = prune(difference(layers[i].polys, supported), 0.05);
  }
  return out;
}

/** How many layers a vertical clearance works out to. */
const gapLayers = (mm, layerHeight) => Math.max(0, Math.round((mm || 0) / layerHeight));

/**
 * Column supports: every overhang projected straight down to whatever it hits.
 *
 * Built top-down, because support at a layer is "everything that needed holding
 * up anywhere above here, that has not yet landed on something".
 */
export function normalSupport(layers, overhangs, s) {
  const n = layers.length;
  const out = new Array(n);
  const gapTop = gapLayers(s.supportZGapTop, s.layerHeight);
  const gapBot = gapLayers(s.supportZGapBottom, s.layerHeight);

  // Grow the overhang sideways a little before projecting. An overhang held up
  // only at its exact footprint is held up by a column with no margin, and the
  // first bead of the overhang lands on the very edge of it.
  const grow = s.lineWidth * 1.5;

  let accum = [];
  for (let i = n - 1; i >= 0; i--) {
    // Everything from above, plus whatever newly overhangs just above this
    // layer. Reading the overhang from i+1 rather than i is what puts the
    // support UNDER the overhang instead of alongside it.
    const fresh = i + 1 < n ? offset(overhangs[i + 1], grow) : [];
    accum = fresh.length ? unionAll([accum, fresh]) : accum;
    if (!accum.length) { out[i] = []; continue; }

    // Never inside the part, and never closer to it than the XY clearance.
    accum = prune(difference(accum, offset(layers[i].polys, s.supportXYGap)), 0.05);

    let here = accum;
    // Stop short of the model above, so the overhang has a gap to peel from.
    if (gapTop > 0 && here.length) {
      const above = [];
      for (let k = i + 1; k <= Math.min(n - 1, i + gapTop); k++) above.push(layers[k].polys);
      if (above.length) here = prune(difference(here, offset(unionAll(above), s.supportXYGap)), 0.05);
    }
    // And do not rest directly on the model either.
    if (gapBot > 0 && here.length) {
      const below = [];
      for (let k = Math.max(0, i - gapBot); k < i; k++) below.push(layers[k].polys);
      if (below.length) here = prune(difference(here, offset(unionAll(below), s.supportXYGap)), 0.05);
    }
    out[i] = here;
  }
  return out;
}

// ---------------------------------------------------------------------------
// tree supports
// ---------------------------------------------------------------------------

/**
 * Sample a region into points to seed tree tips on.
 *
 * Two samplers, because overhangs come in two shapes and each sampler is blind
 * to the other's case. A broad flat overhang wants a GRID, so branches land
 * spread evenly under it. A thin band, which is what a stepped or curved
 * surface produces on every layer, has no interior for a grid to land in at
 * all, and wants points walked along its PERIMETER.
 *
 * What this must not do is fall back to a ring's centroid. The centroid of an
 * annulus is the hole in the middle of it, which for a dome sitting on the bed
 * is a point inside the model, and a tip seeded there is discarded on the same
 * layer as unreachable. The visible symptom is a sphere that reports needing no
 * supports at all while plainly overhanging everywhere.
 */
function samplePoints(region, spacing) {
  const b = bounds(region);
  if (!b) return [];
  const pts = [];
  const far = (p) => pts.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > spacing * 0.7);

  // Anchor to the absolute grid so tips on adjacent layers land in the same
  // places and merge into one branch instead of a thicket of near-misses.
  const x0 = Math.ceil(b.minX / spacing) * spacing;
  const y0 = Math.ceil(b.minY / spacing) * spacing;
  for (let y = y0; y <= b.maxY; y += spacing) {
    for (let x = x0; x <= b.maxX; x += spacing) {
      if (pointInRegion([x, y], region)) pts.push([x, y]);
    }
  }

  // Then walk the outline. The edge of an overhang is also the part that droops
  // furthest, so these are the points most worth holding up even when the grid
  // already covered the middle.
  for (const ring of region) {
    if (ringArea(ring) <= 0) continue;        // holes need nothing under them
    let carried = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
      const p = ring[i], q = ring[(i + 1) % n];
      const seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (seg < 1e-9) continue;
      let t = spacing - carried;
      while (t <= seg) {
        const pt = [p[0] + (q[0] - p[0]) * (t / seg), p[1] + (q[1] - p[1]) * (t / seg)];
        if (far(pt)) pts.push(pt);
        t += spacing;
      }
      carried = (carried + seg) % spacing;
    }
  }
  return pts;
}

/** A circle as a polygon ring, for turning a branch back into an area. */
function disc(cx, cy, r, sides = 16) {
  const ring = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return ring;
}

/**
 * Tree supports.
 *
 * Nodes are seeded under each overhang and walk down one layer at a time. Three
 * rules, applied in this order every layer, produce the branching:
 *
 *   1. MERGE. Nodes closer than their combined radii become one node at their
 *      weighted center. The merged radius is sqrt(r1^2 + r2^2), not r1 + r2,
 *      because what has to be conserved going down a trunk is cross-sectional
 *      AREA. Adding radii makes trunks that could hold up a car.
 *   2. LEAN. Each node moves toward its cluster's center, but never further
 *      than layerHeight * tan(treeAngle) in one layer. That cap is the whole
 *      reason a tree stands up: exceed it and the branch is an overhang that
 *      would itself need support.
 *   3. LAND. A node that arrives over the model has found something to stand
 *      on and stops there, unless the print is set to build from the plate
 *      only, in which case it is nudged clear and keeps going.
 */
export function treeSupport(layers, overhangs, s) {
  const n = layers.length;
  const out = Array.from({ length: n }, () => []);
  const tipR = Math.max(0.4, (s.treeTipDiameter ?? 0.8) / 2);
  const maxR = Math.max(tipR, (s.treeBranchDiameter ?? 3) / 2);
  const lean = Math.tan(Math.max(5, Math.min(70, s.treeAngle ?? 40)) * RAD);
  // Branch thickness grows with depth at a shallow angle, the same way a real
  // tree does, so the tip stays delicate where it touches the part.
  const growth = Math.tan(5 * RAD);
  const sampleSpacing = Math.max(2, maxR * 2.5);

  let nodes = [];
  for (let i = n - 1; i >= 0; i--) {
    // Seed new tips from whatever newly overhangs just above this layer.
    if (i + 1 < n && overhangs[i + 1] && overhangs[i + 1].length) {
      for (const p of samplePoints(overhangs[i + 1], sampleSpacing)) {
        nodes.push({ x: p[0], y: p[1], r: tipR, depth: 0, done: false });
      }
    }
    if (!nodes.length) continue;

    const model = layers[i].polys;
    const clearance = offset(model, s.supportXYGap);

    // 1. merge
    nodes = mergeNodes(nodes, maxR);

    // 2. lean, and thicken with depth
    const maxMove = layers[i].height * lean;
    const clusters = clusterOf(nodes, maxR * 4);
    for (const node of nodes) {
      if (node.done) continue;
      node.depth += layers[i].height;
      node.r = Math.min(maxR, tipR + node.depth * growth);
      const c = clusters.get(node);
      if (c && c.count > 1) {
        const dx = c.x - node.x, dy = c.y - node.y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-9) {
          const step = Math.min(d, maxMove);
          const nx = node.x + (dx / d) * step, ny = node.y + (dy / d) * step;
          // Branches converge toward each other, but the center of a ring of
          // branches is the middle of the part they are standing around. Moving
          // into the model is refused rather than clipped afterwards, because a
          // branch that has burrowed inside has no route back out and simply
          // vanishes on the next layer.
          if (!clearance.length || !pointInRegion([nx, ny], clearance)) {
            node.x = nx; node.y = ny;
          }
        }
      }
    }

    // 3. land, and turn the branches into an area for this layer
    //
    // The distinction that matters here is between being ON the model and being
    // merely NEAR it. A branch standing over solid model has arrived and stops.
    // A branch inside the clearance band has not arrived at anything; it is just
    // too close, and the answer is to step away from the part and keep
    // descending. Treating "too close" as "arrived" is what makes a dome resting
    // on the bed report that it needs no supports: every tip is seeded within a
    // clearance of the layer below it, so every tip dies on the layer it was
    // born, even though a few layers further down the part has narrowed and
    // there is plenty of room.
    const discs = [];
    for (const node of nodes) {
      if (node.done) continue;

      const onModel = model.length && pointInRegion([node.x, node.y], model);
      if (onModel && !s.supportOnBuildplateOnly) {
        discs.push(disc(node.x, node.y, node.r));
        node.done = true;
        continue;
      }
      if (clearance.length && pointInRegion([node.x, node.y], clearance)) {
        stepAwayFrom(node, clearance, model, maxMove);
      }
      discs.push(disc(node.x, node.y, node.r));
    }
    nodes = nodes.filter((nd) => !nd.done);

    if (discs.length) {
      out[i] = prune(difference(unionAll([discs]), clearance), 0.05);
    }
  }

  // Vertical clearance, applied the same way it is for column supports.
  return applyZGaps(layers, out, s);
}

/**
 * Move a branch out of the part's clearance band, as far as one layer's lean
 * allows.
 *
 * Sixteen candidate directions rather than "away from the center", because
 * away-from-the-center is only correct on a convex part. Inside the mouth of a
 * C-shaped part it points at the far wall. Trying real directions and taking
 * one that actually escapes handles concave shapes without needing to know
 * anything about them, and falling back to the outward radial keeps a branch
 * moving in the right general direction even when no single step gets clear.
 */
function stepAwayFrom(node, clearance, model, maxMove) {
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const nx = node.x + Math.cos(a) * maxMove, ny = node.y + Math.sin(a) * maxMove;
    if (!pointInRegion([nx, ny], clearance)) { node.x = nx; node.y = ny; return true; }
  }
  const b = bounds(model);
  if (b) {
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const dx = node.x - cx, dy = node.y - cy;
    const d = Math.hypot(dx, dy);
    if (d > 1e-9) { node.x += (dx / d) * maxMove; node.y += (dy / d) * maxMove; }
  }
  return false;
}

/** Group nodes that are close enough to be one branch. */
function mergeNodes(nodes, maxR) {
  const merged = [];
  const taken = new Uint8Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    if (taken[i]) continue;
    let { x, y, r, depth } = nodes[i];
    let weight = r * r;
    taken[i] = 1;
    for (let j = i + 1; j < nodes.length; j++) {
      if (taken[j]) continue;
      const o = nodes[j];
      if (Math.hypot(o.x - x, o.y - y) > (r + o.r) * 1.1) continue;
      taken[j] = 1;
      const w2 = o.r * o.r;
      // Weighted by area, so a trunk is not dragged sideways by a twig.
      x = (x * weight + o.x * w2) / (weight + w2);
      y = (y * weight + o.y * w2) / (weight + w2);
      weight += w2;
      r = Math.min(maxR, Math.sqrt(weight));
      depth = Math.max(depth, o.depth);
    }
    merged.push({ x, y, r, depth, done: false });
  }
  return merged;
}

/** For each node, the center of the nodes near it, so branches converge. */
function clusterOf(nodes, radius) {
  const map = new Map();
  for (const node of nodes) {
    let sx = 0, sy = 0, count = 0;
    for (const o of nodes) {
      if (Math.hypot(o.x - node.x, o.y - node.y) <= radius) { sx += o.x; sy += o.y; count++; }
    }
    map.set(node, { x: sx / count, y: sy / count, count });
  }
  return map;
}

/** Shared vertical clearance pass. */
function applyZGaps(layers, regions, s) {
  const n = layers.length;
  const gapTop = gapLayers(s.supportZGapTop, s.layerHeight);
  const gapBot = gapLayers(s.supportZGapBottom, s.layerHeight);
  if (!gapTop && !gapBot) return regions;

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let here = regions[i];
    if (!here || !here.length) { out[i] = []; continue; }
    if (gapTop) {
      const above = [];
      for (let k = i + 1; k <= Math.min(n - 1, i + gapTop); k++) above.push(layers[k].polys);
      if (above.length) here = prune(difference(here, offset(unionAll(above), s.supportXYGap)), 0.05);
    }
    if (gapBot) {
      const below = [];
      for (let k = Math.max(0, i - gapBot); k < i; k++) below.push(layers[k].polys);
      if (below.length) here = prune(difference(here, offset(unionAll(below), s.supportXYGap)), 0.05);
    }
    out[i] = here;
  }
  return out;
}

/**
 * Build the support stack for a sliced model.
 *
 * @returns {{regions: number[][][][], interface: number[][][][], touched: boolean}}
 *          `interface` is the denser band at the top of each support column,
 *          which is what decides whether the overhang above it comes out smooth
 *          or comes out as a row of sagging threads.
 */
export function buildSupports(layers, s, onProgress) {
  if (!s.supportEnable) return { regions: layers.map(() => []), interfaces: layers.map(() => []), used: false };

  const overhangs = findOverhangs(layers, s.supportAngle);
  const regions = s.supportType === 'tree'
    ? treeSupport(layers, overhangs, s)
    : normalSupport(layers, overhangs, s);

  if (onProgress) onProgress(0.6);

  // The interface is the top few layers of any support column: the part that
  // the model will actually sit on. Detected as "support here that has no
  // support a couple of layers above it", which is exactly the top of a column
  // whatever shape the column is.
  const nIface = Math.max(0, Math.round(s.supportInterfaceLayers ?? 2));
  const interfaces = new Array(layers.length);
  for (let i = 0; i < layers.length; i++) {
    if (!nIface || !regions[i].length) { interfaces[i] = []; continue; }
    const k = Math.min(layers.length - 1, i + nIface);
    interfaces[i] = i === layers.length - 1 ? regions[i] : prune(difference(regions[i], regions[k] || []), 0.05);
  }

  const used = regions.some((r) => r.length);
  if (onProgress) onProgress(1);
  return { regions, interfaces, used };
}

/** Total footprint of the supports, mm^2 summed over layers. Reported so the
 *  cost of switching support type is visible before committing to a print. */
export function supportArea(regions) {
  let a = 0;
  for (const r of regions) a += area(r);
  return a;
}
