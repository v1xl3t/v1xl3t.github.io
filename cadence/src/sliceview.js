// sliceview.js — the slicer's face: settings, progress, and the layer preview.
//
// The preview is not a rendering of the G-code. It is a rendering of the PLAN,
// the same object the emitter serializes, which is why scrubbing to layer 47
// and reading layer 47 in the file always agree. A preview built by parsing the
// file back would drift the moment the emitter learned a new trick.
//
// Everything is drawn as one LineSegments buffer with vertex colors, ordered
// by layer and then by print order. That ordering is what makes scrubbing free:
// showing the first N layers is a contiguous range of that buffer, and so is
// showing the first M moves of one layer, so both are a drawRange call rather
// than a rebuild. A 400-layer part scrubs at frame rate with no geometry work
// at all.
//
// Coordinates come back from the slicer in PRINTER space: Z up, origin at the
// front-left corner of the bed. The viewport is Y up and centered on the model.
// toCad() below is the exact inverse of the transform io.js applied on the way
// out, so the toolpaths land on the model they came from.

import * as THREE from 'three';
import { gatherPrintMesh } from './io.js';
import {
  buildSettings, listMachines, listMaterials, listQuality, validate,
} from './slicer/profiles.js';
import { formatDuration } from './slicer/gcode.js';
import { connectPrinter, PrinterLink } from './printer.js';

// Feature colors. Chosen to stay apart from each other on the dark viewport
// and to keep the two most important ones, the outer wall and a bridge, the
// easiest to pick out: the outer wall is the surface you will touch, and a
// bridge is the thing most likely to fail.
const COLORS = {
  'wall-outer': 0xff8a3d,
  'wall-inner': 0xa85c26,
  'skin': 0xffd23d,
  'bridge': 0x49c8f0,
  'infill': 0xd2563a,
  'gap': 0xff5fa2,
  'support': 0x35c39a,
  'support-interface': 0x8fe9cd,
  'skirt': 0x7bd634,
  'brim': 0x7bd634,
  // A raft is scaffolding, so it reads as a duller version of the skirt it
  // replaces rather than competing with the part for attention.
  'raft': 0x5f9e2a,
  // Ironing sits exactly on top of the skin it is smoothing, so it is drawn a
  // shade lighter than the skin rather than a different hue. A separate color
  // would look like a separate feature in a place where nothing new was added.
  'ironing': 0xfff0a8,
};
const TRAVEL_COLOR = 0x3c5f9e;

const LEGEND = [
  ['wall-outer', 'Outer wall'], ['wall-inner', 'Inner walls'], ['skin', 'Solid surface'],
  ['bridge', 'Bridge'], ['infill', 'Infill'], ['gap', 'Gap fill'],
  ['support', 'Support'], ['support-interface', 'Support top'], ['skirt', 'Skirt / brim'],
  ['raft', 'Raft'], ['ironing', 'Ironing'],
];

// The slicer keeps its own key rather than sharing the app's settings object.
// main.js holds that object in memory and writes the whole of it back whenever
// a preference changes, so a slicer value written after that load would be
// silently dropped the next time someone picked a UI style.
const STORE_KEY = 'cadence.slicer.v1';

const INFILL_PATTERNS = [
  ['grid', 'Grid'], ['lines', 'Lines'], ['triangles', 'Triangles'],
  ['gyroid', 'Gyroid'], ['concentric', 'Concentric'],
];

export class SliceView {
  constructor(scene, doc, { flash, onOpen, onSliced, onVisibility } = {}) {
    this.scene = scene;
    this.doc = doc;
    this.flash = flash || (() => {});
    this.onOpen = onOpen || (() => {});
    this.onSliced = onSliced || (() => {});
    this.onVisibility = onVisibility || (() => {});

    this.el = document.getElementById('slicer');
    this.plan = null;
    this.stats = null;
    this.gcode = '';
    this.worker = null;
    this.busy = false;
    this.link = null;
    this.hiddenMeshes = [];

    // Two buffers: the toolpaths, and the travels between them. Separate so the
    // travel toggle is a visibility flip rather than a rebuild.
    this.group = new THREE.Group();
    this.group.name = 'slice-preview';
    this.group.visible = false;
    scene.add(this.group);

    this.pathLines = null;
    this.travelLines = null;
    this.bedBox = null;
    this.ranges = [];
    this.travelRanges = [];

    this.settings = buildSettings();
    this.layerIndex = 0;
    this.moveFrac = 1;
    this.mode = 'stack';
    this.showTravel = false;
    this.stale = false;

    this.buildPanel();
    this.restorePanel();

    // A preview describes one particular arrangement of solids. The moment that
    // arrangement changes it stops being a preview and becomes a picture of the
    // past, and the numbers beside it stop being an estimate of anything.
    //
    // This matters more than it sounds. Deleting every object left a hundred
    // layers of toolpath hanging in space with a print time and a filament
    // weight next to it, all describing a model that no longer existed, and
    // nothing on screen said so.
    for (const ev of ['add', 'remove', 'change', 'regroup', 'undo']) {
      doc.addEventListener(ev, (e) => this.markStale(ev, e));
    }
  }

