// gcode.js — toolpaths become instructions a printer will actually obey.
//
// Two things happen here and it is worth being clear that they are separate.
//
// EXTRUSION ARITHMETIC. G-code does not say "lay a bead". It says "move here,
// and advance the filament by this much". Getting from one to the other is a
// volume balance and nothing else:
//
//     volume laid down = path length x line width x layer height
//     filament consumed = volume / cross-section of the filament
//     E = L * w * h / (pi * (d/2)^2)
//
// The bead is modelled as a plain rectangle, width by layer height, rather than
// as the rounded-cornered shape its free surface really takes. That is a
// deliberate choice to match Cura, because the profiles in profiles.js are
// tuned against the numbers a Cura-sliced Ender 3 Pro produces, and mixing a
// Cura flow figure with a PrusaSlicer bead model is how a print ends up eleven
// percent under-extruded with everything apparently set correctly.
//
// TIME AND MOTION. The estimate is a trapezoidal model: each continuous path
// accelerates from the jerk speed, cruises if it is long enough, and
// decelerates at the end. Crucially the model does NOT decelerate between the
// segments WITHIN a path, because real firmware does not either, and treating
// a 200-segment perimeter as 200 independent accelerate-decelerate moves is
// how slicers end up quoting four hours for a two hour print.

import { startGcode, endGcode } from './profiles.js';

/** How many mm of filament carry one mm^3 of plastic. */
const filamentArea = (d) => Math.PI * (d / 2) * (d / 2);

/**
 * Time for one continuous run of length L at feedrate v, given acceleration and
 * a starting/ending speed of roughly half the jerk setting.
 */
function moveTime(L, v, accel, jerk) {
  if (!(L > 0) || !(v > 0)) return 0;
  if (!(accel > 0)) return L / v;
  const v0 = Math.min(v, (jerk || 0) / 2);
  // Distance needed to reach cruise speed and to come back down again.
  const ramp = (v * v - v0 * v0) / (2 * accel);
  if (2 * ramp <= L) return 2 * ((v - v0) / accel) + (L - 2 * ramp) / v;
  // Too short to reach the requested speed: it is a triangle, not a trapezoid.
  const vPeak = Math.sqrt(v0 * v0 + accel * L);
  return 2 * (vPeak - v0) / accel;
}

const fmt = (n) => {
  // Three decimals is a micron, which is finer than any printer positions to,
  // and trimming the trailing zeros keeps the file appreciably smaller.
  const s = n.toFixed(3);
  return s.replace(/\.?0+$/, '') || '0';
};
const fmtE = (n) => n.toFixed(5);

/**
 * Emit G-code for a whole print plan.
 *
 * @param {{layers: {index:number, z:number, height:number, paths:object[]}[]}} plan
 * @param {object} s settings from profiles.js
 * @param {object} [meta] extra header info (model name, bounds)
 * @returns {{gcode:string, stats:object}}
 */
