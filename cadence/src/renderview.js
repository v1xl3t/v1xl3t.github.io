// renderview.js — a presentation "Render view" that toggles against the full
// editor. Hides the editing chrome, shows a clean mobile-first render bar
// (style presets + auto-rotate + fit). Can also load external .obj model(s) as
// real, editable CADence objects for the portfolio (?model= / ?models= &
// view=render). The parametric/STEP core is untouched.
//
// initRenderView({ THREE, scene, camera, renderer, orbit, gizmo, doc,
//                   applyRenderMode }) is called once from main.js.

import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CadObject } from './model.js';

export function initRenderView(api) {
  const { THREE, scene, camera, renderer, orbit, gizmo, doc } = api;

  // ----- render styles. `env` = show studio reflections; the rest map onto the
  // editor's existing reversible material tweaks so both stay in sync.
  const PRESETS = [
    { id: 'studio',    label: 'Studio',    env: true  },
    { id: 'shaded',    label: 'Shaded',    env: false },
    { id: 'matte',     label: 'Clay',      env: false },
    { id: 'wireframe', label: 'Wire',      env: false },
    { id: 'xray',      label: 'X-ray',     env: false },
  ];
  let active = false;
  let preset = 'studio';

  // ----- studio environment (built lazily; reversible) ------------------------
  let envTex = null, savedTone = null, savedExposure = null;
  function buildEnv() {
    if (envTex) return envTex;
    const pmrem = new THREE.PMREMGenerator(renderer);
    envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
    return envTex;
  }
  function setStudio(on) {
    if (on) {
      scene.environment = buildEnv();
      if (savedTone === null) { savedTone = renderer.toneMapping; savedExposure = renderer.toneMappingExposure; }
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
    } else {
      scene.environment = null;
      if (savedTone !== null) { renderer.toneMapping = savedTone; renderer.toneMappingExposure = savedExposure; savedTone = savedExposure = null; }
    }
  }

  // ----- apply a preset (models are real doc objects, styled via main.js) -----
  function applyPreset(id) {
    preset = id;
    const p = PRESETS.find((x) => x.id === id) || PRESETS[0];
    setStudio(p.env);
    api.applyRenderMode(id === 'studio' ? 'shaded' : id);   // studio = shaded materials + env
    for (const b of bar.querySelectorAll('.rv-preset')) b.classList.toggle('active', b.dataset.id === id);
  }

  // ----- fit the camera to everything in the document -------------------------
  function fit() {
    const box = new THREE.Box3();
    let any = false;
    for (const o of doc.list) if (o.mesh && o.mesh.visible !== false) { box.expandByObject(o.mesh); any = true; }
    if (!any || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    if (![center.x, center.y, center.z, size.x, size.y, size.z].every(Number.isFinite)) return;  // NaN-safe
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const dist = radius / Math.sin(Math.min(Math.PI / 2.2, (camera.fov * Math.PI / 180) / 2)) * 1.15;
    const dir = new THREE.Vector3(1, 0.55, 1).normalize();
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = Math.max(radius / 500, 0.01); camera.far = dist + radius * 20;
    camera.updateProjectionMatrix();
    orbit.target.copy(center); orbit.update();
  }

  // ----- parse an .obj (v + f only) into a centered BufferGeometry ------------
  // The real CAD exports here carry NURBS free-form blocks that trip three's
  // OBJLoader (it returns a point cloud), so we read the triangle mesh ourselves.
  function parseOBJGeometry(text) {
    const V = [], P = [];
    const lines = text.split('\n');
    for (let n = 0; n < lines.length; n++) {
      const ln = lines[n];
      if (ln.charCodeAt(0) === 118 && ln[1] === ' ') {            // 'v '
        const t = ln.split(/\s+/);
        V.push(+t[1] || 0, +t[2] || 0, +t[3] || 0);
      } else if (ln.charCodeAt(0) === 102 && ln[1] === ' ') {     // 'f '
        const t = ln.trim().split(/\s+/);
        const idx = [];
        for (let i = 1; i < t.length; i++) {
          let vi = parseInt(t[i], 10);                            // index before any '/'
          if (vi < 0) vi = V.length / 3 + vi + 1;                 // relative index
          idx.push(vi - 1);
        }
        for (let i = 1; i < idx.length - 1; i++) {                // fan-triangulate ngons
          for (const k of [idx[0], idx[i], idx[i + 1]]) {
            const b = k * 3;
            P.push(V[b] || 0, V[b + 1] || 0, V[b + 2] || 0);
          }
        }
      }
    }
    if (!P.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.computeBoundingBox();
    const c = new THREE.Vector3(); g.boundingBox.getCenter(c);
    g.translate(-c.x, -c.y, -c.z);                                // origin at the model's center
    // normalize to a common size so a mixed-scale set lines up like a display row
    const sz = new THREE.Vector3(); g.boundingBox.getSize(sz);
    const maxDim = Math.max(sz.x, sz.y, sz.z) || 1;
    g.scale(MODEL_SIZE / maxDim, MODEL_SIZE / maxDim, MODEL_SIZE / maxDim);
    g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
  const MODEL_SIZE = 100;   // normalized max-dimension for each imported model

  function nameFromUrl(url, i) {
    try { return decodeURIComponent(url.split('/').pop().replace(/\.[^.]+$/, '')) || ('Model ' + (i + 1)); }
    catch { return 'Model ' + (i + 1); }
  }

  // ----- load model(s) as real, editable CADence objects, laid out in a row --
  function loadModels(urls) {
    Promise.all(urls.map((u) => fetch(u).then((r) => r.text()).then(parseOBJGeometry).catch(() => null)))
      .then((geos) => {
        const items = [];
        geos.forEach((g, i) => { if (g) items.push({ g, name: nameFromUrl(urls[i], i) }); });
        if (!items.length) { flash('Could not load model'); return; }
        // each geometry is normalized to MODEL_SIZE, so an even row reads clean
        const spacing = MODEL_SIZE * 1.5;
        items.forEach(({ g, name }, i) => {
          const obj = new CadObject({ kind: 'boolean', geometry: g, name });
          obj.setColor(0xc9d0d8);                                 // neutral, like the reference renders
          obj.mesh.position.x = (i - (items.length - 1) / 2) * spacing;
          doc.addImported(obj);
        });
        applyPreset(preset);
        fit();
      });
  }

  // ----- UI: toggle button in the topbar + a floating render bar -------------
  const topbar = document.getElementById('topbar');
  const toggle = document.createElement('button');
  toggle.id = 'rv-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Toggle render view');
  toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2"/><path d="M12 3.8v16.4M3.8 12h16.4"/></svg><span class="rv-lbl">Render</span>';
  if (topbar) topbar.appendChild(toggle);

  const bar = document.createElement('div');
  bar.id = 'rv-bar';
  bar.hidden = true;
  bar.innerHTML =
    '<div class="rv-group rv-presets">' +
      PRESETS.map((p) => `<button class="rv-preset" type="button" data-id="${p.id}">${p.label}</button>`).join('') +
    '</div>' +
    '<div class="rv-group rv-cam">' +
      '<button id="rv-rotate" type="button" title="Auto-rotate">↻ Spin</button>' +
      '<button id="rv-fit" type="button" title="Fit view">⤢ Fit</button>' +
    '</div>';
  (document.getElementById('app') || document.body).appendChild(bar);

  function flash(msg) { try { document.getElementById('statusbar').textContent = msg; } catch {} }

  function setActive(on) {
    active = on;
    document.body.classList.toggle('render-view', on);
    bar.hidden = !on;
    toggle.classList.toggle('active', on);
    toggle.querySelector('.rv-lbl').textContent = on ? 'Edit' : 'Render';
    if (gizmo) {
      gizmo.enabled = !on;
      if (on) { try { gizmo.detach(); } catch {} scene.remove(gizmo); }   // fully out of the render
      else { scene.add(gizmo); }
    }
    if (on) { applyPreset(preset); fit(); }
    else { setStudio(false); api.applyRenderMode('shaded'); orbit.autoRotate = false; }
  }

  toggle.addEventListener('click', () => setActive(!active));
  bar.addEventListener('click', (e) => {
    const p = e.target.closest('.rv-preset'); if (p) return applyPreset(p.dataset.id);
    if (e.target.closest('#rv-fit')) return fit();
    const r = e.target.closest('#rv-rotate');
    if (r) { orbit.autoRotate = !orbit.autoRotate; orbit.autoRotateSpeed = 1.6; r.classList.toggle('active', orbit.autoRotate); }
  });

  // ----- launch from URL: ?model=<url> or ?models=<url,url,…>  &view=render ---
  try {
    const q = new URLSearchParams(location.search);
    const many = q.get('models');
    const one = q.get('model');
    const urls = many ? many.split(',').map((s) => s.trim()).filter(Boolean) : (one ? [one] : []);
    if (urls.length) loadModels(urls);
    if (q.get('view') === 'render' || urls.length) setActive(true);
  } catch {}

  return { isActive: () => active, setActive, loadModels };
}
