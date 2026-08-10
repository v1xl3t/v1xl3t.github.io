// profiles.js — the machine, the plastic, and how carefully to go.
//
// A slice setting is one of three kinds of thing, and keeping them apart is
// what makes the panel comprehensible instead of a wall of 400 fields:
//
//   MACHINE   facts about the printer. Bed size, nozzle, firmware dialect,
//             what its steppers can survive. Changes when you buy a printer.
//   MATERIAL  facts about the filament. Temperatures, how much it likes to
//             ooze, what it weighs. Changes when you swap a spool.
//   QUALITY   a choice about this print. Layer height and the speeds that go
//             with it. Changes every print.
//
// Everything is a plain object merged in that order, so a user override is just
// one more object on the end and nothing needs a setter. Table-driven all the
// way down: adding a printer or a filament is adding an entry, never a branch.
//
// The defaults are tuned for Vi's Ender 3 Pro specifically, not for a generic
// "0.4mm nozzle" abstraction. It is a Bowden machine with a long melt path and
// a 500 mm/s^2 stock acceleration, which means it wants long retractions and
// modest outer-wall speeds, and a profile that pretends otherwise prints
// stringy corners.

// ---------------------------------------------------------------------------
// machines
// ---------------------------------------------------------------------------

export const MACHINES = {
  'ender3pro': {
    id: 'ender3pro',
    name: 'Creality Ender 3 Pro',
    bedWidth: 220,
    bedDepth: 220,
    bedHeight: 250,
    // The Ender's origin is the front-left corner of the bed, not its middle.
    // CADence models are centred on the origin, so the slicer shifts them by
    // half the bed. Printers that home to the centre set this true instead.
    originCentre: false,
    nozzleDiameter: 0.4,
    filamentDiameter: 1.75,
    heatedBed: true,
    maxBedTemp: 110,
    maxNozzleTemp: 260,
    firmware: 'marlin',
    // Stock Marlin values. The time estimate uses these, so a print quoted at
    // 4 hours is 4 hours on this machine rather than on an imaginary one.
    maxFeedrateXY: 500,
    maxFeedrateZ: 10,
    maxFeedrateE: 25,
    accelerationXY: 500,
    accelerationE: 1000,
    jerkXY: 8,
    jerkZ: 0.4,
    jerkE: 5,
    // Bowden. The 60mm of tube between the gears and the melt is why retraction
    // has to be 5mm here and 0.8mm on a direct drive.
    extruder: 'bowden',
  },

  // Kept deliberately: the point of a table is that the second entry proves the
  // first was not special-cased. A direct-drive machine wants very different
  // retraction, and the defaults below read those numbers from here.
  'generic-direct': {
    id: 'generic-direct',
    name: 'Generic direct drive (0.4mm)',
    bedWidth: 250, bedDepth: 210, bedHeight: 210,
    originCentre: false,
    nozzleDiameter: 0.4, filamentDiameter: 1.75,
    heatedBed: true, maxBedTemp: 110, maxNozzleTemp: 300,
    firmware: 'marlin',
    maxFeedrateXY: 500, maxFeedrateZ: 12, maxFeedrateE: 50,
    accelerationXY: 3000, accelerationE: 3000,
    jerkXY: 10, jerkZ: 0.4, jerkE: 5,
    extruder: 'direct',
  },
};

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------
//
// density is g/cm^3, used to turn extruded length into grams. costPerKg is
// what the estimate multiplies by, and is the only number here a user is
// guaranteed to want to change.

export const MATERIALS = {
  pla: {
    id: 'pla', name: 'PLA',
    nozzleTemp: 200, firstLayerNozzleTemp: 205,
    bedTemp: 60, firstLayerBedTemp: 60,
    density: 1.24, costPerKg: 22,
    fanSpeed: 100, firstLayerFanSpeed: 0, fanFullAtLayer: 3,
    retractLength: { bowden: 5, direct: 0.8 },
    retractSpeed: 45,
    // A multiplier on the quality profile's speeds. PLA is the baseline.
    speedScale: 1,
    minLayerTime: 5,
  },
  petg: {
    id: 'petg', name: 'PETG',
    nozzleTemp: 240, firstLayerNozzleTemp: 240,
    bedTemp: 80, firstLayerBedTemp: 80,
    density: 1.27, costPerKg: 26,
    // PETG stringing is a cooling problem as much as a retraction one; half fan
    // keeps layer bonding without freezing the bridge of ooze into a hair.
    fanSpeed: 50, firstLayerFanSpeed: 0, fanFullAtLayer: 3,
    retractLength: { bowden: 6, direct: 1.5 },
    retractSpeed: 40,
    speedScale: 0.8,
    minLayerTime: 8,
  },
  abs: {
    id: 'abs', name: 'ABS',
    nozzleTemp: 245, firstLayerNozzleTemp: 250,
    bedTemp: 100, firstLayerBedTemp: 100,
    density: 1.04, costPerKg: 24,
    // ABS warps when it cools fast. On an open-frame Ender this is the setting
    // that decides whether the corners lift off the bed.
    fanSpeed: 0, firstLayerFanSpeed: 0, fanFullAtLayer: 999,
    retractLength: { bowden: 5, direct: 1 },
    retractSpeed: 40,
    speedScale: 0.85,
    minLayerTime: 5,
  },
  tpu: {
    id: 'tpu', name: 'TPU (flexible)',
    nozzleTemp: 225, firstLayerNozzleTemp: 225,
    bedTemp: 45, firstLayerBedTemp: 45,
    density: 1.21, costPerKg: 32,
    fanSpeed: 60, firstLayerFanSpeed: 0, fanFullAtLayer: 3,
    // Flexible filament buckles in a Bowden tube instead of retracting, so the
    // honest answer on this machine is to barely retract and go slowly.
    retractLength: { bowden: 1.5, direct: 0.5 },
    retractSpeed: 25,
    speedScale: 0.4,
    minLayerTime: 6,
  },
};

