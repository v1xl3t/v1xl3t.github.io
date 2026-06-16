// primitives.js — the parametric primitive library.
//
// Each entry maps a recipe (kind + params, in millimetres) to a Three.js
// BufferGeometry. Params are the *precise* definition; geometry is derived.
// Keeping this table-driven is deliberate — adding a primitive later (cone,
// torus, wedge) is one entry here, and the rest of the app picks it up for
// free (toolbar, inspector fields, export).

import * as THREE from 'three';

// Display labels for the two roles. Internal role values stay 'solid'/'hole'
// forever (stable), but what the UI *calls* them lives here — so renaming is a
// one-line change. Additive vs subtractive / mass vs negative space.
export const ROLE_LABELS = { solid: 'Add', hole: 'Cut' };

// Default dimensions (mm) for each primitive.
export const DEFAULT_PARAMS = {
  box:      { width: 20, height: 20, depth: 20 },
  cylinder: { radius: 10, height: 20, segments: 48 },
  sphere:   { radius: 10, segments: 32 },
  cone:     { radius: 10, height: 20, segments: 48 },
  torus:    { radius: 12, tube: 4, segments: 48 },
  tube:     { outer: 10, inner: 6, height: 20, segments: 48 },
  wedge:    { width: 20, height: 20, depth: 20 },
  prism:    { sides: 6, radius: 10, height: 20 },
  roundedbox: { width: 20, height: 20, depth: 20, radius: 4 },
};

// Which params are user-editable dimensions, with display metadata for the
// inspector. (segments is structural, edited under an "Advanced" group.)
export const PARAM_SCHEMA = {
  box: [
    { key: 'width',  label: 'Width (X)',  min: 0.1, step: 0.5 },
    { key: 'height', label: 'Height (Y)', min: 0.1, step: 0.5 },
    { key: 'depth',  label: 'Depth (Z)',  min: 0.1, step: 0.5 },
  ],
  cylinder: [
    { key: 'radius', label: 'Radius',   min: 0.1, step: 0.5 },
    { key: 'height', label: 'Height',   min: 0.1, step: 0.5 },
    { key: 'segments', label: 'Facets', min: 3,   step: 1, advanced: true, integer: true },
  ],
  sphere: [
    { key: 'radius',   label: 'Radius', min: 0.1, step: 0.5 },
    { key: 'segments', label: 'Facets', min: 3,   step: 1, advanced: true, integer: true },
  ],
  cone: [
    { key: 'radius',   label: 'Base radius', min: 0.1, step: 0.5 },
    { key: 'height',   label: 'Height',      min: 0.1, step: 0.5 },
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
  ],
  prism: [
    { key: 'sides',  label: 'Sides',  min: 3,   step: 1, integer: true },
    { key: 'radius', label: 'Radius', min: 0.1, step: 0.5 },
    { key: 'height', label: 'Height', min: 0.1, step: 0.5 },
  ],
  roundedbox: [
    { key: 'width',  label: 'Width (X)',     min: 0.1, step: 0.5 },
    { key: 'height', label: 'Height (Y)',    min: 0.1, step: 0.5 },
    { key: 'depth',  label: 'Depth (Z)',     min: 0.1, step: 0.5 },
    { key: 'radius', label: 'Corner radius', min: 0.1, step: 0.5 },
  ],
};

export function buildGeometry(kind, params) {
  let geo;
  switch (kind) {
    case 'box':
      geo = new THREE.BoxGeometry(params.width, params.height, params.depth);
      geo.translate(0, params.height / 2, 0);
      break;
    case 'cylinder':
      geo = new THREE.CylinderGeometry(params.radius, params.radius, params.height, params.segments);
      geo.translate(0, params.height / 2, 0);
      break;
    case 'sphere':
      geo = new THREE.SphereGeometry(params.radius, params.segments, Math.max(3, Math.round(params.segments / 2)));
      geo.translate(0, params.radius, 0);
      break;
    case 'cone':
      geo = new THREE.ConeGeometry(params.radius, params.height, params.segments);
      geo.translate(0, params.height / 2, 0);
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
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(params.width, 0);
      shape.lineTo(0, params.height);
      shape.lineTo(0, 0);
      geo = new THREE.ExtrudeGeometry(shape, { depth: params.depth, bevelEnabled: false });
      geo.translate(-params.width / 2, 0, -params.depth / 2);  // center on X/Z, base at y=0
      break;
    }
    case 'prism':
      // Regular n-sided prism = a low-segment cylinder (exact flat faces).
      geo = new THREE.CylinderGeometry(params.radius, params.radius, params.height, Math.max(3, Math.round(params.sides)));
      geo.translate(0, params.height / 2, 0);
      break;
    case 'roundedbox': {
      // Box with rounded vertical edges: a rounded rectangle extruded up.
      const w = params.width, d = params.depth;
      const r = Math.min(params.radius, Math.min(w, d) / 2 - 0.01);
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
      geo = new THREE.ExtrudeGeometry(s, { depth: params.height, bevelEnabled: false, curveSegments: 6 });
      geo.rotateX(-Math.PI / 2);   // stand up: base at y=0, rounded edges vertical
      break;
    }
    default:
      throw new Error(`Unknown primitive kind: ${kind}`);
  }
  return geo;
}
