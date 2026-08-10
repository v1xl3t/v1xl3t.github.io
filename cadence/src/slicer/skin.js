// skin.js — deciding which parts of a layer have to be solid.
//
// Sparse infill is only acceptable where there is another layer above it to
// hide it and another below to hold it up. Everywhere else the surface is
// visible or unsupported, and has to be filled solid. So the question "is this
// bit of this layer skin?" has an exact answer:
//
//   TOP skin     the material here is NOT covered by every one of the next
//                `topLayers` layers. If any of them is missing above this spot,
//                the spot is on the outside of the part somewhere up there.
//   BOTTOM skin  the material here is NOT sitting on every one of the previous
//                `bottomLayers` layers.
//
// Intersecting the neighbours before differencing is what gives the thickness:
// one layer of solid over a hole would sag, so the rule asks for a run of
// layers to agree, and the skin grows to however many layers it takes.
//
// A missing neighbour (off the top or bottom of the model) intersects to
// nothing, so the very first and last layers come out fully solid without
// needing to be special-cased.
//
// The bridge distinction is separate and physical: bottom skin over a layer
// that exists is printing onto plastic, bottom skin over nothing is printing
// into air, and those want different speeds, different fan, and a chosen
// direction. Only the second is a bridge.

import { intersect, difference, union, prune, area, offset } from './clip.js';

/** Intersection of a run of layer regions. Empty as soon as one is missing,
 *  which is exactly the answer wanted at the ends of the model. */
function intersectRun(layers, from, to) {
  if (from < 0 || to >= layers.length || from > to) return [];
  let acc = layers[from].polys;
  if (!acc.length) return [];
  for (let i = from + 1; i <= to; i++) {
    acc = intersect(acc, layers[i].polys);
    if (!acc.length) return [];
  }
  return acc;
}

/**
 * Split one layer's infill area into solid skin and sparse fill.
 *
 * @param {{polys:number[][][]}[]} layers  every layer's outline
 * @param {number} i  which layer
 * @param {number[][][]} inner  this layer's area inside the walls
 * @param {{topLayers:number, bottomLayers:number, layerHeight:number, lineWidth:number}} s
 * @returns {{top, bottom, bridge, skin, sparse}} all regions
 */
export function classifySkin(layers, i, inner, s) {
  if (!inner || !inner.length) return { top: [], bottom: [], bridge: [], skin: [], sparse: [] };

  const above = intersectRun(layers, i + 1, i + Math.max(0, s.topLayers));
  const below = intersectRun(layers, i - Math.max(0, s.bottomLayers), i - 1);

  const top = s.topLayers > 0 ? prune(difference(inner, above), 0.02) : [];
  const bottom = s.bottomLayers > 0 ? prune(difference(inner, below), 0.02) : [];

  // Overhanging into open air, as opposed to merely being the underside of a
  // step that still has plastic beneath it. The first layer is excluded on
  // purpose: it has nothing below it either, but what it has instead is the
  // bed, and treating the whole footprint of every print as a bridge would slow
  // the one layer that most needs to be pressed down firmly.
  const prev = i > 0 ? layers[i - 1].polys : null;
  const bridge = prev && bottom.length ? prune(difference(bottom, prev), 0.05) : [];

  const skin = union(top, bottom);
  const sparse = prune(difference(inner, skin), 0.02);
  return { top, bottom, bridge, skin, sparse };
}

/**
 * Precompute skin for the whole stack.
 *
 * Done as one pass rather than lazily because the neighbour intersections
 * overlap heavily between adjacent layers, and because the caller wants the
 * totals for an estimate before it commits to generating any toolpaths.
 */
export function classifyAll(layers, inners, s, onProgress) {
  const out = new Array(layers.length);
  for (let i = 0; i < layers.length; i++) {
    out[i] = classifySkin(layers, i, inners[i], s);
    if (onProgress && (i % 16 === 0 || i === layers.length - 1)) onProgress((i + 1) / layers.length);
  }
  return out;
}

/**
 * Angles for solid fill, alternating per layer.
 *
 * Two adjacent solid layers laid in the same direction are two sheets that
 * share no mechanical interlock and peel apart along the grain. Crossing them
 * is the cheapest strength a print gets.
 */
export const skinAngle = (layerIndex, angles = [45, 135]) => angles[layerIndex % angles.length];

/**
 * How much of this layer is solid, as a fraction. Only used for reporting, but
 * it is the number that explains why a print with a large flat top takes twice
 * as long as its volume suggests.
 */
export function skinFraction(skin, inner) {
  const a = area(inner);
  return a > 0 ? Math.max(0, Math.min(1, area(skin) / a)) : 0;
}
