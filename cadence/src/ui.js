// ui.js — the Inspector. The "OnShape-precise" half: every property of the
// selected object is an exact, typed numeric field. The gizmo (in main.js) is
// the "TinkerCAD-easy" half. Both edit the same model, so you can drag roughly
// then dial in an exact value — the workflow swap Vi is after, in miniature.

import { PARAM_SCHEMA, ROLE_LABELS } from './primitives.js';
import { unitScale, unitLabel } from './settings.js';
import * as THREE from 'three';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;
const round = (n, p = 3) => Number(n.toFixed(p));
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Inspector {
  constructor(doc, { onChange, units } = {}) {
    this.doc = doc;
    this.onChange = onChange || (() => {});
    // Getter for the active display unit id (mm/cm/inch); modeling stays in mm.
    this.units = units || (() => 'mm');
    this.empty = document.getElementById('inspector-empty');
    this.body = document.getElementById('inspector-body');

    doc.addEventListener('select', () => this.render());
    doc.addEventListener('change', (e) => this.refreshValues(e.detail));
    doc.addEventListener('undo', () => this.render());
    this.render();
  }

  render() {
    const obj = this.doc.selected;
    if (!obj) {
      this.empty.hidden = false;
      this.body.hidden = true;
      this.body.innerHTML = '';
      return;
    }
    this.empty.hidden = true;
    this.body.hidden = false;

    const isBool = obj.kind === 'boolean';
    const schema = PARAM_SCHEMA[obj.kind] || [];
    const dimFields = schema
      .filter((f) => !f.advanced)
      .map((f) => this._numRow(`dim:${f.key}`, f.label, obj.params[f.key], f.step, f.min))
      .join('');

    const meta = isBool
      ? `Type: <b>group</b> · <b>${obj.children?.length ?? 0}</b> parts baked · id <b>${obj.id}</b>`
      : `Type: <b>${obj.kind}</b> · id <b>${obj.id}</b>`;

    const roleRow = `
      <div class="field">
        <label>Role</label>
        <div class="seg">
          <button type="button" data-role="solid" class="${obj.role !== 'hole' ? 'on' : ''}">${ROLE_LABELS.solid}</button>
          <button type="button" data-role="hole" class="${obj.role === 'hole' ? 'on' : ''}">${ROLE_LABELS.hole}</button>
        </div>
      </div>`;

    // For a baked group, expose its parts as live, editable recipes — changing a
    // part re-runs the boolean (parametric propagation), no ungroup needed.
    const partsRow = isBool && obj.children?.length ? `
      <div class="field">
        <label>Parts <span class="hint">(live · edits re-bake the group)</span></label>
        ${obj.children.map((c, i) => {
          const sch = (PARAM_SCHEMA[c.kind] || []).filter((f) => !f.advanced);
          const fields = sch.map((f) => `
            <div class="axis">
              <span>${f.label}</span>
              <input type="number" data-part="${i}" data-pkey="${f.key}" value="${round(c.params[f.key])}"
                     step="${f.step ?? 0.5}" ${f.min != null ? `min="${f.min}"` : ''} />
            </div>`).join('');
          return `<div class="part">
            <div class="part-nm">${esc(c.name || cap(c.kind))}${c.role === 'hole' ? ' <span class="muted">· cut</span>' : ''}</div>
            ${fields || '<div class="muted">nested group</div>'}
          </div>`;
        }).join('')}
      </div>` : '';

    // A sketch's feature operation: pull the profile straight up (extrude) or spin
    // it around the Y axis (revolve).
    const opRow = obj.kind === 'sketch' ? `
      <div class="field">
        <label>Feature</label>
        <div class="seg">
          <button type="button" data-op="extrude" class="${obj.params.op !== 'revolve' ? 'on' : ''}">Extrude</button>
          <button type="button" data-op="revolve" class="${obj.params.op === 'revolve' ? 'on' : ''}">Revolve</button>
        </div>
      </div>` : '';

    const dimRow = dimFields ? `
      <div class="field">
        <label>Dimensions (mm)</label>
        ${dimFields}
      </div>` : (partsRow || `<div class="meta">A group's shape comes from its parts — <b>Ungroup</b> to edit them, then regroup.</div>`);

    this.body.innerHTML = `
      <div class="meta">${meta}</div>
      <div class="meta" id="bbox-readout">${this._bboxText(obj)}</div>

      <div class="field">
        <label>Name</label>
        <input type="text" data-bind="name" value="${obj.name}" />
      </div>

      ${roleRow}
      ${opRow}
      ${dimRow}

      ${this._vecRow('position', 'Position (mm)', obj.mesh.position, 0.5)}
      ${this._vecRow('rotation', 'Rotation (deg)', this._rotDeg(obj), 1)}
      ${this._vecRow('scale', 'Scale (×)', obj.mesh.scale, 0.05)}

      <div class="field">
        <label>Color</label>
        <div class="swatch-row">
          <input type="color" data-bind="color" value="${obj.color}" />
          <span class="muted">${obj.color}</span>
        </div>
      </div>
    `;

    this._wire(obj);
  }

  _numRow(bind, label, value, step, min) {
    return `
      <div class="axis">
        <span>${label}</span>
        <input type="number" data-bind="${bind}" value="${round(value)}"
               step="${step ?? 0.5}" ${min != null ? `min="${min}"` : ''} />
      </div>`;
  }

  _vecRow(name, label, vec, step) {
    const axis = (a) => `
      <div class="axis ${a}">
        <span>${a.toUpperCase()}</span>
        <input type="number" data-bind="${name}:${a}" value="${round(vec[a])}" step="${step}" />
      </div>`;
    return `
      <div class="field">
        <label>${label}</label>
        <div class="vec">${axis('x')}${axis('y')}${axis('z')}</div>
      </div>`;
  }

  _rotDeg(obj) {
    const e = obj.mesh.rotation;
    return { x: e.x * RAD2DEG, y: e.y * RAD2DEG, z: e.z * RAD2DEG };
  }

  // Overall world-space size of the object — the real footprint, after scale
  // and rotation. Read-only; handy for fitting parts to a print bed.
  _bboxText(obj) {
    obj.mesh.updateWorldMatrix(true, false);
    const s = new THREE.Box3().setFromObject(obj.mesh).getSize(new THREE.Vector3());
    const u = this.units();
    const k = unitScale(u);
    return `Size: <b>${round(s.x * k)} × ${round(s.y * k)} × ${round(s.z * k)}</b> ${unitLabel(u)}`;
  }

  _wire(obj) {
    this.body.querySelectorAll('input[data-bind]').forEach((input) => {
      const evt = input.type === 'color' || input.type === 'text' ? 'input' : 'change';
      input.addEventListener(evt, () => this._apply(obj, input));
    });
    this.body.querySelectorAll('button[data-role]').forEach((btn) => {
      btn.addEventListener('click', () => {
        obj.setRole(btn.dataset.role);
        this.doc.touch(obj);
        this.onChange(obj);
        this.render();           // reflect color + active state
      });
    });
    // Sketch feature toggle (extrude / revolve).
    this.body.querySelectorAll('button[data-op]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (obj.params.op === btn.dataset.op) return;
        this.doc.commit('Sketch: ' + btn.dataset.op);
        obj.params.op = btn.dataset.op;
        obj.rebuild();
        this.doc.touch(obj);
        this.render();
      });
    });
    // Group part edits re-bake the boolean (parametric propagation).
    this.body.querySelectorAll('input[data-part]').forEach((input) => {
      input.addEventListener('change', async () => {
        const v = parseFloat(input.value);
        if (Number.isNaN(v)) return;
        input.disabled = true;
        try { await this.doc.rebakeGroupChild(obj.id, +input.dataset.part, input.dataset.pkey, v); }
        catch (e) { console.error('[CADence] part re-bake failed:', e); input.disabled = false; }
      });
    });
  }

  _apply(obj, input) {
    const bind = input.dataset.bind;
    const num = parseFloat(input.value);

    if (bind === 'name') { obj.name = input.value; }
    else if (bind === 'color') { obj.setColor(input.value); input.nextElementSibling.textContent = input.value; }
    else if (bind.startsWith('dim:')) {
      if (Number.isNaN(num)) return;
      obj.params[bind.slice(4)] = num;
      obj.rebuild();
    }
    else if (bind.startsWith('position:')) { obj.mesh.position[bind.split(':')[1]] = num || 0; }
    else if (bind.startsWith('scale:'))    { obj.mesh.scale[bind.split(':')[1]] = num || 0.0001; }
    else if (bind.startsWith('rotation:')) { obj.mesh.rotation[bind.split(':')[1]] = (num || 0) * DEG2RAD; }

    this.doc.touch(obj);
    this.onChange(obj);
  }

  // Update field values without rebuilding DOM — used while the gizmo drags.
  refreshValues(obj) {
    if (!obj || obj !== this.doc.selected) return;
    const bbox = this.body.querySelector('#bbox-readout');
    if (bbox) bbox.innerHTML = this._bboxText(obj);
    const set = (sel, v) => { const el = this.body.querySelector(sel); if (el && document.activeElement !== el) el.value = round(v); };
    for (const a of ['x', 'y', 'z']) {
      set(`[data-bind="position:${a}"]`, obj.mesh.position[a]);
      set(`[data-bind="scale:${a}"]`, obj.mesh.scale[a]);
      set(`[data-bind="rotation:${a}"]`, obj.mesh.rotation[a] * RAD2DEG);
    }
    // Keep dimension fields in step with edits made via the in-canvas chips.
    for (const key of Object.keys(obj.params || {})) set(`[data-bind="dim:${key}"]`, obj.params[key]);
  }
}