  /**
   * The model has moved on. Put the solids back so the user can see what they
   * are editing, take the stale toolpaths off the screen, and say so.
   *
   * Deliberately not an automatic re-slice. Slicing takes seconds on a real
   * part, and doing it on every nudge of a gizmo would make the app feel like
   * it was fighting you.
   */
  markStale(ev, e) {
    // A mesh that has been deleted must not be held on to, or closing the panel
    // would try to restore the visibility of an object that is gone.
    if (ev === 'remove' && e?.detail?.mesh) {
      this.hiddenMeshes = this.hiddenMeshes.filter((m) => m !== e.detail.mesh);
    }
    if (!this.plan || this.stale) return;
    this.stale = true;
    this.restoreModel();
    this.group.visible = false;
    this.renderStale();
    this.onVisibility(false);
  }

  renderStale() {
    const results = this.el.querySelector('#sl-results');
    const banner = this.el.querySelector('#sl-stale');
    if (!results || !banner) return;
    results.classList.toggle('stale', this.stale);
    banner.hidden = !this.stale;
    this.el.querySelector('#sl-run').classList.toggle('wants-attention', this.stale);
    // The stale banner and the Slice button both live in the scrolling body, so
    // a collapsed panel would hide the warning AND the way to act on it. Going
    // stale is exactly when you need them, so expand.
    if (this.stale && this.collapsed) this.setCollapsed(false);
  }

  get visible() { return !this.el.hidden; }

  /**
   * Collapse the panel to just its dock: the layer readout, the steppers, the
   * scrub slider and Stack / One layer.
   *
   * This exists because of a plain contradiction on a phone. The sheet is
   * capped at 72vh above a 52px bar, so with it open the model is behind the
   * panel — and the whole point of scrubbing layers is to WATCH the model.
   * Reading a layer preview you cannot see is not a preview. Collapsed, the
   * dock is about 120px and the viewport is yours again.
   *
   * It also answers "overwhelming": collapsed, the slicer is four controls.
   */
  setCollapsed(on) {
    this.collapsed = !!on;
    this.el.classList.toggle('sl-collapsed', this.collapsed);
    const btn = this.el.querySelector('#sl-min');
    if (btn) {
      btn.textContent = this.collapsed ? 'Show settings' : 'Hide settings';
      btn.title = this.collapsed
        ? 'Bring the slicer settings back'
        : 'Collapse to just the layer controls so you can see the model';
    }
  }

  toggle(force) {
    const open = force != null ? force : this.el.hidden;
    this.el.hidden = !open;
    // Other panels lay themselves out around this one.
    document.body.classList.toggle('slicer-open', open);
    // Reopening always shows the settings, otherwise the panel comes back as a
    // stub with no visible way to explain itself.
    if (open) this.setCollapsed(false);
    // A stale plan keeps its numbers on screen, marked as stale, but its
    // toolpaths stay off: a picture of the wrong model is worse than no picture.
    this.group.visible = open && !!this.plan && !this.stale;
    if (open) {
      if (!this.stale) this.hideModel();
      this.renderStale();
      this.onOpen();
    } else {
      this.restoreModel();
    }
    this.onVisibility(open);
  }

  // ---- the model gets out of the way ------------------------------------
  //
  // Toolpaths live inside the solid, so with the solid drawn you see its
  // outside and nothing else. The previous visibility of each mesh is
  // remembered rather than assumed, so an object the user had hidden in the
  // Objects panel stays hidden when the preview closes.
  // Additive rather than once-only. Anything added or unhidden while the panel
  // is open also has to get out of the way, or the object you just changed is
  // precisely the one sitting in front of the preview you sliced it into.
  hideModel() {
    for (const obj of this.doc.list) {
      if (obj.mesh && obj.mesh.visible && !this.hiddenMeshes.includes(obj.mesh)) {
        this.hiddenMeshes.push(obj.mesh);
        obj.mesh.visible = false;
      }
    }
  }

  restoreModel() {
    for (const m of this.hiddenMeshes) m.visible = true;
    this.hiddenMeshes = [];
  }

  /**
   * Run something with the model temporarily un-hidden.
   *
   * The export path skips hidden objects, which is right: an object switched
   * off in the Objects panel should not be printed. But the preview hides
   * everything so the toolpaths can be seen, and those two facts together mean
   * that opening the slicer makes the scene look empty to the slicer. Undoing
   * only this class's own hiding, and only for the length of the call, keeps
   * both behaviors intact.
   */
  withModelShown(fn) {
    const hidden = this.hiddenMeshes;
    for (const m of hidden) m.visible = true;
    try {
      return fn();
    } finally {
      for (const m of hidden) m.visible = false;
    }
  }

