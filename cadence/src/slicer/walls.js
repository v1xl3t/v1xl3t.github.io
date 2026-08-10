// walls.js — the outside of the part.
//
// Walls are the one feature of a print that a person actually touches, and
// they are also the simplest to generate: a wall is the layer outline pushed
// inward by half a bead, then by a whole bead for each wall after that.
//
// The half-bead matters and is the most common thing to get wrong. G-code moves
// the CENTRE of the nozzle, but the model boundary is the OUTSIDE of the
// plastic. Putting the first wall's centreline on the outline makes every part
// come out one bead too big in every direction, which on a 0.4mm nozzle is
// 0.4mm of interference on any hole meant to fit a shaft. So wall n sits at
// (n + 0.5) line widths in from the boundary, and what is left over in the
// middle belongs to the infill.
//
//   boundary  |<-- lw/2 -->| wall 0 centre |<-- lw -->| wall 1 centre | ...
//
// After N walls the region has lost exactly N line widths all round, and that
// remainder is handed on untouched.

import { offset, difference, union, offsetLines, area, ringToLoop, prune } from './clip.js';
import { solidFill } from './infill.js';

/**
 * @param {number[][][]} region  the layer outline
 * @param {object} o
 * @param {number} o.wallCount
 * @param {number} o.lineWidth  mm
 * @param {number} [o.infillOverlap] percent of a line width that the infill is
 *        allowed to push back into the innermost wall, so the two weld
 * @returns {{walls: number[][][][], inner: number[][][], gaps: number[][][]}}
 *          walls[0] is the outer wall, as a list of rings.
 */
export function generateWalls(region, o) {
  const lw = o.lineWidth;
  const count = Math.max(0, Math.round(o.wallCount ?? 2));
  const walls = [];
  if (!region || !region.length) return { walls, inner: [], gaps: [] };
  if (count === 0) return { walls, inner: region, gaps: [] };

  for (let i = 0; i < count; i++) {
    const ring = offset(region, -(lw / 2 + i * lw));
    if (!ring.length) break;          // the part is thinner than this many walls
    walls.push(ring);
  }

  // What the walls physically cover, versus what is left for infill. Using the
  // walls actually generated rather than the walls requested is what keeps a
  // thin rib from being handed an "inner" region that its walls already filled.
  const inner = offset(region, -(count * lw));

  // Anywhere inside the outline that neither a wall bead nor the infill region
  // reaches: the classic case is a rib 0.9mm wide, too thick for two walls to
  // meet and too thin for a third. Left alone it prints as two beads with a
  // 0.1mm void down the middle.
  // Mitred rather than rounded, because the question here is "did a bead pass
  // over this", not "what shape is a bead". Round joins leave a sliver at every
  // outside corner, and treating those as gaps means every square part reports
  // four gaps per layer that no amount of plastic would ever fill.
  const covered = walls.length ? offsetLines(walls.flat(), lw, 'closed', 'miter') : [];
  // A gap smaller than one bead squared cannot take even a single dab of
  // plastic, so calling it a gap only produces toolpaths too short to extrude.
  const gaps = prune(difference(difference(region, covered), inner), lw * lw);

  return { walls, inner, gaps };
}

/**
 * The region infill and skin are allowed to occupy. Slightly larger than the
 * geometric leftover, because a sparse line that merely touches the wall does
 * not bond to it; overlapping by a fraction of a bead is what turns two
 * adjacent extrusions into one solid.
 */
export function infillRegion(inner, o) {
  const pct = o.infillOverlap ?? 0;
  if (!inner.length || pct <= 0) return inner;
  return offset(inner, (o.lineWidth * pct) / 100);
}

/**
 * Fill the slivers a whole number of walls could not cover.
 *
 * This is a modest version of what a mature slicer does. The proper answer is a
 * variable-width bead along the medial axis, which needs a Voronoi skeleton;
 * this instead lays narrow solid lines, which fills the void with plastic but
 * does not modulate flow to match the local width. It is better than leaving
 * the gap, and honest about not being the state of the art.
 */
export function fillGaps(gaps, o) {
  if (!gaps || !gaps.length) return [];
  const lw = o.lineWidth;
  const out = [];
  for (const ring of gaps) {
    const piece = [ring];
    if (Math.abs(area(piece)) < 0.02) continue;
    // A narrower nominal bead and a smaller setback, so a 0.3mm sliver still
    // gets a centre line instead of vanishing at the inset.
    const lines = solidFill(piece, { lineWidth: lw * 0.8, angle: o.angle ?? 45, overlap: lw * 0.25 });
    for (const l of lines) out.push(l);
  }
  return out;
}

/** How much plastic the walls of one layer will lay down, in mm of path. */
export function wallLength(walls) {
  let L = 0;
  for (const ring of walls.flat()) {
    for (let i = 0, n = ring.length; i < n; i++) {
      const p = ring[i], q = ring[(i + 1) % n];
      L += Math.hypot(q[0] - p[0], q[1] - p[1]);
    }
  }
  return L;
}
