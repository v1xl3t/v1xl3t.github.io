// main.js — viewport, interaction, and wiring.
//
// Three layers meet here:
//   - the document model (model.js) = source of truth, recipe-carrying
//   - the gizmo (TransformControls) = sculptural / drag editing
//   - the Inspector (ui.js)         = parametric / numeric editing
// Selection, picking, keyboard, and the toolbar route user intent into the
// model; the model emits events; the view reacts. One way in, one way out.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

import { CadDocument } from './model.js';
import { Inspector } from './ui.js';
import { Outliner } from './outliner.js';
import { Timeline } from './timeline.js';
import { DimChips } from './dimchips.js';
import { exportSTL, export3MF, downloadJSON } from './io.js';
import { scheduleAutosave, restoreAutosave, clearAutosave } from './autosave.js';
import { warmKernel, kernelSelfTest } from './kernel.js';
import { ROLE_LABELS } from './primitives.js';
import { loadSettings, saveSettings, UI_STYLES, RENDER_MODES, UNITS, CONTROL_PRESETS, NAV_VERBS, controlMap, unitLabel } from './settings.js';
import { zipSync } from 'fflate';

// ---------------------------------------------------------------- scene setup
const canvas = document.getElementById('viewport');
// logarithmicDepthBuffer keeps depth precision sane across the huge near:far
// range below, so distant objects don't z-fight or sink behind the grid.
// preserveDrawingBuffer keeps the last frame readable after render, so the PNG /
// orbit-shot exporters can grab the canvas pixels reliably.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1116);

// Far plane way out so there's effectively no build limit — you can model and
// fly kilometres from origin without anything clipping or the camera "sticking".
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 1_000_000);
camera.position.set(70, 60, 90);