// ---------------------------------------------------------------------------
// quality presets
// ---------------------------------------------------------------------------
//
// Speeds are mm/s and get multiplied by the material's speedScale. They are
// deliberately conservative: an Ender 3 Pro with a stock bed spring and a
// 500 mm/s^2 acceleration cannot actually deliver the 200 mm/s numbers modern
// profiles quote, and a print that ghosts at speed is slower than one that does
// not have to be reprinted.

export const QUALITY = {
  fine: {
    id: 'fine', name: 'Fine (0.12mm)',
    layerHeight: 0.12, firstLayerHeight: 0.2,
    wallCount: 3, topLayers: 6, bottomLayers: 5,
    infillDensity: 20,
    speeds: {
      outerWall: 25, innerWall: 40, infill: 50, skin: 30,
      support: 45, bridge: 20, firstLayer: 18, travel: 150,
    },
  },
  standard: {
    id: 'standard', name: 'Standard (0.2mm)',
    layerHeight: 0.2, firstLayerHeight: 0.24,
    wallCount: 2, topLayers: 4, bottomLayers: 3,
    infillDensity: 20,
    speeds: {
      outerWall: 30, innerWall: 45, infill: 60, skin: 35,
      support: 50, bridge: 25, firstLayer: 20, travel: 150,
    },
  },
  draft: {
    id: 'draft', name: 'Draft (0.28mm)',
    layerHeight: 0.28, firstLayerHeight: 0.28,
    wallCount: 2, topLayers: 3, bottomLayers: 3,
    infillDensity: 15,
    speeds: {
      outerWall: 35, innerWall: 50, infill: 65, skin: 40,
      support: 55, bridge: 25, firstLayer: 20, travel: 150,
    },
  },
};

// ---------------------------------------------------------------------------
// the rest of the settings
// ---------------------------------------------------------------------------

/** Everything that is neither a machine fact, a plastic fact, nor a speed. */
export const BASE = {
  // Walls. lineWidth defaults to the nozzle diameter, which is the value that
  // makes extrusion arithmetic honest: a bead that is 0.4mm wide and one layer
  // tall carries exactly the volume the E axis is told to push.
  lineWidth: null,                 // null means "use the nozzle diameter"
  firstLayerLineWidth: null,       // null means lineWidth * 1.1, squashed for grip
  outerWallFirst: false,           // inner walls first gives the outer one backing
  seam: 'nearest',                 // nearest | rear | random

  // Solid surfaces
  skinAngles: [45, 135],           // alternate so layers cross-hatch and bond
  ironing: false,

  // Infill
  infillPattern: 'grid',           // lines | grid | triangles | gyroid | concentric
  infillAngle: 45,
  infillOverlap: 15,               // percent of a line width that infill pushes
                                   // into the wall, so the two actually weld
  infillEveryNLayers: 1,

  // Support
  supportEnable: false,
  supportType: 'normal',           // normal | tree
  supportAngle: 50,                // overhang steeper than this needs holding up
  supportDensity: 15,
  supportPattern: 'lines',
  supportXYGap: 0.7,               // horizontal clearance so it snaps off
  supportZGapTop: 0.2,             // vertical clearance under the model
  supportZGapBottom: 0.2,
  supportOnBuildplateOnly: false,
  supportBrim: true,
  // The denser band at the top of a support column, which is what the model
  // actually lands on. Two layers is the usual compromise between a clean
  // overhang and a support you can still get off.
  supportInterfaceLayers: 2,
  supportInterfaceDensity: 60,
  // Tree supports
  treeAngle: 40,                   // how far a branch may lean per unit height
  treeBranchDiameter: 3,
  treeTipDiameter: 0.8,

  // Bed adhesion
  adhesion: 'skirt',               // none | skirt | brim | raft
  skirtLines: 2,
  skirtGap: 3,
  skirtMinLength: 250,             // keep priming until the nozzle is flowing
  brimWidth: 5,
  raftGap: 0.25,
  raftLayers: 2,

  // Retraction and travel
  retractEnable: true,
  retractMinTravel: 1.5,           // shorter hops are not worth the wear
  zhop: 0.2,
  zhopEnable: true,
  retractOnLayerChange: true,
  combing: true,                   // prefer travelling inside the part

  // Cooling
  minSpeed: 10,                    // the floor when a layer is slowed for cooling

  // Flow
  flowRate: 100,                   // percent, the global fudge factor

  // Safety and placement
  centreOnBed: true,
  skipFirstLayerFan: true,
};

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

