// brep.js — the exact kernel, loaded only when it is asked for.
//
// Everything else in CADence models with meshes, through Manifold, and that is
// the right default: it is small, it is fast, and it is guaranteed watertight,
// which is what a slicer needs. What it cannot do is round the edge of a solid.
// A fillet is not a mesh operation. It is a new analytic surface tangent to two
// old ones, and a triangle soup has no analytic surfaces to be tangent to.
//
// So this file is the second kernel: OpenCascade, through replicad, in WASM.
// It gives three things the mesh half cannot:
//
//   1. FILLET AND CHAMFER on the edges of a finished solid, including edges
//      that did not exist until a boolean ran.
//   2. STEP EXPORT that is genuinely parametric. A rounded edge lands in the
//      file as a CYLINDRICAL_SURFACE, not as four hundred flat facets, so a
//      machinist or Fusion or FreeCAD gets a real part rather than a scan.
//   3. STEP IMPORT, which comes free with the same kernel.
//
// WHAT IT COSTS, AND WHY IT IS BEHIND A BUTTON
//
// The OCCT WASM is 10.9MB, plus 0.6MB of replicad. Measured, not estimated.
// That is by a wide margin the heaviest thing this app could ship, and putting
// it in the initial load would make every visitor who only wanted to drag a box
// around pay for a kernel they never touch. So nothing here is imported until
// the moment someone asks for an exact operation, the size is said out loud
// before the download starts, and the mesh half keeps working untouched if the
// download never happens.
//
// PROVENANCE, NOT RECONSTRUCTION
//
// This never tries to work out what a mesh "is". That is reverse engineering
// and it is a research problem. It replays the RECIPE instead: a box that knows
// it is a box becomes a real B-rep box, and a boolean of two of them becomes a
// real B-rep boolean. Everything CADence builds carries its recipe, which is
// exactly why this is tractable at all. Anything without a recipe, or with one
// this file has not been taught, is refused by name rather than approximated.

import * as THREE from 'three';
import { patternTransforms } from './primitives.js';

const REPLICAD_URL = 'https://cdn.jsdelivr.net/npm/replicad@0.23.1/dist/replicad.js';
const OCC_JS_URL = 'https://cdn.jsdelivr.net/npm/replicad-opencascadejs@0.23.0/src/replicad_single.js';
const OCC_WASM_URL = 'https://cdn.jsdelivr.net/npm/replicad-opencascadejs@0.23.0/src/replicad_single.wasm';

/** Said out loud in the UI before the download starts. Measured, not guessed. */
export const BREP_DOWNLOAD_MB = 11.5;

/**
 * CADence is Y-up with every primitive's base at y=0. CAD, STEP and replicad are
 * all Z-up. One rotation converts between them, and it is a rotation and not a
 * flip on purpose: an axis swap that mirrored the part would hand a machinist a
 * left-handed version of the thing on screen.
 */
export const ZUP_TO_YUP = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
export const YUP_TO_ZUP = new THREE.Matrix4().makeRotationX(Math.PI / 2);

let _loading = null;
let _kernel = null;
let _failed = null;

/** 'idle' before anyone asks, then 'loading', then 'ready' or 'failed'. */
export function brepStatus() {
  if (_kernel) return 'ready';
  if (_failed) return 'failed';
  if (_loading) return 'loading';
  return 'idle';
}

export function brepFailure() { return _failed; }

/**
 * Fetch and start the kernel. Safe to call repeatedly, and only ever downloads
 * once, because a second click on Fillet while the first download is in flight
 * would otherwise pull eleven megabytes twice.
 */
export function loadBrep(onProgress = () => {}) {
  if (_kernel) return Promise.resolve(_kernel);
  if (_loading) return _loading;
  _failed = null;
  _loading = (async () => {
    onProgress('Fetching the exact kernel, about 11.5MB. This happens once.');
    const R = await import(/* @vite-ignore */ REPLICAD_URL);
    onProgress('Starting OpenCascade.');
    const mod = await import(/* @vite-ignore */ OCC_JS_URL);
    const init = mod.default || mod;
    const oc = await init({ locateFile: () => OCC_WASM_URL });
    R.setOC(oc);
    _kernel = { R, oc };
    onProgress('The exact kernel is ready.');
    return _kernel;
  })().catch((err) => {
    _loading = null;
    _failed = String(err && err.message || err);
    throw err;
  });
  return _loading;
}

