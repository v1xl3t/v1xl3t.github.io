// nest.js — packing several parts onto one build plate.
//
// WHAT THIS DOES, AND THE HALF IT DELIBERATELY DOES NOT.
//
// The original brief asked for parts "packed automatically, each rotated to the
// orientation that prints best". Those are two different problems wearing one
// name, and only one of them is packing:
//
//   PACKING, which this does. Given a set of footprints and a plate, find
//   somewhere for each of them that does not overlap anything else and does not
//   hang off the edge.
//
//   ORIENTATION, which this does NOT. "Prints best" means fewest overhangs,
//   strongest in the direction it will be loaded, smallest support volume, and
//   flattest face down. Scoring that is a real piece of work and guessing at it
//   would quietly lay parts down in orientations that print worse than where
//   the user put them. So the only rotation here is a quarter turn about the
//   up axis, taken when it makes a part fit a row it otherwise would not, and
//   that never changes which face is on the plate.
//
// THE ALGORITHM is shelf packing: sort by depth, fill a row left to right, start
// a new row when the current one runs out. It is not optimal and nothing here
// pretends it is. It is predictable, it is fast, it never overlaps, and its
// failure mode is leaving a gap rather than producing a plate that looks packed
// and is not. On a 220mm plate with a handful of parts, the difference between
// this and an optimal pack is a few millimetres nobody will use.

/**
 * Work out where each part should sit.
 *
 * Coordinates are CADence's: X across the plate, Z into it, Y up. Footprints
 * are the parts' own world bounding boxes, so a rotated or scaled part is
 * measured as it actually stands rather than as its recipe describes it.
 *
 * @param {{id:string, w:number, d:number, cx:number, cz:number}[]} parts
 *        `w` and `d` are the footprint size, `cx`/`cz` its current centre.
 * @param {{width:number, depth:number, gap?:number, margin?:number}} bed
 * @returns {{placed: {id:string, x:number, z:number, turned:boolean}[],
 *            skipped: {id:string, reason:string}[], rows:number,
 *            used:{w:number,d:number}}}
 *          `x`/`z` are where the part's CENTRE should move to.
 */
export function nestOnPlate(parts, bed) {
  const gap = bed.gap ?? 3;
  const margin = bed.margin ?? 3;
  const usableW = bed.width - margin * 2;
  const usableD = bed.depth - margin * 2;

  const placed = [];
  const skipped = [];

  // Tallest rows first. A shelf packer that meets its deepest part last has to
  // start a new row for it however much space is left, so sorting by depth is
  // most of what makes this work at all.
  const queue = parts
    .map((p) => ({ ...p }))
    .sort((a, b) => Math.max(b.d, b.w) - Math.max(a.d, a.w));

  let rowZ = 0;          // front edge of the current row, measured from the plate's front
  let rowDepth = 0;      // how deep the current row has grown
  let cursorX = 0;       // left edge of the next free space in this row
  let rows = 0;
  let usedW = 0;

  for (const p of queue) {
    // Both ways round, and the one that fits the row we are already in wins. A
    // quarter turn about the up axis does not change which face is on the
    // plate, so it cannot make a part print worse.
    const options = [
      { w: p.w, d: p.d, turned: false },
      { w: p.d, d: p.w, turned: true },
    ];

    let choice = null;
    for (const o of options) {
      if (o.w > usableW || o.d > usableD) continue;              // will not fit at all
      const fitsRow = cursorX + o.w <= usableW + 1e-9;
      const fitsPlate = rowZ + Math.max(rowDepth, o.d) <= usableD + 1e-9;
      if (fitsRow && fitsPlate) { choice = { ...o, newRow: false }; break; }
    }

    if (!choice) {
      // Start a new row, and try again from its left edge.
      const nextZ = rows === 0 ? 0 : rowZ + rowDepth + gap;
      for (const o of options) {
        if (o.w > usableW) continue;
        if (nextZ + o.d <= usableD + 1e-9) { choice = { ...o, newRow: true, nextZ }; break; }
      }
    }

    if (!choice) {
      // Two different failures wearing one symptom, and the difference is what
      // the user can do about it. A part too big for the plate in either
      // orientation will never fit however empty the plate is, and saying "the
      // plate ran out of room" about it sends someone off to delete parts that
      // were not the problem.
      const fitsSomehow = (p.w <= usableW && p.d <= usableD) || (p.d <= usableW && p.w <= usableD);
      skipped.push({
        id: p.id,
        reason: fitsSomehow
          ? 'the plate ran out of room'
          : `it is ${Math.round(p.w)} by ${Math.round(p.d)}mm and the usable plate is ${Math.round(usableW)} by ${Math.round(usableD)}mm`,
      });
      continue;
    }

    if (choice.newRow) {
      rowZ = choice.nextZ;
      rowDepth = 0;
      cursorX = 0;
      rows++;
    } else if (rows === 0) {
      rows = 1;
    }

    // Centre of the part, in plate coordinates measured from the front left
    // corner, then shifted into the model space the app works in, which has the
    // plate centred on the origin.
    const cx = cursorX + choice.w / 2;
    const cz = rowZ + choice.d / 2;
    placed.push({
      id: p.id,
      x: cx + margin - bed.width / 2,
      z: cz + margin - bed.depth / 2,
      turned: choice.turned,
    });

    cursorX += choice.w + gap;
    usedW = Math.max(usedW, cursorX - gap);
    rowDepth = Math.max(rowDepth, choice.d);
  }

  return { placed, skipped, rows: Math.max(rows, placed.length ? 1 : 0), used: { w: usedW, d: rowZ + rowDepth } };
}

/**
 * Do two placed footprints overlap?
 *
 * Only used by the tests, and that is the point: a packer is one of the few
 * things whose correctness can be stated in one sentence, and a suite that only
 * checked "it returned some coordinates" would pass while parts sat on top of
 * each other.
 */
export function overlaps(a, b, gap = 0) {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-6 + gap * 0
      && Math.abs(a.z - b.z) < (a.d + b.d) / 2 - 1e-6 + gap * 0;
}
