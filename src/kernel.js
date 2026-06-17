// kernel.js — the mesh boolean engine (Stage 1).
//
// This is the "TinkerCAD soul": solids unite, holes subtract, grouping bakes
// them into one watertight body. We use the Manifold kernel (Emmett Lalish's
// OCCT-grade mesh CSG) because its output is guaranteed manifold/watertight —
// which is exactly what a 3D printer's slicer needs.
//
// Everything kernel-specific is sealed behind `booleanCombine()`. If we ever
// swap engines (three-bvh-csg, a B-rep kernel), only this file changes.
//
// NOTE: Manifold is a WASM module loaded from a CDN to keep us no-build. The
// load is lazy + cached. If the CDN/version string is ever wrong, you'll see a
// single clear error in the console — fixable in the MANIFOLD_URL constant.

import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildGeometry, DEFAULT_PARAMS } from './primitives.js';

const MANIFOLD_URL = 'https://cdn.jsdelivr.net/npm/manifold-3d@3.0.1/manifold.js';

let _wasmPromise = null;

async function getManifold() {
  if (!_wasmPromise) {
    _wasmPromise = (async () => {
      const Module = (await import(/* @vite-ignore */ MANIFOLD_URL)).default;
      const wasm = await Module();
      wasm.setup();
      return wasm;
    })();
  }
  return _wasmPromise;
}

// Pre-warm the kernel so the first boolean isn't slow. Safe to call anytime.
export function warmKernel() { getManifold().catch(() => {}); }

// --- conversions ----------------------------------------------------------

// Three.js mesh (with its world transform) -> a Manifold solid.
function meshToManifold(wasm, threeMesh) {
  threeMesh.updateWorldMatrix(true, false);
  // Non-indexed positions in WORLD space; Manifold.merge() welds the seams so
  // the result is a valid closed solid even though primitives share corners.
  const geo = threeMesh.geometry.index
    ? threeMesh.geometry.toNonIndexed()
    : threeMesh.geometry.clone();
  geo.applyMatrix4(threeMesh.matrixWorld);

  const pos = geo.getAttribute('position').array; // Float32Array, flat xyz
  const vertCount = pos.length / 3;
  const triVerts = new Uint32Array(vertCount);
  for (let i = 0; i < vertCount; i++) triVerts[i] = i;

  const mesh = new wasm.Mesh({
    numProp: 3,
    vertProperties: new Float32Array(pos),
    triVerts,
  });
  mesh.merge(); // weld coincident verts -> manifold
  geo.dispose();
  return new wasm.Manifold(mesh);
}

// A Manifold solid -> a Three.js BufferGeometry (world space).
function manifoldToGeometry(manifoldSolid) {
  const m = manifoldSolid.getMesh();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.vertProperties), m.numProp));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(m.triVerts), 1));

  // Creased normals: smooth across shallow angles (cylinder walls read round),
  // hard-split across sharp edges (box faces stay flat). This removes the
  // "star" shading artifacts that naive vertex-normal averaging produces on the
  // big flat faces of a boolean result. 30° threshold.
  const creased = toCreasedNormals(geo, Math.PI / 6);
  geo.dispose();
  return creased;
}

// --- public API -----------------------------------------------------------

/**
 * Combine a set of meshes into one watertight geometry.
 * @param parts Array<{ mesh: THREE.Mesh, role: 'solid'|'hole' }>
 * @returns { geometry: THREE.BufferGeometry } in world space, or null if empty.
 *
 * Semantics (TinkerCAD-style): union all solids, then subtract all holes.
 */
export async function booleanCombine(parts) {
  const wasm = await getManifold();
  const solids = parts.filter((p) => p.role !== 'hole').map((p) => meshToManifold(wasm, p.mesh));
  const holes = parts.filter((p) => p.role === 'hole').map((p) => meshToManifold(wasm, p.mesh));

  // Track intermediates separately so we free each Manifold exactly once
  // (Manifold WASM objects aren't garbage-collected; double-free crashes).
  const created = [];
  const union = (list) => {
    if (list.length === 1) return list[0];
    const u = wasm.Manifold.union(list);
    created.push(u);
    return u;
  };

  const freeAll = () => [...solids, ...holes, ...created].forEach((m) => m.delete?.());

  if (solids.length === 0) { freeAll(); return null; } // a pile of holes makes no body

  let body = union(solids);
  if (holes.length) {
    const diff = wasm.Manifold.difference(body, union(holes));
    created.push(diff);
    body = diff;
  }

  const geometry = manifoldToGeometry(body); // body is always in solids[] or created[]
  freeAll();
  return { geometry };
}

/**
 * Intersection of several meshes — keep only the volume common to ALL of them.
 * @param meshes Array<THREE.Mesh>
 * @returns { geometry } in world space, or null if they share no volume.
 */
export async function booleanIntersect(meshes) {
  const wasm = await getManifold();
  const solids = meshes.map((m) => meshToManifold(wasm, m));
  const created = [];
  let body = solids[0];
  for (let i = 1; i < solids.length; i++) {
    const r = wasm.Manifold.intersection(body, solids[i]);
    created.push(r);
    body = r;
  }
  const empty = typeof body.isEmpty === 'function' ? body.isEmpty() : false;
  const geometry = empty ? null : manifoldToGeometry(body);
  [...solids, ...created].forEach((m) => m.delete?.());
  return geometry ? { geometry } : null;
}

