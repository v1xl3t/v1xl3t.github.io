// infill.js — filling an area with line, cheaply and in a pattern.
//
// Every pattern here works the same way, and the sameness is the design: build
// a family of lines that covers the whole bounding box with no regard for the
// shape, then hand them to Clipper to be trimmed to the material. Generating
// lines and clipping them is fast, exact, and handles holes, islands and
// concave notches without any of them being a special case.
//
// The one number that ties patterns together is SPACING. A bead of width w laid
// every s apart covers w/s of the area, so a requested density d gives
// s = w / (d/100). Every pattern below hits that same target coverage, which is
// what makes "20% grid" and "20% gyroid" comparable amounts of plastic instead
// of two unrelated dials.
//
// Line families are anchored to an absolute grid rather than to each region's
// own bounding box. Two separate islands on the same layer then get infill that
// lines up, and more importantly infill on layer n lands on top of infill on
// layer n-2 instead of drifting, which is what stops sparse infill from slowly
// turning into a pile of unsupported diagonal strings.

import { clipLines, offset, bounds, prune, ringToLoop, lineLength, simplifyLine } from './clip.js';

const RAD = Math.PI / 180;

/**
 * A family of parallel lines at `angle` degrees, `spacing` apart, covering a
 * bounding box with margin. Anchored to the absolute coordinate grid.
 */
function lineFamily(bbox, angle, spacing, phase = 0) {
  if (!bbox || !(spacing > 0)) return [];
  const a = angle * RAD;
  const dx = Math.cos(a), dy = Math.sin(a);
  const nx = -dy, ny = dx;

  const cx = (bbox.minX + bbox.maxX) / 2, cy = (bbox.minY + bbox.maxY) / 2;
  const R = Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) / 2 + spacing;

  // How far the box reaches along the family's normal.
  const corners = [[bbox.minX, bbox.minY], [bbox.maxX, bbox.minY], [bbox.maxX, bbox.maxY], [bbox.minX, bbox.maxY]];
  let pMin = Infinity, pMax = -Infinity;
  for (const c of corners) {
    const p = c[0] * nx + c[1] * ny;
    if (p < pMin) pMin = p;
    if (p > pMax) pMax = p;
  }

  const lines = [];
  const start = Math.ceil((pMin - phase) / spacing) * spacing + phase;
  for (let t = start; t <= pMax + 1e-9; t += spacing) {
    // A point on this line, then run it out past both ends of the box.
    const px = nx * t, py = ny * t;
    const ox = cx * dx + cy * dy;   // centre projected along the line direction
    lines.push([
      [px + dx * (ox - R), py + dy * (ox - R)],
      [px + dx * (ox + R), py + dy * (ox + R)],
    ]);
    if (lines.length > 100000) break;
  }
  return lines;
}

/**
 * Marching squares on an implicit function, used for the gyroid. Returns the
 * zero contour as open polylines.
 *
 * Worth having rather than approximating a gyroid with zigzags: the reason to
 * print a gyroid is that it is isotropic and self-supporting in every
 * direction, and a fake one made of straight lines is neither.
 */
