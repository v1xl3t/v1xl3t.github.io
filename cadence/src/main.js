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
import { initRenderView } from './renderview.js';

import { CadDocument } from './model.js';
import {
  createSketch, addPoint, addLine, addCircle, addConstraint, addRectangle,
  solveSketch, sketchProfile, cloneSketch,
  isDimension, constraintLabel, setDimension,
  filletCorner, filletableCorners,
} from './sketch.js';
import { suggestedDepth } from './profile.js';
import { planeFromNormal, sketchToWorld, isGroundPlane } from './primitives.js';
import { Inspector } from './ui.js';
import { Outliner } from './outliner.js';
import { Timeline } from './timeline.js';
import { SliceView } from './sliceview.js';
import { DimChips } from './dimchips.js';
import { exportSTL, export3MF, downloadJSON } from './io.js';
import { scheduleAutosave, restoreAutosave, clearAutosave } from './autosave.js';
import { buildShareLink, tryLoadSharedLink } from './sharelink.js';
import { warmKernel, kernelSelfTest } from './kernel.js';
import { ROLE_LABELS } from './primitives.js';
import { loadSettings, saveSettings, UI_STYLES, RENDER_MODES, UNITS, CONTROL_PRESETS, NAV_VERBS, EXPERIMENTAL_FEATURES, controlMap, unitLabel } from './settings.js';
import { zipSync } from 'fflate';

// Launched as a read-only portfolio viewer? (?model= / ?models= / ?view=render)
// In that mode we don't seed a starter cube, restore, or autosave — the scene
// is driven entirely by the URL so it never clobbers a real user's document.
const IS_VIEWER = (() => {
  try { const q = new URLSearchParams(location.search); return q.has('model') || q.has('models') || q.get('view') === 'render'; }
  catch { return false; }
})();

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
// GridHelper bakes its colours into vertex colours, so a skin change has to
// rebuild it rather than tint a material. Cheap: it happens on skin swap only.
let grid = null;
function setGrid(major, minor) {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  grid = new THREE.GridHelper(1000, 100, major, minor);
  grid.position.y = 0;
  scene.add(grid);
}
setGrid(0x3a4654, 0x232b34);

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
// Touch gestures: one finger orbits, two fingers pan + pinch-zoom together.
orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

// Is this primarily a touch device? Used to fatten the gizmo and tweak UI.
const COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;

const gizmo = new TransformControls(camera, renderer.domElement);
// A bigger gizmo on touch gives fingertips a real hit area on the handles.
gizmo.setSize(COARSE_POINTER ? 1.5 : 0.9);
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
doc.addEventListener('history', () => { if (!IS_VIEWER) scheduleAutosave(doc); });

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
    flash(grp ? 'Grouped into one watertight body.' : 'Only holes selected, nothing to keep.');
  } catch (err) {
    console.error('[CADence] boolean kernel error:', err);
    flash('Boolean kernel failed to load or run. See console.');
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
    flash('Intersect failed. See console.');
  }
}

// Frame the camera on the current selection (or the whole scene if nothing is
// selected). Keeps the current viewing direction, just re-centers and fits.
function frameSelection() {
  const objs = doc.selection.size ? doc.selectedObjects : doc.list;
  // Silence is the wrong answer to a button press. Without this, Frame on an
  // empty scene leaves the status bar showing the button's own hover hint,
  // which reads as "nothing happened and nobody knows why".
  if (!objs.length) { flash('Nothing to frame yet. Add a shape first.'); return; }
  const box = new THREE.Box3();
  for (const o of objs) { o.mesh.updateWorldMatrix(true, false); box.expandByObject(o.mesh); }
  frameBox(box);
}

/** Fit the camera to a box, keeping the direction it is already looking from. */
function frameBox(box) {
  if (!box || box.isEmpty()) return;
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
const inspector = new Inspector(doc, {
  onChange: () => setStatus(),
  units: () => displayUnit,
  onNotice: (msg) => flash(msg),      // a refused dimension explains itself
});
const outliner = new Outliner(doc);
wireSketchBar();

// Recipe Timeline — the multiverse history strip. Clicking a tile time-travels;
// acting from a past tile forks a new branch (5D-chess style).
const timeline = new Timeline(doc, { onGoto: (id) => doc.goToHistory(id) });
// The slicer owns its own preview group in the scene and its own panel. It is
// handed `flash` rather than reaching for the status bar itself, so every
// message in the app still goes through one place.
const sliceView = new SliceView(scene, doc, {
  flash: (m) => flash(m),
  onOpen: () => { if (COARSE_POINTER) closeDrawers(); },
  // A finished slice is a new thing to look at, and the toolpaths of a small
  // part are a few millimetres of thin line in a viewport scaled for modelling.
  // Framing them is the difference between seeing the preview and being told it
  // is there.
  onSliced: (group) => frameBox(new THREE.Box3().setFromObject(group)),
  // Dimension chips annotate a solid. While the preview is up that solid is
  // hidden, so the chips are labels pointing at nothing, floating over a
  // toolpath they do not describe.
  onVisibility: (previewShowing) => dimchips?.setEnabled?.(!previewShowing && experimentalOn()),
});
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
// The sketcher's rubber band and coordinate readout follow the cursor.
renderer.domElement.addEventListener('pointermove', (e) => {
  if (exObj) { extrudeDragMove(e); return; }     // the stage owns the pointer
  if (sketchOn) sketchMove(e);
});
// Lasso begins on a window capture-phase listener so it runs BEFORE OrbitControls
// and TransformControls (whose listeners are on the canvas) and can't be swallowed
// by them — and stopPropagation keeps them from also acting on the same press.
window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target !== renderer.domElement) return;
  // The extrude stage claims the drag before OrbitControls can read it as an
  // orbit, same trick the lasso uses.
  if (exObj) { e.stopPropagation(); extrudeDragStart(e); return; }
  if (!lassoOn) return;
  e.stopPropagation();
  lassoStart(e);
}, true);
window.addEventListener('pointerup', () => { if (exDragging) extrudeDragEnd(); }, true);
renderer.domElement.addEventListener('pointerup', (e) => {
  if (lassoActive) return;            // lasso runs its own window-level drag
  if (gizmo.dragging || !downAt) return;
  // Treat as a click only if the pointer barely moved (otherwise it was an orbit).
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
  if (exObj) return;                  // a click in the view means nothing mid-extrude
  if (sketchOn) { sketchClick(e); return; }
  if (measureOn) { measureClick(e); return; }
  pickAt(e);
});

function pickAt(e) {
  if (document.body.classList.contains('render-view')) return;  // render view = look, don't edit
  const r = renderer.domElement.getBoundingClientRect();
  ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  const meshes = doc.list.map((o) => o.mesh);
  const hit = ray.intersectObjects(meshes, false)[0];
  doc.select(hit ? hit.object.userData.cadId : null, e.shiftKey); // Shift = add to selection
}

// -------------------------------------------------- mini top quick-tools bar
// Each top-bar button just proxies its click to the matching real toolbar button
// (data-proxy = selector), so all existing logic is reused with no duplication.
(function initTopbar() {
  const top = document.getElementById('topbar');
  if (!top) return;
  top.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-proxy]');
    if (!b) return;
    const real = document.querySelector(b.dataset.proxy);
    if (real) real.click();
  });
  // mirror the Box-select toggle state onto its top-bar icon
  const realLasso = document.getElementById('lasso-btn');
  const topLasso = document.getElementById('topbar-lasso');
  if (realLasso && topLasso) {
    const sync = () => topLasso.classList.toggle('active', realLasso.classList.contains('active'));
    new MutationObserver(sync).observe(realLasso, { attributes: true, attributeFilter: ['class'] });
    sync();
  }
})();

