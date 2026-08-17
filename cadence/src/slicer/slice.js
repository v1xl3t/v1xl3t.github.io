// slice.js — a triangle soup becomes a stack of closed outlines.
//
// This is the one step where a 3D model stops being a 3D model. Everything
// after it is 2D: walls, skins, infill and supports are all polygon algebra on
// what comes out of here. So the two properties this file owes the rest of the
// slicer are non-negotiable:
//
//   1. Every contour CLOSES. An open outline is not a boundary, and a wall
//      generated from one leaks plastic into space.
//   2. Winding is meaningful. Counter-clockwise is material, clockwise is void.
//      Every offset downstream depends on that being true, because that is the
//      only thing that tells a bore from a boss.
//
// Two decisions carry most of the robustness here, both learned from how these
// things fail in practice:
//
//   Canonical edge evaluation. Two triangles sharing an edge list its vertices
//   in opposite order. Interpolating the crossing point from (a, b) and from
//   (b, a) gives answers that differ in the last float bit, and then the two
//   segments do not stitch and the contour has a hairline gap. Sorting the two
//   vertices into a fixed order before interpolating makes both triangles
//   compute bit-identical points, so stitching is exact rather than tolerant.
//
//   Nudging the plane, not the geometry. A vertex sitting exactly on the slice
//   plane is the classic source of doubled or dropped segments. Rather than
//   enumerate the degenerate cases, an on-plane vertex is consistently treated
//   as being just above the plane. Consistency is what matters: every triangle
//   touching that vertex makes the same call, so the contour stays closed.
//
// Input is a Z-up, millimeter triangle soup, which is exactly what the printer
// coordinate system wants. No THREE, no DOM.

import { normalize, ringArea, area } from './clip.js';

// Points are snapped to this grid (mm) before stitching. A tenth of a micron is
// two orders of magnitude below anything a printer resolves, and snapping means
// the stitch map can use exact key equality instead of a nearest search.
const SNAP = 1e-4;
const key = (x, y) => `${Math.round(x / SNAP)},${Math.round(y / SNAP)}`;

/**
 * How steep the model is, sampled up its height.
 *
 * The number an adaptive plan needs is the CUSP: the little terrace left where
 * a sloped surface meets a stack of flat layers. For a surface lying at angle a
 * from horizontal, that terrace is `layerHeight × cos(a)`, and `cos(a)` is
 * exactly the vertical component of the surface normal. A vertical wall has a
 * normal pointing sideways, `nz` is zero, and no layer height leaves a terrace
 * on it at all. A shallow dome has `nz` near one and shows every layer.
 *
 * So this returns, per thin band of Z, the largest `|nz|` of anything crossing
 * it, which is the shallowest slope there and therefore the one that decides
 * how fine that band has to be.
 *
 * Facets flatter than `FLAT` are ignored on purpose. A perfectly horizontal top
 * is one layer and has no terrace to smooth, and counting it would drive the
 * whole region to the minimum layer height to improve a surface that is already
 * as good as it can get.
 */
const SLOPE_BAND = 0.05;      // mm, fine enough that a 0.4mm layer sees several
const FLAT = 0.98;            // |nz| above this is a flat face, not a slope

export function slopeProfile(positions, zMin, zMax) {
  const n = Math.max(1, Math.ceil((zMax - zMin) / SLOPE_BAND) + 1);
  const bands = new Float32Array(n);   // max |nz| per band, 0 = nothing steep here
  for (let t = 0; t + 8 < positions.length; t += 9) {
    const ax = positions[t], ay = positions[t + 1], az = positions[t + 2];
    const bx = positions[t + 3], by = positions[t + 4], bz = positions[t + 5];
    const cx = positions[t + 6], cy = positions[t + 7], cz = positions[t + 8];
    // Cross product of two edges, z component only, then normalized by the
    // full length. Only |nz| is wanted, so the other two are needed just to
    // normalize.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-12)) continue;
    const az_ = Math.abs(nz) / len;
    if (az_ >= FLAT) continue;
    const lo = Math.min(az, bz, cz), hi = Math.max(az, bz, cz);
    let i0 = Math.floor((lo - zMin) / SLOPE_BAND), i1 = Math.ceil((hi - zMin) / SLOPE_BAND);
    if (i1 < 0 || i0 > n - 1) continue;
    i0 = Math.max(0, i0); i1 = Math.min(n - 1, i1);
    for (let i = i0; i <= i1; i++) if (az_ > bands[i]) bands[i] = az_;
  }
  return bands;
}

