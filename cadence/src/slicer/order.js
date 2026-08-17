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
/**
 * Print each island completely before travelling to the next one.
 *
 * Grouping by type across the WHOLE layer is right when there is one part on
 * the plate and wrong the moment there are two. Six parts at 20% infill means
 * the head does six sets of walls, crossing the plate five times, then six sets
 * of skin, crossing it five more, and so on for every group in the order. The
 * geometry constraint is only ever within one island: an outer wall needs its
 * own inner walls behind it, not somebody else's.
 *
 * So the group order is preserved inside each island, and the islands
 * themselves are visited nearest first. On a plate of six 20mm cubes this cuts
 * the between-path travel by most of what the crossings cost.
 *
 * Paths that belong to no island, which is the skirt, the brim and the raft,
 * are printed first and in the order they were given, because those are laid
 * around everything rather than on any one part.
 *
 * @param {object[]} paths
 * @param {string[]} groupOrder
 * @param {[number,number]} start
 * @param {{seam?:string, seed?:number, islands?:number[][][][]}} opts
 *        `islands` is a list of regions, one per separate part on this layer.
 */
export function orderByIslands(paths, groupOrder, start, opts = {}) {
  const islands = opts.islands || [];
  if (islands.length < 2) return orderByGroups(paths, groupOrder, start, opts);

  // Which island each path belongs to, decided by its first point. A path that
  // lands in none of them is loose, which is what a skirt is.
  const buckets = islands.map(() => []);
  const loose = [];
  for (const p of paths) {
    const pt = (p.ring || p.points)[0];
    let found = -1;
    for (let k = 0; k < islands.length; k++) {
      if (pointInIsland(pt, islands[k])) { found = k; break; }
    }
    if (found < 0) loose.push(p); else buckets[found].push(p);
  }

  let cur = start;
  let travel = 0;
  const out = [];

  if (loose.length) {
    const r = orderByGroups(loose, groupOrder, cur, opts);
    out.push(...r.paths); travel += r.travel; cur = r.end;
  }

  const left = buckets.map((b, k) => ({ paths: b, k })).filter((b) => b.paths.length);
  while (left.length) {
    // Nearest island next, measured to the first point of anything in it.
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < left.length; i++) {
      for (const p of left[i].paths) {
        const pt = (p.ring || p.points)[0];
        const d = dist2(pt, cur);
        if (d < bestD) { bestD = d; bestI = i; }
      }
    }
    const island = left.splice(bestI, 1)[0];
    const r = orderByGroups(island.paths, groupOrder, cur, { ...opts, seed: (opts.seed ?? 0) + island.k });
    out.push(...r.paths);
    travel += r.travel + Math.sqrt(bestD);
    cur = r.end;
  }

  return { paths: out, end: cur, travel };
}

/** Even-odd point in region, over one island's rings. */
function pointInIsland(pt, region) {
  let inside = false;
  for (const ring of region) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][1], yj = ring[j][1];
      if ((yi > pt[1]) !== (yj > pt[1])) {
        const x = ring[i][0] + ((pt[1] - yi) / (yj - yi)) * (ring[j][0] - ring[i][0]);
        if (pt[0] < x) inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Split a layer's outline into separate parts.
 *
 * A region is a flat list of rings, outers wound one way and holes the other,
 * with nothing saying which hole belongs to which outer. An island is one outer
 * ring plus every hole inside it, and telling them apart is what lets the
 * router know that two rings on opposite sides of the plate are two parts
 * rather than one shape.
 */
export function splitIslands(region) {
  if (!region || !region.length) return [];
  const outers = [], holes = [];
  for (const ring of region) {
    let a = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
      const p = ring[i], q = ring[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    (a >= 0 ? outers : holes).push(ring);
  }
  if (outers.length < 2) return outers.length ? [region] : [];
  const islands = outers.map((o) => [o]);
  for (const h of holes) {
    const pt = h[0];
    // Smallest containing outer wins, which is what makes a hole inside a part
    // that sits inside another part's bounding box land on the right one.
    let best = -1, bestArea = Infinity;
    for (let k = 0; k < outers.length; k++) {
      if (!pointInIsland(pt, [outers[k]])) continue;
      let a = 0;
      for (let i = 0, n = outers[k].length; i < n; i++) {
        const p = outers[k][i], q = outers[k][(i + 1) % n];
        a += p[0] * q[1] - q[0] * p[1];
      }
      a = Math.abs(a) / 2;
      if (a < bestArea) { bestArea = a; best = k; }
    }
    if (best >= 0) islands[best].push(h);
  }
  return islands;
}

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