// ---------------------------------------------------------------- toolbar
document.getElementById('toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.add) {
    if (btn.dataset.add === 'loft' && !experimentalOn()) {
      flash('Loft is an experimental feature. Turn it on in Settings.');
      return;
    }
    doc.add(btn.dataset.add);
    if (COARSE_POINTER) closeDrawers();   // on touch, reveal the new shape
  }
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
    case 'delete':
      if (doc.selection.size) doc.removeSelected();
      else flash(doc.list.length ? 'Nothing selected. Click an object first.' : 'Nothing to delete.');
      break;
    case 'duplicate':
      if (doc.selectedId) doc.duplicate(doc.selectedId);
      else flash(doc.list.length ? 'Nothing selected. Click an object first.' : 'Nothing to duplicate.');
      break;
    case 'group':     groupSelected(); break;
    case 'intersect': intersectSelected(); break;
    case 'ungroup':   ungroupSelected(); break;
    case 'undo':      doc.undo(); break;
    case 'export-stl':
      if (exportSTL(doc.list, undefined, displayUnit)) flash(`Exported STL (${unitLabel(displayUnit)} units).`);
      else flash('Nothing printable to export. Add a solid first.');
      break;
    case 'export-3mf':
      if (export3MF(doc.list, undefined, displayUnit)) flash(`Exported 3MF (${unitLabel(displayUnit)} units).`);
      else flash('Nothing printable to export. Add a solid first.');
      break;
    case 'drop-floor':   dropToFloor(); break;
    case 'sketch':       toggleSketch(); break;
    case 'timeline':
      if (!experimentalOn()) flash('The Recipe Timeline is an experimental feature. Turn it on in Settings.');
      else timeline.toggle();
      break;
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
    case 'share-link':
      buildShareLink(doc).then(url => {
        if (!url) { flash('Nothing to share yet. Add a solid first.'); return; }
        navigator.clipboard.writeText(url)
          .then(() => flash('Share link copied. Anyone who opens it sees this design.'))
          .catch(() => { prompt('Copy this share link:', url); });
      });
      break;
    case 'slice':
      if (!experimentalOn()) flash('The slicer is an experimental feature. Turn it on in Settings.');
      else {
        sliceView.toggle();
        document.getElementById('slice-btn')?.classList.toggle('active', sliceView.visible);
      }
      break;
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
    flash('Could not load that file. See console.');
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
    flash(`Kernel self-test ${pass}/${results.length} passed. Details in console (F12).`);
  } catch (err) {
    console.error('[CADence] self-test error:', err);
    flash('Self-test errored. See console.');
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

  // The extrude stage is modal: while it is open its keys win outright, so a
  // stray R cannot switch to the scale gizmo mid-operation.
  if (exObj) {
    if (k === 'enter') { e.preventDefault(); commitExtrude(); }
    else if (k === 'escape') { e.preventDefault(); cancelExtrude(); }
    else if (k === 'x') { e.preventDefault(); flipExtrude(); }
    else if (k === 's') { e.preventDefault(); toggleExtrudeSymmetric(); }
    return;
  }

  // Typing a number while a curve is in progress means you want that dimension,
  // not the view shortcut that digit is normally bound to. Route it to the live
  // field before any other binding gets a look at it.
  if (sketchOn && !e.ctrlKey && !e.metaKey && !e.altKey &&
      (/^[0-9]$/.test(e.key) || e.key === '.' || e.key === '-') &&
      hudBeginTyping(e.key)) {
    e.preventDefault();
    return;
  }

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
  else if (k === 'k') {
    if (!experimentalOn()) flash('The slicer is an experimental feature. Turn it on in Settings.');
    else {
      sliceView.toggle();
      document.getElementById('slice-btn')?.classList.toggle('active', sliceView.visible);
    }
  }
  // The layer scrub is on the arrow keys while the slicer is open, because
  // stepping a layer at a time is the whole point of a layer preview and
  // dragging a slider one notch is a poor substitute for it.
  else if (sliceView.visible && (k === 'pageup' || k === 'pagedown')) {
    e.preventDefault();
    sliceView.setLayer(sliceView.layerIndex + (k === 'pageup' ? 1 : -1));
  }
  else if (k === 't') {
    if (!experimentalOn()) flash('The Recipe Timeline is an experimental feature. Turn it on in Settings.');
    else timeline.toggle();
  }
  // Standard views on the number row, the way most CAD packages bind them, plus
  // Home for the 3/4 view you started in.
  else if (!e.ctrlKey && !e.metaKey && ['1', '2', '3', '4', '5', '6'].includes(k)) {
    e.preventDefault();
    snapToView({ 1: 'front', 2: 'back', 3: 'left', 4: 'right', 5: 'top', 6: 'bottom' }[k]);
  }
  else if (k === 'home') { e.preventDefault(); snapToView('iso'); }
  // While the sketcher is open its tool letters win, so L is Line rather than
  // Lasso. Outside sketch mode nothing changes.
  else if (sketchOn && ['l', 'r', 'c', 'd', 'o', 'b'].includes(k) && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setSkTool({ l: 'line', r: 'rect', c: 'circle', d: 'dim', o: 'fillet', b: 'chamfer' }[k]);
  }
  else if (sketchOn && k === 'g' && !e.ctrlKey && !e.metaKey) { skSnap = skSnap > 0 ? 0 : 1; syncSketchBar(); flash(skSnap ? 'Grid snap on, 1mm.' : 'Grid snap off.'); }
  else if (sketchOn && k === 'p' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); resetSketchPlane(); }
  else if (sketchOn && k === 'f' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); faceOnView(); }
  else if (k === 'l') toggleLasso();
  else if (k === 'm') toggleMeasure();
  else if (k === 's' && !e.ctrlKey && !e.metaKey) toggleSketch();
  else if (k === 'enter' && sketchOn) { e.preventDefault(); closeSketch(); }
  else if (k === 'backspace' && sketchOn) { e.preventDefault(); undoSketchStep(); }
  else if (k === '?') toggleShortcuts();
  else if (k.startsWith('arrow') && doc.selection.size) { e.preventDefault(); nudgeSelection(k, e.shiftKey, e.repeat); }
  else if (k === 'escape') {
    if (!document.getElementById('shortcuts-overlay').hidden) toggleShortcuts(false);
    // In a sketch, the first Escape ends the curve you are drawing and the
    // second leaves the sketch. Throwing the whole sketch away on the keystroke
    // people use to mean "stop this line" loses work they meant to keep.
    else if (sketchOn && skPending.length) {
      skPending = [];
      drawSketchPreview();
      syncSketchBar();
      flash('Curve ended. Escape again to leave the sketch.');
    }
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
  else if (n > 1) left = `<b>${n}</b> objects selected. Group (Ctrl+G) to combine`;
  else if (sel) left = `<b>${sel.name}</b> · ${sel.kind}${sel.role === 'hole' ? ` · <span style="color:#ff8a8a">${ROLE_LABELS.hole}</span>` : ''} · pos (${fmt(sel.mesh.position)}) mm`;
  else left = `${doc.list.length} object${doc.list.length === 1 ? '' : 's'}. Click to select · Shift-click adds`;
  statusbar.innerHTML = `<span>${left}</span><span class="units">units: mm</span>`;
}
const fmt = (v) => [v.x, v.y, v.z].map((n) => n.toFixed(1)).join(', ');
let flashTimer = null;
function flash(msg) {
  statusbar.innerHTML = `<span>${msg}</span><span class="units">units: mm</span>`;
  // Cancel the previous message's timer. Without this an earlier flash's expiry
  // wipes a later message that is still fresh, which is how a refusal can vanish
  // before it has been read.
  clearTimeout(flashTimer);
  flashTimer = setTimeout(setStatus, 2500);
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

// ---------------------------------------------------------------- render view
// Presentation mode: hides the editing chrome, shows a render bar, and can load
// an external .obj read-only (?model=…&view=render) for the portfolio.
const renderView = initRenderView({
  THREE, scene, camera, renderer, orbit, gizmo, doc, applyRenderMode,
});

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
  flash(on ? 'Box select on. Drag a rectangle around objects. Esc or L to exit.' : 'Box select off.');
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
// Rectangular marquee: lassoPts holds [startCorner, currentCorner]; the box is their bounds.
function lassoMove(e) { if (!lassoActive) return; lassoPts[1] = [e.clientX, e.clientY]; updateLassoPath(); }
function lassoUp(e) { if (lassoActive) lassoEnd(e); }
function lassoRect() {
  const a = lassoPts[0], b = lassoPts[1] || a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}
function updateLassoPath() {
  if (!lassoPath || !lassoPts.length) return;
  const [x0, y0, x1, y1] = lassoRect();
  lassoPath.setAttribute('d', `M${x0},${y0} L${x1},${y0} L${x1},${y1} L${x0},${y1} Z`);
}

function lassoEnd(e) {
  const [x0, y0, x1, y1] = lassoRect();
  clearLasso();
  // A tiny box is really a click — fall back to single-pick so the tool still
  // selects one object cleanly.
  if ((x1 - x0) < 5 && (y1 - y0) < 5) { pickAt(e); return; }

  const inside = [];
  for (const o of doc.list) {
    if (o.mesh.visible === false) continue;
    const sp = objScreenPoint(o);
    if (sp && sp[0] >= x0 && sp[0] <= x1 && sp[1] >= y0 && sp[1] <= y1) inside.push(o.id);
  }
  if (!lassoShift) doc.select(null);
  if (!inside.length) { flash('Box select caught nothing.'); return; }
  for (const id of inside) doc.select(id, true);
  flash(`Selected ${inside.length} object${inside.length === 1 ? '' : 's'}.`);
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
  flash(on ? 'Measure on. Click two points (snaps to nearby corners). Esc or M to exit.' : 'Measure off.');
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
    measureText = 'First point set. Click a second point.';
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
//
// The constrained sketcher. A mode (toolbar / S) where you draw on the ground
// plane with line, rectangle and circle tools. What you draw is not a frozen
// outline: every curve carries constraints, and the shape you see is the
// solver's answer to those rules.
//
// The workflow this is built around is draw rough, then dimension exact. Drawing
// a rectangle roughly square gets you exact right angles immediately (auto
// horizontal and vertical) plus width and height dimensions you then type real
// numbers into. That is the same loop OnShape trains people on, and it is why
// the tools auto-dimension instead of waiting for you to add every rule by hand.
//
// The first point you place is the anchor: it is fixed, so growing a dimension
// grows the shape away from it rather than sliding the whole sketch around.

let sketchOn = false;
let skDoc = null;                  // the sketch document being built
let skTool = 'line';               // line | rect | circle | dim
let skPending = [];                // point ids clicked so far for the active tool
let skHover = null;                // last cursor position in sketch coords
let skSnapHint = null;             // the inference under the cursor, null when on the grid
let skSnap = 1;                    // grid snap in mm, 0 = off
let skDimPair = null;              // the two points awaiting a typed distance
let skPlane = null;                // null = the ground; otherwise a picked face's plane
let skPlaneLabel = 'Ground';
let skPlanePicked = false;         // a face has been chosen, so clicks now draw on it
let skPlaneArmed = false;          // the user explicitly asked to pick a face next
let skNeedsPlanePick = false;      // solids on screen, so the first click chooses the plane

const sketchGroup = new THREE.Group();
scene.add(sketchGroup);
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const SKETCH_COLOR = 0x4fd0ff;
const ANCHOR_COLOR = 0xffc857;
const PENDING_COLOR = 0x9aa6b2;
const SNAP_COLOR = 0x7bffb0;       // reads clearly on every skin's viewport
const SNAP_PICK_MM = 2.5;          // click within this of a point to reuse it
const AXIS_TOL_DEG = 4;            // snap a near-axis segment to exactly axis-aligned
let skCornerSize = 3;              // fillet radius / chamfer setback, in mm

function disposeSketchPreview() {
  for (const c of [...sketchGroup.children]) { c.geometry?.dispose(); c.material?.dispose(); sketchGroup.remove(c); }
}

function setSketch(on) {
  sketchOn = on;
  // The empty-scene prompt sits dead centre, which is where the drawing goes.
  // It only refreshes on document events, so entering a sketch has to say so.
  updateEmptyState();
  // Sketching means drawing onto the model, and the slicer hides every solid so
  // its toolpaths can be seen. Left open, you would be drawing at an invisible
  // part and picking faces you cannot see, so entering a sketch closes it.
  if (on) {
    if (lassoOn) setLasso(false);
    if (measureOn) setMeasure(false);
    if (sliceView?.visible) {
      sliceView.toggle(false);
      document.getElementById('slice-btn')?.classList.remove('active');
    }
  }
  gizmo.enabled = !on;                          // don't let the gizmo eat sketch clicks
  renderer.domElement.style.cursor = on ? 'crosshair' : '';
  document.getElementById('sketch-btn')?.classList.toggle('active', on);
  const bar = document.getElementById('sketch-bar');
  if (bar) bar.hidden = !on;

  if (on) {
    skDoc = createSketch('XZ');
    skTool = 'line';
    skPending = [];
    skDimPair = null;
    skHover = null;
    skHudPx = null;
    skHudKeys = '';
    skHudLock = {};
    skPlane = null;
    skPlaneLabel = 'Ground';
    skPlanePicked = false;
    skPlaneArmed = false;
    // Square the view up with the plane before the first click lands, so what
    // gets drawn is what was meant. See viewPlaneNormal for why this matters.
    //
    // With solids on screen the plane has to be chosen first, because you cannot
    // click the face you want while already staring down at the ground. That is
    // the same order OnShape uses: pick the plane, then the view squares up and
    // the sketch opens. With an empty scene there is nothing to pick, so skip
    // straight to the ground and start drawing.
    saveCameraForSketch();
    skNeedsPlanePick = doc.list.some((o) => o.mesh.visible !== false);
    if (skNeedsPlanePick) {
      flash('Pick the plane first, click a flat face to sketch on it, or click empty space for the ground.');
    } else {
      skPlanePicked = true;
      viewPlaneNormal(null);
      flash('Sketching on the ground, looking straight at it. Enter finishes, Esc cancels.');
    }
    syncSketchBar();
  } else {
    skDoc = null; skPending = []; skDimPair = null; skHover = null;
    clearHudTyping();
    skHudPx = null; skHudKeys = '';
    const hud = document.getElementById('sk-hud');
    if (hud) hud.hidden = true;
    rebuildSketchDims({ force: true });
    disposeSketchPreview();
    restoreCameraAfterSketch();
    flash('Sketch off.');
  }
}
function toggleSketch() {
  // Guarded here rather than only on the button, so the S shortcut and the
  // proxied top bar cannot start a gated feature either.
  if (!experimentalOn()) { flash('Sketching is an experimental feature. Turn it on in Settings.'); return; }
  setSketch(!sketchOn);
}

function aimAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
}

// ------------------------------------------------------- sketch plane camera
//
// Why this exists. The sketcher used to draw on whatever plane you picked while
// the camera stayed at its 3/4 view, about 28 degrees above the ground. On that
// view the sketch plane is foreshortened roughly 4:1 and rotated relative to the
// screen, so a 300x300 pixel square drawn dead centre came out as a 29 x 7 mm
// sliver. That is not a precision bug you can polish away, it is the geometry of
// drawing on a surface you are looking at edge-on, and it is why sketching felt
// imprecise and why the resulting extrude never looked like what was drawn.
//
// Every real CAD package answers this the same way: when you open a sketch, the
// view rotates to look straight down the plane's normal. Then one pixel is one
// predictable distance in both axes and what you draw is what you get.

/** The plane's orthonormal frame: origin, normal, and the u/v axes. */
function planeFrame(plane) {
  if (!plane || isGroundPlane(plane)) {
    return {
      origin: new THREE.Vector3(0, 0, 0),
      normal: new THREE.Vector3(0, 1, 0),
      xdir: new THREE.Vector3(1, 0, 0),
      ydir: new THREE.Vector3(0, 0, 1),
    };
  }
  const n = new THREE.Vector3().fromArray(plane.normal).normalize();
  let x = new THREE.Vector3().fromArray(plane.xdir || [1, 0, 0]);
  x.sub(n.clone().multiplyScalar(x.dot(n)));
  if (x.lengthSq() < 1e-12) {
    // xdir was parallel to the normal, so pick any perpendicular axis instead.
    const seed = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    x = seed.sub(n.clone().multiplyScalar(seed.dot(n)));
  }
  x.normalize();
  // Matches planeMatrix: local +Z (the sketch's v axis) is xdir cross normal.
  const y = new THREE.Vector3().crossVectors(x, n);
  return { origin: new THREE.Vector3().fromArray(plane.origin || [0, 0, 0]), normal: n, xdir: x, ydir: y };
}

// A camera move in flight. Stepped by tick() so it never fights OrbitControls.
let camAnim = null;
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function animateCamera(pos, target, up, ms = 420) {
  if (ms <= 0 || reduceMotion()) {
    camera.position.copy(pos); camera.up.copy(up); orbit.target.copy(target);
    camera.lookAt(target); orbit.update();
    camAnim = null;
    return;
  }
  camAnim = {
    t0: performance.now(), ms,
    p0: camera.position.clone(), p1: pos.clone(),
    u0: camera.up.clone(), u1: up.clone(),
    g0: orbit.target.clone(), g1: target.clone(),
  };
}

function stepCameraAnim() {
  if (!camAnim) return;
  const k = Math.min(1, (performance.now() - camAnim.t0) / camAnim.ms);
  const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;   // easeInOutQuad
  camera.position.lerpVectors(camAnim.p0, camAnim.p1, e);
  orbit.target.lerpVectors(camAnim.g0, camAnim.g1, e);
  camera.up.copy(camAnim.u0).lerp(camAnim.u1, e).normalize();
  if (k >= 1) camAnim = null;
}

/**
 * Look straight down a plane's normal.
 * `up` is -ydir so that u runs right and v runs down the screen, which makes a
 * natural down-and-right drag produce a positive width and a positive height
 * rather than the negative numbers the old 3/4 view produced.
 */
function viewPlaneNormal(plane, { ms = 420, span = 160 } = {}) {
  const f = planeFrame(plane);
  // Frame roughly `span` mm of the plane, so there is room to draw before the
  // first dimension is typed. Keeps a sensible distance on tiny faces too.
  const dist = (span * 0.5) / Math.tan((camera.fov * Math.PI / 180) / 2);
  const target = f.origin.clone();
  const pos = target.clone().add(f.normal.clone().multiplyScalar(dist));
  animateCamera(pos, target, f.ydir.clone().negate(), ms);
}

// Where the camera was before the sketch opened, so finishing puts the model
// back the way the user had it rather than leaving them staring straight down.
let camBeforeSketch = null;
function saveCameraForSketch() {
  camBeforeSketch = { pos: camera.position.clone(), target: orbit.target.clone(), up: camera.up.clone() };
}
function restoreCameraAfterSketch({ ms = 420 } = {}) {
  if (!camBeforeSketch) return;
  const c = camBeforeSketch;
  camBeforeSketch = null;
  animateCamera(c.pos, c.target, c.up, ms);
}

// True when the camera is (near enough) looking straight down the sketch plane.
// Drives the "Face on" button's active state.
function isNormalToSketchPlane() {
  const f = planeFrame(skPlane);
  const view = camera.position.clone().sub(orbit.target).normalize();
  return view.dot(f.normal) > 0.999;
}

// The plane the sketch is currently being drawn on, as a THREE.Plane.
function activePlane() {
  if (!skPlane) return GROUND;
  const n = new THREE.Vector3().fromArray(skPlane.normal);
  const o = new THREE.Vector3().fromArray(skPlane.origin);
  return new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
}

function groundPoint(e) {
  aimAt(e);
  const hit = new THREE.Vector3();
  return ray.ray.intersectPlane(activePlane(), hit) ? hit : null;
}

// Which solid face is under the cursor, as a plane. Returns null over empty space.
function faceUnderCursor(e) {
  aimAt(e);
  const meshes = doc.list.filter((o) => o.mesh.visible !== false).map((o) => o.mesh);
  if (!meshes.length) return null;
  const hits = ray.intersectObjects(meshes, false);
  if (!hits.length || !hits[0].face) return null;
  const h = hits[0];
  const n = h.face.normal.clone()
    .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld))
    .normalize();
  const obj = doc.list.find((o) => o.mesh === h.object);
  return { plane: planeFromNormal(h.point.toArray(), n.toArray()), name: obj?.name || 'face' };
}