/* ------------------------------------------------------------ freeing shapes */
//
// OCCT shapes live in the WASM heap and are NOT garbage collected. Every fuse,
// every fillet and every translate produces a NEW shape and leaves the old one
// behind, so a chain of five operations abandons four solids in memory that
// nothing will ever reclaim.
//
// This is not a tidiness problem. Left alone it crashed the whole browser tab
// partway through the test suite, at around twenty operations, with the renderer
// simply dying rather than throwing anything catchable. A modeller where the
// twentieth fillet kills the page is not shippable, and the failure gives no
// warning on the way down.
//
// So every shape built here is registered as it is made, and everything except
// the one being handed back is freed when the job finishes.

let _tracked = null;

/** Register a shape for freeing when the current job ends. */
function t(shape) {
  if (_tracked) _tracked.push(shape);
  return shape;
}

/**
 * Run a job, then free every intermediate it created.
 *
 * `keep` names what survives, since the caller needs one shape back. Nested
 * scopes restore the outer one, so a scope inside a scope cannot free shapes
 * the outer job is still using.
 */
export function scoped(fn) {
  const outer = _tracked;
  const mine = [];
  _tracked = mine;
  let result;
  try {
    result = fn();
  } finally {
    _tracked = outer;
  }
  const keep = new Set(Array.isArray(result) ? result : [result]);
  for (const s of mine) {
    if (keep.has(s)) { t(s); continue; }        // hand survivors to the outer scope
    try { s?.delete?.(); } catch { /* already gone */ }
  }
  return result;
}

/** Free a shape the caller is finished with. */
export function disposeSolid(s) {
  try { s?.delete?.(); } catch { /* already gone */ }
}

/* ------------------------------------------------------- what can be replayed */

const PRIMITIVE_KINDS = new Set(['box', 'cylinder', 'sphere', 'cone', 'torus', 'tube', 'wedge', 'prism']);

/**
 * Can this object be replayed exactly, and if not, why not in words.
 *
 * Checked before the download rather than after, so nobody waits for eleven
 * megabytes to be told their part contains a loft.
 */
