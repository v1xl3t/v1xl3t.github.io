// primitives.js — the parametric primitive library.
//
// Each entry maps a recipe (kind + params, in millimetres) to a Three.js
// BufferGeometry. Params are the *precise* definition; geometry is derived.
// Keeping this table-driven is deliberate — adding a primitive later (cone,
// torus, wedge) is one entry here, and the rest of the app picks it up for
// free (toolbar, inspector fields, export).
//
// Corner rounding: most primitives carry a `round` param (mm). At round=0 the
// geometry is identical to the classic sharp shape (so nothing else changes);
// above 0 we build a rounded variant — like CSS border-radius for solids. A
// true uniform fillet on arbitrary curved edges is a B-rep-kernel job (Stage 2);
// this is the tractable mesh version that covers the common cases now.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { solveSketch, sketchProfile, TESS_SEGMENTS } from './sketch.js';
import { normalizeProfile, suggestedDepth, offsetRegion } from './profile.js';

// Display labels for the two roles. Internal role values stay 'solid'/'hole'
// forever (stable), but what the UI *calls* them lives here — so renaming is a
// one-line change. Additive vs subtractive / mass vs negative space.
export const ROLE_LABELS = { solid: 'Add', hole: 'Cut' };

// Default dimensions (mm) for each primitive.
export const DEFAULT_PARAMS = {
  box:      { width: 20, height: 20, depth: 20, round: 0 },
  cylinder: { radius: 10, height: 20, segments: 48, round: 0 },
  sphere:   { radius: 10, segments: 32 },
  cone:     { radius: 10, height: 20, segments: 48, round: 0 },
  torus:    { radius: 12, tube: 4, segments: 48 },
  tube:     { outer: 10, inner: 6, height: 20, segments: 48 },
  wedge:    { width: 20, height: 20, depth: 20, round: 0 },
  prism:    { sides: 6, radius: 10, height: 20, round: 0 },
  loft:     { width: 20, depth: 20, topWidth: 12, topDepth: 12, height: 20, round: 0, twist: 0 },
  // A sketch is a closed 2D profile (points, mm) turned into a solid by a feature
  // operation: 'extrude' (straight pull up by `depth`) or 'revolve' (spin the
  // profile around the Y axis by `angle`°). Default profile = a 20mm square.
  sketch:   { profile: [[-10, -10], [10, -10], [10, 10], [-10, 10]], op: 'extrude', depth: 20,
              endType: 'blind', depth2: 0, start: 0, draft: 0, angle: 360, segments: 48,
              plane: null },   // null = the ground plane; a face sketch stores its own
};

// A reusable "corner radius" field for primitives that support rounding.
const ROUND_FIELD = { key: 'round', label: 'Round (mm)', min: 0, step: 0.5 };