export function emitGcode(plan, s, meta = {}) {
  const out = [];
  const eArea = filamentArea(s.filamentDiameter);
  const flow = (s.flowRate ?? 100) / 100;

  // Machine state, tracked so nothing redundant is emitted. A G-code file that
  // repeats F on every line is 20% bigger for no benefit, and an SD card on an
  // 8-bit board is a real bottleneck.
  let x = 0, y = 0, z = 0, e = 0, f = -1, fan = -1;
  let retracted = false;
  let hopped = false;

  // Accumulators for the estimate.
  let time = 0, extrudeLen = 0, travelLen = 0, retractions = 0;
  const timeByType = {};
  // Filament per path type, in mm of feedstock. Supports are the reason this
  // exists: "supports are on" is not an answer to "what are they costing me",
  // and the honest answer is grams. Tracked at the same place e is advanced, so
  // it cannot drift from the real total.
  const filamentByType = {};
  let curType = null;

  const emit = (line) => out.push(line);

  const setFan = (pct) => {
    const v = Math.max(0, Math.min(255, Math.round((pct / 100) * 255)));
    if (v === fan) return;
    fan = v;
    emit(v === 0 ? 'M107' : `M106 S${v}`);
  };

  const travelSpeed = s.speeds.travel;

  const retract = () => {
    if (retracted || !s.retractEnable || !(s.retractLength > 0)) return;
    e -= s.retractLength;
    emit(`G1 F${Math.round(s.retractSpeed * 60)} E${fmtE(e)}`);
    f = s.retractSpeed * 60;
    time += s.retractLength / s.retractSpeed;
    retracted = true;
    retractions++;
  };

  const unretract = () => {
    if (!retracted) return;
    e += s.retractLength;
    emit(`G1 F${Math.round(s.retractSpeed * 60)} E${fmtE(e)}`);
    f = s.retractSpeed * 60;
    time += s.retractLength / s.retractSpeed;
    retracted = false;
  };

  const hop = (up) => {
    if (!s.zhopEnable || !(s.zhop > 0)) return;
    if (up === hopped) return;
    hopped = up;
    const target = up ? z + s.zhop : z;
    emit(`G1 Z${fmt(target)} F${Math.round(s.maxFeedrateZ * 60)}`);
    time += s.zhop / s.maxFeedrateZ;
  };

  /** A non-printing move. */
  const travelTo = (px, py, { combed = false } = {}) => {
    const L = Math.hypot(px - x, py - y);
    if (L < 1e-9) return;
    const needsRetract = s.retractEnable && L >= (s.retractMinTravel ?? 0) && !combed;
    if (needsRetract) { retract(); hop(true); }
    const F = Math.round(travelSpeed * 60);
    emit(`G0${F !== f ? ` F${F}` : ''} X${fmt(px)} Y${fmt(py)}`);
    f = F;
    time += moveTime(L, travelSpeed, s.accelerationXY, s.jerkXY);
    travelLen += L;
    x = px; y = py;
    if (needsRetract) hop(false);
  };

  /** A printing move. */
  const extrudeTo = (px, py, width, height, speed, pathFlow = 1) => {
    const L = Math.hypot(px - x, py - y);
    if (L < 1e-9) return;
    unretract();
    const volume = L * width * height;
    // `pathFlow` is per path rather than global. Ironing is the reason it
    // exists: those passes lay roughly a tenth of a bead, because their job is
    // to melt what is already there rather than to add anything.
    const de = (volume / eArea) * flow * pathFlow;
    e += de;
    if (curType) filamentByType[curType] = (filamentByType[curType] || 0) + de;
    const F = Math.round(speed * 60);
    emit(`G1${F !== f ? ` F${F}` : ''} X${fmt(px)} Y${fmt(py)} E${fmtE(e)}`);
    f = F;
    extrudeLen += L;
    x = px; y = py;
  };

  // ---- header -------------------------------------------------------------
  emit('; Sliced by CADence');
  emit(`; generated ${new Date().toISOString()}`);
  if (meta.name) emit(`; model: ${meta.name}`);
  emit(`; machine: ${s.machineName}`);
  emit(`; material: ${s.materialName}`);
  emit(`; quality: ${s.qualityName}`);
  emit(`; layer height: ${s.layerHeight}mm, first layer ${s.firstLayerHeight}mm`);
  emit(`; walls: ${s.wallCount}, top ${s.topLayers}, bottom ${s.bottomLayers}, infill ${s.infillDensity}% ${s.infillPattern}`);
  if (s.supportEnable) emit(`; supports: ${s.supportType}, ${s.supportAngle} degrees`);
  emit(`; nozzle ${s.nozzleDiameter}mm, filament ${s.filamentDiameter}mm`);
  const headerAt = out.length;      // estimates are spliced in here at the end
  emit('');
  emit(startGcode(s));
  emit('');

  // ---- layers -------------------------------------------------------------
  for (const layer of plan.layers) {
    if (!layer.paths.length) continue;
    emit(`;LAYER:${layer.index}`);
    // The nozzle height, not the slice plane. External G-code previewers read
    // this line and expect the Z the machine will be at.
    emit(`;Z:${fmt(layer.z + layer.height / 2)}`);

    // Cooling. The first layer runs with the fan off so it welds to the bed,
    // then it ramps in over the next few layers rather than slamming on, which
    // would shock the still-warm layers below it.
    let fanPct = s.fanSpeed;
    if (layer.index === 0) fanPct = s.firstLayerFanSpeed;
    else if (layer.index < (s.fanFullAtLayer ?? 1)) {
      fanPct = s.firstLayerFanSpeed + (s.fanSpeed - s.firstLayerFanSpeed) * (layer.index / Math.max(1, s.fanFullAtLayer));
    }
    setFan(fanPct);

    // Move up to the new layer before doing anything on it.
    const target = layer.z + (layer.height / 2);   // the TOP of this layer
    if (Math.abs(target - z) > 1e-9) {
      if (s.retractOnLayerChange) retract();
      z = target;
      hopped = false;
      emit(`G0 Z${fmt(z)} F${Math.round(s.maxFeedrateZ * 60)}`);
      time += Math.abs(layer.height) / s.maxFeedrateZ;
    }

    for (const path of layer.paths) {
      const pts = path.points;
      if (!pts || pts.length < 2) continue;
      const speed = path.speed * (layer.speedFactor ?? 1);
      travelTo(pts[0][0], pts[0][1], { combed: path.combed });
      emit(`;TYPE:${gcodeType(path.type)}`);
      const t0 = time;
      let runLength = 0;
      curType = path.type;
      for (let i = 1; i < pts.length; i++) {
        extrudeTo(pts[i][0], pts[i][1], path.width, layer.height, speed, path.flow ?? 1);
        runLength += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      }
      curType = null;
      // One trapezoid for the whole continuous run, not one per segment.
      time += moveTime(runLength, speed, s.accelerationXY, s.jerkXY);
      timeByType[path.type] = (timeByType[path.type] || 0) + (time - t0);
    }
  }

  // ---- footer -------------------------------------------------------------
  retract();
  emit('');
  emit(endGcode(s));

  const filamentMm = e + (retracted ? s.retractLength : 0);
  const volumeMm3 = filamentMm * eArea;
  const grams = (volumeMm3 / 1000) * (s.density ?? 1.24);
  const stats = {
    timeSeconds: Math.round(time),
    filamentMm: Math.round(filamentMm * 10) / 10,
    filamentM: Math.round(filamentMm / 100) / 10,
    volumeMm3: Math.round(volumeMm3),
    grams: Math.round(grams * 100) / 100,
    cost: Math.round((grams / 1000) * (s.costPerKg ?? 0) * 100) / 100,
    layers: plan.layers.filter((l) => l.paths.length).length,
    extrudeLengthMm: Math.round(extrudeLen),
    travelLengthMm: Math.round(travelLen),
    retractions,
    timeByType,
    filamentByType,
    // Plain numbers, not a helper function: stats is structured-cloned back from
    // the slicing worker, and a function on it throws DataCloneError.
    gramsByType: Object.fromEntries(Object.entries(filamentByType).map(
      ([k, mm]) => [k, Math.round(((mm * eArea) / 1000) * (s.density ?? 1.24) * 100) / 100],
    )),
  };

  // Slicers put these near the top so a printer's LCD and a human both see them
  // before the print starts rather than after.
  out.splice(headerAt, 0,
    `;TIME:${stats.timeSeconds}`,
    `;Filament used: ${(filamentMm / 1000).toFixed(5)}m`,
    `;Filament weight: ${stats.grams}g`,
    `;Estimated print time: ${formatDuration(stats.timeSeconds)}`,
  );

  return { gcode: out.join('\n') + '\n', stats };
}