  // ------------------------------------------------------------------ panel
  buildPanel() {
    const opts = (list, sel) => list.map(([v, label]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${label}</option>`).join('');
    const s = this.settings;

    this.el.innerHTML = `
      <div class="sl-head">
        <span class="group-label">Slice</span>
        <span class="sl-head-actions">
          <!-- Collapsing is the difference between a preview you can read and one
               you cannot. The sheet covers most of a phone screen, so scrubbing
               layers while the model is behind the panel is useless. -->
          <button id="sl-min" title="Collapse to just the layer controls so you can see the model">Hide settings</button>
          <button id="sl-close" title="Close the slicer (K)">✕</button>
        </span>
      </div>

      <div class="sl-scroll">
        <div class="sl-sec">Printer</div>
        <div class="setrow"><label for="sl-machine">Machine</label><select id="sl-machine">${opts(listMachines().map((m) => [m.id, m.name]), s.machineId)}</select></div>
        <div class="setrow"><label for="sl-material">Filament</label><select id="sl-material">${opts(listMaterials().map((m) => [m.id, m.name]), s.materialId)}</select></div>
        <div class="setrow"><label for="sl-quality">Quality</label><select id="sl-quality">${opts(listQuality().map((q) => [q.id, q.name]), s.qualityId)}</select></div>

        <div class="sl-sec">Shell &amp; fill</div>
        <div class="sl-grid">
          <label>Layer mm<input type="number" id="sl-layer" min="0.04" max="0.4" step="0.02" value="${s.layerHeight}"></label>
          <label>Walls<input type="number" id="sl-walls" min="0" max="8" step="1" value="${s.wallCount}"></label>
          <label>Top<input type="number" id="sl-top" min="0" max="20" step="1" value="${s.topLayers}"></label>
          <label>Bottom<input type="number" id="sl-bottom" min="0" max="20" step="1" value="${s.bottomLayers}"></label>
        </div>
        <div class="setrow"><label for="sl-pattern">Infill</label><select id="sl-pattern">${opts(INFILL_PATTERNS, s.infillPattern)}</select></div>
        <label class="sl-range">Density <b id="sl-density-val">${s.infillDensity}%</b>
          <input type="range" id="sl-density" min="0" max="100" step="5" value="${s.infillDensity}">
        </label>

        <div class="sl-sec">Supports</div>
        <div class="setrow"><label for="sl-support">Type</label>
          <select id="sl-support">
            <option value="off" selected>None</option>
            <option value="normal">Columns</option>
            <option value="tree">Tree</option>
          </select>
        </div>
        <label class="sl-range">Overhang angle <b id="sl-angle-val">${s.supportAngle}&deg;</b>
          <input type="range" id="sl-angle" min="10" max="80" step="5" value="${s.supportAngle}">
        </label>
        <div class="hint">Anything leaning further than this from vertical gets held up.</div>

        <div class="sl-sec">Bed</div>
        <div class="setrow"><label for="sl-adhesion">Adhesion</label>
          <select id="sl-adhesion">
            <option value="skirt" selected>Skirt</option>
            <option value="brim">Brim</option>
            <option value="raft">Raft</option>
            <option value="none">None</option>
          </select>
        </div>
        <div class="hint">A skirt primes the nozzle, a brim widens the footprint so a tall thin part is not knocked over, and a raft lifts the whole print onto a disposable slab when the bed itself is the problem.</div>

        <div class="sl-sec">Finish</div>
        <label class="check"><input type="checkbox" id="sl-adaptive"> Adaptive layer height</label>
        <div class="hint">Thin layers where the model is shallow, which is where every layer line shows, and thick ones where it is vertical, which is where none of them do. One layer height has to be a compromise between those two, and this stops being one.</div>
        <label class="check"><input type="checkbox" id="sl-ironing"> Iron the top surfaces</label>
        <div class="hint">Runs the hot nozzle back over each flat top at a tenth of a bead, melting the ridges between lines flat. It adds time to the top layers only, and it is the difference between a striped top and a molded one.</div>

        <div id="sl-advice" hidden></div>
        <button id="sl-run" class="primary sl-run" title="Work out the toolpaths for this model and build the layer preview. Nothing is sent anywhere until you ask.">Slice</button>
        <div id="sl-progress" class="sl-progress" hidden><div class="sl-bar"></div><span class="sl-stage"></span></div>
        <div id="sl-messages"></div>

        <div id="sl-results" hidden>
          <div id="sl-stale" class="sl-msg warn" hidden>
            The model changed after this was sliced, so these toolpaths and
            numbers describe the old one. Slice again to bring them up to date.
          </div>
          <div class="sl-sec">Result</div>
          <div class="sl-stats" id="sl-stats"></div>

          <div class="sl-sec">Preview</div>
          <div class="hint">Layer controls are docked at the bottom of this panel so they stay put while you scroll.</div>
          <label class="sl-range">Within layer <b id="sl-move-val">all</b>
            <input type="range" id="sl-moves" min="0" max="100" step="1" value="100" title="How far through the current layer to draw, so you can watch the order the nozzle takes">
          </label>
          <label class="check"><input type="checkbox" id="sl-travel" title="Draw the moves where nothing is extruded. Lots of them means the nozzle is spending its time getting places rather than printing."> Show travel moves</label>
          <div class="sl-legend">${LEGEND.map(([k, label]) => `<span><i style="background:#${COLORS[k].toString(16).padStart(6, '0')}"></i>${label}</span>`).join('')}</div>

          <div class="sl-sec">Output</div>
          <button id="sl-sup-obj" title="Rebuild the generated supports as an ordinary solid in the scene, so you can move, cut, boolean or delete parts of them like anything else">Supports → object</button>
          <button id="sl-save" title="Download the .gcode file, ready for an SD card">Save G-code</button>
          <button id="sl-print" title="Send this job straight to the printer over its USB cable. Chrome or Edge on a desktop only. It asks before it starts anything.">Print over USB…</button>
          <div id="sl-printer" class="sl-printer"></div>
        </div>
      </div>

      <!-- The dock. Outside .sl-scroll on purpose: these are the controls you
           use while WATCHING the model, so they must not scroll away, and they
           are the only thing left on screen when the panel is collapsed. -->
      <div id="sl-dock" hidden>
        <label class="sl-range sl-dock-read">Layer <b id="sl-layer-val">0</b></label>
        <!-- A slider alone cannot pick a layer. On a 400-layer part at phone
             width the whole stack is 390 pixels, so one layer is less than a
             pixel and there is no way to land on a chosen one. The steppers
             are the precise path, and they are the only path on touch, where
             PgUp and PgDn do not exist. -->
        <div class="sl-step">
          <button type="button" data-layerstep="-1" aria-label="Previous layer" title="Down one layer (PgDn)">−</button>
          <input type="range" id="sl-scrub" min="0" max="0" step="1" value="0" title="Drag for the rough height, then step with the buttons for an exact layer.">
          <button type="button" data-layerstep="1" aria-label="Next layer" title="Up one layer (PgUp)">+</button>
        </div>
        <div class="seg sl-seg">
          <button data-slmode="stack" class="on" title="Show every layer up to the one you have scrubbed to, building the part up as it prints">Stack</button>
          <button data-slmode="single" title="Show only the layer you have scrubbed to, which is how you read what a single pass actually does">One layer</button>
        </div>
      </div>
    `;

    this.wire();
  }

  wire() {
    const $ = (id) => this.el.querySelector('#' + id);
    $('sl-close').addEventListener('click', () => this.toggle(false));
    $('sl-min').addEventListener('click', () => this.setCollapsed(!this.collapsed));
    $('sl-run').addEventListener('click', () => this.run());
    $('sl-save').addEventListener('click', () => this.saveGcode());
    $('sl-sup-obj').addEventListener('click', () => this.supportsToObject());
    $('sl-print').addEventListener('click', () => this.startPrint());

    $('sl-density').addEventListener('input', (e) => { $('sl-density-val').textContent = `${e.target.value}%`; });
    $('sl-angle').addEventListener('input', (e) => { $('sl-angle-val').textContent = `${e.target.value}°`; });

    // One listener for the lot. Every control that feeds a slice re-checks the
    // settings and remembers them, so neither behavior has to be wired up
    // again the next time a control is added to the panel.
    for (const el of this.el.querySelectorAll('select[id], input[id]')) {
      if (el.id === 'sl-scrub' || el.id === 'sl-moves') { el.addEventListener('change', () => this.savePanel()); continue; }
      el.addEventListener('change', () => { this.refreshAdvice(); this.savePanel(); });
    }

    // Changing the machine or material changes what the quality speeds mean, so
    // the layer height field is re-seeded from the new profile rather than left
    // showing a number from the old one.
    for (const id of ['sl-machine', 'sl-material', 'sl-quality']) {
      $(id).addEventListener('change', () => {
        const s = this.readSettings();
        $('sl-layer').value = s.layerHeight;
        $('sl-walls').value = s.wallCount;
        $('sl-top').value = s.topLayers;
        $('sl-bottom').value = s.bottomLayers;
      });
    }

    $('sl-scrub').addEventListener('input', (e) => this.setLayer(+e.target.value));
    this.el.querySelectorAll('[data-layerstep]').forEach((b) => {
      b.addEventListener('click', () => this.setLayer(this.layerIndex + (+b.dataset.layerstep)));
    });
    $('sl-moves').addEventListener('input', (e) => this.setMoveFrac(+e.target.value / 100));
    $('sl-travel').addEventListener('change', (e) => {
      this.showTravel = e.target.checked;
      if (this.travelLines) this.travelLines.visible = this.showTravel;
      this.applyRange();
    });
    this.el.querySelectorAll('[data-slmode]').forEach((b) => {
      b.addEventListener('click', () => {
        this.mode = b.dataset.slmode;
        this.el.querySelectorAll('[data-slmode]').forEach((o) => o.classList.toggle('on', o === b));
        this.applyRange();
        this.savePanel();
      });
    });
  }

  /** Every control on the panel, by id, as plain values. */
  panelValues() {
    const out = {};
    for (const el of this.el.querySelectorAll('select[id], input[id]')) {
      out[el.id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    // The stack / one-layer choice is a pair of buttons rather than an input,
    // so it needs carrying by hand or it is the one setting that forgets.
    out._mode = this.mode;
    return out;
  }

  /**
   * Put the panel back the way it was left.
   *
   * Slice settings are a per-user, per-printer thing that barely changes, and
   * retyping the layer height and re-picking the infill pattern on every visit
   * is the kind of small tax that makes a tool feel unfinished. Restoring is
   * best-effort on purpose: a stored value for a control that no longer exists,
   * or an option that has since been removed, is skipped rather than throwing.
   */
  restorePanel() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
    if (!saved) { this.refreshAdvice(); return; }
    if (saved._mode) {
      this.mode = saved._mode;
      this.el.querySelectorAll('[data-slmode]').forEach((b) => b.classList.toggle('on', b.dataset.slmode === saved._mode));
    }
    for (const [id, v] of Object.entries(saved)) {
      if (id.startsWith('_')) continue;
      const el = this.el.querySelector('#' + CSS.escape(id));
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.tagName === 'SELECT') { if ([...el.options].some((o) => o.value === v)) el.value = v; }
      else el.value = v;
    }
    // The readouts beside the sliders are not inputs, so they need nudging.
    this.el.querySelectorAll('input[type="range"]').forEach((r) => r.dispatchEvent(new Event('input')));
    this.showTravel = this.el.querySelector('#sl-travel').checked;
    if (this.travelLines) this.travelLines.visible = this.showTravel;
    this.refreshAdvice();
  }

  savePanel() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.panelValues())); } catch { /* private mode */ }
  }

  /**
   * Say what is wrong with the settings BEFORE the slice, not after it.
   *
   * validate() already knew all of this; it was just being read out at the end
   * of a job rather than while the number that caused it was being typed. A
   * 0.35mm layer on a 0.4mm nozzle is worth hearing about before waiting for
   * six hundred layers to be computed.
   */
  refreshAdvice() {
    const host = this.el.querySelector('#sl-advice');
    if (!host) return;
    let msgs = [];
    try { msgs = validate(this.readSettings()); } catch (err) { msgs = [err.message]; }
    host.innerHTML = msgs.map((m) => `<div class="sl-msg warn">${escapeHtml(m)}</div>`).join('');
    host.hidden = !msgs.length;
    this.refreshPrintButton();
  }

  /**
   * Some machines cannot be printed to down a USB cable at all.
   *
   * Marlin takes one line, answers "ok", and takes the next. A Bambu does not:
   * it is a network and SD card machine and its USB port is not a print
   * console. Left alone, the button would open the browser's port chooser, find
   * nothing useful, and then sit at nought percent forever waiting for an "ok"
   * that is never coming, which is the worst kind of failure because it looks
   * like a slow start. So the button says why instead.
   */
  refreshPrintButton() {
    const btn = this.el.querySelector('#sl-print');
    if (!btn || (this.link && this.link.printing)) return;
    const can = this.settings.usbPrintable !== false;
    btn.disabled = !can;
    btn.title = can
      ? 'Send this job straight to the printer over its USB cable. Chrome or Edge on a desktop only. It asks before it starts anything.'
      : `A ${this.settings.machineName} does not take a G-code stream over USB. Save the file and send it to the machine the way you normally would.`;
  }

  /** Read the panel back into a settings object. */
  readSettings() {
    const $ = (id) => this.el.querySelector('#' + id);
    const support = $('sl-support').value;
    const layerHeight = Math.max(0.04, +$('sl-layer').value || 0.2);
    this.settings = buildSettings({
      machine: $('sl-machine').value,
      material: $('sl-material').value,
      quality: $('sl-quality').value,
      overrides: {
        layerHeight,
        // The first layer is thicker for grip, but never thinner than the rest
        // and never so thick the nozzle cannot push through it.
        firstLayerHeight: Math.min(0.32, Math.max(layerHeight, layerHeight * 1.2)),
        wallCount: Math.max(0, +$('sl-walls').value || 0),
        topLayers: Math.max(0, +$('sl-top').value || 0),
        bottomLayers: Math.max(0, +$('sl-bottom').value || 0),
        infillPattern: $('sl-pattern').value,
        infillDensity: +$('sl-density').value,
        supportEnable: support !== 'off',
        supportType: support === 'tree' ? 'tree' : 'normal',
        supportAngle: +$('sl-angle').value,
        adhesion: $('sl-adhesion').value,
        ironing: !!$('sl-ironing').checked,
        adaptiveLayers: !!$('sl-adaptive').checked,
      },
    });
    return this.settings;
  }

  // -------------------------------------------------------------- slicing
  run() {
    if (this.busy) return;
    const positions = this.withModelShown(() => gatherPrintMesh(this.doc.list));
    if (!positions.length) { this.flash('Nothing to slice. Add a solid first.'); return; }

    const settings = this.readSettings();
    this.stale = false;
    this.renderStale();
    this.busy = true;
    this.showProgress(0, 'starting');
    this.el.querySelector('#sl-messages').innerHTML = '';
    this.el.querySelector('#sl-run').disabled = true;

    const finish = (msg) => {
      this.busy = false;
      this.el.querySelector('#sl-run').disabled = false;
      this.hideProgress();
      if (msg) this.flash(msg);
    };

    const onDone = (data) => {
      this.plan = data.plan;
      this.stats = data.stats;
      this.gcode = data.gcode;
      this.placement = data.placement;
      this.showResults(data);
      this.buildPreview();
      finish(`Sliced in ${((data.elapsedMs ?? 0) / 1000).toFixed(1)}s. ${formatDuration(data.stats.timeSeconds)} to print.`);
    };

    try {
      if (!this.worker) {
        this.worker = new Worker(new URL('./slicer/worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (ev) => {
          const d = ev.data;
          if (d.type === 'progress') this.showProgress(d.frac, d.stage);
          else if (d.type === 'done') onDone(d);
          else if (d.type === 'error') { this.showError(d.message); finish(); }
        };
        this.worker.onerror = (err) => {
          // A worker that will not start is not a reason to be unable to slice.
          // Falling back keeps the feature working; it just blocks the UI while
          // it runs, which is why it says so.
          this.worker = null;
          this.sliceOnMainThread(positions, settings, onDone, finish);
          err.preventDefault?.();
        };
      }
      // Deliberately NOT transferring the buffer. Transferring saves one copy
      // of a few megabytes, and costs the ability to fall back to the main
      // thread afterwards, because a transferred buffer is detached and the
      // fallback would silently slice an empty model.
      this.worker.postMessage({ type: 'slice', positions, settings });
    } catch {
      this.sliceOnMainThread(positions, settings, onDone, finish);
    }
  }

  async sliceOnMainThread(positions, settings, onDone, finish) {
    this.showProgress(0.05, 'slicing (no worker available)');
    try {
      const mod = await import('./slicer/index.js');
      // Yield once so the progress bar actually paints before the thread locks.
      await new Promise((r) => setTimeout(r, 30));
      const started = performance.now();
      const res = mod.sliceModel(positions, settings);
      onDone({ ...res, elapsedMs: Math.round(performance.now() - started), placement: res.placement });
    } catch (err) {
      this.showError(err.message || String(err));
      finish();
    }
  }

  showProgress(frac, stage) {
    const p = this.el.querySelector('#sl-progress');
    p.hidden = false;
    p.querySelector('.sl-bar').style.width = `${Math.round((frac || 0) * 100)}%`;
    p.querySelector('.sl-stage').textContent = stage || '';
  }

  hideProgress() { this.el.querySelector('#sl-progress').hidden = true; }

  showError(message) {
    this.el.querySelector('#sl-messages').innerHTML =
      `<div class="sl-msg bad">Slicing failed: ${escapeHtml(message)}</div>`;
  }

  showResults(data) {
    const st = data.stats;
    const s = this.settings;
    this.el.querySelector('#sl-results').hidden = false;
    this.stale = false;
    this.renderStale();

    this.el.querySelector('#sl-stats').innerHTML = `
      <div><span>Print time</span><b>${formatDuration(st.timeSeconds)}</b></div>
      <div><span>Filament</span><b>${st.filamentM}m &middot; ${st.grams}g</b></div>
      <div><span>Cost</span><b>${st.cost ? '$' + st.cost.toFixed(2) : '&mdash;'}</b></div>
      <div><span>Layers</span><b>${st.layers}</b></div>
      <div><span>Size</span><b>${fmtSize(data.placement?.size)}</b></div>
      <div><span>Retractions</span><b>${st.retractions}</b></div>
      <div class="sl-stat-wide"><span>Supports</span><b>${supportSummary(st.supports)}</b></div>
    `;

    const msgs = [];
    for (const w of data.warnings || []) msgs.push(`<div class="sl-msg bad">${escapeHtml(w)}</div>`);
    for (const n of data.notes || []) msgs.push(`<div class="sl-msg">${escapeHtml(n)}</div>`);
    this.el.querySelector('#sl-messages').innerHTML = msgs.join('');

    const layers = data.plan.layers.filter((l) => l.paths.length).length;
    const scrub = this.el.querySelector('#sl-scrub');
    scrub.max = String(Math.max(0, layers - 1));
    scrub.value = String(Math.max(0, layers - 1));
    this.layerIndex = Math.max(0, layers - 1);
    this.el.querySelector('#sl-layer-val').textContent = String(this.layerIndex + 1);

    // The dock only means anything once there are layers to scrub.
    this.el.querySelector('#sl-dock').hidden = false;
    // On a phone the sheet is most of the screen, so a slice that finishes with
    // the panel still expanded hands you a preview you cannot see. Collapse to
    // the dock automatically, which is the state you want anyway.
    if (window.matchMedia('(max-width: 640px)').matches) this.setCollapsed(true);
  }

  /**
   * Hand the generated supports back as an ordinary solid.
   *
   * Generated supports are normally a black box: the slicer decides, you accept.
   * Turning them into a real object means the usual tools apply — move them,
   * cut a doorway with a boolean, delete the branch fouling a feature, keep the
   * rest. It also makes them inspectable, which is most of why you would want
   * this in a modeller rather than a slicer.
   *
   * It becomes a `supports` primitive, not an imported mesh, so it saves,
   * reloads, undoes and re-edits like everything else in the scene.
   */
  supportsToObject() {
    const shape = this.plan?.supportShape;
    if (!this.plan) { this.flash('Slice something first.'); return; }
    if (!shape || !shape.length) {
      this.flash('No supports in this slice. Turn them on under Supports, then slice again.');
      return;
    }

    // Printer space is Z-up with the model shifted onto the bed; the scene is
    // Y-up about the origin. Same inverse the preview uses.
    const [dx, dy, dz] = this.placement?.offset || [0, 0, 0];
    // Negating one axis mirrors the plane, which REVERSES every ring's winding.
    // Outers would come back as holes and the whole stack would build empty, so
    // the point order is reversed to put the orientation back.
    const toXZ = (ring) => ring.map((p) => [p[0] - dx, -(p[1] - dy)]).reverse();

    // Collapse runs of identical footprints into single tall slabs. Supports
    // hold their shape for many layers at a time, so this usually turns
    // hundreds of prisms into a handful without changing the solid.
    const slabs = [];
    let key = null;
    for (const layer of shape) {
      const rings = layer.polys.map(toXZ).filter((r) => r.length >= 3);
      if (!rings.length) { key = null; continue; }
      const k = JSON.stringify(rings);
      const bottom = layer.z - layer.height / 2 - dz;
      const last = slabs[slabs.length - 1];
      // Only extend when this layer sits exactly on top of the previous slab;
      // a gap means two separate towers and merging them would invent material.
      if (k === key && last && Math.abs(last.y + last.h - bottom) < 1e-6) {
        last.h += layer.height;
      } else {
        slabs.push({ y: bottom, h: layer.height, rings });
        key = k;
      }
    }

    if (!slabs.length) { this.flash('Those supports had no usable outline.'); return; }
    // `add` names it from the kind ("Supports") and uniquifies it already.
    this.doc.add('supports', { slabs, grow: 0 });
    this.flash(`Supports added as an object, ${slabs.length} slab${slabs.length === 1 ? '' : 's'}. Edit or delete it like any solid.`);
  }

  // -------------------------------------------------------------- preview
  buildPreview() {
    this.disposePreview();
    if (!this.plan || !this.plan.layers.length) return;

    const [dx, dy, dz] = this.placement?.offset || [0, 0, 0];
    // The exact inverse of the Y-up to Z-up rotation io.js baked in, plus the
    // shift that put the model on the bed.
    const toCad = (px, py, pz) => [px - dx, pz - dz, -(py - dy)];

    const pos = [], col = [], ranges = [];
    const tpos = [], tcol = [], tranges = [];
    const c = new THREE.Color();
    const tc = new THREE.Color(TRAVEL_COLOR);

    for (const layer of this.plan.layers) {
      if (!layer.paths.length) continue;
      const zTop = layer.z + layer.height / 2;
      const start = pos.length / 3, tstart = tpos.length / 3;
      let prev = null;

      for (const path of layer.paths) {
        c.setHex(COLORS[path.type] ?? 0x8899aa);
        const pts = path.points;
        if (prev) {
          const a = toCad(prev[0], prev[1], zTop), b = toCad(pts[0][0], pts[0][1], zTop);
          tpos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
          tcol.push(tc.r, tc.g, tc.b, tc.r, tc.g, tc.b);
        }
        for (let i = 1; i < pts.length; i++) {
          const a = toCad(pts[i - 1][0], pts[i - 1][1], zTop);
          const b = toCad(pts[i][0], pts[i][1], zTop);
          pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
          col.push(c.r, c.g, c.b, c.r, c.g, c.b);
        }
        prev = pts[pts.length - 1];
      }
      ranges.push({ start, count: pos.length / 3 - start });
      tranges.push({ start: tstart, count: tpos.length / 3 - tstart });
    }

    this.ranges = ranges;
    this.travelRanges = tranges;

    this.pathLines = makeLines(pos, col, 1);
    this.travelLines = makeLines(tpos, tcol, 0.55);
    this.travelLines.visible = this.showTravel;
    this.group.add(this.pathLines);
    this.group.add(this.travelLines);

    this.buildBed(dx, dy, dz);

    this.group.visible = this.visible;
    this.setLayer(this.ranges.length - 1);
    if (this.group.visible) {
      this.hideModel();
      this.onVisibility(true);
      // Frame the TOOLPATHS, not the group: the group also holds the build
      // volume outline, and fitting a 20mm part inside a 220mm bed puts the
      // thing you wanted to look at in the middle distance.
      this.onSliced(this.pathLines || this.group);
    }
  }

  /** The build volume, drawn where it actually is relative to the model. */
  buildBed(dx, dy, dz) {
    const s = this.settings;
    const x0 = -dx, x1 = s.bedWidth - dx;
    const z0 = dy, z1 = dy - s.bedDepth;      // printer +Y is viewport -Z
    const y0 = -dz, y1 = s.bedHeight - dz;

    const p = [];
    const line = (a, b) => p.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      line([a[0], y0, a[1]], [b[0], y0, b[1]]);              // the bed outline
      line([a[0], y1, a[1]], [b[0], y1, b[1]]);              // the ceiling
      line([a[0], y0, a[1]], [a[0], y1, a[1]]);              // the uprights
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x33435c, transparent: true, opacity: 0.6, depthWrite: false });
    this.bedBox = new THREE.LineSegments(geo, mat);
    this.group.add(this.bedBox);
  }

  setLayer(n) {
    if (!this.ranges.length) return;
    this.layerIndex = Math.max(0, Math.min(this.ranges.length - 1, n | 0));
    const scrub = this.el.querySelector('#sl-scrub');
    if (scrub && +scrub.value !== this.layerIndex) scrub.value = String(this.layerIndex);
    const layer = this.plan.layers.filter((l) => l.paths.length)[this.layerIndex];
    this.el.querySelector('#sl-layer-val').textContent =
      `${this.layerIndex + 1} · ${layer ? layer.z.toFixed(2) : '0'}mm`;
    this.applyRange();
  }

  setMoveFrac(f) {
    this.moveFrac = Math.max(0, Math.min(1, f));
    this.el.querySelector('#sl-move-val').textContent =
      this.moveFrac >= 1 ? 'all' : `${Math.round(this.moveFrac * 100)}%`;
    this.applyRange();
  }

  /**
   * Scrubbing is two drawRange calls and nothing else. Vertex counts are forced
   * even because a LineSegments buffer is read in pairs, and an odd count draws
   * a line to whatever happens to be next.
   */
  applyRange() {
    if (!this.pathLines) return;
    const even = (n) => Math.max(0, n - (n % 2));
    const apply = (mesh, ranges) => {
      if (!mesh) return;
      const r = ranges[this.layerIndex];
      if (!r) { mesh.geometry.setDrawRange(0, 0); return; }
      const within = even(Math.round(r.count * this.moveFrac));
      if (this.mode === 'single') mesh.geometry.setDrawRange(r.start, within);
      else mesh.geometry.setDrawRange(0, even(r.start) + within);
    };
    apply(this.pathLines, this.ranges);
    apply(this.travelLines, this.travelRanges);
  }

  disposePreview() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
    this.pathLines = this.travelLines = this.bedBox = null;
    this.ranges = [];
    this.travelRanges = [];
  }

  // --------------------------------------------------------------- output
  saveGcode() {
    if (!this.gcode) { this.flash('Slice something first.'); return; }
    const blob = new Blob([this.gcode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cadence-${this.settings.qualityId}-${this.settings.materialId}.gcode`;
    a.click();
    URL.revokeObjectURL(url);
    this.flash('G-code saved.');
  }

  async startPrint() {
    const host = this.el.querySelector('#sl-printer');
    const btn = this.el.querySelector('#sl-print');

    // While a job is running this button is the stop button, and stopping never
    // asks a second question.
    if (this.link && this.link.printing) { await this.link.abort(); return; }
    if (!this.gcode) { this.flash('Slice something first.'); return; }

    // The disabled button above is the visible guard. This is the one that
    // matters, because it is the one no keyboard or stale panel state can get
    // past, and nothing has opened a port yet when it fires.
    if (this.settings.usbPrintable === false) {
      host.innerHTML = `<div class="sl-msg warn">A ${escapeHtml(this.settings.machineName)} does not accept a G-code stream over USB. Save the G-code and send it to the machine the way you normally do.</div>`;
      return;
    }

    // Refusing to send a job that does not fit is not paternalism. The gantry
    // will happily drive into its own frame trying.
    if (this.placement && this.placement.fits === false) {
      host.innerHTML = '<div class="sl-msg bad">This model does not fit the printer, so it will not be sent.</div>';
      return;
    }

    const s = this.settings;
    const ok = window.confirm(
      `Start printing on the ${s.machineName}?\n\n` +
      `The nozzle will heat to ${s.firstLayerNozzleTemp}°C and the bed to ${s.firstLayerBedTemp}°C, ` +
      `then it will home and print for about ${formatDuration(this.stats.timeSeconds)}.\n\n` +
      `Make sure the bed is clear and you are there to watch the first layer.`
    );
    if (!ok) return;

    try {
      this.link = await connectPrinter({
        onStatus: (html) => { host.innerHTML = html; },
        onFlash: this.flash,
      });
      if (!this.link) return;                 // the port chooser was dismissed
      btn.textContent = 'Stop the print';
      btn.classList.add('danger');
      await this.link.print(this.gcode, this.settings);
    } catch (err) {
      host.innerHTML = `<div class="sl-msg bad">${escapeHtml(err.message || String(err))}</div>`;
    } finally {
      btn.textContent = 'Print over USB…';
      btn.classList.remove('danger');
    }
  }
}

function makeLines(pos, col, opacity) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: opacity < 1,
    opacity,
  });
  return new THREE.LineSegments(geo, mat);
}

const fmtSize = (s) => (s ? `${s.w.toFixed(1)} × ${s.d.toFixed(1)} × ${s.h.toFixed(1)}mm` : '—');

/**
 * Answer "did my supports actually happen" in one line.
 *
 * Three outcomes, and they are genuinely different: you never asked for any,
 * you asked and the model did not need them, or you asked and here is what they
 * cost. The old panel only ever whispered the middle one into a note, so
 * turning supports on and seeing no change was indistinguishable from a bug.
 */
function supportSummary(sup) {
  if (!sup || !sup.enabled) return 'Off';
  if (!sup.layers) return 'None needed';
  const kind = sup.type === 'tree' ? 'Tree' : 'Columns';
  return `${kind} · ${sup.layers} layers · ${sup.grams}g`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