// Sketch coordinates are the ground plane's x and z, so a sketch point maps to
// world (x, 0, y) and back with no transform to get wrong.
const toSketch = (v3) => {
  if (!skPlane) return { x: v3.x, y: v3.z };
  // Project the world hit back into the plane's own 2D coordinates.
  const o = new THREE.Vector3().fromArray(skPlane.origin);
  const n = new THREE.Vector3().fromArray(skPlane.normal).normalize();
  let x = new THREE.Vector3().fromArray(skPlane.xdir);
  x = x.sub(n.clone().multiplyScalar(x.dot(n))).normalize();
  const y = new THREE.Vector3().crossVectors(x, n);
  const d = v3.clone().sub(o);
  return { x: d.dot(x), y: d.dot(y) };
};
const toWorld = (p) => sketchToWorld(skPlane, p.x, p.y);
const skPoint = (id) => skDoc.points.find((p) => p.id === id);

function snapValue(v) { return skSnap > 0 ? Math.round(v / skSnap) * skSnap : v; }

// Reuse an existing point when the click lands on one. Sharing the id is what
// welds two curves together, which is stronger and cheaper than adding a
// coincident constraint after the fact.
//
// Takes the resolved snap, not raw coordinates, and that matters. inferSnap has
// already decided where this click goes and the toolbar has already promised it
// to the user. Re-deriving anything here (rounding to the grid, re-testing a
// separate reuse radius) can only disagree with that promise, and a click that
// lands somewhere other than the readout said is the whole "points land wrong"
// complaint. So: honour the snap exactly, and never round it a second time.
function pointAt(snap, { allowReuse = true } = {}) {
  // The snap already identified a specific existing point. Reuse that one, not
  // whatever happens to be nearest in millimetres.
  if (allowReuse && snap.ref && POINT_SNAPS.has(snap.kind)) {
    const p = skPoint(snap.ref);
    if (p) return p;
  }
  if (allowReuse) {
    for (const p of skDoc.points) {
      if (p.id === 'origin' && !skDoc.entities.length) continue;
      if (Math.hypot(p.x - snap.x, p.y - snap.y) <= SNAP_PICK_MM) return p;
    }
  }
  const first = skDoc.points.length <= 1;      // only the origin exists so far
  // snap.x / snap.y are final. inferSnap applied the grid itself when nothing
  // better was under the cursor.
  return addPoint(skDoc, snap.x, snap.y, first);
}

// Snap kinds that name an existing point rather than a position in space.
const POINT_SNAPS = new Set(['endpoint', 'origin', 'centre']);

// ------------------------------------------------------------ snap inference
//
// Grid snap alone rounds to the nearest millimetre, which is precise but not
// meaningful: it cannot land you exactly on the corner you are aiming at, only
// near it. Real sketchers infer what you meant from the geometry already there,
// and say so, so you can trust the click before you make it. That is the whole
// difference between "drawing" and "drafting".
//
// Candidates are ranked, strongest first, because the ones that carry real
// design intent should beat the ones that are merely close.

const SNAP_PX = 12;                 // catch radius, in screen pixels

/** Snap tolerance in sketch mm that stays the same size on screen at any zoom. */
function snapTolMm() {
  const dist = camera.position.distanceTo(orbit.target);
  const mmPerPx = (2 * dist * Math.tan((camera.fov * Math.PI / 180) / 2)) / renderer.domElement.clientHeight;
  return SNAP_PX * mmPerPx;
}

const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

/**
 * Work out what the cursor is really pointing at.
 * Returns { x, y, kind, label } and never null: with nothing nearby it falls
 * back to the grid, which is the old behaviour.
 */
function inferSnap(x, y, { anchor = null } = {}) {
  const tol = snapTolMm();
  const tol2 = tol * tol;
  const best = { rank: -1, x, y, kind: 'grid', label: '', ref: null };
  const offer = (rank, px, py, kind, label, ref = null) => {
    if (dist2(x, y, px, py) > tol2) return;
    if (rank > best.rank) Object.assign(best, { rank, x: px, y: py, kind, label, ref });
  };

  // 5, existing points. Landing on one welds the curves together by sharing the
  // id, which is stronger than any constraint added afterwards.
  for (const p of skDoc.points) {
    if (p.id === 'origin' && !skDoc.entities.length) continue;
    offer(5, p.x, p.y, p.id === 'origin' ? 'origin' : 'endpoint', p.id === 'origin' ? 'Origin' : 'Endpoint', p.id);
  }

  // 4, circle centres.
  for (const e of skDoc.entities) {
    if (e.type !== 'circle') continue;
    const c = skPoint(e.c);
    if (c) offer(4, c.x, c.y, 'centre', 'Centre', c.id);
  }

  // 3, line midpoints.
  for (const e of skDoc.entities) {
    if (e.type !== 'line') continue;
    const a = skPoint(e.p1), b = skPoint(e.p2);
    if (a && b) offer(3, (a.x + b.x) / 2, (a.y + b.y) / 2, 'midpoint', 'Midpoint');
  }

  // 2, lined up with the point we are drawing from. These are the guides that
  // let you square a shape off without typing a number.
  if (anchor) {
    if (Math.abs(y - anchor.y) <= tol) offer(2, x, anchor.y, 'axisH', 'Horizontal');
    if (Math.abs(x - anchor.x) <= tol) offer(2, anchor.x, y, 'axisV', 'Vertical');
  }

  // 1, anywhere along an existing line.
  for (const e of skDoc.entities) {
    if (e.type !== 'line') continue;
    const a = skPoint(e.p1), b = skPoint(e.p2);
    if (!a || !b) continue;
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / len2));
    offer(1, a.x + vx * t, a.y + vy * t, 'onLine', 'On edge', e.id);
  }

  if (best.rank >= 0) return best;
  return { x: snapValue(x), y: snapValue(y), kind: 'grid', label: skSnap > 0 ? 'Grid' : '' };
}

/** The point the current tool is drawing from, for alignment guides. */
function snapAnchor() {
  if (!skPending.length) return null;
  const last = skPending[skPending.length - 1];
  return typeof last === 'string' ? skPoint(last) : last;
}

// A segment drawn near an axis was meant to be on it. Promoting that to a real
// constraint is what stops a sketch from being 89.6 degrees forever.
function autoAxisConstraint(line) {
  const a = skPoint(line.p1), b = skPoint(line.p2);
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  const ang = Math.atan2(dy, dx) * 180 / Math.PI;
  if (ang <= AXIS_TOL_DEG) { addConstraint(skDoc, { type: 'horizontal', e: line.id, auto: true }); return 'horizontal'; }
  if (ang >= 90 - AXIS_TOL_DEG) { addConstraint(skDoc, { type: 'vertical', e: line.id, auto: true }); return 'vertical'; }
  return null;
}

// Auto-dimension what was just drawn so there is always a number to type into.
function autoDimension(line, axis) {
  const a = skPoint(line.p1), b = skPoint(line.p2);
  if (axis === 'horizontal') {
    addConstraint(skDoc, { type: 'distanceX', a: line.p1, b: line.p2, value: round1(b.x - a.x), auto: true });
  } else if (axis === 'vertical') {
    addConstraint(skDoc, { type: 'distanceY', a: line.p1, b: line.p2, value: round1(b.y - a.y), auto: true });
  } else {
    addConstraint(skDoc, { type: 'distance', a: line.p1, b: line.p2, value: round1(Math.hypot(b.x - a.x, b.y - a.y)), auto: true });
  }
}

const round1 = (v) => Math.round(v * 10) / 10;

function sketchClick(e) {
  // Nothing drawn yet, and the click landed on a solid? Adopt that face as the
  // sketch plane. This is the whole of "sketch on a face" from the user's side:
  // click the face, then draw on it exactly as you would on the ground.
  if (!skPlanePicked && !skDoc.entities.length && !skPending.length) {
    const face = faceUnderCursor(e);
    if (face) {
      skPlane = face.plane;
      skPlaneLabel = face.name;
      // Latch it, otherwise every following click would land on the same solid
      // and re-pick the plane instead of drawing on it.
      skPlanePicked = true;
      skPlaneArmed = false;
      skNeedsPlanePick = false;
      // Square up to the face. This is the whole of "sketch on a face" from the
      // user's side, and without it the face is drawn on edge-on and unusably
      // foreshortened, which is exactly what made it feel fiddly.
      viewPlaneNormal(face.plane);
      drawSketchPreview();
      syncSketchBar();
      flash(`Sketching on a face of ${face.name}, squared up to it. Press P for the ground.`);
      return;
    }
    // Clicking empty space settles on the ground, so a stray later click over a
    // solid cannot silently move the plane mid-drawing.
    skPlanePicked = true;
    // When the plane was still being chosen, this click only chose it. Squaring
    // up moves the view under the cursor, so drawing from the pre-move position
    // would drop the point somewhere the user did not aim at.
    if (skNeedsPlanePick) {
      skNeedsPlanePick = false;
      viewPlaneNormal(null);
      syncSketchBar();
      flash('Sketching on the ground, squared up to it. Now draw.');
      return;
    }
  }

  const hit = groundPoint(e);
  if (!hit) { flash('Aim at the sketch plane to draw.'); return; }
  const raw = toSketch(hit);
  // Inference first, grid second. Landing exactly on a corner or a midpoint is
  // what makes the next constraint mean something.
  const snap = inferSnap(raw.x, raw.y, { anchor: snapAnchor() });
  placeSketchPoint(snap);
}

/**
 * Build geometry at an already-resolved position.
 *
 * Split out from sketchClick so a click and a typed dimension take the exact
 * same path. Anything that resolves a position, the cursor or the number you
 * typed into the heads-up field, hands a snap to this function and gets
 * identical geometry and identical constraints.
 */