// Which params are user-editable dimensions, with display metadata for the
// inspector. (segments is structural, edited under an "Advanced" group.)
export const PARAM_SCHEMA = {
  box: [
    { key: 'width',  label: 'Width (X)',  min: 0.1, step: 0.5 },
    { key: 'height', label: 'Height (Y)', min: 0.1, step: 0.5 },
    { key: 'depth',  label: 'Depth (Z)',  min: 0.1, step: 0.5 },
    ROUND_FIELD,
  ],
  cylinder: [
    { key: 'radius', label: 'Radius',   min: 0.1, step: 0.5 },
    { key: 'height', label: 'Height',   min: 0.1, step: 0.5 },
    ROUND_FIELD,
    { key: 'segments', label: 'Facets', min: 3,   step: 1, advanced: true, integer: true },
  ],
  sphere: [
    { key: 'radius',   label: 'Radius', min: 0.1, step: 0.5 },
    { key: 'segments', label: 'Facets', min: 3,   step: 1, advanced: true, integer: true },
  ],
  cone: [
    { key: 'radius',   label: 'Base radius', min: 0.1, step: 0.5 },
    { key: 'height',   label: 'Height',      min: 0.1, step: 0.5 },
    ROUND_FIELD,
    { key: 'segments', label: 'Facets',      min: 3,   step: 1, advanced: true, integer: true },
  ],
  torus: [
    { key: 'radius',   label: 'Ring radius', min: 0.1, step: 0.5 },
    { key: 'tube',     label: 'Tube radius', min: 0.1, step: 0.5 },
    { key: 'segments', label: 'Facets',      min: 3,   step: 1, advanced: true, integer: true },
  ],
  tube: [
    { key: 'outer',    label: 'Outer radius', min: 0.2, step: 0.5 },
    { key: 'inner',    label: 'Inner radius', min: 0.1, step: 0.5 },
    { key: 'height',   label: 'Height',       min: 0.1, step: 0.5 },
    { key: 'segments', label: 'Facets',       min: 3,   step: 1, advanced: true, integer: true },
  ],
  wedge: [
    { key: 'width',  label: 'Width (X)',  min: 0.1, step: 0.5 },
    { key: 'height', label: 'Height (Y)', min: 0.1, step: 0.5 },
    { key: 'depth',  label: 'Depth (Z)',  min: 0.1, step: 0.5 },
    ROUND_FIELD,
  ],
  prism: [
    { key: 'sides',  label: 'Sides',  min: 3,   step: 1, integer: true },
    { key: 'radius', label: 'Radius', min: 0.1, step: 0.5 },
    { key: 'height', label: 'Height', min: 0.1, step: 0.5 },
    ROUND_FIELD,
  ],
  loft: [
    { key: 'width',    label: 'Base width (X)',  min: 0.1, step: 0.5 },
    { key: 'depth',    label: 'Base depth (Z)',  min: 0.1, step: 0.5 },
    { key: 'topWidth', label: 'Top width (X)',   min: 0.1, step: 0.5 },
    { key: 'topDepth', label: 'Top depth (Z)',   min: 0.1, step: 0.5 },
    { key: 'height',   label: 'Height',          min: 0.1, step: 0.5 },
    ROUND_FIELD,
    { key: 'twist',    label: 'Twist (°)',       step: 5 },
  ],
  // Profile points are edited by drawing/dragging in the sketch tool, not as scalar
  // fields. The feature scalars (extrude depth, revolve angle) are dimension-editable.
  sketch: [
    { key: 'depth', label: 'Extrude (mm)', min: 0.1, step: 0.5 },
    { key: 'depth2', label: 'Down (mm)',   min: 0,   step: 0.5 },
    { key: 'start', label: 'Start offset', step: 0.5 },
    { key: 'draft', label: 'Draft (°)', min: -45, max: 45, step: 1 },
    { key: 'angle', label: 'Revolve (°)',  min: 1,   step: 5 },
    { key: 'segments', label: 'Facets',    min: 3,   step: 1, advanced: true, integer: true },
  ],
};

// ---- parametric sketch ------------------------------------------------------
//
// A sketch recipe can carry a full constrained sketch document in `params.sk`.
// When it does, `params.profile` stops being the source of truth and becomes a
// derived cache: solve the constraints, walk the closed loop, and write the
// resulting points back. Geometry building itself stays fast and pure, reading
// only the cached profile, so this runs on edit rather than on every frame.
//
// A sketch without `sk` is the older freehand kind and still works untouched.

/**
 * Re-solve a sketch recipe and refresh its cached profile, in place.
 * @returns {{ok:boolean, status:string, dof:number, closed:boolean, reason:string}}
 */
export function resolveSketch(params) {
  if (!params || !params.sk) {
    return { ok: true, status: 'none', dof: 0, closed: true, reason: 'freehand profile, no constraints' };
  }
  const report = solveSketch(params.sk);
  const prof = sketchProfile(params.sk, params.segments ?? TESS_SEGMENTS);
  // Only adopt a profile that actually closed. A half-drawn sketch keeps its
  // last good solid rather than collapsing to nothing under the user.
  if (prof.closed && prof.profile) params.profile = prof.profile;
  return {
    ok: report.ok && prof.closed,
    status: report.status,
    dof: report.dof,
    closed: prof.closed,
    reason: prof.closed ? report.reason : prof.reason,
  };
}

/** True when this recipe is a constraint-driven sketch rather than a freehand one. */
export function isParametricSketch(obj) {
  return obj?.kind === 'sketch' && !!obj.params?.sk;
}