/** The height a band of Z can take without leaving a terrace bigger than `cusp`. */
function heightFor(bands, zMin, from, to, cfg) {
  const lo = Math.max(0, Math.floor((from - zMin) / SLOPE_BAND));
  const hi = Math.min(bands.length - 1, Math.ceil((to - zMin) / SLOPE_BAND));
  let steepest = 0;
  for (let i = lo; i <= hi; i++) if (bands[i] > steepest) steepest = bands[i];
  // Nothing sloped in this band, so nothing to be gained by going fine.
  if (steepest <= 1e-6) return cfg.adaptiveMax;
  return Math.max(cfg.adaptiveMin, Math.min(cfg.adaptiveMax, cfg.adaptiveCusp / steepest));
}

/**
 * Where each layer gets cut, and how thick it is.
 *
 * The plane sits at the MIDDLE of the layer, not its top or bottom. Cutting at
 * the boundary means every flat face in the model is exactly coplanar with a
 * slice plane, which is the worst case for robustness and also the wrong
 * answer: a layer should represent the material through its own thickness, and
 * the middle is the honest single sample of that.
 *
 * A model's height is almost never a whole number of layers. The leftover at
 * the top is handled rather than ignored: if it is thick enough to extrude it
 * becomes a genuinely thinner final layer, and the G-code scales that layer's
 * extrusion to match, so the part comes out its modeled height. If it is
 * thinner than the extruder can meaningfully meter, it is dropped, because
 * truncating by a few microns is invisible and squeezing out a 5-micron layer
 * is not. Letting the last layer run past the top of the model instead would
 * overstate its volume, and every filament and time estimate downstream would
 * inherit the error.
 *
 * @param {number} zMin bottom of the model, mm (normally 0, sitting on the bed)
 * @param {number} zMax top of the model, mm
 * @param {{layerHeight:number, firstLayerHeight:number}} cfg
 * @returns {{index:number, z:number, height:number, bottom:number, top:number}[]}
 *
 * `positions` is optional and only used when adaptive layers are on, where the
 * thickness is decided by the model's slope rather than by one setting.
 */
export function layerPlan(zMin, zMax, cfg, positions = null) {
  const lh = cfg.layerHeight;
  const flh = cfg.firstLayerHeight ?? lh;
  const height = zMax - zMin;
  if (!(height > 0) || !(lh > 0)) return [];

  // Adaptive layers need the geometry, not just its extent, so a caller that
  // has not got it falls back to the uniform plan rather than guessing.
  const adaptive = cfg.adaptiveLayers && positions && positions.length >= 9;
  if (adaptive) return adaptivePlan(zMin, zMax, cfg, positions);

  // Below this, a final sliver is not worth printing.
  const minSliver = Math.max(0.04, lh * 0.2);

  const layers = [];
  let bottom = zMin;
  let i = 0;
  while (bottom < zMax - 1e-9) {
    const nominal = i === 0 ? flh : lh;
    const remaining = zMax - bottom;
    if (remaining < nominal - 1e-9) {
      // The top of the model lands inside this layer.
      if (remaining < minSliver) break;
      layers.push({ index: i, bottom, top: zMax, height: remaining, z: bottom + remaining / 2 });
      break;
    }
    const top = bottom + nominal;
    layers.push({ index: i, bottom, top, height: nominal, z: bottom + nominal / 2 });
    bottom = top;
    i++;
    if (i > 100000) break;    // a runaway guard; 100k layers is 20m of print
  }
  return layers;
}

