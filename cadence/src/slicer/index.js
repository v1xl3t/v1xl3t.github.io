// index.js — the pipeline.
//
// Everything else in this folder is a stage that does one thing to polygons.
// This file is the order they go in, and the order is not arbitrary: each stage
// consumes the previous stage's output and nothing can be moved without
// breaking that chain.
//
//   place        put the model on the bed and check it fits
//   slice        mesh  ->  a closed outline per layer
//   walls        outline -> perimeter loops + the area left inside them
//   skin         that inner area -> solid where it is exposed, sparse elsewhere
//   supports     the whole stack -> scaffolding under the overhangs
//   adhesion     layer 0 -> skirt or brim
//   fill         every region -> actual lines
//   cool         layer times -> speed factors where a layer is too quick
//   order        a bag of paths -> a route
//   emit         a route -> G-code
//
// The PLAN is the thing worth caring about. It is a plain data structure of
// typed paths with coordinates and speeds, produced before any G-code exists.
// The preview draws the plan, the estimates measure the plan, and the emitter
// serialises the plan. That is why the layer preview always agrees with the
// file: they are the same object, not two renderings of the same intent.

import { sliceMesh, meshBounds } from './slice.js';
import { generateWalls, fillGaps, infillRegion } from './walls.js';
import { classifyAll, skinAngle } from './skin.js';
import { infillFill, solidFill, bridgeAngle, ironingLines } from './infill.js';
import { buildSupports } from './supports.js';
import { buildAdhesion, supportBrim } from './adhesion.js';
import { orderByGroups, orderByIslands, splitIslands } from './order.js';
import { buildRaft, liftLayers } from './raft.js';
import { emitGcode, estimateLayerTime, coolingFactor, formatDuration } from './gcode.js';
import { buildSettings, validate } from './profiles.js';
import { offset, area, ringToLoop, union, difference, bounds, pointInRegion } from './clip.js';

// What gets printed before what, within a layer.
const GROUP_ORDER = [
  'raft', 'skirt', 'brim',
  'support', 'support-interface',
  'wall-inner', 'wall-outer',
  'gap', 'bridge', 'skin', 'infill',
  // Ironing goes last on purpose. It is a pass over a surface that has to
  // already exist, so anything that would still be laying plastic on this
  // layer has to have finished first.
  'ironing',
];

/**
 * Move the model onto the bed.
 *
 * CADence models are centred on the origin and the Ender's origin is the front
 * left corner of its bed, so without this every print would be quartered off
 * the front left of the plate. The model is also dropped so its lowest point
 * is exactly zero, because a model floating 0.02mm above the bed slices into a
 * first layer that never touches anything.
 *
 * @returns {{positions: Float32Array, offset: [number,number,number], fits: boolean, warnings: string[]}}
 */
export function placeOnBed(positions, s) {
  const warnings = [];
  const b = meshBounds(positions);
  if (!b) return { positions, offset: [0, 0, 0], fits: false, warnings: ['there is nothing to slice'] };

  const w = b.maxX - b.minX, d = b.maxY - b.minY, h = b.maxZ - b.minZ;
  let dx = 0, dy = 0;
  if (s.centreOnBed) {
    const cx = s.originCentre ? 0 : s.bedWidth / 2;
    const cy = s.originCentre ? 0 : s.bedDepth / 2;
    dx = cx - (b.minX + b.maxX) / 2;
    dy = cy - (b.minY + b.maxY) / 2;
  }
  const dz = -b.minZ;

  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i] + dx;
    out[i + 1] = positions[i + 1] + dy;
    out[i + 2] = positions[i + 2] + dz;
  }

  let fits = true;
  if (w > s.bedWidth || d > s.bedDepth) {
    fits = false;
    warnings.push(`the model is ${w.toFixed(1)} x ${d.toFixed(1)}mm and the bed is ${s.bedWidth} x ${s.bedDepth}mm`);
  }
  if (h > s.bedHeight) {
    fits = false;
    warnings.push(`the model is ${h.toFixed(1)}mm tall and this machine can reach ${s.bedHeight}mm`);
  }
  return { positions: out, offset: [dx, dy, dz], fits, warnings, size: { w, d, h } };
}