// --- self-test ------------------------------------------------------------
// Because the kernel runs in WASM and can't be exercised headlessly, this lets
// you verify every boolean op IN THE BROWSER with real volume assertions —
// union, difference, intersection, and the tricky "hole straddling solid + air"
// case. Returns [{ name, pass, detail }]. Wired to the Diagnostics button.

function volumeOf(m) {
  if (typeof m.volume === 'function') return m.volume();
  if (typeof m.getProperties === 'function') return m.getProperties().volume;
  return NaN;
}

export async function kernelSelfTest() {
  const wasm = await getManifold();
  const M = wasm.Manifold;
  const results = [];
  const check = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail });
  const mk = (geo, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo);
    mesh.position.set(x, y, z);
    mesh.updateMatrixWorld(true);
    return meshToManifold(wasm, mesh);
  };
  const box = () => new THREE.BoxGeometry(20, 20, 20);          // 8000 mm³
  const made = [];
  const reg = (m) => { made.push(m); return m; };

  try {
    // 1. sanity: a 20mm cube measures ~8000 mm³ through the kernel
    const vbox = volumeOf(reg(mk(box())));
    check('Cube 20³ volume ≈ 8000 mm³', Math.abs(vbox - 8000) < 60, `got ${vbox.toFixed(0)}`);

    // 2. UNION of two cubes overlapping by half → 8000 + 8000 − 4000 = 12000
    const vU = volumeOf(reg(M.union(reg(mk(box())), reg(mk(box(), 10)))));
    check('Union (50% overlap) ≈ 12000 mm³', Math.abs(vU - 12000) < 150, `got ${vU.toFixed(0)}`);

    // 3. INTERSECTION of the same pair → just the shared 4000
    const vI = volumeOf(reg(M.intersection(reg(mk(box())), reg(mk(box(), 10)))));
    check('Intersection (50% overlap) ≈ 4000 mm³', Math.abs(vI - 4000) < 150, `got ${vI.toFixed(0)}`);

    // 4. DIFFERENCE: cube minus the overlapping cube → 8000 − 4000 = 4000
    const vD = volumeOf(reg(M.difference(reg(mk(box())), reg(mk(box(), 10)))));
    check('Difference (cube − overlap) ≈ 4000 mm³', Math.abs(vD - 4000) < 150, `got ${vD.toFixed(0)}`);

    // 5. HOLE straddling SOLID + AIR: a tall cylinder on the +X face. Only the
    //    part inside the cube is removed; the half hanging in air does nothing.
    const vBored = volumeOf(reg(M.difference(reg(mk(box())), reg(mk(new THREE.CylinderGeometry(5, 5, 40, 48), 10)))));
    check('Hole straddling solid+air subtracts only the overlap', vBored < 7999 && vBored > 4000, `got ${vBored.toFixed(0)} (expect <8000, >4000)`);

    // 6. HOLE entirely in AIR: disjoint subtractor leaves the solid untouched
    const vNoop = volumeOf(reg(M.difference(reg(mk(box())), reg(mk(box(), 200)))));
    check('Hole in pure air leaves solid unchanged', Math.abs(vNoop - 8000) < 60, `got ${vNoop.toFixed(0)}`);

    // 7+. PRIMITIVE VOLUMES — each default primitive measured against its exact
    // analytic volume. Curved shapes are faceted, so they read slightly under;
    // tolerances allow for that. A wildly-off or zero value means the primitive
    // isn't a valid closed solid (e.g. a broken extrude cap).
    const primVol = (kind) => {
      const mesh = new THREE.Mesh(buildGeometry(kind, DEFAULT_PARAMS[kind]));
      mesh.updateMatrixWorld(true);
      return volumeOf(reg(meshToManifold(wasm, mesh)));
    };
    const near = (got, exp, pct) => Math.abs(got - exp) <= exp * pct;
    const P = DEFAULT_PARAMS;
    const expect = {
      cylinder: Math.PI * P.cylinder.radius ** 2 * P.cylinder.height,
      sphere: (4 / 3) * Math.PI * P.sphere.radius ** 3,
      cone: (1 / 3) * Math.PI * P.cone.radius ** 2 * P.cone.height,
      torus: 2 * Math.PI ** 2 * P.torus.radius * P.torus.tube ** 2,
      tube: Math.PI * (P.tube.outer ** 2 - P.tube.inner ** 2) * P.tube.height,
      wedge: 0.5 * P.wedge.width * P.wedge.height * P.wedge.depth,
      prism: 0.5 * P.prism.sides * P.prism.radius ** 2 * Math.sin((2 * Math.PI) / P.prism.sides) * P.prism.height,
    };
    const tol = { cylinder: 0.03, sphere: 0.04, cone: 0.04, torus: 0.06, tube: 0.03, wedge: 0.01, prism: 0.02 };
    for (const kind of Object.keys(expect)) {
      const got = primVol(kind);
      check(`Primitive "${kind}" volume ≈ ${expect[kind].toFixed(0)} mm³`, near(got, expect[kind], tol[kind]), `got ${got.toFixed(0)}`);
    }
  } catch (err) {
    check('kernel self-test threw', false, String(err));
  } finally {
    made.forEach((m) => m.delete?.());
  }
  return results;
}