/**
 * A layer plan that thins out where the model is shallow and thickens where it
 * is vertical.
 *
 * The trade this makes is the one worth making on a curved part: a sphere or a
 * fillet shows every layer line, and a straight wall shows none, so spending
 * fine layers on the wall buys nothing and spending coarse ones on the curve
 * costs the whole surface. Uniform layers have to pick one number for both.
 *
 * The height of each layer is chosen from the slope of what that layer will
 * actually cut through, and then it is not allowed to change by more than
 * `adaptiveStep` from the one below it. That last rule is not cosmetic: a jump
 * from 0.08mm to 0.28mm between neighbors is a visible band on the part and it
 * is also a sudden change in flow that a pressure-advance-less machine cannot
 * follow cleanly.
 */
function adaptivePlan(zMin, zMax, cfg, positions) {
  const bands = slopeProfile(positions, zMin, zMax);
  const flh = cfg.firstLayerHeight ?? cfg.layerHeight;
  const minSliver = Math.max(0.04, cfg.adaptiveMin * 0.2);
  const layers = [];
  let bottom = zMin;
  let prev = flh;
  let i = 0;

  while (bottom < zMax - 1e-9) {
    let h;
    if (i === 0) {
      h = flh;                       // the first layer is about the bed, not the surface
    } else {
      // Ask what the coarsest allowed layer would cut through, then ask again
      // against the height that answer suggests. Two passes is enough: the
      // window only shrinks, so the second answer cannot ask for a taller one.
      h = heightFor(bands, zMin, bottom, bottom + cfg.adaptiveMax, cfg);
      h = heightFor(bands, zMin, bottom, bottom + h, cfg);
      const step = cfg.adaptiveStep ?? 0.04;
      h = Math.max(prev - step, Math.min(prev + step, h));
      h = Math.max(cfg.adaptiveMin, Math.min(cfg.adaptiveMax, h));
      // Land on a whole number of microns, so the Z moves in the file are the
      // kind of numbers a person reading the G-code can check.
      h = Math.round(h * 1000) / 1000;
    }
    const remaining = zMax - bottom;
    if (remaining < h - 1e-9) {
      if (remaining < minSliver) break;
      layers.push({ index: i, bottom, top: zMax, height: remaining, z: bottom + remaining / 2 });
      break;
    }
    layers.push({ index: i, bottom, top: bottom + h, height: h, z: bottom + h / 2 });
    bottom += h;
    prev = h;
    i++;
    if (i > 100000) break;
  }
  return layers;
}

/** Z extent of a triangle soup, plus its XY footprint. */
export function meshBounds(positions) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return Number.isFinite(minZ) ? { minX, minY, minZ, maxX, maxY, maxZ } : null;
}

// Lexicographic order on a vertex, used only to pick a fixed evaluation
// direction for a shared edge. Which vertex wins is irrelevant; that both
// triangles agree is the whole point.
function firstIsLower(ax, ay, az, bx, by, bz) {
  if (az !== bz) return az < bz;
  if (ax !== bx) return ax < bx;
  return ay < by;
}

/**
 * Cut one triangle with a horizontal plane.
 *
 * @returns {[number,number,number,number]|null} [x0, y0, x1, y1], directed so
 *          that material lies to the LEFT of travel. That single convention is
 *          what makes the stitched loops come out counter-clockwise for solid
 *          and clockwise for holes, with no post-hoc orientation guessing.
 */