// Lights
scene.add(new THREE.HemisphereLight(0xbcd3ff, 0x20262e, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(200, 400, 150);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -500; sc.right = 500; sc.top = 500; sc.bottom = -500; sc.near = 1; sc.far = 2000;
scene.add(sun);

// Build plate + grid (units = mm). Grid is 1000mm wide, 10mm divisions —
// generous working area; building beyond it is fine, it's just visual reference.
const grid = new THREE.GridHelper(1000, 100, 0x3a4654, 0x232b34);
grid.position.y = 0;
scene.add(grid);

const plate = new THREE.Mesh(
  new THREE.PlaneGeometry(1000, 1000),
  new THREE.ShadowMaterial({ opacity: 0.28 })
);
plate.rotation.x = -Math.PI / 2;
plate.receiveShadow = true;
plate.position.y = -0.01;
scene.add(plate);

// ---------------------------------------------------------------- controls
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.target.set(0, 10, 0);
orbit.minDistance = 0.5;
orbit.maxDistance = 500_000;   // effectively unlimited dolly-out, no hard stop
// Mouse-button scheme is set by the active control preset (see Settings, below).

const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSize(0.9);
gizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
gizmo.addEventListener('mouseDown', () =>                          // one history step per drag
  doc.commit({ translate: 'Move', rotate: 'Rotate', scale: 'Scale' }[gizmo.getMode()] || 'Transform'));
gizmo.addEventListener('objectChange', () => {
  const obj = doc.selected;
  if (obj) doc.dispatchEvent(new CustomEvent('change', { detail: obj }));
});
scene.add(gizmo);

applySnap(true);
function applySnap(on) {
  const mv = parseFloat(document.getElementById('snap-move').value) || 1;
  const rt = parseFloat(document.getElementById('snap-rot').value) || 15;
  gizmo.translationSnap = on ? mv : null;                 // mm
  gizmo.rotationSnap = on ? THREE.MathUtils.degToRad(rt) : null;
  gizmo.scaleSnap = on ? 0.1 : null;
}

// ---------------------------------------------------------------- document
const doc = new CadDocument();
let clipboard = [];   // serialized objects from Ctrl+C, recreated on Ctrl+V

doc.addEventListener('add', (e) => scene.add(e.detail.mesh));
doc.addEventListener('remove', (e) => scene.remove(e.detail.mesh));
doc.addEventListener('select', () => refreshSelectionView());
doc.addEventListener('undo', () => rebuildSceneFromDoc());
doc.addEventListener('regroup', () => rebuildSceneFromDoc());
// Every committing change (and time-travel / file load) emits 'history'; ride that
// same path the undo tree uses to debounce-save the project to localStorage. Because
// same-origin tabs share localStorage, a save made in the portfolio "Run it here"
// preview iframe carries over when CADence is opened in its own tab.
doc.addEventListener('history', () => scheduleAutosave(doc));

function rebuildSceneFromDoc() {
  // Drop every cad mesh currently in the scene, re-add from the model.
  for (const m of [...scene.children]) if (m.userData?.cadId) scene.remove(m);
  for (const obj of doc.list) scene.add(obj.mesh);
  refreshSelectionView();
}

// Highlight every selected object; the gizmo binds to the primary selection.
let _highlighted = new Set();
function refreshSelectionView() {
  for (const mesh of _highlighted) mesh.material.emissive.setHex(0x000000);
  _highlighted = new Set();
  for (const obj of doc.selectedObjects) {
    obj.mesh.material.emissive.setHex(0x16335c);
    _highlighted.add(obj.mesh);
  }
  const primary = doc.selected;
  if (primary) gizmo.attach(primary.mesh); else gizmo.detach();
  setStatus();
}

async function groupSelected() {
  const ids = [...doc.selection];
  if (ids.length < 2) { flash('Select 2+ objects to group (Shift-click them).'); return; }
  flash('Combining bodies…');
  try {
    const grp = await doc.group(ids);
    flash(grp ? 'Grouped into one watertight body.' : 'Only holes selected — nothing to keep.');
  } catch (err) {
    console.error('[CADence] boolean kernel error:', err);
    flash('Boolean kernel failed to load/run — see console.');
  }
}

function ungroupSelected() {
  if (doc.selected?.kind === 'boolean') doc.ungroup(doc.selectedId);
  else flash('Select a group to ungroup.');
}

async function intersectSelected() {
  const ids = [...doc.selection];
  if (ids.length < 2) { flash('Select 2+ objects to intersect (Shift-click them).'); return; }
  flash('Intersecting…');
  try {
    const grp = await doc.intersect(ids);
    flash(grp ? 'Kept the shared volume.' : 'No overlapping volume to intersect.');
  } catch (err) {
    console.error('[CADence] intersect error:', err);
    flash('Intersect failed — see console.');
  }
}

// Frame the camera on the current selection (or the whole scene if nothing is
// selected). Keeps the current viewing direction, just re-centers and fits.
function frameSelection() {
  const objs = doc.selection.size ? doc.selectedObjects : doc.list;
  if (!objs.length) return;
  const box = new THREE.Box3();
  for (const o of objs) { o.mesh.updateWorldMatrix(true, false); box.expandByObject(o.mesh); }
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const diag = box.getSize(new THREE.Vector3()).length() || 40;
  const fit = (diag * 0.5) / Math.tan((camera.fov * Math.PI / 180) / 2) * 1.4;
  const dir = camera.position.clone().sub(orbit.target).normalize();
  orbit.target.copy(center);
  camera.position.copy(center).add(dir.multiplyScalar(Math.max(fit, diag)));
  orbit.update();
}

// Active display/export unit (mm/cm/inch). Modeling stays in mm; this only
// re-expresses the Inspector size readout and scales exported files. Seeded from
// saved settings so a reload keeps the user's choice.
let displayUnit = loadSettings().units || 'mm';
const inspector = new Inspector(doc, { onChange: () => setStatus(), units: () => displayUnit });
const outliner = new Outliner(doc);

// Recipe Timeline — the multiverse history strip. Clicking a tile time-travels;
// acting from a past tile forks a new branch (5D-chess style).
const timeline = new Timeline(doc, { onGoto: (id) => doc.goToHistory(id) });
// Each history step gets a small snapshot of the viewport for its tile.
doc.setThumbnailProvider(() => {
  try {
    renderer.render(scene, camera);
    const c = document.createElement('canvas'); c.width = 96; c.height = 60;
    c.getContext('2d').drawImage(renderer.domElement, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } catch { return null; }
});

// In-canvas dimension chips — edit a part's dimensions right on the geometry.
const dimchips = new DimChips(doc, {
  camera, renderer,
  onEdit: (obj, key, val) => {
    doc.commit('Edit ' + obj.name);
    obj.params[key] = val;
    obj.rebuild();
    doc.touch(obj);
  },
});

// ---------------------------------------------------------------- picking
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
let downAt = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
});
// Lasso begins on a window capture-phase listener so it runs BEFORE OrbitControls
// and TransformControls (whose listeners are on the canvas) and can't be swallowed
// by them — and stopPropagation keeps them from also acting on the same press.
window.addEventListener('pointerdown', (e) => {
  if (!lassoOn || e.button !== 0) return;
  if (e.target !== renderer.domElement) return;   // ignore clicks on panels/buttons
  e.stopPropagation();
  lassoStart(e);
}, true);
renderer.domElement.addEventListener('pointerup', (e) => {
  if (lassoActive) return;            // lasso runs its own window-level drag
  if (gizmo.dragging || !downAt) return;
  // Treat as a click only if the pointer barely moved (otherwise it was an orbit).
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
  if (sketchOn) { sketchClick(e); return; }
  if (measureOn) { measureClick(e); return; }
  pickAt(e);
});

function pickAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  const meshes = doc.list.map((o) => o.mesh);
  const hit = ray.intersectObjects(meshes, false)[0];
  doc.select(hit ? hit.object.userData.cadId : null, e.shiftKey); // Shift = add to selection
}

// ---------------------------------------------------------------- toolbar
document.getElementById('toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.add) doc.add(btn.dataset.add);
  if (btn.dataset.align) align(btn.dataset.align, btn.dataset.alignMode || 'center');
  if (btn.dataset.distribute) distribute(btn.dataset.distribute);

  if (btn.dataset.mode) {
    gizmo.setMode(btn.dataset.mode);
    document.querySelectorAll('button.mode').forEach((b) => b.classList.toggle('active', b === btn));
  }

  switch (btn.dataset.action) {
    case 'frame':     frameSelection(); break;
    case 'lasso':     toggleLasso(); break;
    case 'measure':   toggleMeasure(); break;
    case 'export-png':   exportScreenshot(); break;
    case 'export-shots': exportOrbitShots(); break;
    case 'save-preset':  saveControlsPreset(); break;
    case 'delete':    doc.removeSelected(); break;
    case 'duplicate': if (doc.selectedId) doc.duplicate(doc.selectedId); break;
    case 'group':     groupSelected(); break;
    case 'intersect': intersectSelected(); break;
    case 'ungroup':   ungroupSelected(); break;
    case 'undo':      doc.undo(); break;
    case 'export-stl':
      if (exportSTL(doc.list, undefined, displayUnit)) flash(`Exported STL (${unitLabel(displayUnit)} units).`);
      else flash('Nothing printable to export — add a solid first.');
      break;
    case 'export-3mf':
      if (export3MF(doc.list, undefined, displayUnit)) flash(`Exported 3MF (${unitLabel(displayUnit)} units).`);
      else flash('Nothing printable to export — add a solid first.');
      break;
    case 'drop-floor':   dropToFloor(); break;
    case 'sketch':       toggleSketch(); break;
    case 'timeline':     timeline.toggle(); break;
    case 'shortcuts':    toggleShortcuts(); break;
    case 'new-project':
      doc.newScene();
      clearAutosave();        // deliberate clean slate: forget the restored session
      flash('New scene. Canvas cleared.');
      break;
    case 'save-project':
      if (doc.list.length) { downloadJSON(doc.toJSON()); flash('Project saved.'); }
      else flash('Nothing to save yet.');
      break;
    case 'load-project': document.getElementById('file-input').click(); break;
    case 'selftest':  runSelfTest(); break;
  }
});