/**
 * Build one flat settings object from a machine, a material, a quality preset
 * and any overrides. Flat on purpose: every stage downstream reads settings by
 * name and none of them should have to know which table a value came from.
 */
export function buildSettings({ machine = 'ender3pro', material = 'pla', quality = 'standard', overrides = {} } = {}) {
  const M = typeof machine === 'string' ? MACHINES[machine] : machine;
  const F = typeof material === 'string' ? MATERIALS[material] : material;
  const Q = typeof quality === 'string' ? QUALITY[quality] : quality;
  if (!M) throw new Error(`unknown machine: ${machine}`);
  if (!F) throw new Error(`unknown material: ${material}`);
  if (!Q) throw new Error(`unknown quality: ${quality}`);

  const scale = F.speedScale ?? 1;
  const speeds = {};
  for (const [k, v] of Object.entries(Q.speeds)) {
    // Travel is a move of the gantry, not of plastic, so the filament has no
    // say in how fast it happens.
    speeds[k] = k === 'travel' ? v : Math.round(v * scale * 10) / 10;
  }

  const s = {
    ...BASE,
    // machine
    machineId: M.id, machineName: M.name,
    bedWidth: M.bedWidth, bedDepth: M.bedDepth, bedHeight: M.bedHeight,
    originCentre: M.originCentre,
    nozzleDiameter: M.nozzleDiameter, filamentDiameter: M.filamentDiameter,
    heatedBed: M.heatedBed, firmware: M.firmware,
    maxFeedrateXY: M.maxFeedrateXY, maxFeedrateZ: M.maxFeedrateZ, maxFeedrateE: M.maxFeedrateE,
    accelerationXY: M.accelerationXY, accelerationE: M.accelerationE,
    jerkXY: M.jerkXY, jerkZ: M.jerkZ, jerkE: M.jerkE,
    extruder: M.extruder,
    maxBedTemp: M.maxBedTemp, maxNozzleTemp: M.maxNozzleTemp,
    // material
    materialId: F.id, materialName: F.name,
    nozzleTemp: F.nozzleTemp, firstLayerNozzleTemp: F.firstLayerNozzleTemp,
    bedTemp: F.bedTemp, firstLayerBedTemp: F.firstLayerBedTemp,
    density: F.density, costPerKg: F.costPerKg,
    fanSpeed: F.fanSpeed, firstLayerFanSpeed: F.firstLayerFanSpeed, fanFullAtLayer: F.fanFullAtLayer,
    retractLength: F.retractLength[M.extruder] ?? F.retractLength.bowden,
    retractSpeed: F.retractSpeed,
    minLayerTime: F.minLayerTime,
    // quality
    qualityId: Q.id, qualityName: Q.name,
    layerHeight: Q.layerHeight, firstLayerHeight: Q.firstLayerHeight,
    wallCount: Q.wallCount, topLayers: Q.topLayers, bottomLayers: Q.bottomLayers,
    infillDensity: Q.infillDensity,
    speeds,
    ...overrides,
  };

  // Derived values, resolved once so no stage has to re-derive them and no two
  // stages can disagree about what a line width is.
  s.lineWidth = s.lineWidth || s.nozzleDiameter;
  s.firstLayerLineWidth = s.firstLayerLineWidth || s.lineWidth * 1.1;
  if (overrides.speeds) s.speeds = { ...speeds, ...overrides.speeds };
  return s;
}

/**
 * Things worth saying out loud before a 9 hour print starts. These are
 * warnings, not errors: the answer to "0.3mm layers on a 0.4mm nozzle" is to
 * tell someone it will bond badly, not to refuse.
 */
