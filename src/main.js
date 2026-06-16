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
import { exportSTL, export3MF, downloadJSON } from './io.js';
import { warmKernel, kernelSelfTest } from './kernel.js';
import { ROLE_LABELS } from './primitives.js';

// ---------------------------------------------------------------- scene setup
const canvas = document.getElementById('viewport');
// logarithmicDepthBuffer keeps depth precision sane across the huge near:far
// range below, so distant objects don't z-fight or sink behind the grid.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
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

const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSize(0.9);
gizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
gizmo.addEventListener('mouseDown', () => doc.commit());          // one undo step per drag
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

const inspector = new Inspector(doc, { onChange: () => setStatus() });
const outliner = new Outliner(doc);

// ---------------------------------------------------------------- picking
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
let downAt = null;

renderer.domElement.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (gizmo.dragging || !downAt) return;
  // Treat as a click only if the pointer barely moved (otherwise it was an orbit).
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;

  const r = renderer.domElement.getBoundingClientRect();
  ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);

  const meshes = doc.list.map((o) => o.mesh);
  const hit = ray.intersectObjects(meshes, false)[0];
  doc.select(hit ? hit.object.userData.cadId : null, e.shiftKey); // Shift = add to selection
});

// ---------------------------------------------------------------- toolbar
document.getElementById('toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.add) doc.add(btn.dataset.add);

  if (btn.dataset.mode) {
    gizmo.setMode(btn.dataset.mode);
    document.querySelectorAll('button.mode').forEach((b) => b.classList.toggle('active', b === btn));
  }

  switch (btn.dataset.action) {
    case 'delete':    doc.removeSelected(); break;
    case 'duplicate': if (doc.selectedId) doc.duplicate(doc.selectedId); break;
    case 'group':     groupSelected(); break;
    case 'intersect': intersectSelected(); break;
    case 'ungroup':   ungroupSelected(); break;
    case 'undo':      doc.undo(); break;
    case 'export-stl':
      if (exportSTL(doc.list)) flash('Exported STL.');
      else flash('Nothing printable to export — add a solid first.');
      break;
    case 'export-3mf':
      if (export3MF(doc.list)) flash('Exported 3MF (mm units).');
      else flash('Nothing printable to export — add a solid first.');
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
  else if ((e.ctrlKey || e.metaKey) && k === 'z') { doc.undo(); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'd') { if (doc.selectedId) doc.duplicate(doc.selectedId); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'g') { e.preventDefault(); e.shiftKey ? ungroupSelected() : groupSelected(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'i') { e.preventDefault(); intersectSelected(); }
  else if (k === 'f') frameSelection();
  else if (k === 'escape') doc.select(null);
});

function setMode(mode) {
  gizmo.setMode(mode);
  document.querySelectorAll('button.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}

// ---------------------------------------------------------------- status bar
const statusbar = document.getElementById('statusbar');
function setStatus() {
  const sel = doc.selected;
  const n = doc.selection.size;
  let left;
  if (n > 1) left = `<b>${n}</b> objects selected — Group (Ctrl+G) to combine`;
  else if (sel) left = `<b>${sel.name}</b> · ${sel.kind}${sel.role === 'hole' ? ` · <span style="color:#ff8a8a">${ROLE_LABELS.hole}</span>` : ''} · pos (${fmt(sel.mesh.position)}) mm`;
  else left = `${doc.list.length} object${doc.list.length === 1 ? '' : 's'} — click to select · Shift-click adds`;
  statusbar.innerHTML = `<span>${left}</span><span class="units">units: mm</span>`;
}
const fmt = (v) => [v.x, v.y, v.z].map((n) => n.toFixed(1)).join(', ');
function flash(msg) {
  statusbar.innerHTML = `<span>${msg}</span><span class="units">units: mm</span>`;
  setTimeout(setStatus, 2500);
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
}
tick();

// Pre-warm the boolean kernel in the background so the first Group is snappy.
warmKernel();

// Seed the scene so first load isn't empty.
doc.add('box');
setStatus();

// Expose for console tinkering / debugging.
window.cadence = { doc, scene, THREE };