document.getElementById('file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    doc.loadJSON(JSON.parse(await file.text()));
    flash(`Loaded ${file.name}.`);
  } catch (err) {
    console.error('[CADence] load error:', err);
    flash('Could not load that file — see console.');
  }
  e.target.value = '';   // allow re-loading the same file
});

async function runSelfTest() {
  flash('Running kernel self-test…');
  try {
    const results = await kernelSelfTest();
    const pass = results.filter((r) => r.pass).length;
    console.group(`%cCADence kernel self-test — ${pass}/${results.length} passed`, 'font-weight:bold');
    results.forEach((r) => console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`));
    console.groupEnd();
    flash(`Kernel self-test: ${pass}/${results.length} passed — details in console (F12).`);
  } catch (err) {
    console.error('[CADence] self-test error:', err);
    flash('Self-test errored — see console.');
  }
}

const snapToggle = document.getElementById('snap-toggle');
snapToggle.addEventListener('change', (e) => applySnap(e.target.checked));
['snap-move', 'snap-rot'].forEach((id) =>
  document.getElementById(id).addEventListener('change', () => applySnap(snapToggle.checked)));

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;     // don't hijack typing in fields
  const k = e.key.toLowerCase();

  if (k === 'w') setMode('translate');
  else if (k === 'e') setMode('rotate');
  else if (k === 'r') setMode('scale');
  else if ((k === 'delete' || k === 'backspace') && doc.selection.size) { doc.removeSelected(); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); doc.selectAll(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'c') { const c = doc.copySelection(); if (c.length) { clipboard = c; flash(`Copied ${c.length}.`); } e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'v') { if (clipboard.length) { doc.paste(clipboard); flash('Pasted.'); } e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? doc.redo() : doc.undo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); doc.redo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'd') { if (doc.selectedId) doc.duplicate(doc.selectedId); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'g') { e.preventDefault(); e.shiftKey ? ungroupSelected() : groupSelected(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'i') { e.preventDefault(); intersectSelected(); }
  else if (k === 'f') frameSelection();
  else if (k === 't') timeline.toggle();
  else if (k === 'l') toggleLasso();
  else if (k === 'm') toggleMeasure();
  else if (k === 's' && !e.ctrlKey && !e.metaKey) toggleSketch();
  else if (k === 'enter' && sketchOn) { e.preventDefault(); closeSketch(); }
  else if (k === '?') toggleShortcuts();
  else if (k.startsWith('arrow') && doc.selection.size) { e.preventDefault(); nudgeSelection(k, e.shiftKey, e.repeat); }
  else if (k === 'escape') {
    if (!document.getElementById('shortcuts-overlay').hidden) toggleShortcuts(false);
    else if (sketchOn) setSketch(false);
    else if (lassoOn) setLasso(false);
    else if (measureOn) setMeasure(false);
    else doc.select(null);
  }
});

// Shortcuts overlay: close on its ✕ button or by clicking the dim backdrop.
document.getElementById('tl-close').addEventListener('click', () => timeline.toggle(false));
document.getElementById('shortcuts-close').addEventListener('click', () => toggleShortcuts(false));
document.getElementById('shortcuts-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'shortcuts-overlay') toggleShortcuts(false);
});

function setMode(mode) {
  gizmo.setMode(mode);
  document.querySelectorAll('button.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}

// Arrow keys nudge the selection by the snap step (1 mm if snapping is off) in
// the ground plane; hold Shift to nudge vertically (Y). One undo step per hold.
function nudgeSelection(key, shift, repeat) {
  const step = snapToggle.checked ? (parseFloat(document.getElementById('snap-move').value) || 1) : 1;
  const d = new THREE.Vector3();
  if (key === 'arrowleft') d.x = -step;
  else if (key === 'arrowright') d.x = step;
  else if (key === 'arrowup') shift ? (d.y = step) : (d.z = -step);
  else if (key === 'arrowdown') shift ? (d.y = -step) : (d.z = step);
  else return;
  if (!repeat) doc.commit('Nudge');
  for (const o of doc.selectedObjects) o.mesh.position.add(d);
  if (doc.selected) doc.touch(doc.selected);
  setStatus();
}

// ---------------------------------------------------------------- status bar
const statusbar = document.getElementById('statusbar');
function setStatus() {
  if (measureOn && measureText) { statusbar.innerHTML = `<span>${measureText}</span><span class="units">units: mm</span>`; return; }
  const sel = doc.selected;
  const n = doc.selection.size;
  let left;
  if (measureOn) left = 'Measure: click two points on objects to read the distance. Esc/M to exit.';
  else if (n > 1) left = `<b>${n}</b> objects selected — Group (Ctrl+G) to combine`;
  else if (sel) left = `<b>${sel.name}</b> · ${sel.kind}${sel.role === 'hole' ? ` · <span style="color:#ff8a8a">${ROLE_LABELS.hole}</span>` : ''} · pos (${fmt(sel.mesh.position)}) mm`;
  else left = `${doc.list.length} object${doc.list.length === 1 ? '' : 's'} — click to select · Shift-click adds`;
  statusbar.innerHTML = `<span>${left}</span><span class="units">units: mm</span>`;
}
const fmt = (v) => [v.x, v.y, v.z].map((n) => n.toFixed(1)).join(', ');
function flash(msg) {
  statusbar.innerHTML = `<span>${msg}</span><span class="units">units: mm</span>`;
  setTimeout(setStatus, 2500);
}

// ---------------------------------------------------------------- render modes
// How solids are drawn. Implemented as reversible tweaks on each object's own
// MeshStandardMaterial (never a swap), so selection-emissive, holes, and undo all
// keep working — and any mode is one step from baseline.
let renderMode = 'shaded';

function styleMaterial(o) {
  const m = o.mesh.material;
  if (!m || !('wireframe' in m)) return;
  const isHole = o.role === 'hole';
  // Reset to the baseline CadObject._material() produces…
  m.wireframe = false;
  m.metalness = 0.05; m.roughness = 0.65;
  m.transparent = isHole; m.opacity = isHole ? 0.35 : 1; m.depthWrite = !isHole;
  // …then layer the active mode on top.
  if (renderMode === 'wireframe') m.wireframe = true;
  else if (renderMode === 'matte') { m.metalness = 0; m.roughness = 1; }
  else if (renderMode === 'xray') { m.transparent = true; m.opacity = 0.3; m.depthWrite = false; }
  m.needsUpdate = true;
}

function applyRenderMode(id) { renderMode = id; for (const o of doc.list) styleMaterial(o); }
// Switch the display/export unit: re-render the Inspector so its size readout
// re-expresses in the new unit. Modeling values (recipes, positions) are untouched.
function applyUnits(id) { displayUnit = id; inspector.render(); }

// Keep the active render mode applied as the scene changes identity (add, undo,
// regroup all mint fresh meshes/materials).
doc.addEventListener('add', (e) => styleMaterial(e.detail));
doc.addEventListener('change', (e) => { if (e.detail) styleMaterial(e.detail); });
doc.addEventListener('regroup', () => doc.list.forEach(styleMaterial));
doc.addEventListener('undo', () => doc.list.forEach(styleMaterial));

// ---------------------------------------------------------------- lasso select
// A mode (toolbar button / L): while on, left-drag draws a freehand loop and
// everything whose center falls inside it gets selected. Orbit is suspended so
// the drag belongs to the lasso; Esc or L exits.
const SVGNS = 'http://www.w3.org/2000/svg';
let lassoOn = false, lassoActive = false, lassoPts = [], lassoShift = false;
let lassoSvg = null, lassoPath = null;

function ensureLassoSvg() {
  if (lassoSvg) return;
  lassoSvg = document.createElementNS(SVGNS, 'svg');
  lassoSvg.id = 'lasso-svg';
  lassoPath = document.createElementNS(SVGNS, 'path');
  lassoSvg.appendChild(lassoPath);
  document.getElementById('app').appendChild(lassoSvg);
}

function setLasso(on) {
  lassoOn = on;
  if (on && measureOn) setMeasure(false);    // one viewport mode at a time
  orbit.enabled = !on;                       // give the drag to the lasso, not the camera
  gizmo.enabled = !on;                       // stop the transform gizmo eating the drag
  gizmo.visible = !on;                        // and hide it so the loop reads clearly
  renderer.domElement.style.cursor = on ? 'crosshair' : '';
  document.getElementById('lasso-btn')?.classList.toggle('active', on);
  if (!on) { clearLasso(); refreshSelectionView(); }   // restore gizmo on the primary
  flash(on ? 'Lasso on — drag a loop around objects. Esc or L to exit.' : 'Lasso off.');
}
function toggleLasso() { setLasso(!lassoOn); }

function clearLasso() {
  lassoActive = false; lassoPts = [];
  window.removeEventListener('pointermove', lassoMove, true);
  window.removeEventListener('pointerup', lassoUp, true);
  if (lassoPath) lassoPath.removeAttribute('d');
}

function lassoStart(e) {
  ensureLassoSvg();
  e.preventDefault();
  lassoActive = true; lassoShift = e.shiftKey; lassoPts = [[e.clientX, e.clientY]];
  updateLassoPath();
  // Track on window (capture) so the drag survives leaving the canvas or a missed
  // pointer-capture — the old canvas-only listeners left lassoActive stuck if the
  // pointer was released off-canvas.
  window.addEventListener('pointermove', lassoMove, true);
  window.addEventListener('pointerup', lassoUp, true);
}
function lassoMove(e) { if (!lassoActive) return; lassoPts.push([e.clientX, e.clientY]); updateLassoPath(); }
function lassoUp(e) { if (lassoActive) lassoEnd(e); }
function updateLassoPath() {
  if (!lassoPath || !lassoPts.length) return;
  lassoPath.setAttribute('d', lassoPts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ') + ' Z');
}

function lassoEnd(e) {
  const pts = lassoPts.slice();
  clearLasso();
  // A tiny loop is really a click — fall back to single-pick so the tool still
  // selects one object cleanly.
  if (pts.length < 3 || polyArea(pts) < 25) { pickAt(e); return; }

  const inside = [];
  for (const o of doc.list) {
    if (o.mesh.visible === false) continue;
    const sp = objScreenPoint(o);
    if (sp && pointInPoly(sp, pts)) inside.push(o.id);
  }
  if (!lassoShift) doc.select(null);
  if (!inside.length) { flash('Lasso caught nothing.'); return; }
  for (const id of inside) doc.select(id, true);
  flash(`Lassoed ${inside.length} object${inside.length === 1 ? '' : 's'}.`);
}

function objScreenPoint(o) {
  o.mesh.updateWorldMatrix(true, false);
  const c = new THREE.Box3().setFromObject(o.mesh).getCenter(new THREE.Vector3());
  c.project(camera);
  if (c.z > 1) return null;                  // behind the camera — not on screen
  const r = renderer.domElement.getBoundingClientRect();
  return [(c.x * 0.5 + 0.5) * r.width + r.left, (-c.y * 0.5 + 0.5) * r.height + r.top];
}
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
}

// ---------------------------------------------------------------- measure tool
// A mode (toolbar / M): click two points on object surfaces to read the straight-
// line distance and per-axis deltas. Orbit stays live, so drag still rotates.
let measureOn = false;
let measurePts = [];          // up to 2 world-space points
let measureText = '';
const measureGroup = new THREE.Group();
scene.add(measureGroup);
const MEASURE_COLOR = 0xffd54a;

function disposeMeasureChildren() {
  for (const c of [...measureGroup.children]) { c.geometry?.dispose(); c.material?.dispose(); measureGroup.remove(c); }
}
function clearMeasure() { measurePts = []; measureText = ''; disposeMeasureChildren(); }

function setMeasure(on) {
  measureOn = on;
  if (on && lassoOn) setLasso(false);          // one viewport mode at a time
  gizmo.enabled = !on;                         // don't let the gizmo swallow measure clicks
  renderer.domElement.style.cursor = on ? 'crosshair' : '';
  document.getElementById('measure-btn')?.classList.toggle('active', on);
  if (!on) clearMeasure();
  flash(on ? 'Measure on — click two points (snaps to nearby corners). Esc or M to exit.' : 'Measure off.');
}
function toggleMeasure() { setMeasure(!measureOn); }

// Snap a measure click to the nearest geometry vertex of the clicked object when
// the cursor is within a few pixels of one — so distances land on exact corners,
// not arbitrary surface points. Falls back to the raw surface hit otherwise.
function snapToVertex(hit, e) {
  const mesh = hit.object;
  const posAttr = mesh.geometry?.getAttribute('position');
  if (!posAttr) return hit.point.clone();
  mesh.updateWorldMatrix(true, false);
  const r = renderer.domElement.getBoundingClientRect();
  const v = new THREE.Vector3();
  let best = null, bestPx = 14;                              // snap radius, screen pixels
  const step = Math.max(1, Math.floor(posAttr.count / 4000)); // cap work on dense meshes
  for (let i = 0; i < posAttr.count; i += step) {
    v.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
    const p = v.clone().project(camera);
    if (p.z > 1) continue;
    const sx = (p.x * 0.5 + 0.5) * r.width + r.left;
    const sy = (-p.y * 0.5 + 0.5) * r.height + r.top;
    const px = Math.hypot(sx - e.clientX, sy - e.clientY);
    if (px < bestPx) { bestPx = px; best = v.clone(); }
  }
  return best || hit.point.clone();
}

function measureClick(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  const meshes = doc.list.map((o) => o.mesh).filter((m) => m.visible !== false);
  const hit = ray.intersectObjects(meshes, false)[0];
  if (!hit) { flash('Click on an object surface to drop a measure point.'); return; }
  if (measurePts.length >= 2) clearMeasure();   // a third click starts a fresh measurement
  measurePts.push(snapToVertex(hit, e));
  drawMeasure();
  if (measurePts.length === 2) {
    const [a, b] = measurePts;
    measureText = `Distance: <b>${a.distanceTo(b).toFixed(2)}</b> mm &nbsp;(Δ ${Math.abs(b.x - a.x).toFixed(2)}, ${Math.abs(b.y - a.y).toFixed(2)}, ${Math.abs(b.z - a.z).toFixed(2)})`;
  } else {
    measureText = 'First point set — click a second point.';
  }
  setStatus();
}

function drawMeasure() {
  disposeMeasureChildren();
  for (const p of measurePts) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 12), new THREE.MeshBasicMaterial({ color: MEASURE_COLOR, depthTest: false }));
    dot.position.copy(p); dot.renderOrder = 999;
    measureGroup.add(dot);
  }
  if (measurePts.length === 2) {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(measurePts), new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false }));
    line.renderOrder = 999;
    measureGroup.add(line);
  }
}

// ---------------------------------------------------------------- sketch tool
// A mode (toolbar / S): click points on the ground plane to lay down a closed 2D
// profile, then Enter (or click back on the first point) to turn it into a solid
// via the sketch feature — extrude by default. The result is a parametric sketch
// object (profile + op + depth), so it's editable and lands on the Recipe Timeline.
let sketchOn = false;
let sketchPts = [];                 // world-space ground points (THREE.Vector3)
const sketchGroup = new THREE.Group();
scene.add(sketchGroup);
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const SKETCH_COLOR = 0x4fd0ff;

function disposeSketchPreview() {
  for (const c of [...sketchGroup.children]) { c.geometry?.dispose(); c.material?.dispose(); sketchGroup.remove(c); }
}
function setSketch(on) {
  sketchOn = on;
  if (on) { if (lassoOn) setLasso(false); if (measureOn) setMeasure(false); }
  gizmo.enabled = !on;                          // don't let the gizmo eat sketch clicks
  renderer.domElement.style.cursor = on ? 'crosshair' : '';
  document.getElementById('sketch-btn')?.classList.toggle('active', on);
  if (!on) { sketchPts = []; disposeSketchPreview(); }
  flash(on ? 'Sketch on — click points on the ground; Enter (or click the first point) to finish. Esc cancels.' : 'Sketch off.');
}
function toggleSketch() { setSketch(!sketchOn); }

function groundPoint(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  const hit = new THREE.Vector3();
  return ray.ray.intersectPlane(GROUND, hit) ? hit : null;
}

function sketchClick(e) {
  const p = groundPoint(e);
  if (!p) { flash('Aim at the ground plane to drop a sketch point.'); return; }
  // Click near the first point to close the loop.
  if (sketchPts.length >= 3 && p.distanceTo(sketchPts[0]) < 3) { closeSketch(); return; }
  sketchPts.push(p.clone());
  drawSketchPreview();
}

function drawSketchPreview() {
  disposeSketchPreview();
  for (const p of sketchPts) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 8), new THREE.MeshBasicMaterial({ color: SKETCH_COLOR, depthTest: false }));
    dot.position.copy(p); dot.renderOrder = 999;
    sketchGroup.add(dot);
  }
  if (sketchPts.length >= 2) {
    const loop = sketchPts.length >= 3 ? [...sketchPts, sketchPts[0]] : sketchPts;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop), new THREE.LineBasicMaterial({ color: SKETCH_COLOR, depthTest: false }));
    line.renderOrder = 999;
    sketchGroup.add(line);
  }
}

function closeSketch() {
  if (sketchPts.length < 3) { flash('Need at least 3 points to close a sketch.'); return; }
  // Center the profile on its centroid, place the object there — keeps the recipe
  // tidy and the geometry local.
  const cx = sketchPts.reduce((s, p) => s + p.x, 0) / sketchPts.length;
  const cz = sketchPts.reduce((s, p) => s + p.z, 0) / sketchPts.length;
  const profile = sketchPts.map((p) => [p.x - cx, p.z - cz]);
  const obj = doc.add('sketch', { profile, op: 'extrude', depth: 20 });
  obj.mesh.position.set(cx, 0, cz);
  doc.touch(obj);
  setSketch(false);
  flash('Sketch extruded into a solid. Edit its profile, extrude, or switch to revolve in the Inspector.');
}

// ---------------------------------------------------------------- image export
function dataURLToU8(url) {
  const bin = atob(url.split(',')[1]);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function snapshotURL() { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); }

function exportScreenshot() {
  const a = document.createElement('a');
  a.href = snapshotURL(); a.download = 'cadence-view.png'; a.click();
  flash('Saved screenshot (PNG).');
}

// Six canonical angles; each entry is a direction the camera sits along, looking
// back at the framed scene center.
const SHOT_VIEWS = {
  iso:   [1, 0.8, 1],
  front: [0, 0, 1],
  back:  [0, 0, -1],
  right: [1, 0, 0],
  left:  [-1, 0, 0],
  top:   [0, 1, 0.001],   // tiny z so 'up' isn't parallel to the view direction
};

function exportOrbitShots() {
  if (!doc.list.length) { flash('Nothing to shoot — add a solid first.'); return; }
  const box = new THREE.Box3();
  for (const o of doc.list) { o.mesh.updateWorldMatrix(true, false); box.expandByObject(o.mesh); }
  if (box.isEmpty()) { flash('Nothing visible to shoot.'); return; }
  const center = box.getCenter(new THREE.Vector3());
  const diag = box.getSize(new THREE.Vector3()).length() || 40;
  const dist = (diag * 0.5) / Math.tan((camera.fov * Math.PI / 180) / 2) * 1.5;

  const savePos = camera.position.clone();
  const saveTarget = orbit.target.clone();
  const files = {};
  for (const [name, dir] of Object.entries(SHOT_VIEWS)) {
    const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
    camera.position.copy(center).addScaledVector(d, Math.max(dist, diag));
    camera.lookAt(center);
    camera.updateMatrixWorld();
    files[`cadence-${name}.png`] = dataURLToU8(snapshotURL());
  }
  // Restore the user's exact viewpoint.
  camera.position.copy(savePos);
  orbit.target.copy(saveTarget);
  orbit.update();

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([zipSync(files)], { type: 'application/zip' }));
  a.download = 'cadence-shots.zip'; a.click();
  URL.revokeObjectURL(a.href);
  flash('Saved 6 orbit shots (zip).');
}

// ---------------------------------------------------------------- hover hints
// Mousing over any control writes its explanation into the status bar (bottom
// left). Reads data-hint, falling back to the element's title.
function wireHints() {
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-hint], [title]');
    const hint = el && (el.dataset.hint || el.getAttribute('title'));
    if (hint) statusbar.innerHTML = `<span>${hint}</span><span class="units">units: mm</span>`;
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-hint], [title]')) setStatus();
  });
}

// ---------------------------------------------------------------- arrange tools
// Align / distribute / drop-to-floor work on world-space bounding boxes, so they
// behave intuitively regardless of an object's rotation or scale.
function worldBox(o) { o.mesh.updateWorldMatrix(true, false); return new THREE.Box3().setFromObject(o.mesh); }
function boxCenter(b, a) { return (b.min[a] + b.max[a]) / 2; }

// Align selected objects on an axis by their world-space bounding boxes. mode =
// 'min' (low faces flush), 'center' (centers level), or 'max' (high faces flush).
function align(axis, mode = 'center') {
  const objs = doc.selectedObjects;
  if (objs.length < 2) { flash('Select 2+ objects to align (Shift-click them).'); return; }
  const edge = (b) => (mode === 'min' ? b.min[axis] : mode === 'max' ? b.max[axis] : boxCenter(b, axis));
  doc.commit(`Align ${mode} ${axis.toUpperCase()}`);
  const boxes = objs.map(worldBox);
  let target;
  if (mode === 'min') target = Math.min(...boxes.map((b) => b.min[axis]));
  else if (mode === 'max') target = Math.max(...boxes.map((b) => b.max[axis]));
  else target = (Math.min(...boxes.map((b) => b.min[axis])) + Math.max(...boxes.map((b) => b.max[axis]))) / 2;
  objs.forEach((o, i) => { o.mesh.position[axis] += target - edge(boxes[i]); doc.touch(o); });
  setStatus();
  flash(`Aligned ${objs.length} on ${axis.toUpperCase()} ${mode}.`);
}

function distribute(axis) {
  const objs = doc.selectedObjects;
  if (objs.length < 3) { flash('Select 3+ objects to distribute evenly.'); return; }
  doc.commit('Distribute ' + axis.toUpperCase());
  const items = objs.map((o) => ({ o, center: boxCenter(worldBox(o), axis) })).sort((a, b) => a.center - b.center);
  const lo = items[0].center, hi = items[items.length - 1].center;
  const gap = (hi - lo) / (items.length - 1);
  items.forEach((it, i) => { it.o.mesh.position[axis] += (lo + gap * i) - it.center; doc.touch(it.o); });
  setStatus();
  flash(`Distributed ${objs.length} on ${axis.toUpperCase()}.`);
}

// Sit each object's bottom on the ground (Y=0) — independent per object, so a
// scene is print-ready in one click.
function dropToFloor() {
  const objs = doc.selectedObjects.length ? doc.selectedObjects : doc.list;
  if (!objs.length) { flash('Nothing to drop.'); return; }
  doc.commit('Drop to floor');
  for (const o of objs) { o.mesh.position.y -= worldBox(o).min.y; doc.touch(o); }
  setStatus();
  flash(`Dropped ${objs.length} to the floor (Y=0).`);
}

// ---------------------------------------------------------------- shortcuts overlay
function toggleShortcuts(force) {
  const ov = document.getElementById('shortcuts-overlay');
  ov.hidden = force != null ? !force : !ov.hidden;
}

// ---------------------------------------------------------------- collapsible panels
// Adds a –/+ toggle to a panel's header; collapsing hides all but that header.
function makeCollapsible(panelId, headSelector) {
  const panel = document.getElementById(panelId);
  const head = panel?.querySelector(headSelector);
  if (!head) return;
  const btn = document.createElement('button');
  btn.className = 'collapse-btn';
  btn.title = 'Collapse / expand this panel';
  btn.textContent = '–';
  btn.addEventListener('click', () => { btn.textContent = panel.classList.toggle('collapsed') ? '+' : '–'; });
  head.appendChild(btn);
}

// ---------------------------------------------------------------- resizable panels
// A drag handle on a panel's inner edge sets a CSS width variable (persisted), so
// the left toolbar and right inspector/outliner can be widened — handy when long
// numbers would otherwise clip.
const PANEL_MIN = 170, PANEL_MAX = 560;
// The handle lives in #app (overflow:visible), NOT inside the panel — a panel's
// `overflow-y:auto` also clips horizontal overflow, which hid the old edge handle.
// It's a full-height gutter strip anchored to the panel edge via the width var.
function makeResizable(cls, cssVar, grows) {
  const app = document.getElementById('app');
  const handle = document.createElement('div');
  handle.className = `resize-handle ${cls}`;
  handle.dataset.hint = 'Drag to resize this panel';
  app.appendChild(handle);
  const curW = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10) || 200;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    const startX = e.clientX, startW = curW();
    const onMove = (ev) => {
      const delta = grows === 'right' ? ev.clientX - startX : startX - ev.clientX;
      const w = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(startW + delta)));
      document.documentElement.style.setProperty(cssVar, w + 'px');
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.classList.remove('dragging');
      localStorage.setItem('cad.' + cssVar, document.documentElement.style.getPropertyValue(cssVar));
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}
function restorePanelWidth(cssVar) {
  const w = localStorage.getItem('cad.' + cssVar);
  if (w) document.documentElement.style.setProperty(cssVar, w);
}

// ---------------------------------------------------------------- settings
const settings = loadSettings();

function fillSelect(id, items, current) {
  const sel = document.getElementById(id);
  sel.innerHTML = items.map((it) => `<option value="${it.id}">${it.label}</option>`).join('');
  sel.value = current;
}

function applyUiStyle(id) {
  document.documentElement.dataset.ui = id;
  // Tie the viewport background to the palette so panel + scene feel cohesive.
  const bg = { paper: 0xdfe3e8, plush: 0xece4fb, blueprint: 0x0a1622, neon: 0x0d0a18, graphite: 0x0b0d10 }[id] ?? 0x0e1116;
  scene.background = new THREE.Color(bg);
}

// --- controls: built-in presets + per-button custom + saveable user presets ---
function allControlPresets() { return [...CONTROL_PRESETS, ...(settings.userPresets || [])]; }
function presetMap(id) { const p = allControlPresets().find((x) => x.id === id); return p ? p.map : null; }
// The map actually applied: an explicit custom/saved map wins, else derive from
// the selected built-in preset.
function activeMap() { return settings.map || presetMap(settings.controls) || controlMap('cadence'); }

function applyControlsMap(map) {
  const v = (verb) => (verb === 'NONE' ? -1 : THREE.MOUSE[verb]);   // -1 = button does nothing
  orbit.mouseButtons = { LEFT: v(map.LEFT), MIDDLE: v(map.MIDDLE), RIGHT: v(map.RIGHT) };
}

function fillControlsSelect() {
  const sel = document.getElementById('set-controls');
  sel.innerHTML = allControlPresets().map((p) => `<option value="${p.id}">${p.label}</option>`).join('')
    + '<option value="custom">Custom…</option>';
  sel.value = settings.controls;
}

const MAP_SELECTS = [['map-left', 'LEFT'], ['map-middle', 'MIDDLE'], ['map-right', 'RIGHT']];
function fillButtonMap(map) {
  for (const [id, btn] of MAP_SELECTS) {
    const sel = document.getElementById(id);
    sel.innerHTML = NAV_VERBS.map((v) => `<option value="${v.id}">${v.label}</option>`).join('');
    sel.value = map[btn];
  }
}

// Apply a map, remember it, and sync every control widget to it.
function setControls(map, presetId) {
  settings.map = { ...map };
  settings.controls = presetId;
  applyControlsMap(map);
  fillButtonMap(map);
  document.getElementById('set-controls').value = presetId;
  saveSettings(settings);
}

function readButtonMap() {
  return {
    LEFT: document.getElementById('map-left').value,
    MIDDLE: document.getElementById('map-middle').value,
    RIGHT: document.getElementById('map-right').value,
  };
}

function saveControlsPreset() {
  const name = prompt('Name this controls preset:');
  if (!name || !name.trim()) return;
  const id = 'user-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36);
  settings.userPresets = settings.userPresets || [];
  settings.userPresets.push({ id, label: name.trim(), map: { ...activeMap() } });
  settings.controls = id;
  saveSettings(settings);
  fillControlsSelect();
  document.getElementById('set-controls').value = id;
  flash(`Saved controls preset "${name.trim()}".`);
}

function initControls() {
  const m = activeMap();
  fillControlsSelect();
  fillButtonMap(m);
  applyControlsMap(m);

  document.getElementById('set-controls').addEventListener('change', (e) => {
    const id = e.target.value;
    if (id === 'custom') { settings.controls = 'custom'; saveSettings(settings); return; }
    const map = presetMap(id);
    if (map) { setControls(map, id); flash(`Controls: ${e.target.selectedOptions[0].text}.`); }
  });

  for (const [id] of MAP_SELECTS) {
    document.getElementById(id).addEventListener('change', () => { setControls(readButtonMap(), 'custom'); flash('Custom controls applied.'); });
  }
}

function initSettings() {
  fillSelect('set-ui', UI_STYLES, settings.ui);
  fillSelect('set-render', RENDER_MODES, settings.render);
  fillSelect('set-units', UNITS, settings.units);
  applyUiStyle(settings.ui);
  applyRenderMode(settings.render);
  applyUnits(settings.units);
  initControls();

  const bind = (id, key, apply) => document.getElementById(id).addEventListener('change', (e) => {
    settings[key] = e.target.value; apply(settings[key]); saveSettings(settings);
    flash(`${e.target.previousElementSibling.textContent}: ${e.target.selectedOptions[0].text}.`);
  });
  bind('set-ui', 'ui', applyUiStyle);
  bind('set-render', 'render', applyRenderMode);
  bind('set-units', 'units', applyUnits);

  makeCollapsible('toolbar', '.brand');
  makeCollapsible('inspector', '.group-label');
  makeCollapsible('outliner', '.group-label');

  restorePanelWidth('--toolbar-w');
  restorePanelWidth('--side-w');
  makeResizable('toolbar', '--toolbar-w', 'right');   // left panel: drag its right edge
  makeResizable('side', '--side-w', 'left');           // right panels share one edge handle
  wireHints();
}

// ---------------------------------------------------------------- resize + loop
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function tick() {
  requestAnimationFrame(tick);
  orbit.update();
  renderer.render(scene, camera);
  dimchips.update();
}
tick();

// Pre-warm the boolean kernel in the background so the first Group is snappy.
warmKernel();

// Apply saved preferences (UI style, render mode, controls) and wire hover hints
// before seeding, so the first object is drawn in the active render mode.
initSettings();

// Restore the last autosaved project before the first render, so a reload — or
// reopening from the portfolio preview iframe in a fresh tab — picks up exactly
// where the session left off. If there's nothing valid to restore, seed a starter
// box so first load isn't empty.
if (!restoreAutosave(doc)) doc.add('box');
setStatus();

// Expose for console tinkering / debugging.
window.cadence = { doc, scene, THREE };
