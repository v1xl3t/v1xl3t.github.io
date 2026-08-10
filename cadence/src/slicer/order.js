// order.js — what to print next, and where to start it.
//
// By the time a layer's toolpaths exist, the geometry question is settled and
// only the routing question is left: the nozzle is somewhere, and there are
// eighty paths to visit. Visiting them in the order they were generated means
// the head crosses the part repeatedly, and every crossing is a retraction, a
// travel, an unretract, and a small blob where the pressure came back.
//
// Nearest-neighbour is used rather than anything cleverer. It is O(n^2) in the
// paths of one layer, which is nothing, it captures nearly all the available
// win, and unlike a proper tour optimiser it never reorders things into a
// sequence that violates what has to be printed before what.
//
// SEAM PLACEMENT is the other half. Every closed loop has to start somewhere,
// and that somewhere leaves a small scar where the nozzle stopped and started.
// Stacking those scars in a line down the part is the single most visible
// artefact on an otherwise good print.

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/**
 * Pick where a closed loop should start.
 *
 * @param {number[][]} ring
 * @param {[number,number]} from  where the nozzle is now
 * @param {'nearest'|'rear'|'random'} mode
 * @param {number} seed  so 'random' is reproducible across re-slices
 */
export function seamIndex(ring, from, mode = 'nearest', seed = 0) {
  if (!ring || !ring.length) return 0;
  if (mode === 'rear') {
    // Hide the scar at the back of the part, on the assumption that the front
    // is the side being looked at.
    let best = 0;
    for (let i = 1; i < ring.length; i++) if (ring[i][1] > ring[best][1]) best = i;
    return best;
  }
  if (mode === 'random') {
    // Scattering the scar trades one visible line for a slightly rougher
    // surface everywhere, which on a curved part is the better deal.
    const r = Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1;
    return Math.floor(r * ring.length) % ring.length;
  }
  let best = 0, bestD = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = dist2(ring[i], from);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Rotate a ring to start at `index` and close it by repeating that point. */
export function rotateLoop(ring, index) {
  const out = [];
  for (let i = 0; i < ring.length; i++) out.push(ring[(index + i) % ring.length]);
  out.push(out[0]);
  return out;
}

/**
 * Order a layer's paths for printing, and resolve every loop's seam.
 *
 * @param {{type:string, ring?:number[][], points?:number[][], closed:boolean}[]} paths
 * @param {[number,number]} start  the nozzle's current position
 * @param {{seam?:string, seed?:number}} opts
 * @returns {{paths: object[], end: [number,number], travel: number}}
 *          `travel` is the total distance between paths, which is the number
 *          this whole file exists to make small.
 */
export function orderPaths(paths, start, opts = {}) {
  const remaining = paths.slice();
  const out = [];
  let cur = start;
  let travel = 0;
  let seed = opts.seed ?? 0;

  while (remaining.length) {
    let bestI = 0, bestD = Infinity, bestFlip = false;

    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i];
      if (p.closed) {
        // A loop can be entered at any vertex, so its distance is the distance
        // to the nearest one.
        const ring = p.ring || p.points;
        for (let k = 0; k < ring.length; k++) {
          const d = dist2(ring[k], cur);
          if (d < bestD) { bestD = d; bestI = i; bestFlip = false; }
        }
      } else {
        // An open line can be printed either way round, and choosing costs
        // nothing while saving a whole traverse of the line.
        const pts = p.points;
        const dHead = dist2(pts[0], cur);
        const dTail = dist2(pts[pts.length - 1], cur);
        if (dHead < bestD) { bestD = dHead; bestI = i; bestFlip = false; }
        if (dTail < bestD) { bestD = dTail; bestI = i; bestFlip = true; }
      }
    }

    const chosen = remaining.splice(bestI, 1)[0];
    travel += Math.sqrt(bestD);

    if (chosen.closed) {
      const ring = chosen.ring || chosen.points;
      const idx = seamIndex(ring, cur, opts.seam, seed++);
      const points = rotateLoop(ring, idx);
      out.push({ ...chosen, points, closed: true });
      cur = points[points.length - 1];
    } else {
      const points = bestFlip ? chosen.points.slice().reverse() : chosen.points;
      out.push({ ...chosen, points, closed: false });
      cur = points[points.length - 1];
    }
  }

  return { paths: out, end: cur, travel };
}

/**
 * Group paths so that everything of one kind is printed together, in the order
 * given, and only then routed within its group.
 *
 * The grouping is not cosmetic. Skin printed before the sparse infill under it
 * has nothing to sit on; an outer wall printed before the inner ones has no
 * backing and bulges. So the routing optimiser is only ever allowed to reorder
 * within a group, never across one.
 */
export function orderByGroups(paths, groupOrder, start, opts = {}) {
  let cur = start;
  const out = [];
  let travel = 0;
  for (const type of groupOrder) {
    const group = paths.filter((p) => p.type === type);
    if (!group.length) continue;
    const r = orderPaths(group, cur, opts);
    out.push(...r.paths);
    travel += r.travel;
    cur = r.end;
  }
  // Anything with a type not named in the order still has to be printed.
  const leftovers = paths.filter((p) => !groupOrder.includes(p.type));
  if (leftovers.length) {
    const r = orderPaths(leftovers, cur, opts);
    out.push(...r.paths);
    travel += r.travel;
    cur = r.end;
  }
  return { paths: out, end: cur, travel };
}