// ---- extrude ----------------------------------------------------------------
//
// The extrude feature, in the shape people expect from a CAD package.
//
//   endType 'blind'      pull one way by `depth`, sitting on the sketch plane
//   endType 'symmetric'  centre `depth` on the sketch plane, half each way
//   endType 'twoSided'   pull `depth` up and `depth2` down, independently
//
// plus a `start` offset that lifts or sinks the whole extrusion off its plane.
// Blind starting at zero is the old behaviour exactly, so existing sketches are
// untouched.
//
// The profile is normalised first, which is what makes a self-crossing outline
// (and any hole it encloses) build a real solid instead of a torn one.

// ---- sketch planes ----------------------------------------------------------
//
// A sketch lives on a plane. Until now that plane was always the ground, so it
// never needed saying. Sketching on the face of an existing solid is the same
// sketch with a different frame, which is why the plane is stored on the recipe
// and applied as a single matrix rather than special-cased through the builder.
//
// The frame is: local +X runs along the plane's xdir, local +Z along its ydir,
// and local +Y along its normal, which is the direction the extrusion pulls.

export const GROUND_PLANE = { origin: [0, 0, 0], normal: [0, 1, 0], xdir: [1, 0, 0] };

/** True when a plane is the ground, so the transform can be skipped entirely. */
export function isGroundPlane(plane) {
  if (!plane) return true;
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const n = plane.normal || GROUND_PLANE.normal;
  const x = plane.xdir || GROUND_PLANE.xdir;
  const o = plane.origin || GROUND_PLANE.origin;
  return near(o[0], 0) && near(o[1], 0) && near(o[2], 0) &&
         near(n[0], 0) && near(n[1], 1) && near(n[2], 0) &&
         near(x[0], 1) && near(x[1], 0) && near(x[2], 0);
}

/**
 * Build a plane's frame from a normal and a point, choosing a stable xdir.
 * The chosen xdir is the world axis least parallel to the normal, so a face
 * that is nearly axis-aligned gets an axis-aligned sketch frame instead of an
 * arbitrarily rotated one.
 */
export function planeFromNormal(origin, normal) {
  const n = new THREE.Vector3().fromArray(normal).normalize();
  const candidates = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)];
  let best = candidates[0], bestDot = 1;
  for (const c of candidates) {
    const d = Math.abs(c.dot(n));
    if (d < bestDot) { bestDot = d; best = c; }
  }
  const xdir = best.clone().sub(n.clone().multiplyScalar(best.dot(n))).normalize();
  return { origin: [...origin], normal: n.toArray(), xdir: xdir.toArray() };
}

/** The matrix taking sketch-local space into the world, or null for the ground. */
export function planeMatrix(plane) {
  if (isGroundPlane(plane)) return null;
  const n = new THREE.Vector3().fromArray(plane.normal).normalize();
  let x = new THREE.Vector3().fromArray(plane.xdir || [1, 0, 0]);
  // Re-orthogonalise: a stored xdir can drift, and a skewed frame would shear
  // the solid rather than place it.
  x = x.sub(n.clone().multiplyScalar(x.dot(n)));
  if (x.lengthSq() < 1e-12) x = planeFromNormalAxis(n);
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, n);   // local +Z is the plane's ydir
  const o = new THREE.Vector3().fromArray(plane.origin || [0, 0, 0]);
  return new THREE.Matrix4().makeBasis(x, n, z).setPosition(o);
}

function planeFromNormalAxis(n) {
  const alt = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  return alt.sub(n.clone().multiplyScalar(alt.dot(n)));
}

/** Map a sketch-space point to world space on the sketch's plane. */
export function sketchToWorld(plane, u, v) {
  const M = planeMatrix(plane);
  const p = new THREE.Vector3(u, 0, v);
  return M ? p.applyMatrix4(M) : p;
}

/** Map a world point onto the sketch plane's 2D coordinates. */
export function worldToSketch(plane, point) {
  const M = planeMatrix(plane);
  if (!M) return { x: point.x, y: point.z };
  const inv = M.clone().invert();
  const p = point.clone().applyMatrix4(inv);
  return { x: p.x, y: p.z };
}