/** Feature names in the dialect Cura uses, so existing G-code previewers and
 *  OctoPrint plugins colour a CADence file correctly without being taught. */
function gcodeType(type) {
  switch (type) {
    case 'wall-outer': return 'WALL-OUTER';
    case 'wall-inner': return 'WALL-INNER';
    case 'skin': case 'bridge': return 'SKIN';
    case 'infill': return 'FILL';
    case 'support': return 'SUPPORT';
    case 'support-interface': return 'SUPPORT-INTERFACE';
    case 'skirt': case 'brim': return 'SKIRT';
    // Common previewers know RAFT and SKIN. Ironing has no standard type, and
    // calling it SKIN is honest: it is a pass over the skin.
    case 'raft': return 'RAFT';
    case 'ironing': return 'SKIN';
    case 'gap': return 'FILL';
    default: return 'FILL';
  }
}

/** Seconds to something a person reads without counting zeros. */
export function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  if (m) return `${m}m`;
  return `${Math.round(sec)}s`;
}

/**
 * Slow a layer down until it takes long enough to cool.
 *
 * A 4mm spire printed at 60mm/s gives each layer under a second to solidify,
 * and the next one lands on plastic that is still liquid. The fix is to spend
 * longer on the layer, and the floor exists because slowing to 2mm/s parks a
 * hot nozzle over the same spot and cooks it instead.
 *
 * @returns {number} a factor to multiply every speed on the layer by
 */
export function coolingFactor(layerTimeSeconds, s) {
  const min = s.minLayerTime ?? 0;
  if (!min || layerTimeSeconds >= min || layerTimeSeconds <= 0) return 1;
  const wanted = layerTimeSeconds / min;
  // Never below minSpeed relative to the slowest feature on the layer.
  const floor = s.minSpeed / Math.max(s.minSpeed, s.speeds.outerWall);
  return Math.max(floor, wanted);
}

/**
 * Estimate one layer's printing time from its paths alone, before any G-code
 * exists. Needed because the cooling decision has to be made BEFORE the speeds
 * are baked into the moves.
 */
export function estimateLayerTime(paths, s) {
  let t = 0;
  for (const p of paths) {
    if (!p.points || p.points.length < 2) continue;
    let L = 0;
    for (let i = 1; i < p.points.length; i++) {
      L += Math.hypot(p.points[i][0] - p.points[i - 1][0], p.points[i][1] - p.points[i - 1][1]);
    }
    t += moveTime(L, p.speed, s.accelerationXY, s.jerkXY);
  }
  return t;
}

export { moveTime, filamentArea };