function cutTriangle(p, t, z) {
  const ax = p[t], ay = p[t + 1], az = p[t + 2];
  const bx = p[t + 3], by = p[t + 4], bz = p[t + 5];
  const cx = p[t + 6], cy = p[t + 7], cz = p[t + 8];

  // A vertex exactly on the plane counts as above it. Applied identically to
  // every triangle, so shared vertices never disagree.
  const da = az >= z ? 1 : -1;
  const db = bz >= z ? 1 : -1;
  const dc = cz >= z ? 1 : -1;
  if (da === db && db === dc) return null;

  // Interpolate along one edge, always from its canonically-lower end.
  const cross = (x0, y0, z0, x1, y1, z1) => {
    let X0 = x0, Y0 = y0, Z0 = z0, X1 = x1, Y1 = y1, Z1 = z1;
    if (!firstIsLower(x0, y0, z0, x1, y1, z1)) {
      X0 = x1; Y0 = y1; Z0 = z1; X1 = x0; Y1 = y0; Z1 = z0;
    }
    const dz = Z1 - Z0;
    const s = Math.abs(dz) < 1e-12 ? 0 : (z - Z0) / dz;
    return [X0 + (X1 - X0) * s, Y0 + (Y1 - Y0) * s];
  };

  // Exactly two of the three edges change sign.
  const hits = [];
  if (da !== db) hits.push(cross(ax, ay, az, bx, by, bz));
  if (db !== dc) hits.push(cross(bx, by, bz, cx, cy, cz));
  if (dc !== da) hits.push(cross(cx, cy, cz, ax, ay, az));
  if (hits.length !== 2) return null;

  const [p0, p1] = hits;
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  if (dx * dx + dy * dy < 1e-18) return null;      // a vertex-only touch

  // The triangle's outward normal, projected to the plane. Rotating the travel
  // direction 90 degrees clockwise must give the outward normal, so the travel
  // direction is the normal rotated 90 degrees counter-clockwise.
  const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
  const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  const wantX = -ny, wantY = nx;
  if (dx * wantX + dy * wantY < 0) return [p1[0], p1[1], p0[0], p0[1]];
  return [p0[0], p0[1], p1[0], p1[1]];
}

/**
 * Join a bag of directed segments into closed rings.
 *
 * Walking start-to-end through a hash of endpoints is O(n). The interesting
 * part is what happens when the walk dead-ends, which means the mesh was not
 * watertight at this height. Rather than throw the layer away we close the gap
 * if it is small enough to be float noise or a hairline crack, and report it,
 * because a slicer that silently drops a contour prints a part with a missing
 * wall and no warning.
 */
function stitch(segments, gapTolerance) {
  const starts = new Map();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const k = key(s[0], s[1]);
    let list = starts.get(k);
    if (!list) starts.set(k, (list = []));
    list.push(i);
  }

  const used = new Uint8Array(segments.length);
  const rings = [];
  let repairs = 0, dropped = 0;

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const first = segments[i];
    const ring = [[first[0], first[1]]];
    let cx = first[2], cy = first[3];
    const startKey = key(first[0], first[1]);

    for (let guard = 0; guard < segments.length + 2; guard++) {
      ring.push([cx, cy]);
      if (key(cx, cy) === startKey) break;

      const list = starts.get(key(cx, cy));
      let next = -1;
      if (list) for (const j of list) if (!used[j]) { next = j; break; }
      if (next < 0) {
        // Dead end. Close it if the hole is small, otherwise this piece of the
        // outline is genuinely missing from the mesh.
        const gap = Math.hypot(cx - first[0], cy - first[1]);
        if (gap <= gapTolerance) repairs++;
        else { dropped++; ring.length = 0; }
        break;
      }
      used[next] = 1;
      cx = segments[next][2]; cy = segments[next][3];
    }

    if (ring.length >= 4) {
      ring.pop();                                   // drop the repeated closing point
      if (ring.length >= 3) rings.push(ring);
    }
  }
  return { rings, repairs, dropped };
}

/**
 * Slice a Z-up triangle soup into per-layer regions.
 *
 * @param {Float32Array|number[]} positions  9 floats per triangle, mm, Z up
 * @param {object} cfg  { layerHeight, firstLayerHeight }
 * @param {(frac:number)=>void} [onProgress]
 * @returns {{layers:{index,z,height,bottom,top,polys}[], bounds, warnings:string[]}}
 */