// The two scene-aware end types.
//
//   'through'  pull far enough to pass completely through everything in the way
//   'upTo'     pull until the first surface of another body, and stop there
//
// Both are questions about the rest of the model, and buildGeometry is pure by
// design: it turns one recipe into one geometry and never looks at the scene.
// So the scene answer is resolved BEFORE the build and cached on the recipe as
// `params.reach`, exactly the way `params.profile` is a cache of the solved
// sketch. resolveExtrudeReach in model.js writes it; this reads it.
//
// If the cache is missing (a recipe loaded from an older save, or a headless
// build with no scene) the fallback is a blind pull of `depth`. That is the
// conservative direction: a shape that is too short is visibly wrong and easy
// to fix, whereas silently defaulting to some huge number would punch a hole
// through the whole model the moment a file opened.
const REACH_MARGIN = 1; // mm past the far surface, so 'through' cuts cleanly

/** Describes what an extrude will do, for the UI, without building geometry. */
export function extrudeSpan(params) {
  const depth = Math.max(0.01, Number(params.depth) || 0.01);
  const start = Number(params.start) || 0;
  const end = params.endType || 'blind';
  if (end === 'symmetric') return { bottom: start - depth / 2, top: start + depth / 2 };
  if (end === 'twoSided') {
    const d2 = Math.max(0, Number(params.depth2) || 0);
    return { bottom: start - d2, top: start + depth };
  }
  if (end === 'through' || end === 'upTo') {
    const r = params.reach;
    const far = r && Number.isFinite(r.top) ? r.top : null;
    const near = r && Number.isFinite(r.bottom) ? r.bottom : null;
    if (far === null) return { bottom: start, top: start + depth, unresolved: true };
    if (end === 'upTo') return { bottom: start, top: far };
    // 'through' also reaches backwards when there is material behind the sketch,
    // which is what makes a through-cut on a mid-plane sketch behave the way a
    // through-cut should rather than only cutting the half in front of it.
    return { bottom: near === null ? start : Math.min(start, near), top: far };
  }
  return { bottom: start, top: start + depth };
}

/**
 * How far the extrude must travel to satisfy 'through' / 'upTo'.
 *
 * Works in the sketch's own frame, where the pull always runs along +Y, so the
 * plane's orientation is handled by the same matrix the builder already uses
 * instead of by separate axis maths.
 *
 * `others` are the world-space bounding boxes of every OTHER body in the scene.
 * Bounding boxes, not exact surfaces: 'upTo' therefore stops at the first body's
 * box rather than at its true silhouette. For a flat face, the common case, they
 * are the same. For a curved or angled face it stops slightly early, which errs
 * toward leaving material rather than cutting something that should have stayed.
 * Exact face picking is the B-rep kernel's job, not this one's.
 */
// The other bodies' boxes arrive in WORLD space, while the plane matrix maps the
// sketch frame to the sketch OBJECT's local space. Skipping the object's own
// world transform would give the right answer only while the sketch sat at the
// origin unrotated, and would quietly drift the moment it was moved. So compose
// both: world -> object local (worldInv) -> sketch frame (plane inverse).
function boxHeights(box, planeParam, worldInv) {
  const M = planeMatrix(planeParam);
  const planeInv = M ? M.clone().invert() : null;
  const out = [];
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    );
    if (worldInv) p.applyMatrix4(worldInv);
    if (planeInv) p.applyMatrix4(planeInv);
    out.push(p.y);                          // height along the pull direction
  }
  return out;
}

export function computeExtrudeReach(planeParam, others, opts = {}) {
  const start = Number(opts.start) || 0;
  let top = null, bottom = null;
  for (const box of others) {
    if (!box || box.isEmpty()) continue;
    // Every corner, not the centre: that is what keeps this correct when the
    // sketch plane is not axis-aligned with the body it has to pass through.
    for (const h of boxHeights(box, planeParam, opts.worldInv)) {
      if (h > start && (top === null || h > top)) top = h;
      if (h < start && (bottom === null || h < bottom)) bottom = h;
    }
  }
  if (top === null && bottom === null) return null;
  return {
    top: top === null ? start : top + REACH_MARGIN,
    bottom: bottom === null ? start : bottom - REACH_MARGIN,
  };
}

