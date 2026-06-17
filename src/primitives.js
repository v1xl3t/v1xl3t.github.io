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
};

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
    default:
      throw new Error(`Unknown primitive kind: ${kind}`);
  }
  return geo;
}