function placeSketchPoint(snap) {
  const x = snap.x, y = snap.y;

  if (skTool === 'line') {
    const p = pointAt(snap);
    // A point put on an edge should STAY on that edge when the sketch is later
    // re-dimensioned, so record the inference as a constraint rather than
    // leaving it as a position that happens to line up today.
    if (snap.kind === 'onLine' && snap.ref && !skDoc.points.some((q) => q.id === p.id && q.fixed)) {
      addConstraint(skDoc, { type: 'pointOnLine', p: p.id, e: snap.ref, auto: true });
    }
    if (skPending.length) {
      const prev = skPending[skPending.length - 1];
      if (prev === p.id) return;                       // ignore a double click in place
      const line = addLine(skDoc, prev, p.id);
      const axis = autoAxisConstraint(line);
      autoDimension(line, axis);
      // Closing back onto the chain's start finishes the loop.
      if (p.id === skPending[0] && skPending.length >= 2) { skPending = []; solveAndDraw(); finishSketch(); return; }
    }
    skPending.push(p.id);
  }

  else if (skTool === 'rect') {
    if (!skPending.length) { skPending.push({ ...snap }); }
    else {
      const a = skPending.pop();
      if (Math.abs(a.x - x) < 0.5 || Math.abs(a.y - y) < 0.5) { flash('That rectangle has no area. Click a second corner further out.'); return; }
      const rect = addRectangle(skDoc, a.x, a.y, x, y);
      if (skDoc.points.length === 5) rect.points[0].fixed = true;   // first geometry anchors
      addConstraint(skDoc, { type: 'distanceX', a: rect.points[0].id, b: rect.points[1].id, value: round1(x - a.x), auto: true });
      addConstraint(skDoc, { type: 'distanceY', a: rect.points[1].id, b: rect.points[2].id, value: round1(y - a.y), auto: true });
      skPending = [];
    }
  }

  else if (skTool === 'circle') {
    // Keep the whole snap, not just its coordinates, so a centre placed on an
    // existing corner reuses that corner's point instead of stacking a second
    // one on top of it.
    if (!skPending.length) { skPending.push({ ...snap }); }
    else {
      const c = skPending.pop();
      const r = Math.hypot(x - c.x, y - c.y);
      if (r < 0.5) { flash('That circle has no radius. Click further from the centre.'); return; }
      const cp = pointAt(c);
      const circ = addCircle(skDoc, cp.id, round1(r));
      addConstraint(skDoc, { type: 'radius', e: circ.id, value: round1(r), auto: true });
      skPending = [];
    }
  }

  else if (skTool === 'fillet' || skTool === 'chamfer') {
    applyCornerTool(snap);
    return;
  }

  else if (skTool === 'dim') {
    const p = pointAt(snap, { allowReuse: true });
    skPending.push(p.id);
    if (skPending.length === 2) {
      const [a, b] = skPending;
      skPending = [];
      if (a === b) { flash('Pick two different points to dimension.'); return; }
      const pa = skPoint(a), pb = skPoint(b);
      skDimPair = { a, b, measured: round1(Math.hypot(pb.x - pa.x, pb.y - pa.y)) };
      openDimInput();
      return;
    }
  }

  solveAndDraw();
  // The curve just changed, so any dimension the user had typed belongs to the
  // segment that is now finished, not the next one.
  skHudLock = {};
  updateHud();
  syncSketchBar();
}

function sketchMove(e) {
  if (!sketchOn || !skDoc) return;
  const hit = groundPoint(e);
  if (!hit) return;
  const raw = toSketch(hit);
  const snap = inferSnap(raw.x, raw.y, { anchor: snapAnchor() });
  skHover = { x: snap.x, y: snap.y };
  skSnapHint = snap.kind === 'grid' ? null : snap;
  skHudPx = { x: e.clientX, y: e.clientY };
  updateHud();
  syncSketchBar();
  // The snap marker and its guide have to redraw on every move, not only while
  // a curve is in progress, otherwise you cannot see what a first click will do.
  drawSketchPreview();
}

// ------------------------------------------------------------- corner tools
//
// Fillet rounds a corner, chamfer bevels it. Both work on the SKETCH rather than
// on a finished solid, because CADence's kernel is a mesh CSG engine: it can
// union and subtract, but rolling a constant-radius blend along an arbitrary
// edge of an existing body is a B-rep operation it does not have. Rounding the
// profile before the extrude reaches the same part, stays exact, and leaves the
// radius as a dimension you can retype afterwards.

/** The filletable corner nearest a click, or null when the click missed them all. */
function cornerNear(x, y) {
  const tol = Math.max(snapTolMm() * 2, 3);
  let best = null, bestD = Infinity;
  for (const id of filletableCorners(skDoc)) {
    const p = skPoint(id);
    if (!p) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD && d <= tol) { best = id; bestD = d; }
  }
  return best;
}

function applyCornerTool(snap) {
  const mode = skTool === 'chamfer' ? 'chamfer' : 'fillet';
  // A size typed into the cursor field counts even without Enter, so typing the
  // number and clicking the corner works as one gesture.
  const typed = skHudLock[mode];
  if (Number.isFinite(typed) && typed > 0) skCornerSize = typed;

  const id = snap.ref && POINT_SNAPS.has(snap.kind) ? snap.ref : cornerNear(snap.x, snap.y);
  if (!id) { flash(`Click a corner where two lines meet to ${mode} it.`); return; }

  const res = filletCorner(skDoc, id, skCornerSize, { mode });
  if (!res.ok) {
    // filletCorner restores the sketch itself on failure, so there is nothing to
    // undo here, only to explain.
    flash(`No ${mode}: ${res.reason}`);
    return;
  }
  drawSketchPreview();
  rebuildSketchDims({ force: true });
  syncSketchBar();
  flash(mode === 'fillet'
    ? `Corner rounded to ${round1(skCornerSize)}mm. Click the radius to change it.`
    : `Corner bevelled by ${round1(skCornerSize)}mm.`);
}

// ------------------------------------------------- editable sketch dimensions
//
// Every curve you draw already carries a driving dimension, added automatically
// so there is always a number to change. Until now those numbers lived only in
// the solver, which made the sketch parametric on paper and frozen in practice.
// These chips put each one on the curve it drives: click, retype, and the solver
// moves the geometry to obey. That round trip is the entire parametric promise.

const skDimsEl = () => document.getElementById('sk-dims');

/**
 * Where a dimension should sit, in sketch coordinates, and how to label it.
 *
 * Also returns `along`, the direction of the thing being measured. The chip is
 * pushed off the geometry perpendicular to that, which is what every drafting
 * convention does and, more practically, is what stops the chip from covering
 * the midpoint of the very edge you are trying to snap to.
 */
function dimAnchor(c) {
  const P = (id) => skPoint(id);
  if (c.type === 'distance' || c.type === 'distanceX' || c.type === 'distanceY') {
    const a = P(c.a), b = P(c.b);
    if (!a || !b) return null;
    const key = c.type === 'distanceX' ? 'W' : c.type === 'distanceY' ? 'H' : 'L';
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, key, unit: 'mm', along: { x: b.x - a.x, y: b.y - a.y } };
  }
  if (c.type === 'radius' || c.type === 'diameter') {
    const e = skDoc.entities.find((k) => k.id === c.e);
    const ctr = e && P(e.c);
    if (!ctr) return null;
    // Park it on the rim rather than the centre, so two concentric circles do
    // not stack their dimensions on top of each other.
    const r = e.type === 'circle' ? e.r : 0;
    return {
      x: ctr.x + r * 0.707, y: ctr.y + r * 0.707,
      key: c.type === 'radius' ? 'R' : '⌀', unit: 'mm',
      along: { x: -0.707, y: 0.707 },        // tangent at that point on the rim
    };
  }
  if (c.type === 'angle') {
    const a = skDoc.entities.find((k) => k.id === c.a);
    const p1 = a && P(a.p1), p2 = a && P(a.p2);
    if (!p1 || !p2) return null;
    return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, key: '∡', unit: '°', along: { x: p2.x - p1.x, y: p2.y - p1.y } };
  }
  return null;
}

// How far off the geometry a dimension chip sits, in screen pixels. Big enough
// that the chip never covers the edge's own snap targets.
const DIM_OFFSET_PX = 26;

/** Project a sketch point to client pixels, so a chip can sit on the geometry. */
function sketchToScreen(p) {
  const w = toWorld(p);
  const v = new THREE.Vector3(w.x, w.y, w.z).project(camera);
  if (v.z > 1) return null;                            // behind the camera
  const r = renderer.domElement.getBoundingClientRect();
  return { x: (v.x * 0.5 + 0.5) * r.width + r.left, y: (-v.y * 0.5 + 0.5) * r.height + r.top };
}

let skDimSig = '';           // which dimensions are on screen, to avoid needless rebuilds

/**
 * Rebuild the chip set.
 *
 * This is called from the redraw path, which runs on every mouse move, so it
 * has to be cheap and it must never yank the DOM out from under someone who is
 * mid-edit. Both are handled by rebuilding only when the set of dimensions
 * actually changed. Positions are updated separately, every frame.
 */
function rebuildSketchDims({ force = false } = {}) {
  const layer = skDimsEl();
  if (!layer) return;
  // Never rebuild while a value is being typed; that would destroy the field.
  if (!force && layer.contains(document.activeElement)) return;

  if (!sketchOn || !skDoc) { layer.innerHTML = ''; layer.hidden = true; skDimSig = ''; return; }

  const dims = skDoc.constraints.filter(isDimension);
  const sig = dims.map((c) => `${c.id}:${c.type}:${c.auto ? 'a' : 'm'}`).join('|');
  if (!force && sig === skDimSig) return;
  skDimSig = sig;

  layer.innerHTML = '';
  if (!dims.length) { layer.hidden = true; return; }
  layer.hidden = false;

  for (const c of dims) {
    const a = dimAnchor(c);
    if (!a) continue;
    const chip = document.createElement('div');
    chip.className = 'skdim' + (c.auto ? ' auto' : '');
    chip.dataset.cid = c.id;
    chip.innerHTML = `<span class="sd-k">${a.key}</span><span class="sd-v">${round1(c.value)}</span>`;
    chip.title = `${constraintLabel(c)}, click to change it`;
    // The canvas treats a pointerdown as the start of an orbit or a sketch
    // click, so the chip has to claim its own presses.
    chip.addEventListener('pointerdown', (e) => e.stopPropagation());
    chip.addEventListener('click', (e) => { e.stopPropagation(); editSketchDim(chip, c.id); });
    layer.appendChild(chip);
  }
  positionSketchDims();
}

/** Reposition existing chips. Cheap enough to run every frame. */
function positionSketchDims() {
  const layer = skDimsEl();
  if (!layer || layer.hidden || !skDoc) return;
  // While a curve is being drawn, every click belongs to the drawing. Chips go
  // click-through so a dimension can never intercept a point you are placing.
  layer.style.pointerEvents = skPending.length ? 'none' : '';
  for (const chip of layer.children) {
    const c = skDoc.constraints.find((k) => k.id === chip.dataset.cid);
    const a = c && dimAnchor(c);
    const s = a && sketchToScreen(a);
    if (!s) { chip.style.display = 'none'; continue; }
    chip.style.display = '';
    // Push the chip off the edge, perpendicular to it, measured on screen so the
    // clearance is the same at any zoom.
    let ox = 0, oy = 0;
    if (a.along) {
      const tip = sketchToScreen({ x: a.x + a.along.x, y: a.y + a.along.y });
      if (tip) {
        const dx = tip.x - s.x, dy = tip.y - s.y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-6) { ox = (-dy / d) * DIM_OFFSET_PX; oy = (dx / d) * DIM_OFFSET_PX; }
      }
    }
    chip.style.left = `${s.x + ox}px`;
    chip.style.top = `${s.y + oy}px`;
    // Keep the displayed number honest while the solver moves things around.
    const v = chip.querySelector('.sd-v');
    if (v && !chip.querySelector('input')) v.textContent = round1(c.value);
  }
}

function editSketchDim(chip, cid) {
  if (chip.querySelector('input')) return;
  const c = skDoc.constraints.find((k) => k.id === cid);
  if (!c) return;
  const key = chip.querySelector('.sd-k')?.textContent || '';
  chip.innerHTML = `<span class="sd-k">${key}</span><input class="sd-in" type="number" step="any" value="${round1(c.value)}" aria-label="${constraintLabel(c)}" />`;
  const inp = chip.querySelector('input');
  inp.focus(); inp.select();
  inp.addEventListener('pointerdown', (e) => e.stopPropagation());

  const commit = () => {
    const v = parseFloat(inp.value);
    if (!Number.isFinite(v)) { rebuildSketchDims({ force: true }); return; }
    const report = setDimension(skDoc, cid, v);
    // setDimension puts the old value back itself when the sketch cannot reach
    // the new one, so the geometry is already safe. All that is left is saying so.
    if (!report || !report.ok) {
      flash('The sketch cannot reach that value with the rules already on it, so it was left alone.');
      rebuildSketchDims({ force: true });
      const again = skDimsEl()?.querySelector(`[data-cid="${cid}"]`);
      if (again) { again.classList.add('bad'); setTimeout(() => again.classList.remove('bad'), 900); }
      return;
    }
    // A hand-set dimension is no longer one CADence guessed for you, so it stops
    // being muted and starts being protected from later auto-dimensioning.
    c.auto = false;
    drawSketchPreview();
    rebuildSketchDims({ force: true });
    syncSketchBar();
    flash(`Set to ${round1(v)}. ${report.dof} free.`);
  };

  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();                       // never let app shortcuts fire mid-typing
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); inp.value = ''; rebuildSketchDims({ force: true }); }
  });
  inp.addEventListener('blur', commit, { once: true });
}