export function canBrep(node) {
  if (!node) return { ok: false, reason: 'there is nothing selected' };
  const kind = node.kind;
  if (PRIMITIVE_KINDS.has(kind)) return { ok: true };
  if (kind === 'boolean') {
    if (!node.children || !node.children.length) return { ok: false, reason: 'that group has no parts to replay' };
    for (const c of node.children) {
      const r = canBrep(c);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (kind === 'pattern') {
    const src = node.params && node.params.src;
    if (!src) return { ok: false, reason: 'that pattern has no source recipe' };
    if (src.geo) return { ok: false, reason: 'a pattern of a baked group has no recipe to replay, so release it first' };
    return canBrep({ kind: src.kind, params: src.params });
  }
  if (kind === 'sketch') {
    const p = node.params || {};
    if (p.op === 'revolve') return { ok: true };
    const end = p.endType || 'blind';
    if (end !== 'blind' && end !== 'symmetric') {
      return { ok: false, reason: `an extrude ending in "${end}" is not replayed exactly yet, so set it to blind or symmetric first` };
    }
    if (p.draft) return { ok: false, reason: 'a drafted extrude is not replayed exactly yet, so set the draft to zero first' };
    if (!Array.isArray(p.profile) || p.profile.length < 3) return { ok: false, reason: 'that sketch has no closed profile' };
    return { ok: true };
  }
  if (kind === 'loft') {
    if (node.params && node.params.twist) return { ok: false, reason: 'a twisted loft is not replayed exactly yet, so set the twist to zero first' };
    return { ok: true };
  }
  if (kind === 'brep') return { ok: true };
  return { ok: false, reason: `a ${kind} has no exact equivalent here yet` };
}

/* ---------------------------------------------------------------- the replay */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * One recipe node to a replicad solid, in Z-up local space with its base at
 * z=0, exactly mirroring what the mesh half builds at y=0.
 */
function primitiveSolid(R, kind, params = {}) {
  const p = params;
  const round = p.round || 0;
  let s;
  switch (kind) {
    case 'box':
      s = t(R.makeBaseBox(p.width, p.depth, p.height));
      // The mesh half draws `round` with a RoundedBoxGeometry, which rounds
      // every edge. Here that is a genuine fillet rather than an approximation
      // of one, so the exact version is strictly better than the picture.
      if (round > 0.001) s = t(s.fillet(clamp(round, 0, Math.min(p.width, p.depth, p.height) / 2 - 0.01)));
      return s;

    case 'cylinder':
      s = t(R.makeCylinder(p.radius, p.height));
      if (round > 0.001) s = t(s.fillet(clamp(round, 0, Math.min(p.radius, p.height / 2) - 0.01)));
      return s;

    case 'sphere':
      return t(t(R.makeSphere(p.radius)).translate([0, 0, p.radius]));

    case 'cone': {
      // replicad has no cone primitive, so revolve a right triangle about Z.
      const rr = p.radius;
      s = t(R.draw([0, 0]).lineTo([rr, 0]).lineTo([0, p.height]).close().sketchOnPlane('XZ').revolve());
      if (round > 0.001) {
        // A cone's apex cannot take a fillet, so only the base rim is offered,
        // and a radius the geometry refuses is reported rather than swallowed.
        try { s = t(s.fillet(clamp(round, 0, rr / 2), (e) => e.inPlane('XY', 0))); } catch { /* leave it sharp */ }
      }
      return s;
    }

    case 'torus':
      return t(t(R.drawCircle(p.tube).translate([p.radius, 0]).sketchOnPlane('XZ').revolve())
        .translate([0, 0, p.tube]));

    case 'tube':
      return t(t(R.makeCylinder(p.outer, p.height))
        .cut(t(R.makeCylinder(Math.min(p.inner, p.outer - 0.1), p.height))));

    case 'wedge': {
      // Right triangle in XZ, extruded along depth, centered on it, matching the
      // mesh half's `translate(-width/2, 0, -depth/2)`.
      const tri = R.draw([-p.width / 2, 0]).lineTo([p.width / 2, 0]).lineTo([-p.width / 2, p.height]).close();
      s = t(t(tri.sketchOnPlane('XZ').extrude(p.depth)).translate([0, p.depth / 2, 0]));
      if (round > 0.001) {
        try { s = t(s.fillet(clamp(round, 0, Math.min(p.width, p.height) / 3), (e) => e.inDirection('Y'))); } catch { /* leave it sharp */ }
      }
      return s;
    }

    case 'prism':
      s = t(R.sketchPolysides(p.radius, Math.max(3, Math.round(p.sides))).extrude(p.height));
      if (round > 0.001) {
        try { s = t(s.fillet(clamp(round, 0, p.radius / 3), (e) => e.inDirection('Z'))); } catch { /* leave it sharp */ }
      }
      return s;

    case 'loft': {
      // Two rounded rectangles, bottom and top, skinned between. Twist is
      // refused up in canBrep, because a twisted loft is a ruled surface this
      // does not build the same way the mesh half does and a silent difference
      // between the picture and the export would be the worst outcome.
      const rb = clamp(p.round || 0, 0, Math.min(p.width, p.depth) / 2 - 0.01);
      const rt = clamp(p.round || 0, 0, Math.min(p.topWidth, p.topDepth) / 2 - 0.01);
      const bottom = R.drawRoundedRectangle(p.width, p.depth, rb).sketchOnPlane('XY', 0);
      const top = R.drawRoundedRectangle(p.topWidth, p.topDepth, rt).sketchOnPlane('XY', p.height);
      return t(R.loft([bottom, top]));
    }

    case 'sketch': {
      const prof = p.profile;
      let pen = R.draw([prof[0][0], prof[0][1]]);
      for (let i = 1; i < prof.length; i++) pen = pen.lineTo([prof[i][0], prof[i][1]]);
      const closed = pen.close();
      if (p.op === 'revolve') {
        // The mesh half treats x as a radius and spins about Y, which is Z here.
        const rev = t(closed.sketchOnPlane('XZ').revolve());
        const bb = rev.boundingBox;
        return t(rev.translate([0, 0, -bb.bounds[0][2]]));   // rest it on the plate
      }
      const depth = p.depth ?? 20;
      const start = p.start ?? 0;
      const end = p.endType || 'blind';
      const sk = closed.sketchOnPlane('XY', end === 'symmetric' ? start - depth / 2 : start);
      return t(sk.extrude(depth));
    }

    default:
      throw new Error(`the exact kernel has no recipe for a ${kind}`);
  }
}

/**
 * Apply a placement matrix, in Z-up space, to a replicad solid.
 *
 * Decomposed rather than handed over whole, because a B-rep transform has to be
 * a rigid motion plus a uniform scale to stay exact. Stretching a cylinder more
 * on X than on Y turns a circle into an ellipse, which is a genuinely different
 * surface, so a non-uniform scale is refused by name instead of being rounded
 * into something that merely looks close.
 */
function applyMatrix(solid, m) {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  m.decompose(pos, quat, scl);

  let s = solid;
  const uniform = Math.abs(scl.x - scl.y) < 1e-9 && Math.abs(scl.y - scl.z) < 1e-9;
  if (!uniform) {
    throw new Error('a part stretched by a different amount on each axis has no exact equivalent here, so scale it evenly or bake it first');
  }
  if (Math.abs(scl.x - 1) > 1e-9) s = t(s.scale(scl.x));

  const axis = new THREE.Vector3();
  let angle = 2 * Math.acos(clamp(quat.w, -1, 1));
  const sinHalf = Math.sqrt(Math.max(0, 1 - quat.w * quat.w));
  if (sinHalf > 1e-9) axis.set(quat.x / sinHalf, quat.y / sinHalf, quat.z / sinHalf);
  else { axis.set(0, 0, 1); angle = 0; }
  if (Math.abs(angle) > 1e-9) s = t(s.rotate((angle * 180) / Math.PI, [0, 0, 0], [axis.x, axis.y, axis.z]));

  if (pos.lengthSq() > 1e-18) s = t(s.translate([pos.x, pos.y, pos.z]));
  return s;
}

/** Every copy of a pattern, replayed and fused into one solid. */
function patternSolid(R, params) {
  const src = params.src;
  const mats = patternTransforms(params);
  let acc = null;
  for (const m of mats) {
    // The pattern's own transforms are authored in CADence's Y-up frame, so
    // each one has to be conjugated into Z-up before the kernel sees it.
    const zm = new THREE.Matrix4().multiplyMatrices(YUP_TO_ZUP, m).multiply(ZUP_TO_YUP);
    const copy = applyMatrix(primitiveSolid(R, src.kind, src.params), zm);
    acc = acc ? t(acc.fuse(copy)) : copy;
  }
  return acc;
}

/**
 * A recipe node to a solid, placed by its own transform.
 * @param {*} node a CadObject-shaped thing, or a boolean child snapshot
 */
export function solidFromNode(R, node) {
  let base;
  if (node.kind === 'boolean') {
    const kids = (node.children || []).map((c) => ({ role: c.role || 'solid', solid: solidFromNode(R, c) }));
    const solids = kids.filter((k) => k.role !== 'hole');
    const holes = kids.filter((k) => k.role === 'hole');
    if (!solids.length) throw new Error('that group is holes all the way down, so there is no solid to make');
    base = solids[0].solid;
    for (let i = 1; i < solids.length; i++) base = t(base.fuse(solids[i].solid));
    for (const h of holes) base = t(base.cut(h.solid));
    // A boolean child's transform is baked into its own replay above, so a
    // group only carries whatever it has been moved by since it was made.
    return placeNode(base, node);
  }
  if (node.kind === 'pattern') base = patternSolid(R, node.params);
  else base = primitiveSolid(R, node.kind, node.params);
  return placeNode(base, node);
}

/** Read a node's placement, whichever shape it arrived in, and apply it. */
function placeNode(solid, node) {
  let m;
  if (node.mesh) {
    node.mesh.updateWorldMatrix(true, false);
    m = node.mesh.matrixWorld.clone();
  } else if (node.position) {
    m = new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(node.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(node.rotation || [0, 0, 0]))),
      new THREE.Vector3().fromArray(node.scale || [1, 1, 1]),
    );
  } else return solid;
  if (isIdentity(m)) return solid;
  const zm = new THREE.Matrix4().multiplyMatrices(YUP_TO_ZUP, m).multiply(ZUP_TO_YUP);
  return applyMatrix(solid, zm);
}