/**
 * Decide which travels can skip their retraction.
 *
 * Retraction exists to stop a string of plastic being drawn across open air on
 * the way to the next path. If the travel never leaves the material, there is
 * no open air to string across, and the retraction is pure cost: on a Bowden
 * machine it is 5mm out and 5mm back at 45mm/s, roughly a quarter second, and
 * a wear cycle on the filament every single time.
 *
 * Untreated, a 20mm cube at 20% grid infill retracts seven or eight times per
 * layer, because every jump from one infill line to the next is longer than the
 * minimum travel. Nearly all of those jumps are entirely inside the part.
 *
 * The test is deliberately the conservative half of what a full combing
 * implementation does. A real one also REROUTES the travel around holes; this
 * one only suppresses the retraction when the straight line already happens to
 * stay inside, and retracts as normal otherwise. That cannot make stringing
 * worse than not combing at all, which is the property worth having.
 */
function markCombing(paths, region, startAt, s) {
  if (!region || !region.length) return;
  let cur = startAt;
  for (const path of paths) {
    const to = path.points[0];
    const L = Math.hypot(to[0] - cur[0], to[1] - cur[1]);
    // Below the minimum travel nothing retracts anyway; above 30mm the odds of
    // a straight line staying inside are low enough not to be worth sampling.
    if (L >= (s.retractMinTravel ?? 0) && L <= 30) {
      const steps = Math.min(16, Math.max(3, Math.ceil(L)));
      let inside = true;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        if (!pointInRegion([cur[0] + (to[0] - cur[0]) * t, cur[1] + (to[1] - cur[1]) * t], region)) { inside = false; break; }
      }
      path.combed = inside;
    }
    cur = path.points[path.points.length - 1];
  }
}

/** Turn a region into closed loop paths of a given type. */
function loopsOf(region, type, width, speed) {
  const out = [];
  for (const ring of region || []) {
    if (!ring || ring.length < 3) continue;
    out.push({ type, ring, closed: true, width, speed });
  }
  return out;
}

/** Turn open polylines into paths of a given type. */
function linesOf(lines, type, width, speed) {
  const out = [];
  for (const line of lines || []) {
    if (!line || line.length < 2) continue;
    out.push({ type, points: line, closed: false, width, speed });
  }
  return out;
}

/**
 * Slice a model all the way to G-code.
 *
 * @param {Float32Array} positions Z-up millimetre triangle soup, 9 floats per triangle
 * @param {object} settings  from buildSettings()
 * @param {(p:{stage:string, frac:number})=>void} [onProgress]
 * @returns {{plan, stats, gcode, warnings, settings}}
 */