export function sliceMesh(positions, cfg, onProgress) {
  const warnings = [];
  const bnds = meshBounds(positions);
  if (!bnds) return { layers: [], bounds: null, warnings: ['the model has no geometry'] };

  // The geometry is handed to the planner as well as its extent, because an
  // adaptive plan is decided by the model's slope and not only by its height.
  const plan = layerPlan(bnds.minZ, bnds.maxZ, cfg, positions);
  if (!plan.length) return { layers: [], bounds: bnds, warnings: ['the model has no height to slice'] };

  // Bucket triangles by the layers they span, so each plane only tests the
  // triangles that can possibly cross it. Without this, slicing is O(layers x
  // triangles) and a 200k-triangle model takes minutes instead of seconds.
  const buckets = Array.from({ length: plan.length }, () => []);
  const planeZ = plan.map((l) => l.z);
  const lo = planeZ[0], hi = planeZ[planeZ.length - 1];
  const span = planeZ.length > 1 ? (hi - lo) / (planeZ.length - 1) : 1;

  const indexFor = (z) => {
    // Uniform after the first layer, so a direct guess plus a short walk beats
    // a binary search and stays correct when the first layer is a different
    // thickness from the rest.
    let i = Math.round((z - lo) / span);
    if (i < 0) i = 0;
    if (i >= planeZ.length) i = planeZ.length - 1;
    while (i > 0 && planeZ[i] > z) i--;
    while (i < planeZ.length - 1 && planeZ[i] < z) i++;
    return i;
  };

  let degenerate = 0;
  for (let t = 0; t + 8 < positions.length; t += 9) {
    const z0 = positions[t + 2], z1 = positions[t + 5], z2 = positions[t + 8];
    if (!Number.isFinite(z0) || !Number.isFinite(z1) || !Number.isFinite(z2)) { degenerate++; continue; }
    const tMin = Math.min(z0, z1, z2), tMax = Math.max(z0, z1, z2);
    if (tMax - tMin < 1e-12) continue;              // horizontal, crosses no plane
    let a = indexFor(tMin), b = indexFor(tMax);
    while (a > 0 && planeZ[a] > tMin) a--;
    while (b < planeZ.length - 1 && planeZ[b] < tMax) b++;
    for (let i = a; i <= b; i++) {
      if (planeZ[i] >= tMin && planeZ[i] < tMax) buckets[i].push(t);
    }
  }
  if (degenerate) warnings.push(`${degenerate} triangle${degenerate === 1 ? '' : 's'} had non-finite coordinates and were skipped`);

  // A crack narrower than a fifth of a layer is float noise or a modeling
  // hairline, and closing it is right. Anything wider is a real hole.
  const gapTolerance = Math.max(cfg.layerHeight * 0.2, 0.05);

  const layers = [];
  let totalRepairs = 0, totalDropped = 0;
  for (let i = 0; i < plan.length; i++) {
    const segments = [];
    for (const t of buckets[i]) {
      const seg = cutTriangle(positions, t, plan[i].z);
      if (seg) segments.push(seg);
    }
    const { rings, repairs, dropped } = stitch(segments, gapTolerance);
    totalRepairs += repairs; totalDropped += dropped;

    // Clipper resolves anything the stitcher left ambiguous: rings that cross
    // themselves, two bodies that overlap, a ring traced twice.
    const polys = rings.length ? normalize(rings) : [];
    layers.push({ ...plan[i], polys });
    if (onProgress && (i % 16 === 0 || i === plan.length - 1)) onProgress((i + 1) / plan.length);
  }

  if (totalRepairs) warnings.push(`closed ${totalRepairs} hairline gap${totalRepairs === 1 ? '' : 's'} in the mesh`);
  if (totalDropped) warnings.push(`${totalDropped} outline${totalDropped === 1 ? '' : 's'} could not be closed and were dropped, so the model is probably not watertight`);

  const empty = layers.filter((l) => !l.polys.length).length;
  if (empty === layers.length) warnings.push('nothing intersected any slice plane');

  return { layers, bounds: bnds, warnings };
}

/** Total solid cross-section area of a slice stack, mm^2 per layer. Handy for
 *  tests: multiplied by layer height it must recover the model's volume. */
export function layerAreas(layers) {
  return layers.map((l) => area(l.polys));
}

/** Approximate model volume from the slices, mm^3. A cube sliced correctly
 *  reproduces its own volume to within one layer of quantization, which makes
 *  this the single best end-to-end check that slicing is not lying. */
export function slicedVolume(layers) {
  let v = 0;
  for (const l of layers) v += area(l.polys) * l.height;
  return v;
}

export { ringArea };