// -------------------------------------------------- live dimension input (HUD)
//
// Why this exists. Drawing with a mouse can only ever be approximate, so every
// real CAD package pairs the cursor with a number you can overwrite. Without it
// the only way to get a 40mm line is to draw roughly 40 and correct it after,
// which is the "I can't tell what the numbers are" complaint exactly.
//
// The rule: the HUD always shows what you are making right now, and any field
// you type into is LOCKED, holding that value while the mouse keeps steering
// whatever you did not type. Type a length and aim the angle, or type both and
// press Enter without aiming at all.

let skHudPx = null;              // last cursor position, in client pixels
let skHudLock = {};              // field key -> typed value the mouse must not override
let skHudKeys = '';              // which fields are on screen, to avoid needless rebuilds

const hudEl = () => document.getElementById('sk-hud');

/**
 * The measurements that describe the curve in progress.
 * With no curve started yet the useful numbers are the position itself, which
 * is also how you place a first point exactly on a coordinate.
 */
function liveFields() {
  if (!skDoc || !skHover) return [];

  // The corner tools have no anchor and no rubber band. Their one number is the
  // size that the next corner you click will be cut by, so the field carries
  // that rather than a measurement of anything on screen.
  if (skTool === 'fillet') return [{ key: 'fillet', label: 'R', unit: 'mm', value: skCornerSize, setting: true }];
  if (skTool === 'chamfer') return [{ key: 'chamfer', label: 'C', unit: 'mm', value: skCornerSize, setting: true }];

  const a = snapAnchor();

  if (!a) {
    return [
      { key: 'x', label: 'X', unit: 'mm', value: skHover.x },
      { key: 'y', label: 'Y', unit: 'mm', value: skHover.y },
    ];
  }

  const dx = skHover.x - a.x, dy = skHover.y - a.y;

  if (skTool === 'line') {
    let ang = Math.atan2(dy, dx) * 180 / Math.PI;
    if (ang < 0) ang += 360;
    return [
      { key: 'len', label: 'L', unit: 'mm', value: Math.hypot(dx, dy) },
      { key: 'ang', label: 'A', unit: '°', value: ang },
    ];
  }
  if (skTool === 'rect') {
    return [
      { key: 'w', label: 'W', unit: 'mm', value: Math.abs(dx) },
      { key: 'h', label: 'H', unit: 'mm', value: Math.abs(dy) },
    ];
  }
  if (skTool === 'circle') {
    return [{ key: 'r', label: 'R', unit: 'mm', value: Math.hypot(dx, dy) }];
  }
  if (skTool === 'dim') {
    return [{ key: 'len', label: 'D', unit: 'mm', value: Math.hypot(dx, dy) }];
  }
  return [];
}

/**
 * Turn the field values (mouse-driven, or typed and locked) back into the
 * sketch position they describe. This is what lets a typed number and a click
 * produce the same geometry through the same code path.
 */
function hudTarget(fields) {
  const a = snapAnchor();
  const val = (k, fallback) => (k in skHudLock ? skHudLock[k] : fallback);
  const get = (k) => fields.find((f) => f.key === k)?.value ?? 0;

  if (!a) return { x: val('x', get('x')), y: val('y', get('y')) };

  const dx = skHover.x - a.x, dy = skHover.y - a.y;

  if (skTool === 'rect') {
    // Keep the quadrant the mouse is in; a typed width means 40mm to the side
    // you are already pulling towards, not 40mm to the right regardless.
    const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
    return { x: a.x + sx * val('w', Math.abs(dx)), y: a.y + sy * val('h', Math.abs(dy)) };
  }
  if (skTool === 'circle') {
    const d = Math.hypot(dx, dy) || 1;
    const r = val('r', d);
    return { x: a.x + (dx / d) * r, y: a.y + (dy / d) * r };
  }
  // line and dim: polar, so length and angle are independently typeable.
  let ang = Math.atan2(dy, dx) * 180 / Math.PI;
  if (ang < 0) ang += 360;
  const L = val('len', Math.hypot(dx, dy));
  const A = val('ang', ang) * Math.PI / 180;
  return { x: a.x + L * Math.cos(A), y: a.y + L * Math.sin(A) };
}