export function sliceModel(positions, settings, onProgress = () => {}) {
  const s = settings || buildSettings();
  // Warnings are things that might mean a bad print. Notes are things the
  // slicer did on purpose that are worth knowing about. Mixing the two trains
  // people to ignore both.
  const warnings = [...validate(s)];
  const notes = [];

  const placed = placeOnBed(positions, s);
  warnings.push(...placed.warnings);

  onProgress({ stage: 'slicing', frac: 0 });
  const sliced = sliceMesh(placed.positions, s, (f) => onProgress({ stage: 'slicing', frac: f * 0.25 }));
  warnings.push(...sliced.warnings);
  const layers = sliced.layers;
  if (!layers.length) {
    return { plan: { layers: [] }, stats: emptyStats(), gcode: '', warnings, notes, settings: s, placement: placed };
  }

  // ---- walls --------------------------------------------------------------
  onProgress({ stage: 'walls', frac: 0.25 });
  const walls = new Array(layers.length);
  const inners = new Array(layers.length);
  const gaps = new Array(layers.length);
  for (let i = 0; i < layers.length; i++) {
    const lw = i === 0 ? s.firstLayerLineWidth : s.lineWidth;
    const w = generateWalls(layers[i].polys, { wallCount: s.wallCount, lineWidth: lw });
    walls[i] = w.walls; inners[i] = w.inner; gaps[i] = w.gaps;
    if (i % 16 === 0) onProgress({ stage: 'walls', frac: 0.25 + 0.15 * (i / layers.length) });
  }

  // ---- skin ---------------------------------------------------------------
  onProgress({ stage: 'surfaces', frac: 0.4 });
  const skins = classifyAll(layers, inners, s, (f) => onProgress({ stage: 'surfaces', frac: 0.4 + f * 0.15 }));

  // ---- supports -----------------------------------------------------------
  onProgress({ stage: 'supports', frac: 0.55 });
  const sup = buildSupports(layers, s, (f) => onProgress({ stage: 'supports', frac: 0.55 + f * 0.1 }));

  // ---- adhesion -----------------------------------------------------------
  // A raft replaces the skirt and the brim rather than joining them. It IS the
  // adhesion, and a skirt around a raft is two loops of wasted plastic around
  // something already stuck down.
  const wantRaft = s.adhesion === 'raft';
  const raft = wantRaft ? buildRaft(layers[0].polys, sup.regions[0], s) : { layers: [], height: 0, lift: 0 };
  const adhesion = wantRaft ? { loops: [], type: 'raft', length: 0 } : buildAdhesion(layers[0].polys, sup.regions[0], s);
  const supBrim = wantRaft ? [] : supportBrim(sup.regions[0], layers[0].polys, s);

  // ---- fill and assemble the plan ----------------------------------------
  onProgress({ stage: 'filling', frac: 0.65 });
  const planLayers = new Array(layers.length);
  let nozzleAt = [0, 0];

  for (let i = 0; i < layers.length; i++) {
    const first = i === 0;
    const lw = first ? s.firstLayerLineWidth : s.lineWidth;
    const sp = s.speeds;
    // On the first layer everything runs at one slow speed. Bed adhesion is
    // decided in those few minutes and nothing else on the print matters if it
    // fails there.
    const speedOf = (v) => (first ? sp.firstLayer : v);

    const paths = [];

    // Adhesion, first layer only.
    if (first) {
      for (const loop of adhesion.loops) {
        paths.push({ type: adhesion.type === 'brim' ? 'brim' : 'skirt', points: loop, closed: false, width: lw, speed: sp.firstLayer });
      }
      for (const loop of supBrim) {
        paths.push({ type: 'brim', points: loop, closed: false, width: lw, speed: sp.firstLayer });
      }
    }

    // Supports. One outline wall so the column holds together, then a sparse
    // fill. The interface band at the top gets a denser fill, because that is
    // the surface the model lands on.
    const supRegion = sup.regions[i] || [];
    if (supRegion.length) {
      const iface = sup.interfaces[i] || [];
      const body = iface.length ? difference(supRegion, iface) : supRegion;
      const outline = offset(supRegion, -lw / 2);
      paths.push(...loopsOf(outline, 'support', lw, speedOf(sp.support)));
      if (body.length) {
        paths.push(...linesOf(
          infillFill(offset(body, -lw), { pattern: s.supportPattern, density: s.supportDensity, lineWidth: lw, angle: 0, layerIndex: i, z: layers[i].z }),
          'support', lw, speedOf(sp.support)));
      }
      if (iface.length) {
        paths.push(...linesOf(
          infillFill(offset(iface, -lw), { pattern: 'lines', density: s.supportInterfaceDensity, lineWidth: lw, angle: 90, layerIndex: i, z: layers[i].z }),
          'support-interface', lw, speedOf(sp.support)));
      }
    }

    // Walls, innermost first so the outer one is laid against something solid.
    const wl = walls[i] || [];
    for (let k = wl.length - 1; k >= 0; k--) {
      const type = k === 0 ? 'wall-outer' : 'wall-inner';
      paths.push(...loopsOf(wl[k], type, lw, speedOf(k === 0 ? sp.outerWall : sp.innerWall)));
    }

    // Slivers a whole number of walls could not reach.
    if (gaps[i] && gaps[i].length) {
      paths.push(...linesOf(fillGaps(gaps[i], { lineWidth: lw, angle: skinAngle(i, s.skinAngles) }), 'gap', lw, speedOf(sp.skin)));
    }

    // Solid surfaces. Bridges are separated out because they are printed in a
    // chosen direction, slower, and with the fan hard on.
    const k = skins[i];
    const bridgeReg = k.bridge;
    const plainSkin = bridgeReg.length ? difference(k.skin, bridgeReg) : k.skin;

    if (bridgeReg.length) {
      const ang = bridgeAngle(bridgeReg) ?? skinAngle(i, s.skinAngles);
      paths.push(...linesOf(
        solidFill(infillRegion(bridgeReg, { lineWidth: lw, infillOverlap: s.infillOverlap }), { lineWidth: lw, angle: ang }),
        'bridge', lw, first ? sp.firstLayer : sp.bridge));
    }
    if (plainSkin.length) {
      paths.push(...linesOf(
        solidFill(infillRegion(plainSkin, { lineWidth: lw, infillOverlap: s.infillOverlap }), { lineWidth: lw, angle: skinAngle(i, s.skinAngles) }),
        'skin', lw, speedOf(sp.skin)));
    }

    // Sparse infill.
    if (k.sparse.length && s.infillDensity > 0) {
      const every = Math.max(1, Math.round(s.infillEveryNLayers || 1));
      if (i % every === 0) {
        paths.push(...linesOf(
          infillFill(infillRegion(k.sparse, { lineWidth: lw, infillOverlap: s.infillOverlap }), {
            pattern: s.infillPattern, density: s.infillDensity, lineWidth: lw,
            angle: s.infillAngle, layerIndex: i, z: layers[i].z,
          }),
          'infill', lw, speedOf(sp.infill)));
      }
    }

    // Ironing, once everything else on this layer is down.
    //
    // NOT `k.top`. That region means "solid because it is near the top", which
    // on a 4-top-layer profile is true of the top four layers, and three of
    // those get buried by the one above. Ironing them is invisible and it is
    // not cheap: measured on a 20mm cube it was 645 seconds on a 1277 second
    // print, half the print time spent polishing surfaces nobody will ever see.
    //
    // What ironing wants is the surface EXPOSED to air, which is this layer's
    // area minus whatever the next layer covers. On the last layer there is no
    // next layer, so all of it is exposed.
    const exposed = i === layers.length - 1
      ? (inners[i] || [])
      : difference(inners[i] || [], layers[i + 1].polys);
    if (s.ironing && exposed.length) {
      const lines = ironingLines(exposed, {
        lineWidth: lw,
        spacing: s.ironingSpacing ?? 0.1,
        angle: skinAngle(i, s.skinAngles) + 90,   // across the skin, not along it
      });
      for (const line of lines) {
        if (!line || line.length < 2) continue;
        paths.push({
          type: 'ironing', points: line, closed: false, width: lw,
          speed: s.ironingSpeed ?? 20,
          flow: Math.max(0, (s.ironingFlow ?? 10) / 100),
        });
      }
    }

    // Route, then work out whether the layer needs slowing to cool.
    // On a plate with more than one part, finish each part before travelling to
    // the next rather than doing all the walls everywhere, then all the skin
    // everywhere, crossing the plate once per group.
    const islands = splitIslands(layers[i].polys);
    const routed = islands.length > 1
      ? orderByIslands(paths, GROUP_ORDER, nozzleAt, { seam: s.seam, seed: i, islands })
      : orderByGroups(paths, GROUP_ORDER, nozzleAt, { seam: s.seam, seed: i });
    if (s.combing) markCombing(routed.paths, layers[i].polys, nozzleAt, s);
    nozzleAt = routed.end;
    const bare = estimateLayerTime(routed.paths, s);
    const factor = first ? 1 : coolingFactor(bare, s);

    planLayers[i] = {
      index: layers[i].index,
      z: layers[i].z,
      height: layers[i].height,
      paths: routed.paths,
      speedFactor: factor,
      travel: routed.travel,
      outline: layers[i].polys,
    };

    if (i % 8 === 0) onProgress({ stage: 'filling', frac: 0.65 + 0.25 * (i / layers.length) });
  }

  // ---- emit ---------------------------------------------------------------
  onProgress({ stage: 'writing G-code', frac: 0.9 });
  // The support REGIONS, not their toolpaths, ride along with the plan so the
  // app can rebuild them as an editable solid. Toolpaths are hatching and would
  // reconstruct into a comb; the regions are the actual footprint per layer.
  // Cheap to carry: outlines only, and empty unless supports were asked for.
  const supportShape = s.supportEnable
    ? layers.map((l, i) => ({ z: l.z, height: l.height, polys: sup.regions[i] || [] }))
      .filter((l) => l.polys.length)
    : [];
  // The raft goes under everything, and everything moves up by its height plus
  // the air gap above it. Done here rather than during slicing so the raft
  // never affects what the model's own layers contain: they are the same
  // toolpaths at a different Z, which is the only way the two can be trusted to
  // agree.
  let allLayers = planLayers;
  if (wantRaft && raft.layers.length) {
    liftLayers(planLayers, raft.lift, raft.layers.length);
    allLayers = [...raft.layers, ...planLayers];
    notes.push(`a ${raft.layers.length} layer raft under the part, with the model starting ${raft.lift.toFixed(2)}mm up`);
  } else if (wantRaft) {
    warnings.push('a raft was asked for and the first layer gave nothing to build one on');
  }

  const plan = { layers: allLayers, bounds: sliced.bounds, placement: placed, supportShape, raftHeight: raft.lift };
  const { gcode, stats } = emitGcode(plan, s, { name: s.modelName });

  if (!placed.fits) warnings.push('this will not fit the printer, so the file is for inspection only');
  // A raft makes the whole print taller, and the height check ran before the
  // raft existed. A part that fitted by two millimetres does not fit on a raft.
  if (wantRaft && raft.lift && placed.size && placed.size.h + raft.lift > s.bedHeight) {
    warnings.push(`the raft adds ${raft.lift.toFixed(2)}mm and takes the print past this machine's ${s.bedHeight}mm reach`);
  }
  const ironed = planLayers.filter((l) => l.paths.some((p) => p.type === 'ironing')).length;
  if (s.ironing) {
    notes.push(ironed
      ? `${ironed} top surface${ironed === 1 ? '' : 's'} ironed flat, at ${s.ironingFlow ?? 10}% flow`
      : 'ironing is on and this model has no upward facing flat surface to iron');
  }
  const slowed = planLayers.filter((l) => l.speedFactor < 0.999).length;
  if (slowed) notes.push(`${slowed} layer${slowed === 1 ? ' was' : 's were'} slowed down so the plastic has time to set`);
  // Supports get their own line in the result panel rather than only a note,
  // because "did my supports actually apply" is a yes/no question and a note
  // buried among the settings is not a visible answer to it. Always populated,
  // including when they are off, so the row never silently disappears.
  const supLayers = planLayers.filter(
    (l) => l.paths.some((p) => p.type === 'support' || p.type === 'support-interface'),
  ).length;
  const supGrams = Math.round(
    (((stats.gramsByType || {}).support || 0) + ((stats.gramsByType || {})['support-interface'] || 0)) * 100,
  ) / 100;
  stats.supports = {
    enabled: !!s.supportEnable,
    type: s.supportEnable ? s.supportType : 'off',
    layers: supLayers,
    grams: supGrams,
  };
  if (s.supportEnable) {
    notes.push(supLayers
      ? `${s.supportType} supports on ${supLayers} layers, about ${supGrams}g of filament`
      : 'nothing on this model needed supporting, so none were added');
  }

  onProgress({ stage: 'done', frac: 1 });
  return { plan, stats, gcode, warnings, notes, settings: s, placement: placed };
}

const emptyStats = () => ({
  timeSeconds: 0, filamentMm: 0, filamentM: 0, volumeMm3: 0, grams: 0, cost: 0,
  layers: 0, extrudeLengthMm: 0, travelLengthMm: 0, retractions: 0, timeByType: {},
});

export { formatDuration, buildSettings, validate, GROUP_ORDER };