/** Nearest surface ahead of the sketch, for 'upTo'. Same frame, same caveats. */
export function computeExtrudeUpTo(planeParam, others, opts = {}) {
  const start = Number(opts.start) || 0;
  let nearest = null;
  for (const box of others) {
    if (!box || box.isEmpty()) continue;
    const hs = boxHeights(box, planeParam, opts.worldInv);
    const lo = Math.min(...hs);
    // Only bodies that actually sit ahead of the sketch can stop it. A body
    // straddling the sketch plane is already being cut into, so its near face is
    // behind us and stopping there would build nothing.
    if (lo > start && (nearest === null || lo < nearest)) nearest = lo;
  }
  return nearest === null ? null : { top: nearest, bottom: start };
}

// A tapered extrusion, built by hand because ExtrudeGeometry only makes straight
// walls. The top is the profile offset inward by rise * tan(draft), and because
// the offset preserves the vertex count, the side walls are a simple ribbon of
// quads between corresponding points.
function buildDraftedExtrude(regions, span, draftDeg) {
  const rise = span.top - span.bottom;
  const d = rise * Math.tan((draftDeg * Math.PI) / 180);

  const pairs = [];
  for (const region of regions) {
    const top = offsetRegion(region, d);
    // Refusing beats guessing. A taper this steep has no honest answer, and a
    // silently un-drafted or folded solid is worse than being told why.
    if (!top) return { geo: null, reason: `a ${draftDeg}° draft is too steep for this profile over ${Math.round(rise)}mm` };
    pairs.push({ bottom: region, top });
  }

  const positions = [];
  const indices = [];

  for (const { bottom, top } of pairs) {
    const bRings = [bottom.outer, ...bottom.holes];
    const tRings = [top.outer, ...top.holes];

    // One triangulation serves both caps: the rings correspond point for point.
    const contour = bottom.outer.map((p) => new THREE.Vector2(p[0], p[1]));
    const holes = bottom.holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
    const faces = THREE.ShapeUtils.triangulateShape(contour, holes);

    const flatB = bRings.flat();
    const flatT = tRings.flat();

    const bStart = positions.length / 3;
    for (const p of flatB) positions.push(p[0], span.bottom, p[1]);
    const tStart = positions.length / 3;
    for (const p of flatT) positions.push(p[0], span.top, p[1]);

    // Sketch (u, v) maps to world (x, z) with Y up, which flips handedness: a
    // counter-clockwise ring in sketch space is clockwise seen from above. So the
    // triangulator's winding has to be reversed here, or the whole solid ends up
    // inside out (caught by a signed-volume check, not by looking at it).
    // Sketch (u, v) maps to world (x, z) with Y up, which flips handedness: a
    // ring wound counter-clockwise in sketch space reads clockwise from above.
    // So the triangulator's native order already faces DOWN, which is what the
    // bottom cap wants, and the top cap takes the reverse. The side walls need
    // the opposite convention, which is why they look "backwards" below. Getting
    // these two groups consistent is what a signed-volume check catches and the
    // naked eye does not.
    for (const f of faces) {
      indices.push(bStart + f[0], bStart + f[1], bStart + f[2]);   // bottom, faces down
      indices.push(tStart + f[0], tStart + f[2], tStart + f[1]);   // top, faces up
    }

    let off = 0;
    for (let r = 0; r < bRings.length; r++) {
      const n = bRings[r].length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const b0 = bStart + off + i, b1 = bStart + off + j;
        const t0 = tStart + off + i, t1 = tStart + off + j;
        indices.push(b0, t1, b1);
        indices.push(b0, t0, t1);
      }
      off += n;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return { geo, reason: `drafted ${draftDeg}°` };
}

function buildExtrude(prof, params) {
  const { regions, repaired, reason } = normalizeProfile(prof);
  const span = extrudeSpan(params);
  const thickness = Math.max(0.01, span.top - span.bottom);

  if (!regions.length) {
    // Never hand back nothing: a zero-triangle mesh reads as "the app broke".
    // A tiny marker plus the reason on the recipe keeps the object selectable
    // and lets the inspector explain what is wrong with the outline.
    const g = new THREE.BoxGeometry(1, 1, 1);
    g.userData.profileError = reason;
    return g;
  }

  // Sketch (x, y) maps to world (x, z), so build the 2D shape as (x, -y) and
  // stand the extrusion up afterwards. Holes are inner paths on their shape.
  const shapes = regions.map((r) => {
    const s = new THREE.Shape();
    r.outer.forEach((p, i) => (i === 0 ? s.moveTo(p[0], -p[1]) : s.lineTo(p[0], -p[1])));
    s.closePath();
    for (const h of r.holes) {
      const path = new THREE.Path();
      h.forEach((p, i) => (i === 0 ? path.moveTo(p[0], -p[1]) : path.lineTo(p[0], -p[1])));
      path.closePath();
      s.holes.push(path);
    }
    return s;
  });

  const draft = Number(params.draft) || 0;
  let geo;
  let draftNote = null;
  if (draft !== 0) {
    const res = buildDraftedExtrude(regions, span, draft);
    if (res.geo) {
      geo = res.geo;                 // already in place, no rotate or translate
    } else {
      // Fall back to a straight wall and say why, rather than refusing to build.
      draftNote = res.reason;
    }
  }
  if (!geo) {
    geo = new THREE.ExtrudeGeometry(shapes, { depth: thickness, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);       // extrusion runs along Z → stand it up along Y
    geo.translate(0, span.bottom, 0);// then place the span relative to the sketch plane
  }

  // Everything above is built in the sketch's own frame, where the profile lies
  // flat and the pull runs up +Y. A sketch drawn on the face of another solid
  // simply carries a different frame, so one matrix at the end is the whole of
  // sketch-on-face as far as geometry is concerned.
  const M = planeMatrix(params.plane);
  if (M) geo.applyMatrix4(M);

  geo.userData.repaired = repaired;
  geo.userData.profileReason = reason;
  geo.userData.regions = regions.length;
  geo.userData.draftRefused = draftNote;
  return geo;
}

// ---- rounding helpers -------------------------------------------------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Points along a circular arc, inclusive of both ends.
function arcPts(cx, cy, r, a0, a1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    out.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return out;
}

// A revolved solid (base at y=0) from a profile whose outer corners are rounded
// by r. `topRadius` lets us reuse this for both cylinder (==radius) and a cone-
// style straight taper to the apex (topRadius=0, no top round).
function latheRounded({ radius, height, round, segments, taperToApex }) {
  const r = clamp(round, 0, Math.min(radius - 0.05, height / 2 - 0.05));
  const n = 5;
  const pts = [new THREE.Vector2(0, 0), new THREE.Vector2(radius - r, 0)];
  arcPts(radius - r, r, r, -Math.PI / 2, 0, n).forEach((p) => pts.push(p));   // bottom-outer fillet
  if (taperToApex) {
    pts.push(new THREE.Vector2(0, height));                                   // straight slope to tip
  } else {
    pts.push(new THREE.Vector2(radius, height - r));
    arcPts(radius - r, height - r, r, 0, Math.PI / 2, n).forEach((p) => pts.push(p)); // top-outer fillet
    pts.push(new THREE.Vector2(0, height));
  }
  return new THREE.LatheGeometry(pts, segments);
}

// A closed Shape from polygon verts with each corner rounded by r — keeps the
// footprint (rounding insets corners, edges stay put), so dimensions hold. Used
// for the rounded prism and rounded wedge. Rounds the edges that run along the
// extrusion (e.g. a prism's vertical edges); reliable ExtrudeGeometry normals.
function roundedShapeFromVerts(verts, round) {
  let minEdge = Infinity;
  for (let i = 0; i < verts.length; i++) minEdge = Math.min(minEdge, verts[i].distanceTo(verts[(i + 1) % verts.length]));
  const r = clamp(round, 0, minEdge / 2 - 0.02);
  const n = verts.length;
  const s = new THREE.Shape();
  for (let i = 0; i < n; i++) {
    const cur = verts[i];
    const toPrev = verts[(i - 1 + n) % n].clone().sub(cur).normalize();
    const toNext = verts[(i + 1) % n].clone().sub(cur).normalize();
    const p1 = cur.clone().addScaledVector(toPrev, r);
    const p2 = cur.clone().addScaledVector(toNext, r);
    if (i === 0) s.moveTo(p1.x, p1.y);
    else s.lineTo(p1.x, p1.y);
    s.quadraticCurveTo(cur.x, cur.y, p2.x, p2.y);
  }
  s.closePath();
  return s;
}

function regularPolygonVerts(sides, radius) {
  const verts = [];
  for (let i = 0; i < sides; i++) {
    const a = Math.PI / 2 + (i * 2 * Math.PI) / sides;
    verts.push(new THREE.Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
  }
  return verts;
}

// A centered rounded-rectangle Shape (used as loft cross-sections). round=0 → rect.
function roundedRectShape(w, d, round) {
  const r = clamp(round, 0, Math.min(w, d) / 2 - 0.01);
  const x = -w / 2, z = -d / 2;
  const s = new THREE.Shape();
  s.moveTo(x + r, z);
  s.lineTo(x + w - r, z);
  s.quadraticCurveTo(x + w, z, x + w, z + r);
  s.lineTo(x + w, z + d - r);
  s.quadraticCurveTo(x + w, z + d, x + w - r, z + d);
  s.lineTo(x + r, z + d);
  s.quadraticCurveTo(x, z + d, x, z + d - r);
  s.lineTo(x, z + r);
  s.quadraticCurveTo(x, z, x + r, z);
  return s;
}

// Loft: a solid skinned between a bottom and a top rounded-rectangle profile over
// a height, with optional twist. Linear blend of corresponding perimeter points
// (so a square base can taper/twist into a smaller square top, etc.). Built as a
// watertight indexed mesh — rings of N points at K+1 layers + a centroid cap at
// each end. Winding chosen so Manifold reads a positive solid (validated headless).
function buildLoft(params) {
  const N = 80;                                       // perimeter samples per ring
  const H = params.height;
  const round = params.round || 0;
  const twist = (params.twist || 0) * Math.PI / 180;
  const K = Math.max(1, Math.min(96, Math.round(Math.abs(params.twist || 0) / 4))); // smooth twist

  const sample = (shape) => shape.getSpacedPoints(N).slice(0, N);
  const base = sample(roundedRectShape(params.width, params.depth, round));
  const top  = sample(roundedRectShape(params.topWidth, params.topDepth, round));

  const verts = [];
  for (let j = 0; j <= K; j++) {
    const t = j / K, ang = twist * t, ca = Math.cos(ang), sa = Math.sin(ang), y = H * t;
    for (let i = 0; i < N; i++) {
      const px = base[i].x + (top[i].x - base[i].x) * t;
      const pz = base[i].y + (top[i].y - base[i].y) * t;   // Shape's Y maps to world Z
      verts.push(px * ca - pz * sa, y, px * sa + pz * ca);
    }
  }
  const cb = verts.length / 3; verts.push(0, 0, 0);   // bottom centroid
  const ct = verts.length / 3; verts.push(0, H, 0);   // top centroid

  const idx = [];
  for (let j = 0; j < K; j++) {                       // side walls
    for (let i = 0; i < N; i++) {
      const i2 = (i + 1) % N;
      const a = j * N + i, b = j * N + i2, c = (j + 1) * N + i2, dPt = (j + 1) * N + i;
      idx.push(a, dPt, b, b, dPt, c);                 // outward winding (validated)
    }
  }
  for (let i = 0; i < N; i++) idx.push(cb, i, (i + 1) % N);                 // bottom cap (faces -Y)
  const tb = K * N;
  for (let i = 0; i < N; i++) idx.push(ct, tb + (i + 1) % N, tb + i);       // top cap (faces +Y)

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function buildGeometry(kind, params) {
  let geo;
  // Back-compat: the old standalone "Rounded Box" is now Box + a `round` param.
  // Older saved projects still load — map them so nothing breaks.
  if (kind === 'roundedbox') {
    kind = 'box';
    params = { ...params, round: params.round ?? params.radius ?? 0 };
  }
  const round = params.round || 0;
  switch (kind) {
    case 'box': {
      if (round > 0.001) {
        const r = clamp(round, 0, Math.min(params.width, params.height, params.depth) / 2 - 0.01);
        geo = new RoundedBoxGeometry(params.width, params.height, params.depth, 4, r);
      } else {
        geo = new THREE.BoxGeometry(params.width, params.height, params.depth);
      }
      geo.translate(0, params.height / 2, 0);
      break;
    }
    case 'cylinder':
      if (round > 0.001) {
        geo = latheRounded({ radius: params.radius, height: params.height, round, segments: params.segments });
      } else {
        geo = new THREE.CylinderGeometry(params.radius, params.radius, params.height, params.segments);
        geo.translate(0, params.height / 2, 0);
      }
      break;
    case 'sphere':
      geo = new THREE.SphereGeometry(params.radius, params.segments, Math.max(3, Math.round(params.segments / 2)));
      geo.translate(0, params.radius, 0);
      break;
    case 'cone':
      if (round > 0.001) {
        geo = latheRounded({ radius: params.radius, height: params.height, round, segments: params.segments, taperToApex: true });
      } else {
        geo = new THREE.ConeGeometry(params.radius, params.height, params.segments);
        geo.translate(0, params.height / 2, 0);
      }
      break;
    case 'torus': {
      const seg = params.segments;
      geo = new THREE.TorusGeometry(params.radius, params.tube, Math.max(8, Math.round(seg / 2)), seg);
      geo.rotateX(Math.PI / 2);            // lay the donut flat (hole points up)
      geo.translate(0, params.tube, 0);
      break;
    }
    case 'tube': {
      // Hollow pipe: outer circle with an inner circular hole, extruded upward.
      const outer = params.outer;
      const inner = Math.min(params.inner, outer - 0.1);
      const shape = new THREE.Shape();
      shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
      shape.holes.push(hole);
      geo = new THREE.ExtrudeGeometry(shape, { depth: params.height, bevelEnabled: false, curveSegments: params.segments });
      geo.rotateX(-Math.PI / 2);           // extrude runs along Z → stand it up along Y (base at 0)
      break;
    }
    case 'wedge': {
      // Right-triangular prism (a ramp): triangle in XY, extruded along depth.
      const tri = [new THREE.Vector2(0, 0), new THREE.Vector2(params.width, 0), new THREE.Vector2(0, params.height)];
      const shape = round > 0.001
        ? roundedShapeFromVerts(tri, round)        // rounds the edges running along depth
        : (() => { const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(params.width, 0); s.lineTo(0, params.height); s.lineTo(0, 0); return s; })();
      geo = new THREE.ExtrudeGeometry(shape, { depth: params.depth, bevelEnabled: false });
      geo.translate(-params.width / 2, 0, -params.depth / 2);  // center on X/Z, base at y=0
      break;
    }
    case 'prism':
      // Regular n-sided prism = a low-segment cylinder (exact flat faces).
      if (round > 0.001) {
        const shape = roundedShapeFromVerts(regularPolygonVerts(Math.max(3, Math.round(params.sides)), params.radius), round);
        geo = new THREE.ExtrudeGeometry(shape, { depth: params.height, bevelEnabled: false, curveSegments: 4 });
        geo.rotateX(-Math.PI / 2);          // stand up: base at y=0
      } else {
        geo = new THREE.CylinderGeometry(params.radius, params.radius, params.height, Math.max(3, Math.round(params.sides)));
        geo.translate(0, params.height / 2, 0);
      }
      break;
    case 'loft':
      geo = buildLoft(params);
      break;
    case 'sketch': {
      const prof = (params.profile && params.profile.length >= 3) ? params.profile : DEFAULT_PARAMS.sketch.profile;
      if (params.op === 'revolve') {
        // Spin the profile around the Y axis. Treat each point's x as a radius
        // (clamped ≥0 so it can't cross the axis) and y as height.
        const pts = prof.map((p) => new THREE.Vector2(Math.max(0, p[0]), p[1]));
        const ang = clamp((params.angle ?? 360), 1, 360) * Math.PI / 180;
        geo = new THREE.LatheGeometry(pts, Math.max(3, params.segments ?? 48), 0, ang);
        geo.computeBoundingBox();             // rest the result on the y=0 build plate
        geo.translate(0, -geo.boundingBox.min.y, 0);
      } else {
        geo = buildExtrude(prof, params);
      }
      break;
    }
    default:
      throw new Error(`Unknown primitive kind: ${kind}`);
  }
  return geo;
}
export { suggestedDepth, normalizeProfile } from './profile.js';
