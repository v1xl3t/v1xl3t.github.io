// adhesion.js — getting the first layer to stay where it was put.
//
// Three answers, in increasing order of how much they cost you:
//
//   SKIRT  a loop or two around the part, not touching it. Contributes nothing
//          mechanically. Its actual job is to get plastic flowing and to let
//          you watch the first line go down and abort if the bed is off.
//   BRIM   loops that DO touch the part, widening its footprint. This is what
//          stops a tall thin thing from being knocked over and a sharp corner
//          from curling up off the bed.
//   RAFT   a whole disposable slab printed first, with the part on top of it.
//          The answer when the bed itself is the problem.
//
// Only the first two are implemented here. A raft is not a first-layer feature
// but a change to the Z of every layer in the print, which belongs in the
// pipeline rather than in a helper, and doing it badly is worse than not
// offering it. See TODO.md.

import { offset, union, unionAll, difference, prune, ringToLoop, ringLength, area } from './clip.js';

/**
 * @param {number[][][]} firstLayer  the model's outline on layer 0
 * @param {number[][][]} supportFirstLayer  supports also want holding down
 * @param {object} s settings
 * @returns {{loops: number[][][], type: string, length: number}} closed loops,
 *          outermost first, ready to print before anything else on layer 0
 */
export function buildAdhesion(firstLayer, supportFirstLayer, s) {
  const type = s.adhesion || 'skirt';
  if (type === 'none' || !firstLayer || !firstLayer.length) return { loops: [], type: 'none', length: 0 };

  const lw = s.firstLayerLineWidth || s.lineWidth;
  const base = supportFirstLayer && supportFirstLayer.length
    ? unionAll([firstLayer, supportFirstLayer])
    : firstLayer;

  const loops = [];
  if (type === 'brim') {
    // Brim rings start half a bead outside the part and step outward. Only the
    // outer boundaries get a brim: putting one inside a hole would weld the
    // slug in the middle to the part.
    const count = Math.max(1, Math.round((s.brimWidth || 5) / lw));
    for (let i = 0; i < count; i++) {
      const ring = outerOnly(offset(base, lw * (i + 0.5)));
      if (!ring.length) break;
      for (const r of ring) {
        const loop = ringToLoop(r);
        if (loop) loops.push(loop);
      }
    }
  } else {
    // Skirt: a gap, then however many loops it takes to prime the nozzle.
    const gap = s.skirtGap ?? 3;
    let i = 0;
    let total = 0;
    const minLength = s.skirtMinLength ?? 0;
    const maxLoops = 40;
    while (i < maxLoops) {
      if (i >= (s.skirtLines ?? 2) && total >= minLength) break;
      const ring = outerOnly(offset(base, gap + lw * (i + 0.5)));
      if (!ring.length) break;
      for (const r of ring) {
        const loop = ringToLoop(r);
        if (loop) { loops.push(loop); total += ringLength(r); }
      }
      i++;
    }
  }

  // Outermost first. A skirt printed inside-out would have the nozzle crossing
  // the loops it just laid on its way out.
  loops.reverse();
  let length = 0;
  for (const l of loops) for (let i = 1; i < l.length; i++) {
    length += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
  }
  return { loops, type, length };
}

/** Drop hole rings. Growing a region outward can only ever shrink its holes,
 *  and a brim ring inside a bore is a plug, not adhesion. */
function outerOnly(region) {
  const out = [];
  for (const ring of region || []) {
    let a = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
      const p = ring[i], q = ring[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    if (a > 0) out.push(ring);
  }
  return out;
}

/**
 * A brim under the supports only. Tree supports in particular land on the plate
 * as a handful of small circles, and a 3mm circle standing 60mm tall will be
 * knocked over by the nozzle long before the print finishes.
 */
export function supportBrim(supportFirstLayer, modelFirstLayer, s) {
  if (!s.supportBrim || !supportFirstLayer || !supportFirstLayer.length) return [];
  const lw = s.firstLayerLineWidth || s.lineWidth;
  const count = Math.max(1, Math.round(3 / lw));
  const loops = [];
  for (let i = 0; i < count; i++) {
    let ring = outerOnly(offset(supportFirstLayer, lw * (i + 0.5)));
    // Never let a support brim run into the part itself.
    if (modelFirstLayer && modelFirstLayer.length) {
      ring = outerOnly(difference(ring, offset(modelFirstLayer, s.supportXYGap)));
    }
    if (!ring.length) break;
    for (const r of ring) {
      const loop = ringToLoop(r);
      if (loop) loops.push(loop);
    }
  }
  return loops;
}
