// raft.js — a disposable slab printed first, with the part standing on it.
//
// The reason this was deferred rather than dropped into adhesion.js with the
// skirt and the brim: a skirt and a brim are things that happen ON the first
// layer, and a raft is a change to the Z of EVERY layer in the print. The model
// no longer starts at the bed. It starts on top of a stack of sacrificial
// layers, across an air gap, and every layer above it moves up by the same
// amount. That is a pipeline change, and half of one is worse than none: a raft
// that forgets to lift the model prints the part straight through its own
// scaffolding.
//
// Three bands, which is what makes a raft work rather than just being a thick
// brim:
//
//   BASE       one thick layer of fat, widely spaced lines. Fat because it has
//              to bridge whatever is wrong with the bed, and widely spaced
//              because squashed round beads with room to spread grip better
//              than a solid sheet that traps air under itself.
//   INTERFACE  ordinary layers, solid, alternating direction. These turn the
//              corrugated base into something flat.
//   THE GAP    the model's first layer is printed slightly ABOVE the raft's top
//              rather than onto it, so the two fuse just enough to hold and not
//              so much that they will never come apart. This is the number
//              people actually tune, and it is `raftGap`.

import { offset, unionAll, ringToLoop } from './clip.js';
import { solidFill, infillFill } from './infill.js';

/** Drop hole rings. A raft under a bore would be a plug you cannot remove. */
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
 * Build the raft, as ready-to-print plan layers.
 *
 * @param {number[][][]} modelFirstLayer  the model's outline on its own layer 0
 * @param {number[][][]} supportFirstLayer supports stand on the raft too
 * @param {object} s settings
 * @returns {{layers: object[], height: number, lift: number, footprintArea: number}}
 *          `lift` is how far every model layer has to move up, which is the
 *          raft's own height PLUS the air gap above it.
 */
export function buildRaft(modelFirstLayer, supportFirstLayer, s) {
  const none = { layers: [], height: 0, lift: 0, footprintArea: 0 };
  if (!modelFirstLayer || !modelFirstLayer.length) return none;

  const base = supportFirstLayer && supportFirstLayer.length
    ? unionAll([modelFirstLayer, supportFirstLayer])
    : modelFirstLayer;

  // The raft is wider than the part on purpose. A raft that stops at the
  // part's own edge peels from its corners, which is the failure it exists to
  // prevent.
  const margin = s.raftMargin ?? 4;
  const foot = outerOnly(offset(base, margin));
  if (!foot.length) return none;

  const nozzle = s.nozzleDiameter || 0.4;
  const baseWidth = nozzle * (s.raftBaseWidthFactor ?? 2.2);
  const baseHeight = (s.firstLayerHeight || s.layerHeight) * (s.raftBaseHeightFactor ?? 1.5);
  const ifaceHeight = s.layerHeight;
  const ifaceCount = Math.max(1, Math.round(s.raftLayers ?? 2) - 1);
  const speed = s.speeds.firstLayer;

  const layers = [];
  let bottom = 0;

  // --- base: fat lines with air between them
  {
    const lines = infillFill(offset(foot, -baseWidth / 2), {
      pattern: 'lines',
      density: s.raftBaseDensity ?? 70,
      lineWidth: baseWidth,
      angle: 0,
      layerIndex: 0,
      z: baseHeight / 2,
    });
    const paths = [];
    // One outline so the fat lines have something to end against, or the raft
    // edge is a row of unsupported line ends that curl.
    for (const ring of offset(foot, -baseWidth / 2)) {
      const loop = ringToLoop(ring);
      if (loop) paths.push({ type: 'raft', points: loop, closed: false, width: baseWidth, speed });
    }
    for (const line of lines) {
      if (line && line.length >= 2) paths.push({ type: 'raft', points: line, closed: false, width: baseWidth, speed });
    }
    layers.push({
      index: layers.length,
      z: bottom + baseHeight / 2,
      height: baseHeight,
      paths,
      speedFactor: 1,
      travel: 0,
      outline: foot,
      raft: true,
    });
    bottom += baseHeight;
  }

  // --- interface: ordinary solid layers that flatten the base out
  for (let k = 0; k < ifaceCount; k++) {
    const lw = s.lineWidth;
    const angle = k % 2 === 0 ? 90 : 0;
    const lines = solidFill(foot, { lineWidth: lw, angle });
    const paths = [];
    for (const ring of offset(foot, -lw / 2)) {
      const loop = ringToLoop(ring);
      if (loop) paths.push({ type: 'raft', points: loop, closed: false, width: lw, speed });
    }
    for (const line of lines) {
      if (line && line.length >= 2) paths.push({ type: 'raft', points: line, closed: false, width: lw, speed });
    }
    layers.push({
      index: layers.length,
      z: bottom + ifaceHeight / 2,
      height: ifaceHeight,
      paths,
      speedFactor: 1,
      travel: 0,
      outline: foot,
      raft: true,
    });
    bottom += ifaceHeight;
  }

  let footprintArea = 0;
  for (const ring of foot) {
    let a = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
      const p = ring[i], q = ring[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    footprintArea += Math.abs(a) / 2;
  }

  return {
    layers,
    height: bottom,
    lift: bottom + (s.raftGap ?? 0.25),
    footprintArea,
  };
}

/**
 * Move the model up onto the raft.
 *
 * Every layer's z and index shift together. The index matters as much as the z:
 * the emitter reads index 0 as "this is the first layer, keep the fan off and
 * weld it to the bed", and after a raft the layer that is actually against the
 * bed is the raft's base, not the model's bottom.
 */
export function liftLayers(planLayers, lift, indexOffset) {
  for (const l of planLayers) {
    l.z += lift;
    l.index += indexOffset;
  }
  return planLayers;
}