function isIdentity(m) {
  const e = m.elements;
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 16; i++) if (Math.abs(e[i] - I[i]) > 1e-12) return false;
  return true;
}

/**
 * Apply only what a baked part has been MOVED by since it was baked.
 *
 * An exact solid's recipe already carries the placement the original part had,
 * so replaying it puts the solid back exactly where it was made. Anything the
 * user has done to it since then is the difference between its current world
 * matrix and the one recorded at bake time, which is the same delta the mesh
 * half uses to put a group's children back after an ungroup.
 */
export function applyDelta(solid, mesh, baseMatrix) {
  if (!mesh) return solid;
  mesh.updateWorldMatrix(true, false);
  if (!baseMatrix) return solid;
  const delta = new THREE.Matrix4().copy(baseMatrix).invert().premultiply(mesh.matrixWorld);
  if (isIdentity(delta)) return solid;
  const zm = new THREE.Matrix4().multiplyMatrices(YUP_TO_ZUP, delta).multiply(ZUP_TO_YUP);
  return applyMatrix(solid, zm);
}

/* --------------------------------------------------------------- operations */

export const EDGE_SELECTORS = [
  { id: 'all', label: 'Every edge', note: 'round or bevel the whole part at once' },
  { id: 'vertical', label: 'Upright edges', note: 'the edges running up the sides, leaving the top and bottom sharp' },
  { id: 'top', label: 'Top edges', note: 'only the edges on the highest face' },
  { id: 'bottom', label: 'Bottom edges', note: 'only the edges sitting on the plate, which a printer usually wants left sharp' },
];