function marchingSquares(bbox, f, step) {
  const w = Math.ceil((bbox.maxX - bbox.minX) / step) + 2;
  const h = Math.ceil((bbox.maxY - bbox.minY) / step) + 2;
  if (w * h > 4e6) return [];
  const x0 = bbox.minX - step, y0 = bbox.minY - step;

  // A sample of exactly zero means the contour runs through a grid corner, and
  // the two cells meeting there disagree about which side it passed on. Nudging
  // every exact zero the same direction removes the case entirely, at a cost
  // far below the sampling error already present.
  const val = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = f(x0 + i * step, y0 + j * step);
      val[j * w + i] = v === 0 ? -1e-12 : v;
    }
  }

  const rawSegs = [];
  const lerp = (xa, ya, va, xb, yb, vb) => {
    const t = Math.abs(vb - va) < 1e-12 ? 0.5 : va / (va - vb);
    return [xa + (xb - xa) * t, ya + (yb - ya) * t];
  };
  // Where the contour clips a grid corner, both crossings land on that corner
  // and the cell emits a segment of no length. It carries no toolpath but it
  // does occupy the chain map, so a real contour arriving at that corner can
  // find the stub instead of its true continuation.
  const segs = {
    push(...items) {
      for (const s of items) {
        if (Math.abs(s[1][0] - s[0][0]) > 1e-9 || Math.abs(s[1][1] - s[0][1]) > 1e-9) rawSegs.push(s);
      }
    },
  };

  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const xa = x0 + i * step, ya = y0 + j * step, xb = xa + step, yb = ya + step;
      const v00 = val[j * w + i], v10 = val[j * w + i + 1];
      const v11 = val[(j + 1) * w + i + 1], v01 = val[(j + 1) * w + i];
      let code = 0;
      if (v00 > 0) code |= 1;
      if (v10 > 0) code |= 2;
      if (v11 > 0) code |= 4;
      if (v01 > 0) code |= 8;
      if (code === 0 || code === 15) continue;

      const B = () => lerp(xa, ya, v00, xb, ya, v10);      // bottom edge
      const R2 = () => lerp(xb, ya, v10, xb, yb, v11);     // right
      const T = () => lerp(xb, yb, v11, xa, yb, v01);      // top
      const L = () => lerp(xa, yb, v01, xa, ya, v00);      // left

      // Every segment travels with the inside (f > 0) on its LEFT. That is not
      // cosmetic: a case and its complement must run in OPPOSITE directions,
      // and if they do not, a contour that crosses from one to the other breaks
      // into two chains at the boundary. Sharing a table row between a code and
      // its complement is exactly how a gyroid ends up as ten thousand
      // two-point stubs with a travel move between each of them.
      switch (code) {
        case 1:  segs.push([B(), L()]); break;
        case 14: segs.push([L(), B()]); break;
        case 2:  segs.push([R2(), B()]); break;
        case 13: segs.push([B(), R2()]); break;
        case 3:  segs.push([R2(), L()]); break;
        case 12: segs.push([L(), R2()]); break;
        case 4:  segs.push([T(), R2()]); break;
        case 11: segs.push([R2(), T()]); break;
        case 6:  segs.push([T(), B()]); break;
        case 9:  segs.push([B(), T()]); break;
        case 8:  segs.push([L(), T()]); break;
        case 7:  segs.push([T(), L()]); break;
        // Saddles: two contours pass through one cell and the corner values
        // alone cannot say whether the two positive corners are joined through
        // the middle or pinched apart. Guessing splits the contour wherever the
        // guess disagrees with the neighbouring cell, which is what turns a
        // gyroid into confetti. The asymptotic decider settles it by asking
        // what the function does at the centre of the cell.
        case 5: {
          if ((v00 + v10 + v11 + v01) > 0) segs.push([B(), R2()], [T(), L()]);
          else segs.push([B(), L()], [T(), R2()]);
          break;
        }
        case 10: {
          if ((v00 + v10 + v11 + v01) > 0) segs.push([L(), B()], [R2(), T()]);
          else segs.push([R2(), B()], [L(), T()]);
          break;
        }
      }
    }
  }

  // Join the segment soup into runs, so the printer draws long strokes instead
  // of thousands of two-point moves with a travel between each.
  //
  // Chains have to grow in BOTH directions, and this is not an optimisation.
  // Cells are visited in raster order, but a contour travels whichever way its
  // own geometry says. For a contour heading downward, the cell holding its
  // continuation was already visited and turned into its own chain, so a
  // forward-only walk finds every continuation used and emits the entire
  // contour as a pile of single segments. Roughly half of any closed pattern
  // runs "against the raster", so forward-only chaining fragments about half
  // the toolpath, and the printer then travels between every 0.15mm stroke.
  const segments = rawSegs;
  const SNAP = step * 1e-3;
  const key = (p) => `${Math.round(p[0] / SNAP)},${Math.round(p[1] / SNAP)}`;
  const byStart = new Map(), byEnd = new Map();
  for (let i = 0; i < segments.length; i++) {
    const ks = key(segments[i][0]), ke = key(segments[i][1]);
    if (!byStart.has(ks)) byStart.set(ks, []);
    byStart.get(ks).push(i);
    if (!byEnd.has(ke)) byEnd.set(ke, []);
    byEnd.get(ke).push(i);
  }
  const used = new Uint8Array(segments.length);
  const take = (map, k) => {
    const list = map.get(k);
    if (list) for (const j of list) if (!used[j]) return j;
    return -1;
  };

  const lines = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [segments[i][0], segments[i][1]];

    for (let guard = 0; guard < 100000; guard++) {
      const next = take(byStart, key(line[line.length - 1]));
      if (next < 0) break;
      used[next] = 1;
      line.push(segments[next][1]);
    }
    // Only worth walking back if the forward walk did not already close a loop.
    if (key(line[0]) !== key(line[line.length - 1])) {
      for (let guard = 0; guard < 100000; guard++) {
        const prev = take(byEnd, key(line[0]));
        if (prev < 0) break;
        used[prev] = 1;
        line.unshift(segments[prev][0]);
      }
    }
    if (line.length >= 2) lines.push(simplifyLine(line, step * 0.05));
  }
  return lines;
}

// The gyroid's zero contour has this much line length per unit area, per unit
// of wavelength. Measured, not guessed: models/slicer.test.mjs re-derives it
// from a plain 100mm square and fails if this drifts, because if it is wrong
// then every gyroid print comes out at the wrong density.
export const GYROID_LENGTH_CONSTANT = 2.40;

/** Spacing that achieves a target coverage for a bead of the given width. */
export const spacingFor = (lineWidth, density) => (density > 0 ? lineWidth / (density / 100) : Infinity);

/**
 * Fill a region with a sparse pattern.
 *
 * @param {number[][][]} region  the area to fill, holes included
 * @param {object} o
 * @param {string} o.pattern   lines | grid | triangles | gyroid | concentric
 * @param {number} o.density   percent
 * @param {number} o.lineWidth mm
 * @param {number} o.angle     base angle, degrees
 * @param {number} o.layerIndex used to alternate direction between layers
 * @param {number} o.z         needed by the gyroid, which is genuinely 3D
 * @returns {number[][][]} open polylines, already trimmed to the region
 */
