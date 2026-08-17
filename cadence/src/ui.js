// ui.js — the Inspector. The "OnShape-precise" half: every property of the
// selected object is an exact, typed numeric field. The gizmo (in main.js) is
// the "TinkerCAD-easy" half. Both edit the same model, so you can drag roughly
// then dial in an exact value — the workflow swap Vi is after, in miniature.

import { PARAM_SCHEMA, ROLE_LABELS, resolveSketch, extrudeSpan, PATTERN_FIELDS, patternTransforms } from './primitives.js';
import { dimensionList, constraintLabel, isDimension } from './sketch.js';
import { unitScale, unitLabel } from './settings.js';
import * as THREE from 'three';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;
const round = (n, p = 3) => Number(n.toFixed(p));
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Inspector {
  constructor(doc, { onChange, units, onNotice, onExactEdit } = {}) {
    this.doc = doc;
    this.onChange = onChange || (() => {});
    // Retyping the radius of an exact operation re-runs the whole chain through
    // the B-rep kernel, which lives behind a lazy import, so the owner of that
    // import handles it rather than this file reaching for it.
    this.onExactEdit = onExactEdit || (() => {});
    // How the inspector tells the user something without a dialog, e.g. a
    // dimension the sketch's constraints will not allow.
    this.onNotice = onNotice || (() => {});
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

    // A sketch carries fields for both of its feature operations. Showing the
    // revolve angle next to the extrude depth was always confusing, so only the
    // fields that actually drive the current shape are rendered.
    const isSketch = obj.kind === 'sketch';
    const isPattern = obj.kind === 'pattern';
    const isRevolve = isSketch && obj.params.op === 'revolve';
    const endType = obj.params.endType || 'blind';
    const relevant = (f) => {
      // A pattern carries the fields for all three modes and only one mode's
      // worth of them mean anything at a time. Showing a ring radius while the
      // copies march in a straight line is a number you can type that changes
      // nothing, which is worse than no field at all.
      if (isPattern) return (PATTERN_FIELDS[obj.params.mode] || PATTERN_FIELDS.linear).includes(f.key);
      if (!isSketch) return true;
      if (f.key === 'angle') return isRevolve;
      // 'upTo' works out its own distance, so a depth field would be a number
      // you can type that changes nothing. 'through' keeps it, because it is
      // still the fallback when there is nothing in the way.
      if (f.key === 'depth') return !isRevolve && endType !== 'upTo';
      if (f.key === 'depth2') return !isRevolve && endType === 'twoSided';
      if (f.key === 'start') return !isRevolve;
      if (f.key === 'draft') return !isRevolve;
      return true;
    };
    // The depth means something slightly different per end type, so say which.
    const DEPTH_LABEL = {
      blind: 'Depth (mm)', symmetric: 'Total depth (mm)', twoSided: 'Up (mm)',
      through: 'Depth if nothing is in the way (mm)',
    };
    const labelFor = (f) => (isSketch && f.key === 'depth' ? (DEPTH_LABEL[endType] || f.label) : f.label);

    const dimFields = schema
      .filter((f) => !f.advanced && relevant(f))
      .map((f) => this._numRow(`dim:${f.key}`, labelFor(f), obj.params[f.key] ?? 0, f.step, f.min))
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
        <label>${isPattern ? 'The rule' : 'Dimensions (mm)'}</label>
        ${dimFields}
      </div>` : (partsRow || this._exactRow(obj) || `<div class="meta">A group's shape comes from its parts. <b>Ungroup</b> to edit them, then regroup.</div>`);

    this.body.innerHTML = `
      <div class="meta">${meta}</div>
      <div class="meta" id="bbox-readout">${this._bboxText(obj)}</div>

      <div class="field">
        <label>Name</label>
        <input type="text" data-bind="name" value="${obj.name}" />
      </div>

      ${roleRow}
      ${opRow}
      ${this._patternRow(obj)}
      ${this._extrudeRow(obj)}
      ${this._sketchRow(obj)}
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

  // How far the extrusion goes, and which way. Three end types cover almost
  // everything people reach for: one direction, centred on the plane, or a
  // different distance each way. Each is one tap, which matters on a phone.
  /**
   * The pattern rule: which way the copies go, around which axis, and a plain
   * sentence saying what the numbers add up to.
   *
   * The sentence matters more than it looks. A pattern is the one object here
   * whose shape is not visible from its own dimensions, and "6 copies, 25mm
   * apart, 125mm end to end" is the check that stops a part being sent to a
   * printer that cannot fit it.
   */
  _patternRow(obj) {
    if (obj.kind !== 'pattern') return '';
    const p = obj.params;
    const mode = p.mode || 'linear';
    const seg = (attr, value, label, title) =>
      `<button type="button" data-${attr}="${value}" title="${esc(title)}" class="${(attr === 'pmode' ? mode : attr === 'paxis' ? (p.axis || 'y') : (p.plane || 'x')) === value ? 'on' : ''}">${label}</button>`;

    const axisRow = mode === 'circular' ? `
      <div class="field">
        <label>Ring axis</label>
        <div class="seg">
          ${seg('paxis', 'x', 'X', 'Copies ring around the X axis')}
          ${seg('paxis', 'y', 'Y', 'Copies ring around the up axis, which is the usual one for a bolt circle')}
          ${seg('paxis', 'z', 'Z', 'Copies ring around the Z axis')}
        </div>
      </div>` : '';

    const planeRow = mode === 'mirror' ? `
      <div class="field">
        <label>Mirror across</label>
        <div class="seg">
          ${seg('pplane', 'x', 'YZ', 'Flip left to right')}
          ${seg('pplane', 'y', 'XZ', 'Flip top to bottom')}
          ${seg('pplane', 'z', 'XY', 'Flip front to back')}
        </div>
      </div>` : '';

    const count = patternTransforms(p).length;
    let says;
    if (mode === 'mirror') {
      says = "The original and one reflection of it, through a plane at this object's own origin.";
    } else if (mode === 'circular') {
      const step = (p.sweep >= 359.999 ? p.sweep / count : p.sweep / Math.max(1, count - 1));
      says = `${count} copies on a ${round(p.radius)}mm ring, one every ${round(step, 1)}°, centred on this object's own origin.`;
    } else {
      const span = Math.hypot((p.dx || 0) * (count - 1), (p.dy || 0) * (count - 1), (p.dz || 0) * (count - 1));
      says = `${count} copies, ${round(span, 1)}mm from the first to the last.`;
    }

    return `
      <div class="field">
        <label>Pattern</label>
        <div class="seg">
          ${seg('pmode', 'linear', 'Line', 'Copies march along a straight step in X, Y and Z')}
          ${seg('pmode', 'circular', 'Ring', 'Copies go round a circle, for bolt holes, gear teeth and spokes')}
          ${seg('pmode', 'mirror', 'Mirror', 'One reflected copy, for parts that come in left and right hands')}
        </div>
      </div>
      ${axisRow}
      ${planeRow}
      <div class="meta">${esc(says)} <b>Release</b> in the toolbar gives the single part back.</div>`;
  }

  /**
   * What an exact solid is made of: the recipe underneath, and the list of
   * roundings on top of it, in the order they were applied.
   *
   * A rounded part looks like a mesh and is not one, and the difference matters
   * enough to say on screen. It also matters that the list is a LIST: each
   * radius is still a thing that happened rather than a change baked into
   * triangles, which is why Undo the rounding can give the original part back.
   */
  _exactRow(obj) {
    if (obj.kind !== 'brep') return '';
    const ops = obj.params.ops || [];
    if (obj.params.imported) {
      return `<div class="meta">Opened from <b>${esc(obj.params.imported)}</b>. It came in as a solid and is tessellated for the screen. There is no recipe behind it, so it cannot be rounded or written back out exactly.</div>`;
    }
    const src = obj.params.src;
    const rows = ops.map((o, i) => `
      <div class="axis">
        <span>${i + 1}. ${o.type === 'chamfer' ? 'Bevel' : 'Round'}, ${esc(String(o.select === 'all' ? 'every edge' : o.select === 'vertical' ? 'upright edges' : `${o.select} edges`))}</span>
        <input type="number" data-exact="${i}" value="${round(o.size)}" step="0.5" min="0.1" />
      </div>`).join('');
    return `
      <div class="field">
        <label>Exact operations <span class="hint">(edits re-run the whole chain)</span></label>
        ${rows || '<div class="muted">none yet</div>'}
      </div>
      <div class="meta">Built from a <b>${esc(src ? src.kind : 'part')}</b> through the exact kernel, so its rounded faces are real curved surfaces and a STEP export carries them as such. <b>Undo the rounding</b> in the toolbar gives the original part back.</div>`;
  }

  _extrudeRow(obj) {
    if (obj.kind !== 'sketch' || obj.params.op === 'revolve') return '';
    const end = obj.params.endType || 'blind';
    // The reach is a cache of a question about the scene, and the scene may have
    // moved since it was last written. Re-resolve on render so the number under
    // the buttons is never stale. It is a no-op for the other end types.
    this.doc.resolveExtrudeReach(obj);
    const btn = (v, label, title) =>
      `<button type="button" data-endtype="${v}" title="${title}" class="${end === v ? 'on' : ''}">${label}</button>`;

    const span = extrudeSpan(obj.params);
    const fmt = (n) => (Math.round(n * 100) / 100);
    const reach = `Reaches ${fmt(span.bottom)} to ${fmt(span.top)} mm about the sketch plane.`;

    // If the drawn outline had to be repaired, say so plainly. Silently fixing
    // someone's geometry and never mentioning it is how trust gets lost.
    const g = obj.mesh?.geometry?.userData || {};
    const note = g.repaired
      ? `<div class="sk-note repaired">Your outline crossed itself${g.regions > 1 ? `, so it became ${g.regions} separate pieces` : ' and was repaired'}. The solid is clean.</div>`
      : (g.profileError ? `<div class="sk-warn">${esc(g.profileError)}</div>` : '');

    // A draft the shape cannot take falls back to straight walls. Say so, or the
    // number in the field would claim something the solid does not show.
    const draftNote = g.draftRefused
      ? `<div class="sk-warn">${esc(g.draftRefused)}. The walls are straight instead, so lower the angle or pull a shorter depth.</div>`
      : '';

    // The two scene-aware types get their own row. They are a different KIND of
    // choice: the first three are distances you type, these two are answers the
    // model works out for you, and mixing them into one strip of five made the
    // depth field look as though it still applied.
    const scene = `
        <div class="seg seg-2">
          ${btn('through', 'Through all', 'Pull far enough to pass through every other body in the way')}
          ${btn('upTo', 'Up to face', 'Pull until the first body ahead of the sketch, and stop there')}
        </div>`;

    // When a scene-aware pull has nothing to bite on, say so where the reach
    // normally goes. Otherwise the number would silently be the blind fallback
    // and look like a bug in the shape rather than an empty scene.
    const sceneNote = (end === 'through' || end === 'upTo') && span.unresolved
      ? `<div class="sk-warn">${end === 'through'
          ? 'Nothing to pass through yet, so this is pulling the plain depth. Add a body in the way.'
          : 'No body ahead of this sketch to stop at, so this is pulling the plain depth.'}</div>`
      : '';

    return `
      <div class="field">
        <label>Extrude</label>
        <div class="seg seg-3">
          ${btn('blind', 'Up', 'Pull the profile one way from the sketch plane')}
          ${btn('symmetric', 'Centred', 'Centre the depth on the sketch plane, half each way')}
          ${btn('twoSided', 'Both', 'Pull a different distance each way')}
        </div>
        ${scene}
        <div class="muted sk-note">${reach}</div>
        ${sceneNote}
        ${note}
        ${draftNote}
      </div>`;
  }

  // The parametric block: what the sketch is constrained by, how free it still
  // is, and the driving numbers you can type into. This is the part that makes a
  // sketch a rule set rather than a frozen outline.
  _sketchRow(obj) {
    if (obj.kind !== 'sketch' || !obj.params.sk) return '';
    const sk = obj.params.sk;
    const report = resolveSketch(obj.params);
    const dims = dimensionList(sk);

    const STATE = {
      fully: ['ok', 'Fully constrained'],
      under: ['warn', `Under-constrained · ${report.dof} free`],
      over: ['warn', 'Over-constrained · redundant rules'],
      conflict: ['bad', 'Conflicting constraints'],
    };
    const [cls, text] = STATE[report.status] || ['warn', report.status];
    const openWarn = report.closed ? '' :
      `<div class="sk-warn">The profile is not closed yet. ${esc(report.reason)}</div>`;

    const dimRows = dims.length ? dims.map((d) => `
      <div class="axis">
        <span>${esc(d.label.replace(/ [-\d.]+°?$/, ''))}</span>
        <input type="number" data-skdim="${d.id}" value="${round(d.value)}" step="0.5" />
      </div>`).join('') : '<div class="muted">No driving dimensions yet.</div>';

    const cons = sk.constraints.filter((c) => !isDimension(c));
    const conChips = cons.length ? cons.map((c) => `
      <button type="button" class="sk-chip" data-skdel="${c.id}"
              title="Remove this constraint">${esc(constraintLabel(c))} <span>×</span></button>`).join('') : '';

    return `
      <div class="field sketch-field">
        <label>Parametric sketch <span class="sk-state ${cls}">${esc(text)}</span></label>
        ${openWarn}
        <div class="sk-sub">Driving dimensions</div>
        ${dimRows}
        ${conChips ? `<div class="sk-sub">Constraints</div><div class="sk-chips">${conChips}</div>` : ''}
        <div class="muted sk-note">${sk.entities.length} curves · ${sk.points.length} points. Press <b>S</b> to edit the sketch on the canvas.</div>
      </div>`;
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

    // Typing a driving dimension re-solves the sketch and rebuilds the solid.
    this.body.querySelectorAll('input[data-skdim]').forEach((input) => {
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (Number.isNaN(v)) return;
        const report = this.doc.setSketchDimension(obj.id, input.dataset.skdim, v);
        if (!report) return;
        if (!report.ok) {
          // Put the old number back rather than leaving a value the geometry
          // never actually took.
          this.render();
          this.onNotice?.(`The sketch cannot reach that value. ${report.reason}`);
          return;
        }
        this.onChange(obj);
        this.render();
      });
    });

    this.body.querySelectorAll('button[data-skdel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.doc.editSketchConstraint(obj.id, 'remove', { id: btn.dataset.skdel });
        this.onChange(obj);
        this.render();
      });
    });
    this.body.querySelectorAll('button[data-endtype]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.doc.commit('Extrude end type');
        obj.params.endType = btn.dataset.endtype;
        // Starting a two-sided pull with nothing on the second side reads as
        // broken, so seed it from the first side the first time.
        if (obj.params.endType === 'twoSided' && !(obj.params.depth2 > 0)) {
          obj.params.depth2 = Math.max(1, Math.round((obj.params.depth || 20) / 2));
        }
        // Answer the scene question before building, or the first click would
        // draw the blind fallback and only come right on the next render.
        this.doc.resolveExtrudeReach(obj);
        obj.rebuild();
        this.doc.touch(obj);
        this.onChange(obj);
        this.render();
      });
    });
    this.body.querySelectorAll('button[data-role]').forEach((btn) => {
      btn.addEventListener('click', () => {
        obj.setRole(btn.dataset.role);
        this.doc.touch(obj);
        this.onChange(obj);
        this.render();           // reflect color + active state
      });
    });
    this.body.querySelectorAll('input[data-exact]').forEach((input) => {
      input.addEventListener('change', async () => {
        const v = parseFloat(input.value);
        if (!Number.isFinite(v) || v <= 0) { this.render(); return; }
        input.disabled = true;
        try { await this.onExactEdit(obj, +input.dataset.exact, v); }
        finally { input.disabled = false; }
      });
    });
    // The pattern rule. Three controls, one path: set the key, rebuild, re-render
    // so the fields that stopped meaning anything go away with it.
    for (const [attr, key] of [['pmode', 'mode'], ['paxis', 'axis'], ['pplane', 'plane']]) {
      this.body.querySelectorAll(`button[data-${attr}]`).forEach((btn) => {
        btn.addEventListener('click', () => {
          const v = btn.dataset[attr];
          if (obj.params[key] === v) return;
          this.doc.setPatternParam(obj.id, key, v);
          this.onChange(obj);
          this.render();
        });
      });
    }
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