export function validate(s) {
  const w = [];
  if (s.layerHeight > s.nozzleDiameter * 0.8) {
    w.push(`a ${s.layerHeight}mm layer is more than 80% of the ${s.nozzleDiameter}mm nozzle, so layers will bond weakly`);
  }
  if (s.layerHeight < 0.04) w.push('layers under 0.04mm are below what the Z axis can reliably position');
  if (s.lineWidth < s.nozzleDiameter * 0.85) {
    w.push(`a ${s.lineWidth}mm line is narrower than the ${s.nozzleDiameter}mm nozzle can lay down`);
  }
  if (s.lineWidth > s.nozzleDiameter * 2.5) w.push('a line wider than 2.5 nozzles will not stick to its neighbour');
  if (s.nozzleTemp > s.maxNozzleTemp) w.push(`${s.nozzleTemp}C is above this hotend's ${s.maxNozzleTemp}C limit`);
  if (s.bedTemp > s.maxBedTemp) w.push(`${s.bedTemp}C is above this bed's ${s.maxBedTemp}C limit`);
  if (!s.heatedBed && s.bedTemp > 0) w.push('this machine has no heated bed, so the bed temperature is ignored');
  if (s.infillDensity < 0 || s.infillDensity > 100) w.push('infill density must be between 0 and 100 percent');
  if (s.wallCount < 1) w.push('a part with no walls has no outside surface');
  if (s.supportEnable && s.supportZGapTop < s.layerHeight * 0.5) {
    w.push('a top gap under half a layer will fuse the support to the part');
  }
  if (s.retractLength > 8) w.push('retracting more than 8mm risks pulling molten filament back into the cold end');
  if (s.materialId === 'tpu' && s.extruder === 'bowden' && s.retractLength > 2) {
    w.push('flexible filament buckles in a Bowden tube, so keep retraction under 2mm');
  }
  if (s.materialId === 'abs' && s.fanSpeed > 30) w.push('ABS at high fan will warp off the bed on an open frame');
  return w;
}

/** Default settings for Vi's machine, which is what the panel opens with. */
export const defaultSettings = () => buildSettings();

/** Menu data for the UI, so the panel never hard-codes a list. */
export const listMachines = () => Object.values(MACHINES).map((m) => ({ id: m.id, name: m.name }));
export const listMaterials = () => Object.values(MATERIALS).map((m) => ({ id: m.id, name: m.name }));
export const listQuality = () => Object.values(QUALITY).map((q) => ({ id: q.id, name: q.name }));

// ---------------------------------------------------------------------------
// firmware scripts
// ---------------------------------------------------------------------------

/**
 * The start script. The prime line matters more than it looks: it wipes the
 * ooze that built up while the nozzle came to temperature, and it gives the
 * first real extrusion somewhere to start from other than the middle of the
 * part. The Ender's stock line runs up the left edge of the bed.
 */
export function startGcode(s) {
  const bed = Math.round(s.firstLayerBedTemp);
  const hot = Math.round(s.firstLayerNozzleTemp);
  const y2 = Math.min(s.bedDepth - 20, 200);
  const lines = [
    '; CADence start script',
    'M140 S' + bed + '            ; start heating the bed',
    'M104 S' + hot + '            ; start heating the nozzle',
    'M190 S' + bed + '            ; wait for the bed',
    'M109 S' + hot + '            ; wait for the nozzle',
    'G21                          ; millimetres',
    'G90                          ; absolute positioning',
    'M82                          ; absolute extrusion',
    'M107                         ; fan off for the first layer',
    'G28                          ; home all axes',
    'G92 E0                       ; zero the extruder',
    'G1 Z2.0 F3000                ; lift clear of the bed',
    'G1 X0.1 Y20 Z0.3 F5000       ; move to the start of the prime line',
    `G1 X0.1 Y${y2} Z0.3 F1500 E15   ; draw the prime line`,
    'G1 X0.4 Y' + y2 + ' Z0.3 F5000',
    `G1 X0.4 Y20 Z0.3 F1500 E30   ; and back, to wipe`,
    'G92 E0                       ; zero the extruder again',
    'G1 Z2.0 F3000                ; lift before travelling to the part',
  ];
  if (!s.heatedBed) return lines.filter((l) => !/^M1[49]0/.test(l)).join('\n');
  return lines.join('\n');
}

/** The end script. Retract, get the nozzle off the part, cool down, and push
 *  the bed forward so the print is reachable without leaning into the gantry. */
export function endGcode(s) {
  return [
    '; CADence end script',
    'M107                         ; fan off',
    'G91                          ; relative positioning',
    'G1 E-3 F2700                 ; retract to stop oozing',
    'G1 E-2 Z0.2 F2400            ; retract and lift off the part',
    'G1 X5 Y5 F3000               ; wipe clear',
    'G1 Z10 F3000                 ; raise',
    'G90                          ; absolute positioning',
    `G1 X0 Y${Math.round(s.bedDepth)} F3000   ; present the print`,
    'M104 S0                      ; nozzle off',
    s.heatedBed ? 'M140 S0                      ; bed off' : null,
    'M84 X Y E                    ; steppers off, keep Z holding',
  ].filter(Boolean).join('\n');
}
