// renderview.js — a presentation "Render view" that toggles against the full
// editor. Hides the editing chrome, shows a clean mobile-first render bar
// (style presets + auto-rotate + fit), and can load an external .obj read-only
// for the portfolio (via ?model=…&view=render). The editor's parametric/STEP
// core is never touched — this only adds a display layer on top.
//
// initRenderView({ THREE, scene, camera, renderer, orbit, gizmo, doc,
//                   applyRenderMode, fitToBox }) is called once from main.js.

import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

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
  const extMeshes = [];          // meshes from an externally loaded .obj (portfolio)

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

  // ----- apply a preset to editor objects (via main.js) AND any external meshes
  function styleExt(mode) {
    for (const m of extMeshes) {
      const mat = m.material; if (!mat || !('wireframe' in mat)) continue;
      mat.wireframe = false; mat.metalness = 0.08; mat.roughness = 0.6;
      mat.transparent = false; mat.opacity = 1; mat.depthWrite = true;
      if (mode === 'wireframe') mat.wireframe = true;
      else if (mode === 'matte') { mat.metalness = 0; mat.roughness = 1; }
      else if (mode === 'xray') { mat.transparent = true; mat.opacity = 0.32; mat.depthWrite = false; }
      mat.needsUpdate = true;
    }
  }
  function applyPreset(id) {
    preset = id;
    const p = PRESETS.find((x) => x.id === id) || PRESETS[0];
    setStudio(p.env);
    const matMode = (id === 'studio') ? 'shaded' : id;   // studio uses shaded materials + env
    api.applyRenderMode(matMode);
    styleExt(matMode);
    for (const b of bar.querySelectorAll('.rv-preset')) b.classList.toggle('active', b.dataset.id === id);
  }

  // ----- fit the camera to everything in view --------------------------------
  function fit() {
    const box = new THREE.Box3();
    let any = false;
    for (const o of doc.list) { if (o.mesh?.visible !== false) { box.expandByObject(o.mesh); any = true; } }
    for (const m of extMeshes) { box.expandByObject(m); any = true; }
    if (!any || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    if (![center.x, center.y, center.z, size.x, size.y, size.z].every(Number.isFinite)) return;  // NaN-safe
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const dist = radius / Math.sin(Math.min(Math.PI / 2.2, (camera.fov * Math.PI / 180) / 2)) * 1.15;
    const dir = new THREE.Vector3(1, 0.7, 1).normalize();
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = Math.max(radius / 500, 0.01); camera.far = dist + radius * 20;
    camera.updateProjectionMatrix();
    orbit.target.copy(center); orbit.update();
  }

  // ----- external .obj loader (read-only display) ----------------------------
  // Minimal, robust OBJ reader (v + f only). The real CAD exports here carry
  // NURBS free-form blocks that trip three's OBJLoader (it returns a point
  // cloud), so we parse the triangle mesh ourselves and ignore everything else.
  function loadOBJ(url) {
    fetch(url).then((r) => r.text()).then((text) => {
      const V = [];       // vertices, flat x,y,z
      const P = [];       // output triangle positions
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
      if (!P.length) { flash('Model has no faces'); return; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xcfd6de, metalness: 0.08, roughness: 0.6 }));
      mesh.frustumCulled = false;
      extMeshes.push(mesh);
      scene.add(mesh);
      for (const o of doc.list) if (o.mesh) o.mesh.visible = false;   // clean viewer: hide starter objects
      applyPreset(preset);
      fit();
    }).catch(() => flash('Could not load model'));
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

  // ----- launch from URL: ?model=<url>  ?view=render -------------------------
  try {
    const q = new URLSearchParams(location.search);
    const model = q.get('model');
    if (model) loadOBJ(model);
    if (q.get('view') === 'render' || model) setActive(true);
  } catch {}

  return { isActive: () => active, setActive, loadOBJ };
}
