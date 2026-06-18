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
};
const abbrev = (l) => ABBR[l] || l.replace(/\s*\(.*\)/, '').split(' ').map((w) => w[0]).join('').toUpperCase();
const fmt = (n) => Number(n.toFixed(3)).toString();

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
      chip.innerHTML = `<span class="dc-k">${abbrev(f.label)}</span><span class="dc-v">${fmt(obj.params[f.key])}</span>`;
      chip.title = `${f.label} — click to edit`;
      chip.addEventListener('pointerdown', (e) => e.stopPropagation());   // don't deselect/pick
      chip.addEventListener('click', () => this.editChip(chip, f));
      this.layer.appendChild(chip);
      this.chips.push({ el: chip, field: f });
    }
    this.update();
  }

  editChip(chip, f) {
    if (chip.querySelector('input')) return;
    const cur = this.obj.params[f.key];
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
      if (!Number.isNaN(v) && this.obj) this.onEdit(this.obj, f.key, f.integer ? Math.round(v) : v);
      this.rebuild();
    });
  }

  // Cheap value refresh (e.g. while the gizmo drags) without rebuilding chips.
  syncValues() {
    if (!this.obj) return;
    for (const c of this.chips) {
      if (c.el.querySelector('input')) continue;
      const v = c.el.querySelector('.dc-v');
      if (v) v.textContent = fmt(this.obj.params[c.field.key]);
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