export function infillFill(region, o) {
  if (!region || !region.length) return [];
  const density = Math.max(0, Math.min(100, o.density ?? 20));
  if (density <= 0) return [];
  const lw = o.lineWidth;
  const bbox = bounds(region);
  if (!bbox) return [];
  const base = o.angle ?? 45;
  const layer = o.layerIndex ?? 0;

  switch (o.pattern) {
    case 'concentric':
      return concentricFill(region, spacingFor(lw, density));

    case 'grid': {
      // Two families at right angles, each carrying half the coverage.
      const s = spacingFor(lw, density) * 2;
      return clipLines([...lineFamily(bbox, base, s), ...lineFamily(bbox, base + 90, s)], region);
    }

    case 'triangles': {
      const s = spacingFor(lw, density) * 3;
      return clipLines([
        ...lineFamily(bbox, base, s),
        ...lineFamily(bbox, base + 60, s),
        ...lineFamily(bbox, base + 120, s),
      ], region);
    }

    case 'gyroid': {
      // The wavelength that produces the requested coverage.
      const targetLengthPerArea = (density / 100) / lw;
      const period = GYROID_LENGTH_CONSTANT / targetLengthPerArea;
      const k = (Math.PI * 2) / period;
      const z = (o.z ?? 0) * k;
      const sz = Math.sin(z), cz = Math.cos(z);
      const f = (x, y) => {
        const sx = Math.sin(k * x), cx = Math.cos(k * x);
        const sy = Math.sin(k * y), cy = Math.cos(k * y);
        return sx * cy + sy * cz + sz * cx;
      };
      // Sixteen samples per wavelength. Below about twelve the saddle cells
      // outnumber the clean ones and the contour comes out visibly faceted;
      // above about twenty the grid cost climbs with nothing to show for it.
      const step = Math.max(period / 16, 0.12);
      const raw = marchingSquares(bbox, f, step);
      return clipLines(raw, region);
    }

    case 'lines':
    default: {
      // Alternating 90 degrees each layer is what makes stacked sparse lines
      // into a lattice rather than a set of unconnected walls.
      const s = spacingFor(lw, density);
      return clipLines(lineFamily(bbox, base + (layer % 2) * 90, s), region);
    }
  }
}

/**
 * Fill a region solid: lines one width apart, so the beads touch.
 *
 * `angle` alternates between layers by the caller, which is what makes a top
 * surface cross-hatch and bond instead of delaminating into a stack of
 * unidirectional sheets.
 */
export function solidFill(region, { lineWidth, angle = 45, overlap = 0 }) {
  if (!region || !region.length) return [];
  // Beads are laid centre to centre one width apart, and the outermost bead
  // sits half a width inside the boundary, otherwise solid fill overruns the
  // wall it is supposed to butt against.
  const inner = offset(region, -lineWidth / 2 + overlap);
  if (!inner.length) return [];
  const bbox = bounds(inner);
  return clipLines(lineFamily(bbox, angle, lineWidth), inner);
}

/** Successive insets, each emitted as a closed loop. Good for round parts and
 *  for the top surface of anything you want to look turned rather than milled. */
export function concentricFill(region, spacing) {
  const out = [];
  let cur = offset(region, -spacing / 2);
  for (let i = 0; i < 500 && cur.length; i++) {
    for (const ring of cur) {
      const loop = ringToLoop(ring);
      if (loop && lineLength(loop) > 1e-6) out.push(loop);
    }
    cur = offset(cur, -spacing);
  }
  return out;
}

/**
 * Which way to lay a bridge.
 *
 * A skin with nothing under it has to span, and the span should be as short as
 * possible and should land on solid ground at both ends. Sweeping candidate
 * angles and taking the one whose trimmed segments are shortest on average
 * finds that direction without needing to identify the anchors explicitly, and
 * it degrades gracefully on a shape with no obvious span.
 */
export function bridgeAngle(region) {
  if (!region || !region.length) return null;
  const bbox = bounds(region);
  if (!bbox) return null;
  const probe = Math.max(1, Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) / 20);

  let best = null, bestScore = Infinity;
  for (let a = 0; a < 180; a += 5) {
    const segs = clipLines(lineFamily(bbox, a, probe), region);
    if (!segs.length) continue;
    let total = 0, worst = 0;
    for (const s of segs) {
      const L = lineLength(s);
      total += L;
      if (L > worst) worst = L;
    }
    // The longest unsupported run is what actually droops, so weight it.
    const score = worst * 2 + total / segs.length;
    if (score < bestScore) { bestScore = score; best = a; }
  }
  // `best` is already the direction to print in: it is the angle whose trimmed
  // segments came out shortest, which is the same as saying the plastic spends
  // the least time crossing thin air before it reaches something to land on.
  return best;
}

export { lineFamily, marchingSquares };
