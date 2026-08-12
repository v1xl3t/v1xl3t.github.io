// dimchips.js — in-canvas dimension editing (Phase 2 of the parametric push).
//
// Floating, editable dimension chips that sit on the selected part right in the
// 3D view. Click a chip, type a value, the geometry obeys — no hunting through a
// panel. Direct manipulation married to exact precision; the chips track the
// object as the camera orbits. Each edit is a real history step, so it lands on
// the Recipe Timeline too.

import { PARAM_SCHEMA } from './primitives.js';
import * as THREE from 'three';

const ABBR = {
  'Width (X)': 'W', 'Height (Y)': 'H', 'Depth (Z)': 'D', 'Height': 'H',
  'Radius': 'R', 'Base radius': 'R', 'Ring radius': 'Rᵣ', 'Tube radius': 't',
  'Outer radius': 'Rₒ', 'Inner radius': 'Rᵢ', 'Round (mm)': '⌒',
  'Sides': 'n', 'Top width (X)': 'Wₜ', 'Top depth (Z)': 'Dₜ',
  'Base width (X)': 'W', 'Base depth (Z)': 'D', 'Twist (°)': '∡',
  // A sketch feature carries five of these at once and the initials collide:
  // "Down" and "Draft" both abbreviate to D, so the row read "E 6 · D 0 · SO 0 ·
  // D 0 · R 360" and two different numbers wore the same name. Spelled out far
  // enough to tell apart, still short enough to be a chip.
  'Extrude (mm)': 'Up', 'Down (mm)': 'Dn', 'Start offset': 'Off',
  'Draft (°)': 'Draft', 'Revolve (°)': 'Rev',
};
const abbrev = (l) => ABBR[l] || l.replace(/\s*\(.*\)/, '').split(' ').map((w) => w[0]).join('').toUpperCase();
const fmt = (n) => Number(n.toFixed(3)).toString();

// Which axis of mesh.scale stretches each recipe number.
//
// The chips used to print obj.params straight out, and the gizmo never touches
// params — it only writes mesh.scale. So the moment you scaled a part with the
// scale tool the chips froze at the size the part used to be, which is what Vi
// hit. Multiplying by the scale on the axis a number actually governs makes the
// chip report the size the object IS, whichever route changed it.
//
// Only genuine lengths are listed. Facet counts, side counts, twist and draft
// angles are not lengths and are shown raw. Corner rounding is left out on
// purpose too: under a non-uniform scale a fillet is no longer one radius, so
// any single number we printed would be a lie.
const SCALE_AXIS = {
  box:      { width: 'x', height: 'y', depth: 'z' },
  cylinder: { radius: 'x', height: 'y' },
  sphere:   { radius: 'x' },
  cone:     { radius: 'x', height: 'y' },
  torus:    { radius: 'x', tube: 'y' },      // the donut is laid flat, hole up
  tube:     { outer: 'x', inner: 'x', height: 'y' },
  wedge:    { width: 'x', height: 'y', depth: 'z' },
  prism:    { radius: 'x', height: 'y' },
  loft:     { width: 'x', depth: 'z', topWidth: 'x', topDepth: 'z', height: 'y' },
  sketch:   { depth: 'y', depth2: 'y', start: 'y' },   // the extrusion runs up Y
};

// How much a given recipe number has been stretched by the scale tool. Always
// a positive factor: a mirrored object is still that many millimetres across.
export function scaleFactor(obj, key) {
  const axis = SCALE_AXIS[obj?.kind]?.[key];
  if (!axis || !obj.mesh) return 1;
  const s = Math.abs(obj.mesh.scale[axis]);
  return s > 1e-9 ? s : 1;
}

export class DimChips {
  constructor(doc, { camera, renderer, onEdit } = {}) {
    this.doc = doc;
    this.camera = camera;
    this.renderer = renderer;
    this.onEdit = onEdit || (() => {});
    this.layer = document.getElementById('dimchips');
    this.obj = null;
    this.chips = [];
    this.enabled = true;

    doc.addEventListener('select', () => this.rebuild());
    doc.addEventListener('regroup', () => this.rebuild());
    doc.addEventListener('undo', () => this.rebuild());
    doc.addEventListener('change', (e) => { if (e.detail === this.obj) this.syncValues(); });
    this.rebuild();
  }