function edgeFinder(solid, select) {
  if (!select || select === 'all') return undefined;
  // 'vertical' is a direction in the kernel's Z-up frame, which is CADence's up.
  if (select === 'vertical') return (e) => e.inDirection('Z');
  const bb = solid.boundingBox.bounds;
  if (select === 'top') return (e) => e.inPlane('XY', bb[1][2]);
  if (select === 'bottom') return (e) => e.inPlane('XY', bb[0][2]);
  return undefined;
}

/**
 * Round or bevel edges, and say something useful when it will not go.
 *
 * OCCT refuses a fillet whose radius does not fit between the surfaces it has
 * to stay tangent to, and the error it throws for that is not something to show
 * anyone. A radius too big for the part is the overwhelmingly common cause, so
 * that is the thing the message names.
 */
export function applyOp(solid, op) {
  const size = Number(op.size);
  if (!Number.isFinite(size) || size <= 0) throw new Error('that radius has to be a positive number');
  const finder = edgeFinder(solid, op.select);
  try {
    return t(op.type === 'chamfer' ? solid.chamfer(size, finder) : solid.fillet(size, finder));
  } catch (err) {
    throw new Error(
      `${size}mm is more than this shape can take on ${op.select === 'all' ? 'every edge' : 'those edges'}. ` +
      'Try a smaller radius, or pick fewer edges.',
    );
  }
}

export function applyOps(solid, ops = []) {
  let s = solid;
  for (const op of ops) s = applyOp(s, op);
  return s;
}

/**
 * Build a recipe, run its operations, and hand back geometry with nothing left
 * behind in the WASM heap.
 *
 * The one entry point the document layer uses, so freeing cannot be forgotten
 * at a call site. Everything the job made, including the final solid, is gone
 * by the time this returns, because the only thing anyone needed from it was
 * the triangles.
 */
export function geometryFor(R, node, ops = [], meshOpts) {
  let geo = null;
  scoped(() => {
    const solid = applyOps(solidFromNode(R, node), ops);
    geo = tessellate(solid, meshOpts);
    return null;                                 // keep nothing, the triangles are out
  });
  return geo;
}

/* -------------------------------------------------------------- tessellation */

/**
 * A replicad solid to a Three geometry, back in CADence's Y-up frame.
 *
 * The tolerance is a real trade rather than a constant. Too coarse and a fillet
 * reads as a chamfer on screen; too fine and a part with twenty rounded edges
 * takes long enough to notice. These numbers were picked by looking at a 3mm
 * fillet on a 20mm box at a normal zoom.
 */
export function tessellate(solid, { tolerance = 0.03, angularTolerance = 0.15 } = {}) {
  const m = solid.mesh({ tolerance, angularTolerance });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.vertices), 3));
  if (m.normals && m.normals.length === m.vertices.length) {
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(m.normals), 3));
  }
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(m.triangles), 1));
  geo.applyMatrix4(ZUP_TO_YUP);
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  else geo.computeVertexNormals();     // the rotation invalidated the old ones
  geo.computeBoundingBox();
  return geo;
}

/* -------------------------------------------------------------------- STEP */

/**
 * Write a STEP file for a set of already-replayed solids.
 * @param {Array<{shape:*, name:string}>} parts
 */
export async function stepTextOf(R, parts) {
  const out = R.exportSTEP(parts);
  return typeof out === 'string' ? out : await out.text();
}

/**
 * Read a STEP file and hand back geometry ready to drop into the scene.
 *
 * The one direction that was always easy. STEP carries exact surfaces and
 * meshing them is only sampling, so this is a tessellation and never a guess.
 */
export function stepToGeometry(R, text, opts) {
  return Promise.resolve(R.importSTEP(new Blob([text]))).then((s) => {
    const geometry = tessellate(s, opts);
    // The shape has served its purpose. An imported part is held as triangles
    // like any other baked body, and keeping the B-rep alive would leak the
    // whole file's worth of surfaces on every import.
    disposeSolid(s);
    return { geometry };
  });
}