function updateHud() {
  const el = hudEl();
  if (!el) return;
  const fields = liveFields();
  if (!sketchOn || !fields.length || !skHudPx) { el.hidden = true; skHudKeys = ''; return; }

  const keys = fields.map((f) => f.key).join(',');
  if (keys !== skHudKeys) {
    // The field set changed (different tool, or the first point just landed), so
    // rebuild. Locks belong to the old set and would be meaningless here.
    skHudKeys = keys;
    skHudLock = {};
    el.classList.remove('typing');
    el.innerHTML = fields.map((f) => `
      <span class="hud-f" data-k="${f.key}">
        <span class="hud-k">${f.label}</span>
        <input class="hud-v" type="number" step="any" inputmode="decimal"
               aria-label="${f.label} in ${f.unit === '°' ? 'degrees' : 'millimetres'}" />
        <span class="hud-u">${f.unit}</span>
      </span>`).join('') + `<span class="hud-tip">type to set · Enter</span>`;
    for (const input of el.querySelectorAll('.hud-v')) wireHudField(input);
  }

  for (const f of fields) {
    const input = el.querySelector(`.hud-f[data-k="${f.key}"] .hud-v`);
    const wrap = input?.closest('.hud-f');
    if (!input || !wrap) continue;
    const locked = f.key in skHudLock;
    wrap.classList.toggle('locked', locked);
    // Never overwrite a field the user is typing into, or one they locked.
    if (!locked && document.activeElement !== input) input.value = round1(f.value).toFixed(1);
  }

  el.hidden = false;
  // Offset below-right of the cursor, flipped near the edges so it never leaves
  // the window or sits under the pointer.
  const r = el.getBoundingClientRect();
  const pad = 14;
  let x = skHudPx.x + pad, y = skHudPx.y + pad;
  if (x + r.width > window.innerWidth - 8) x = skHudPx.x - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = skHudPx.y - r.height - pad;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, y)}px`;
}

function wireHudField(input) {
  const key = input.closest('.hud-f').dataset.k;
  const lock = () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) skHudLock[key] = v; else delete skHudLock[key];
    input.closest('.hud-f').classList.toggle('locked', key in skHudLock);
  };
  input.addEventListener('input', lock);
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();                      // the app's shortcuts must not fire
    if (ev.key === 'Enter') { ev.preventDefault(); lock(); commitHud(); }
    else if (ev.key === 'Tab') {
      // Tab moves to the next field and locks this one, so "40 Tab 90 Enter"
      // draws an exact 40mm vertical line without touching the mouse.
      lock();
      const all = [...hudEl().querySelectorAll('.hud-v')];
      const next = all[(all.indexOf(input) + 1) % all.length];
      if (all.length > 1) { ev.preventDefault(); next.focus(); next.select(); }
    }
    else if (ev.key === 'Escape') { ev.preventDefault(); clearHudTyping(); }
  });
}

/** Build the curve at the typed numbers, exactly as a click at that spot would. */
function commitHud() {
  const fields = liveFields();
  if (!fields.length) return;

  // A settings field builds nothing. Enter just accepts the size and hands the
  // pointer back, so the next corner you click uses it.
  if (fields[0].setting) {
    const v = skHudLock[fields[0].key];
    if (Number.isFinite(v) && v > 0) {
      skCornerSize = v;
      flash(`${skTool === 'chamfer' ? 'Chamfer' : 'Fillet'} set to ${round1(v)}mm. Now click a corner.`);
    }
    clearHudTyping();
    updateHud();
    return;
  }

  const t = hudTarget(fields);
  clearHudTyping();
  // Typed positions are exact by definition, so they skip inference entirely.
  placeSketchPoint({ x: t.x, y: t.y, kind: 'typed', label: 'Typed', ref: null });
}

function clearHudTyping() {
  skHudLock = {};
  const el = hudEl();
  if (!el) return;
  el.classList.remove('typing');
  el.querySelectorAll('.hud-f').forEach((f) => f.classList.remove('locked'));
  if (el.contains(document.activeElement)) document.activeElement.blur();
  renderer.domElement.focus?.();
}

/** A digit typed over the canvas means "set this dimension", so route it in. */
function hudBeginTyping(ch) {
  const el = hudEl();
  if (!el || el.hidden) return false;
  const first = el.querySelector('.hud-v');
  if (!first) return false;
  el.classList.add('typing');
  first.focus();
  first.value = ch;
  first.dispatchEvent(new Event('input'));
  return true;
}

// Solve, then redraw. The preview shows the SOLVED shape, not the raw clicks, so
// what you see on the ground is what the constraints actually produced.
function solveAndDraw() {
  if (!skDoc) return null;
  const report = solveSketch(skDoc);
  drawSketchPreview();
  return report;
}

function addSeg(pts, color, width = 1) {
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: width })
  );
  line.renderOrder = 999;
  sketchGroup.add(line);
}

function drawSketchPreview() {
  disposeSketchPreview();
  if (!skDoc) return;

  for (const e of skDoc.entities) {
    if (e.type === 'line') {
      addSeg([toWorld(skPoint(e.p1)), toWorld(skPoint(e.p2))], SKETCH_COLOR);
    } else if (e.type === 'circle') {
      const c = skPoint(e.c);
      const pts = [];
      for (let i = 0; i <= 64; i++) {
        const t = (i / 64) * Math.PI * 2;
        // Via toWorld, not a raw (x, 0, y): on a face sketch the preview would
        // otherwise be drawn flat on the ground while the solid built on the face.
        pts.push(toWorld({ x: c.x + e.r * Math.cos(t), y: c.y + e.r * Math.sin(t) }));
      }
      addSeg(pts, SKETCH_COLOR);
    } else if (e.type === 'arc') {
      // Fillets are arcs. Without this the rounded corner is drawn as a gap
      // between two edges that no longer meet, which looks like the fillet
      // broke the profile even though the solid comes out correct.
      const c = skPoint(e.c), a = skPoint(e.p1), b = skPoint(e.p2);
      if (!c || !a || !b) continue;
      const r = Math.hypot(a.x - c.x, a.y - c.y);
      const a0 = Math.atan2(a.y - c.y, a.x - c.x);
      const a1 = Math.atan2(b.y - c.y, b.x - c.x);
      let sweep = a1 - a0;
      // Match the winding the profile walker uses, so what is drawn is what
      // gets built.
      if (e.ccw) { while (sweep <= 0) sweep += Math.PI * 2; }
      else { while (sweep >= 0) sweep -= Math.PI * 2; }
      const n = Math.max(4, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * 64));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = a0 + (sweep * i) / n;
        pts.push(toWorld({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }));
      }
      addSeg(pts, SKETCH_COLOR);
    }
  }

  for (const p of skDoc.points) {
    if (p.id === 'origin' && !skDoc.entities.length) continue;
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(p.fixed ? 0.9 : 0.7, 12, 8),
      new THREE.MeshBasicMaterial({ color: p.fixed ? ANCHOR_COLOR : SKETCH_COLOR, depthTest: false })
    );
    dot.position.copy(toWorld(p));
    dot.renderOrder = 999;
    sketchGroup.add(dot);
  }

  // Rubber band from the last placed point to the cursor.
  if (skHover && skPending.length) {
    const last = skPending[skPending.length - 1];
    const from = typeof last === 'string' ? skPoint(last) : last;
    if (from) {
      if (skTool === 'rect') {
        const c = [
          { x: from.x, y: from.y }, { x: skHover.x, y: from.y },
          { x: skHover.x, y: skHover.y }, { x: from.x, y: skHover.y },
          { x: from.x, y: from.y },
        ].map(toWorld);
        addSeg(c, PENDING_COLOR);
      } else if (skTool === 'circle') {
        const r = Math.hypot(skHover.x - from.x, skHover.y - from.y);
        const pts = [];
        for (let i = 0; i <= 48; i++) {
          const t = (i / 48) * Math.PI * 2;
          pts.push(toWorld({ x: from.x + r * Math.cos(t), y: from.y + r * Math.sin(t) }));
        }
        addSeg(pts, PENDING_COLOR);
      } else {
        addSeg([toWorld(from), toWorld(skHover)], PENDING_COLOR);
      }
    }
  }

  drawSnapHint();
  // Keep the editable dimensions in step with the geometry they drive. Cheap:
  // it returns immediately unless the set of dimensions actually changed.
  rebuildSketchDims();
}

// The snap marker, and the guide line that explains an alignment snap. Without
// these the inference is invisible and you are back to trusting your aim.
function drawSnapHint() {
  if (!skSnapHint || !skHover) return;
  const h = skSnapHint;
  const r = Math.max(0.6, snapTolMm() * 0.34);   // constant size on screen

  if (h.kind === 'axisH' || h.kind === 'axisV') {
    // Dashed guide back to the point being drawn from, so the alignment reads
    // as a relationship rather than a coincidence.
    const a = snapAnchor();
    if (a) {
      const g = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([toWorld(a), toWorld(h)]),
        new THREE.LineDashedMaterial({ color: SNAP_COLOR, dashSize: r * 1.6, gapSize: r * 1.2, depthTest: false })
      );
      g.computeLineDistances();
      g.renderOrder = 998;
      sketchGroup.add(g);
    }
  }

  // A square for a point you can land exactly on, a diamond for everything else.
  const square = h.kind === 'endpoint' || h.kind === 'origin' || h.kind === 'centre' || h.kind === 'midpoint';
  const pts = square
    ? [[-r, -r], [r, -r], [r, r], [-r, r], [-r, -r]]
    : [[0, -r * 1.3], [r * 1.3, 0], [0, r * 1.3], [-r * 1.3, 0], [0, -r * 1.3]];
  addSeg(pts.map(([dx, dy]) => toWorld({ x: h.x + dx, y: h.y + dy })), SNAP_COLOR, 2);
}

// ---- the sketch toolbar -----------------------------------------------------

function syncSketchBar() {
  const bar = document.getElementById('sketch-bar');
  if (!bar || bar.hidden) return;
  bar.querySelectorAll('button[data-sktool]').forEach((b) => b.classList.toggle('on', b.dataset.sktool === skTool));
  const snapBtn = bar.querySelector('[data-sksnap]');
  if (snapBtn) { snapBtn.classList.toggle('on', skSnap > 0); snapBtn.textContent = skSnap > 0 ? `Snap ${skSnap}mm` : 'Snap off'; }
  const read = bar.querySelector('.sk-read');
  if (read) {
    const state = skDoc && skDoc.entities.length ? solveSketch(skDoc) : null;
    // Naming the snap is the point of having one. "Midpoint" tells you the next
    // click means something; a pair of coordinates does not.
    const hint = skSnapHint ? `<i class="sk-snap">${skSnapHint.label}</i> ` : '';
    read.innerHTML = skHover
      ? `${hint}<b>${skHover.x.toFixed(1)}</b>, <b>${skHover.y.toFixed(1)}</b> mm${state ? ` · ${state.dof} free` : ''}`
      : 'Click to draw';
  }
  const pl = bar.querySelector('[data-skplane]');
  if (pl) {
    // Report the plane you are actually on. 'Pick a face' only appears when you
    // explicitly asked for it, since at open you can equally just draw.
    pl.textContent = skPlane ? `On ${skPlaneLabel}` : (skPlaneArmed ? 'Pick a face' : 'On ground');
    pl.classList.toggle('on', !!skPlane || skPlaneArmed);
    // Once a curve exists the plane is locked in, since moving it would drag the
    // drawing out from under itself.
    pl.disabled = !!(skDoc && skDoc.entities.length);
  }
}

// The plane control. On a face, it drops you back to the ground and KEEPS you
// there, because a click over a solid should not silently undo the choice you
// just made. Already on the ground, it arms face picking for the next click.
// Both are refused once a curve exists, since moving the plane would drag the
// drawing out from under itself.
// Re-square the view with the sketch plane. Orbiting mid-sketch is allowed, and
// sometimes useful for seeing where a profile sits on a solid, but drawing while
// off-square is what produced the old imprecision, so getting back is one click.
function faceOnView() {
  if (!sketchOn) return;
  // Keep whatever the user has framed rather than yanking back to a fixed span.
  const span = Math.max(20, camera.position.distanceTo(orbit.target)
    * 2 * Math.tan((camera.fov * Math.PI / 180) / 2));
  viewPlaneNormal(skPlane, { span });
  flash('Squared up to the sketch plane.');
}

function resetSketchPlane() {
  if (skDoc && skDoc.entities.length) { flash('The plane is set once you start drawing. Undo the curves to change it.'); return; }

  if (skPlane) {
    skPlane = null;
    skPlaneLabel = 'Ground';
    skPlanePicked = true;               // latched: clicks now draw on the ground
    skPlaneArmed = false;
    skNeedsPlanePick = false;
    viewPlaneNormal(null);
    flash('Back on the ground plane, squared up to it.');
  } else {
    skPlanePicked = false;              // armed: the next click can choose a face
    skPlaneArmed = true;
    skNeedsPlanePick = true;
    // Drop back to the saved 3/4 view, otherwise there is no face to aim at
    // from straight overhead.
    if (camBeforeSketch) {
      const c = camBeforeSketch;
      animateCamera(c.pos.clone(), c.target.clone(), c.up.clone());
    }
    flash('Click a flat face to draw on it.');
  }
  drawSketchPreview();
  syncSketchBar();
}

function setSkTool(t) {
  skTool = t;
  skPending = [];
  closeDimInput();
  drawSketchPreview();
  syncSketchBar();
  const HINT = {
    line: 'Line: click a chain of points. Click the first point again to close it.',
    rect: 'Rectangle: click two opposite corners. Right angles and both dimensions come for free.',
    circle: 'Circle: click the centre, then a point on the rim.',
    dim: 'Dimension: click two points, then type the distance you want.',
    fillet: 'Fillet: type the radius at the cursor, then click a corner to round it.',
    chamfer: 'Chamfer: type the setback at the cursor, then click a corner to bevel it.',
  };
  flash(HINT[t] || '');
}

// The dimension entry: a number field that appears in the sketch bar rather than
// a browser prompt, so it stays inside the app and on a phone.
function openDimInput() {
  const bar = document.getElementById('sketch-bar');
  if (!bar || !skDimPair) return;
  closeDimInput();
  const wrap = document.createElement('span');
  wrap.id = 'sk-dim-entry';
  wrap.innerHTML = `<input type="number" step="0.5" value="${skDimPair.measured}" style="width:82px" aria-label="Distance in millimetres" /><button type="button" data-skapply>Set</button>`;
  bar.appendChild(wrap);
  const input = wrap.querySelector('input');
  input.focus(); input.select();
  const apply = () => {
    const v = parseFloat(input.value);
    closeDimInput();
    if (!Number.isFinite(v) || v <= 0 || !skDimPair) { skDimPair = null; return; }
    const con = addConstraint(skDoc, { type: 'distance', a: skDimPair.a, b: skDimPair.b, value: v });
    skDimPair = null;
    const report = solveAndDraw();
    if (!report.ok) {
      skDoc.constraints = skDoc.constraints.filter((c) => c.id !== con.id);
      solveAndDraw();
      flash('That dimension conflicts with the rules already on the sketch, so it was not added.');
    } else {
      flash(`Dimension set to ${v}mm.`);
    }
    syncSketchBar();
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); apply(); }
    if (ev.key === 'Escape') { ev.preventDefault(); closeDimInput(); skDimPair = null; }
  });
  wrap.querySelector('[data-skapply]').addEventListener('click', apply);
}

function closeDimInput() {
  document.getElementById('sk-dim-entry')?.remove();
}

function wireSketchBar() {
  const bar = document.getElementById('sketch-bar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.sktool) setSkTool(t.dataset.sktool);
    else if (t.dataset.sksnap !== undefined) { skSnap = skSnap > 0 ? 0 : 1; syncSketchBar(); }
    else if (t.dataset.skplane !== undefined) resetSketchPlane();
    else if (t.dataset.skface !== undefined) faceOnView();
    else if (t.dataset.skundo !== undefined) undoSketchStep();
    else if (t.dataset.skdone !== undefined) finishSketch();
    else if (t.dataset.skcancel !== undefined) setSketch(false);
  });
}

// Undo inside the sketcher drops the last curve and anything that only existed
// to describe it, rather than reaching into the document's history.
function undoSketchStep() {
  if (!skDoc) return;

  // A half-placed rectangle, circle or dimension has no curve yet, so undo just
  // abandons the click that started it.
  if (skPending.length && skTool !== 'line') { skPending = []; skDimPair = null; closeDimInput(); drawSketchPreview(); return; }

  const last = skDoc.entities.pop();
  if (!last) {
    // Nothing drawn, but a line chain may still have its first point down.
    if (skPending.length) { skPending = []; drawSketchPreview(); return; }
    flash('Nothing left to undo in this sketch.');
    return;
  }
  // Mid-chain, stepping back a segment also steps the chain's head back, so the
  // next click continues from where the removed segment started.
  if (skTool === 'line' && skPending.length > 1) skPending.pop();
  const ids = new Set([last.id]);
  skDoc.constraints = skDoc.constraints.filter((c) => !(ids.has(c.e) || ids.has(c.a) || ids.has(c.b) || ids.has(c.c)));
  // Drop points no remaining curve references.
  const used = new Set();
  for (const e of skDoc.entities) { for (const k of ['p1', 'p2', 'c']) if (e[k]) used.add(e[k]); }
  skDoc.points = skDoc.points.filter((p) => p.id === 'origin' || used.has(p.id));
  skDoc.constraints = skDoc.constraints.filter((c) =>
    [c.a, c.b, c.p].every((id) => id == null || id === 'origin' || skDoc.points.some((p) => p.id === id)));
  // The chain cannot keep pointing at a point that was just swept away.
  skPending = skPending.filter((id) => typeof id !== 'string' || skDoc.points.some((p) => p.id === id));
  solveAndDraw();
  syncSketchBar();
}

// A chain of lines with two loose ends is one segment short of a profile.
// Finishing should close it rather than refuse, which is what the old freehand
// tool did and what people expect from clicking points and pressing Enter.
function autoCloseChain() {
  const deg = new Map();
  for (const e of skDoc.entities) {
    if (e.type !== 'line') return false;                 // circles and arcs, leave it alone
    for (const k of ['p1', 'p2']) deg.set(e[k], (deg.get(e[k]) || 0) + 1);
  }
  const ends = [...deg.entries()].filter(([, n]) => n === 1).map(([id]) => id);
  if (ends.length !== 2 || skDoc.entities.length < 2) return false;
  const line = addLine(skDoc, ends[0], ends[1]);
  autoAxisConstraint(line);
  return true;
}

function finishSketch() {
  if (!skDoc || !skDoc.entities.length) { flash('Draw something before finishing the sketch.'); return; }
  skPending = [];
  let report = solveSketch(skDoc);
  let prof = sketchProfile(skDoc);
  if (!prof.closed && autoCloseChain()) {
    report = solveSketch(skDoc);
    prof = sketchProfile(skDoc);
  }
  if (!prof.closed) { flash(`The sketch is not a closed loop yet, so it cannot become a solid. ${prof.reason}`); return; }

  // Scale the first depth to the size of the drawing. A flat 20mm default is
  // right for a small bracket and looks like foil on a 400mm plate, which is
  // exactly what a big first sketch produced. The number stays editable.
  const depth = suggestedDepth(prof.profile);

  const obj = doc.add('sketch', {
    sk: cloneSketch(skDoc),
    profile: prof.profile,
    plane: skPlane ? JSON.parse(JSON.stringify(skPlane)) : null,
    op: 'extrude',
    depth,
    endType: 'blind',
    depth2: 0,
    start: 0,
    angle: 360,
    segments: 48,
  });
  doc.touch(obj);
  // Stash the profile before leaving the sketcher, so Cancel can put you back
  // in the sketch you just drew rather than an empty scene.
  const stash = { sk: cloneSketch(skDoc), plane: skPlane ? JSON.parse(JSON.stringify(skPlane)) : null, label: skPlaneLabel };
  // Leaving sketch mode also swings the camera back off square-on, which is
  // what makes the extrude visible at all: from straight down the plane the
  // solid grows directly at the camera and the depth reads as no change.
  setSketch(false);

  const state = report.status === 'fully' ? 'fully constrained' : `${report.dof} degrees of freedom left`;
  const repaired = obj.mesh.geometry.userData?.repaired;
  const pieces = obj.mesh.geometry.userData?.regions ?? 1;
  const fixNote = repaired
    ? (pieces > 1
        ? ` Your outline crossed itself, so it became ${pieces} separate pieces.`
        : ' Your outline crossed itself and was repaired.')
    : '';
  // Hand straight over to the extrude stage rather than declaring victory. The
  // solid exists, but the depth is still a guess until the user says otherwise.
  openExtrudeStage(obj, { note: `Profile closed, ${state}.${fixNote}`, stash });
}

// ------------------------------------------------------------- extrude stage
//
// Closing a profile used to build a solid at a guessed depth and drop you back
// in the scene with a one-line flash. Nothing was called "extrude", nothing was
// previewed, and the number was only findable in the Inspector afterwards. So
// the flagship operation was invisible: you could do it without ever knowing
// you had, and you could not tell it apart from "the sketch turned into a
// thing". This stage makes the depth the thing you are looking at and holds the
// operation open until you accept it.

let exObj = null;                  // the solid being shaped, null when closed
let exSymmetric = false;
let exDragging = null;
let exStash = null;                // the sketch that made it, so Cancel can go back

const exBar = () => document.getElementById('extrude-bar');
const exInput = () => document.getElementById('ex-depth');

function openExtrudeStage(obj, { note = '', stash = null } = {}) {
  exObj = obj;
  exStash = stash;
  exSymmetric = false;
  doc.select?.(obj.id);
  const bar = exBar();
  if (bar) bar.hidden = false;
  const inp = exInput();
  if (inp) {
    inp.value = round1(obj.params.depth);
    // Select the number so typing a real one replaces it immediately. This is
    // the single most common next action.
    inp.focus({ preventScroll: true });
    inp.select();
  }
  syncExtrudeBar();
  flash(`${note} Set the depth, then press Done.`.trim());
}

function closeExtrudeStage() {
  exObj = null; exDragging = null; exStash = null;
  const bar = exBar();
  if (bar) bar.hidden = true;
}

function syncExtrudeBar() {
  const sym = document.querySelector('[data-exsym]');
  if (sym) sym.setAttribute('aria-pressed', String(exSymmetric));
}

/** Apply a depth to the in-flight solid and rebuild it live. */
function setExtrudeDepth(mm, { fromInput = false } = {}) {
  if (!exObj) return;
  const d = Math.max(0.1, Math.abs(mm));
  const sign = mm < 0 ? -1 : 1;
  exObj.params.depth = d;
  // "Symmetric" grows the same total depth either side of the sketch plane, so
  // the number in the box stays the number you get overall.
  exObj.params.start = exSymmetric ? -d / 2 * sign : (sign < 0 ? -d : 0);
  exObj.rebuild();
  doc.touch(exObj);
  const inp = exInput();
  if (inp && !fromInput) inp.value = round1(d);
}

function flipExtrude() {
  if (!exObj) return;
  const cur = exObj.params.start < 0 && !exSymmetric ? 1 : -1;
  setExtrudeDepth(exObj.params.depth * cur);
  flash('Flipped the extrude direction.');
}

function toggleExtrudeSymmetric() {
  if (!exObj) return;
  exSymmetric = !exSymmetric;
  syncExtrudeBar();
  setExtrudeDepth(exObj.params.depth);
  flash(exSymmetric ? 'Growing both ways from the sketch plane.' : 'Growing one way from the sketch plane.');
}

function commitExtrude() {
  if (!exObj) return;
  const d = round1(exObj.params.depth);
  closeExtrudeStage();
  flash(`Extruded ${d}mm. Change it any time in the Inspector.`);
}

function cancelExtrude() {
  if (!exObj) return;
  const id = exObj.id;
  const stash = exStash;
  closeExtrudeStage();
  doc.remove(id);
  // Back into the sketch that made it, so a profile that was nearly right can
  // be fixed rather than redrawn from nothing.
  if (stash) {
    setSketch(true);
    skDoc = stash.sk;
    skPlane = stash.plane;
    skPlaneLabel = stash.label;
    skPlanePicked = true;
    skNeedsPlanePick = false;
    viewPlaneNormal(skPlane);
    syncSketchBar();
    solveAndDraw();
    flash('Extrude cancelled, back in the sketch.');
  } else {
    flash('Extrude cancelled.');
  }
}

// Dragging in the view sets the depth. Vertical drag, because the extrusion
// grows along the plane normal and "pull it up out of the sketch" is the mental
// model. The scale follows the camera distance so the solid tracks the finger
// at roughly the rate it appears to move, near or far.
function extrudeMmPerPixel() {
  const dist = camera.position.distanceTo(orbit.target);
  const worldPerPixel = (2 * dist * Math.tan((camera.fov * Math.PI / 180) / 2)) / renderer.domElement.clientHeight;
  return worldPerPixel;
}

function extrudeDragStart(e) {
  exDragging = { y: e.clientY, depth: exObj.params.depth, moved: false };
  renderer.domElement.setPointerCapture?.(e.pointerId);
}

function extrudeDragMove(e) {
  if (!exDragging) return;
  const dy = exDragging.y - e.clientY;         // up = thicker
  if (Math.abs(dy) > 2) exDragging.moved = true;
  let d = exDragging.depth + dy * extrudeMmPerPixel();
  // Snap to whole millimetres unless a fine drag is asked for, so the number
  // lands somewhere a person would have typed.
  if (!e.shiftKey) d = Math.round(d);
  setExtrudeDepth(Math.max(0.1, d));
}

function extrudeDragEnd() {
  if (exDragging?.moved) flash(`Depth ${round1(exObj.params.depth)}mm. Hold Shift while dragging for finer control.`);
  exDragging = null;
}

function wireExtrudeBar() {
  const bar = exBar();
  if (!bar) return;
  // The stage holds a reference to one object. Anything that can take that
  // object away underneath it — New scene, undo, a time-travel jump, a delete —
  // has to close the stage too, otherwise its bar sits there swallowing keys
  // while pointing at a solid that no longer exists.
  const dropIfGone = () => {
    if (exObj && !doc.list.some((o) => o.id === exObj.id)) closeExtrudeStage();
  };
  for (const ev of ['remove', 'undo', 'regroup', 'history']) doc.addEventListener(ev, dropIfGone);
  bar.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.exflip !== undefined) flipExtrude();
    else if (t.dataset.exsym !== undefined) toggleExtrudeSymmetric();
    else if (t.dataset.exok !== undefined) commitExtrude();
    else if (t.dataset.excancel !== undefined) cancelExtrude();
  });
  const inp = exInput();
  inp?.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (Number.isFinite(v) && v > 0) setExtrudeDepth(v, { fromInput: true });
  });
  inp?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitExtrude(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelExtrude(); }
  });
}

// Keep the old name working for the existing Enter binding.
const closeSketch = finishSketch;

// ------------------------------------------------------------------ view cube
//
// Vi's note was "it's super hard to angle the camera appropriately and I wish
// it would snap for me". Squaring up to the sketch plane covers the sketching
// half of that. This covers the rest: a cube that turns with the model, so you
// can always read which way you are facing, and whose every face is a button
// that flies the camera to that view.

// Which way the camera sits for each named view, as a direction from the target.
const VIEW_DIRS = {
  top:    [0, 1, 0],
  bottom: [0, -1, 0],
  front:  [0, 0, 1],
  back:   [0, 0, -1],
  right:  [1, 0, 0],
  left:   [-1, 0, 0],
  iso:    [0.62, 0.53, 0.80],
};

function snapToView(name) {
  const d = VIEW_DIRS[name];
  if (!d) return;
  const dir = new THREE.Vector3().fromArray(d).normalize();
  const target = orbit.target.clone();
  // Keep the distance the user already framed, so snapping turns the model
  // without also zooming somewhere unexpected.
  const dist = camera.position.distanceTo(target) || 160;
  // Straight up and straight down have no natural roll, so pick one that keeps
  // the model the right way up instead of letting lookAt spin it arbitrarily.
  const up = Math.abs(dir.y) > 0.999 ? new THREE.Vector3(0, 0, dir.y > 0 ? -1 : 1) : new THREE.Vector3(0, 1, 0);
  animateCamera(target.clone().add(dir.multiplyScalar(dist)), target, up);
}

// CSS 3D uses Y down and the DOM's own handedness, three.js uses Y up, so the
// rotation is conjugated by diag(1, -1, 1) on the way across. Without that the
// cube turns the wrong way vertically and reads as broken.
const vcEls = { cube: null, wrap: null };
let vcLast = '';

function syncViewCube() {
  if (!vcEls.cube) return;
  const m = new THREE.Matrix4().extractRotation(camera.matrixWorldInverse);
  const e = m.elements;                       // column-major, e[col * 4 + row]
  const s = [1, -1, 1];
  const v = [];
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) v.push(s[row] * e[col * 4 + row] * s[col]);
  }
  const css = `matrix3d(${v[0]},${v[1]},${v[2]},0,${v[3]},${v[4]},${v[5]},0,${v[6]},${v[7]},${v[8]},0,0,0,0,1)`;
  if (css !== vcLast) { vcEls.cube.style.transform = css; vcLast = css; }
}

function wireViewCube() {
  vcEls.wrap = document.getElementById('viewcube-wrap');
  vcEls.cube = document.querySelector('#viewcube .vc-cube');
  if (!vcEls.wrap) return;
  vcEls.wrap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    snapToView(b.dataset.view);
    flash(`${b.dataset.view === 'iso' ? 'Isometric' : b.dataset.view[0].toUpperCase() + b.dataset.view.slice(1)} view.`);
  });
  syncViewCube();
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
  if (!doc.list.length) { flash('Nothing to shoot. Add a solid first.'); return; }
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
  // The glyph is a dash, which tells a screen reader nothing and does not say
  // which panel it belongs to. Name it after the panel, and keep the name and
  // the pressed state honest as it toggles.
  const label = panelId.charAt(0).toUpperCase() + panelId.slice(1);
  const btn = document.createElement('button');
  btn.className = 'collapse-btn';
  btn.type = 'button';
  btn.title = 'Collapse / expand this panel';
  btn.textContent = '–';
  const name = (collapsed) => `${collapsed ? 'Expand' : 'Collapse'} the ${label} panel`;
  btn.setAttribute('aria-label', name(false));
  btn.setAttribute('aria-expanded', 'true');
  btn.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    btn.textContent = collapsed ? '+' : '–';
    btn.setAttribute('aria-label', name(collapsed));
    btn.setAttribute('aria-expanded', String(!collapsed));
  });
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

// Each skin owns three colours in the viewport: the background, and the grid's
// major and minor lines. The grid used to be blue-grey for every skin, which is
// why the pink skin still read as cold and blue (Vi, 2026-08-07).
const SKIN_VIEWPORT = {
  paper:     { bg: 0xdfe3e8, major: 0x9aa4b0, minor: 0xc3cad2 },
  plush:     { bg: 0xfceaf4, major: 0xe07cb6, minor: 0xf2c2dd },
  blueprint: { bg: 0x0a1622, major: 0x2d5a86, minor: 0x16334f },
  neon:      { bg: 0x0d0a18, major: 0x4b3a7a, minor: 0x261d40 },
  graphite:  { bg: 0x0b0d10, major: 0x333a42, minor: 0x1e2329 },
};
const SKIN_DEFAULT = { bg: 0x0e1116, major: 0x3a4654, minor: 0x232b34 };

function applyUiStyle(id) {
  document.documentElement.dataset.ui = id;
  // Tie the viewport background AND the grid to the palette, so the scene reads
  // as the same colour family as the panels rather than a cold hole in them.
  const skin = SKIN_VIEWPORT[id] ?? SKIN_DEFAULT;
  scene.background = new THREE.Color(skin.bg);
  setGrid(skin.major, skin.minor);
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

/** True when the still-under-construction parametric features are opted in. */
function experimentalOn() { return !!settings.experimental; }

/**
 * Show or hide everything behind the experimental gate.
 *
 * Hiding is done with a body class rather than by setting `hidden` on each
 * element, because several of these already use `hidden` for their own open and
 * closed state; writing to it here would fight that and leave, say, the sketch
 * bar visible the next time a sketch opened.
 *
 * Hiding a button is not enough on its own. Anything reachable another way, a
 * keyboard shortcut or the proxied top bar, is guarded at its entry point too,
 * so a gated feature cannot be started at all while the switch is off.
 */
function applyExperimental(on) {
  document.body.classList.toggle('no-experimental', !on);

  // A toolbar group whose every control is gated would otherwise be left as a
  // heading with nothing under it, which reads as a broken section rather than
  // a hidden one. Worked out from the DOM rather than hardcoded, so it stays
  // right as controls move between groups.
  for (const g of document.querySelectorAll('#toolbar .group')) {
    const controls = g.querySelectorAll('button, input, select');
    if (!controls.length) continue;
    const allGated = [...controls].every((c) => c.closest('[data-experimental]'));
    g.hidden = allGated && !on;
  }

  if (!on) {
    // Leave any gated mode that happens to be open, otherwise its state would
    // linger with no way to see or exit it.
    if (sketchOn) setSketch(false);
    if (exObj) cancelExtrude();
    timeline?.toggle?.(false);
    // Closing the slicer also puts the model back on screen, which matters more
    // than the panel does: it hides every mesh while it is open, and leaving
    // that behind would look like the scene had been emptied.
    sliceView?.toggle?.(false);
    document.getElementById('slice-btn')?.classList.remove('active');
  }
  dimchips?.setEnabled?.(on);
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

  // The gate's own list, rendered rather than restated. Adding a feature to
  // EXPERIMENTAL_FEATURES is now the only edit needed for it to appear here.
  const expList = document.getElementById('experimental-note');
  if (expList) {
    expList.innerHTML = EXPERIMENTAL_FEATURES
      .map((f) => `<li><b>${f.label}</b> — ${f.note}</li>`).join('')
      + '<li class="exp-caution">All of it is still being built, so expect rough edges. '
      + 'The slicer has not driven a real printer yet, so watch the first layer of anything you send it.</li>';
  }

  const expBox = document.getElementById('set-experimental');
  if (expBox) {
    expBox.checked = !!settings.experimental;
    expBox.addEventListener('change', () => {
      settings.experimental = expBox.checked;
      applyExperimental(settings.experimental);
      saveSettings(settings);
      flash(settings.experimental
        ? 'Experimental features on. Sketch, extrude, fillet, chamfer, loft, the timeline and the slicer are now in the toolbar.'
        : 'Experimental features off. The toolbar is back to the finished tools.');
    });
  }
  applyExperimental(settings.experimental);

  makeCollapsible('toolbar', '.brand');
  makeCollapsible('inspector', '.group-label');
  makeCollapsible('outliner', '.group-label');

  restorePanelWidth('--toolbar-w');
  restorePanelWidth('--side-w');
  makeResizable('toolbar', '--toolbar-w', 'right');   // left panel: drag its right edge
  makeResizable('side', '--side-w', 'left');           // right panels share one edge handle
  wireHints();
}

// ---------------------------------------------------------------- mobile UI
// On phones the floating panels would bury the viewport, so they become
// off-canvas drawers driven by a fixed bottom bar (created here, kept
// display:none above 640px so desktop is untouched). One drawer open at a time.
let openPanelId = null;
const scrim = document.createElement('div');
scrim.id = 'mobile-scrim';
const mobileBar = document.createElement('div');
mobileBar.id = 'mobile-bar';

function closeDrawers() {
  for (const id of ['toolbar', 'inspector', 'outliner'])
    document.getElementById(id)?.classList.remove('drawer-open');
  scrim.classList.remove('show');
  document.body.classList.remove('drawer-active');   // restore the Tips button
  openPanelId = null;
  syncMobileBar();
}
function openDrawer(id) {
  if (openPanelId === id) { closeDrawers(); return; }   // tapping the active tab closes it
  closeDrawers();
  // The slicer is a bottom sheet too, and two of them stacked is neither.
  if (sliceView?.visible) {
    sliceView.toggle(false);
    document.getElementById('slice-btn')?.classList.remove('active');
  }
  document.getElementById(id)?.classList.add('drawer-open');
  scrim.classList.add('show');
  document.body.classList.add('drawer-active');        // a drawer covers the Tips button, hide it
  openPanelId = id;
  syncMobileBar();
}
function syncMobileBar() {
  mobileBar.querySelectorAll('button[data-drawer]').forEach((b) =>
    b.classList.toggle('active', b.dataset.drawer === openPanelId));
}

function setupMobileUI() {
  const app = document.getElementById('app');
  const BTNS = [
    { drawer: 'toolbar',   ico: '☰', label: 'Tools' },
    { drawer: 'outliner',  ico: '▤', label: 'Objects' },
    { drawer: 'inspector', ico: '⚙', label: 'Inspect' },
    { act: 'frame',        ico: '⤢', label: 'Frame' },
  ];
  mobileBar.innerHTML = BTNS.map((b) =>
    `<button ${b.drawer ? `data-drawer="${b.drawer}"` : `data-act="${b.act}"`} title="${b.label}">`
    + `<span class="mb-ico">${b.ico}</span><span>${b.label}</span></button>`).join('');
  mobileBar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.drawer) openDrawer(btn.dataset.drawer);
    else if (btn.dataset.act === 'frame') { closeDrawers(); frameSelection(); }
  });
  scrim.addEventListener('click', closeDrawers);
  app.appendChild(scrim);
  app.appendChild(mobileBar);
}

// ---------------------------------------------------------------- empty state
// A gentle "Add a shape to begin" prompt, shown only when the scene is empty
// (e.g. just after New). pointer-events stay off the wrapper so it never blocks
// orbiting; only the button is live.
const emptyState = document.createElement('div');
emptyState.id = 'empty-state';
emptyState.hidden = true;
emptyState.innerHTML =
  `<div class="es-title">Add a shape to begin</div>`
  + `<div class="es-sub">Pick a primitive from the toolbar, then drag the gizmo or type exact sizes in the Inspector.</div>`
  + `<button class="es-add">Add a box</button>`;
// Hidden once anything exists, and also while a sketch is open: the scene is
// still technically empty then, but the middle of the canvas is exactly where
// the drawing and its dimensions are, so the prompt would cover the work.
function updateEmptyState() { emptyState.hidden = doc.list.length > 0 || sketchOn; }
function setupEmptyState() {
  document.getElementById('app').appendChild(emptyState);
  emptyState.querySelector('.es-add').addEventListener('click', () => doc.add('box'));
  for (const ev of ['add', 'remove', 'undo', 'regroup']) doc.addEventListener(ev, updateEmptyState);
  updateEmptyState();
}

// ---------------------------------------------------------------- onboarding
// A short, non-obtrusive coachmark tour: small callouts that point at the real
// controls (create primitives, edit, the Objects panel, autosave). The page stays
// fully interactive behind them. Shown once on first visit, replayable via Tips.
const ONBOARD_KEY = 'cadence.onboarded.v2';
function tourSteps() {
  return COARSE_POINTER ? [
    { sel: '[data-drawer="toolbar"]',   text: 'Tap Tools to create primitives like box, cylinder, sphere, and more.' },
    { sel: '[data-drawer="inspector"]', text: 'Tap Inspect to type exact sizes and positions for the selected shape.' },
    { sel: '[data-drawer="outliner"]',  text: 'Tap Objects for everything in your scene. Hit Multi to select several at once.' },
    { sel: null, text: 'Your work auto-saves as you go. Reopen CADence, even in a new browser tab, and it picks up right where you left off.' },
  ] : [
    { sel: '#toolbar [data-add]',         text: 'Create primitives here. Click a shape to drop it into the scene.' },
    { sel: '#toolbar .mode',              text: 'Drag the gizmo to move a shape; switch to Rotate or Scale here, or type exact sizes in the Inspector.' },
    { sel: '#outliner',                   text: 'Every object lives here. Shift-click, or hit Multi, to select several at once.' },
    { sel: '[data-action="new-project"]', text: 'Your work auto-saves as you go. Reload or open CADence in a new tab and it picks up right where you left off. New starts a fresh scene.' },
  ];
}
let _tour = null;
function endTour() {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch {}
  if (!_tour) return;
  window.removeEventListener('resize', _tour.onResize);
  _tour.card.remove(); _tour.ring.remove();
  _tour = null;
}
function startTour() {
  endTour();
  const app = document.getElementById('app');
  const list = tourSteps();
  const ring = document.createElement('div'); ring.id = 'cm-ring'; ring.hidden = true;
  const card = document.createElement('div'); card.id = 'cm-card';
  app.appendChild(ring); app.appendChild(card);
  _tour = { list, card, ring, i: 0, onResize: () => showStep(_tour.i) };
  window.addEventListener('resize', _tour.onResize);
  showStep(0);
}
function showStep(i) {
  if (!_tour) return;
  const step = _tour.list[i];
  if (!step) { endTour(); return; }
  _tour.i = i;
  const target = step.sel ? document.querySelector(step.sel) : null;
  let rect = target ? target.getBoundingClientRect() : null;
  if (rect && (rect.width === 0 || rect.height === 0)) rect = null;   // hidden / collapsed anchor
  const ring = _tour.ring;
  if (rect) {
    ring.hidden = false;
    ring.style.left = (rect.left - 6) + 'px'; ring.style.top = (rect.top - 6) + 'px';
    ring.style.width = (rect.width + 12) + 'px'; ring.style.height = (rect.height + 12) + 'px';
  } else ring.hidden = true;
  const last = i === _tour.list.length - 1;
  _tour.card.innerHTML =
    `<div class="cm-text">${step.text}</div>`
    + `<div class="cm-foot"><span class="cm-count">${i + 1} / ${_tour.list.length}</span>`
    + `<span class="cm-btns">`
    + (i > 0 ? `<button class="cm-back">Back</button>` : ``)
    + `<button class="cm-skip">Skip</button>`
    + `<button class="cm-next">${last ? 'Done' : 'Next'}</button>`
    + `</span></div>`;
  _tour.card.querySelector('.cm-next').onclick = () => (last ? endTour() : showStep(i + 1));
  _tour.card.querySelector('.cm-skip').onclick = endTour;
  const back = _tour.card.querySelector('.cm-back');
  if (back) back.onclick = () => showStep(i - 1);
  positionTourCard(rect);
}
function positionTourCard(rect) {
  const card = _tour.card;
  card.style.visibility = 'hidden'; card.style.left = '0px'; card.style.top = '0px';
  const cw = card.offsetWidth, ch = card.offsetHeight, vw = innerWidth, vh = innerHeight, gap = 12, pad = 10;
  let left, top;
  if (rect) {
    if (rect.bottom + gap + ch <= vh) top = rect.bottom + gap;
    else if (rect.top - gap - ch >= 0) top = rect.top - gap - ch;
    else top = rect.bottom + gap;
    left = rect.left + rect.width / 2 - cw / 2;
  } else { left = vw / 2 - cw / 2; top = vh - ch - 80; }
  left = Math.min(vw - cw - pad, Math.max(pad, left));
  top  = Math.min(vh - ch - pad, Math.max(pad, top));
  card.style.left = left + 'px'; card.style.top = top + 'px'; card.style.visibility = 'visible';
}
function setupOnboarding() {
  const tips = document.createElement('button');
  tips.id = 'tips-btn'; tips.textContent = 'Tips'; tips.title = 'Replay the quick tour';
  tips.addEventListener('click', startTour);
  document.getElementById('app').appendChild(tips);
  let seen = false;
  try { seen = !!localStorage.getItem(ONBOARD_KEY); } catch {}
  // Don't run onboarding when launched as a read-only portfolio viewer.
  let asViewer = false;
  try { const q = new URLSearchParams(location.search); asViewer = q.has('model') || q.get('view') === 'render'; } catch {}
  if (!seen && !asViewer) setTimeout(startTour, 700);
}

// ---------------------------------------------------------------- resize + loop
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
// The window 'resize' event doesn't fire when only the iframe is resized (e.g.
// the portfolio modal growing after open), which left the camera aspect stale
// and the model looking squashed. A ResizeObserver on <body> catches it.
if (window.ResizeObserver) { try { new ResizeObserver(resize).observe(document.body); } catch {} }
resize();

function tick() {
  requestAnimationFrame(tick);
  stepCameraAnim();
  orbit.update();
  renderer.render(scene, camera);
  dimchips.update();
  positionSketchDims();
  syncViewCube();
}
tick();

// Wired down here rather than beside wireSketchBar because the stage's helpers
// are const arrows, so an early call would land in their temporal dead zone.
wireExtrudeBar();
wireViewCube();

// Pre-warm the boolean kernel in the background so the first Group is snappy.
warmKernel();

// Apply saved preferences (UI style, render mode, controls) and wire hover hints
// before seeding, so the first object is drawn in the active render mode.
initSettings();

// Mobile drawers, the empty-state prompt, and the first-run tip. Safe on desktop
// (the bar/scrim stay hidden via CSS above 640px).
setupMobileUI();
setupEmptyState();
setupOnboarding();

// Restore the last autosaved project before the first render, so a reload — or
// reopening from the portfolio preview iframe in a fresh tab — picks up exactly
// where the session left off. If there's nothing valid to restore, seed a starter
// box so first load isn't empty.
if (IS_VIEWER) { /* renderview loads the model(s) from the URL; no starter cube */ }
else if (await tryLoadSharedLink(doc)) {
  flash('Shared design loaded. Your own last session is safe in a backup.');
  // Adopt the shared design as this session's working project: drop the #d= from
  // the URL so a close-and-reopen restores your edited autosave (not the original
  // link), and persist it right away so it survives even before the first edit.
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}
  scheduleAutosave(doc, 0);
}
else if (!restoreAutosave(doc)) doc.add('box');
setStatus();

// Expose for console tinkering / debugging.
window.cadence = {
  doc, scene, THREE, camera, renderer, orbit,
  // The slicer, exposed so the headless harness can drive it and read back the
  // plan rather than screenshot-diffing a pile of coloured lines.
  slicer: sliceView,
  // Sketcher internals, exposed so the headless harness can drive and inspect
  // the constrained sketcher the same way a person does.
  sketch: {
    get on() { return sketchOn; },
    get doc() { return skDoc; },
    get tool() { return skTool; },
    setTool: (t) => setSkTool(t),
    setSnap: (mm) => { skSnap = mm; syncSketchBar(); },
    get plane() { return skPlane; },
    get planeArmed() { return skPlaneArmed; },
    // What the cursor is currently promising: the snapped position and the kind
    // of snap. The harness asserts that a click lands exactly here, which is the
    // only way to catch the readout and the geometry disagreeing.
    get hover() { return skHover; },
    get snapHint() { return skSnapHint; },
    resetPlane: () => resetSketchPlane(),
    solve: () => (skDoc ? solveSketch(skDoc) : null),
    profile: () => (skDoc ? sketchProfile(skDoc) : null),
    finish: () => finishSketch(),
    cancel: () => setSketch(false),
  },
};