  setEnabled(on) { this.enabled = on; this.rebuild(); }

  rebuild() {
    this.layer.innerHTML = '';
    this.chips = [];
    const obj = this.doc.selected;
    this.obj = obj;
    // Only primitives carry editable dimensions; a baked group has none.
    if (!this.enabled || !obj || obj.kind === 'boolean') { this.layer.style.display = 'none'; return; }
    const schema = (PARAM_SCHEMA[obj.kind] || []).filter((f) => !f.advanced);
    if (!schema.length) { this.layer.style.display = 'none'; return; }
    this.layer.style.display = '';
    for (const f of schema) {
      const chip = document.createElement('div');
      chip.className = 'dimchip';
      chip.dataset.key = f.key;
      chip.innerHTML = `<span class="dc-k">${abbrev(f.label)}</span><span class="dc-v">${fmt(this.worldValue(f.key))}</span>`;
      chip.title = `${f.label}, click to edit`;
      chip.addEventListener('pointerdown', (e) => e.stopPropagation());   // don't deselect/pick
      chip.addEventListener('click', () => this.editChip(chip, f));
      this.layer.appendChild(chip);
      this.chips.push({ el: chip, field: f });
    }
    this.update();
  }

  // What this number measures in the world right now: the recipe value with the
  // scale tool's stretch folded in.
  worldValue(key) { return this.obj.params[key] * scaleFactor(this.obj, key); }

  editChip(chip, f) {
    if (chip.querySelector('input')) return;
    const cur = this.worldValue(f.key);
    chip.innerHTML = `<span class="dc-k">${abbrev(f.label)}</span>`
      + `<input class="dc-in" type="number" step="${f.step ?? 0.5}" ${f.min != null ? `min="${f.min}"` : ''} value="${fmt(cur)}"/>`;
    const inp = chip.querySelector('input');
    inp.focus(); inp.select();
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') inp.blur();
      else if (e.key === 'Escape') this.rebuild();
      e.stopPropagation();                      // don't trigger app shortcuts while typing
    });
    inp.addEventListener('blur', () => {
      const v = parseFloat(inp.value);
      // You typed the size you want the part to BE, so divide the stretch back
      // out before it goes into the recipe. Type 20 into a chip on a part the
      // scale tool doubled and the part measures 20, not 40.
      if (!Number.isNaN(v) && this.obj) {
        const raw = v / scaleFactor(this.obj, f.key);
        this.onEdit(this.obj, f.key, f.integer ? Math.round(raw) : raw);
      }
      this.rebuild();
    });
  }

  // Cheap value refresh (e.g. while the gizmo drags) without rebuilding chips.
  syncValues() {
    if (!this.obj) return;
    for (const c of this.chips) {
      if (c.el.querySelector('input')) continue;
      const v = c.el.querySelector('.dc-v');
      if (v) v.textContent = fmt(this.worldValue(c.field.key));
    }
  }

  // Called every frame: park the chip cluster just above the object's top-centre
  // in screen space, so it rides along as the camera moves.
  update() {
    if (!this.enabled || !this.obj || !this.chips.length) return;
    const mesh = this.obj.mesh;
    mesh.updateWorldMatrix(true, false);
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) { this.layer.style.display = 'none'; return; }
    const center = box.getCenter(new THREE.Vector3());
    const anchor = new THREE.Vector3(center.x, box.max.y, center.z).project(this.camera);
    if (anchor.z > 1) { this.layer.style.display = 'none'; return; }   // behind camera
    this.layer.style.display = '';
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = (anchor.x * 0.5 + 0.5) * r.width + r.left;
    const y = (-anchor.y * 0.5 + 0.5) * r.height + r.top;
    this.layer.style.left = `${x}px`;
    this.layer.style.top = `${y - 14}px`;
  }
}
