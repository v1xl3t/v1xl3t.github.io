// model.js — the document model.
//
// The whole bet of CADence is that sculptural (mesh) and parametric (B-rep)
// worlds can coexist. The seed of that bridge lives here: every object carries
// a `recipe` — a small, serializable description of how it was made.
//
//   primitive: { kind: 'box', params: { width, height, depth }, role }
//   boolean:   { kind: 'boolean', children: [ ...child recipes ] }
//
// The Three.js mesh is *generated from* the recipe, never the source of truth.
// A box always knows it's a box; a group always knows the parts it ate. That
// provenance is what makes the mesh<->parametric round-trip tractable:
// group() bakes parts into one watertight body, ungroup() regenerates the exact
// parametric parts from their stored recipes. That cycle *is* the Stage-1
// bidirectional spike — parametric -> mesh -> boolean -> parametric, proven.

import { buildGeometry, DEFAULT_PARAMS } from './primitives.js';
import { booleanCombine, booleanIntersect } from './kernel.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three';

let _id = 0;
const nextId = () => `obj-${++_id}`;
const ensureId = (n) => { if (n > _id) _id = n; };  // keep the counter ahead of loaded ids
const cap = (s) => s[0].toUpperCase() + s.slice(1);

const SOLID_COLOR = '#7aa2ff';
const HOLE_COLOR = '#ff8a8a';
const GROUP_COLOR = '#9ad29a';

export class CadObject {
  // opts: { kind, params, name, role, geometry?, children? }
  //   geometry/children are only used for kind === 'boolean'.
  constructor({ kind, params, name, role = 'solid', geometry = null, children = null, baseMatrix = null }) {
    this.id = nextId();
    this.kind = kind;                       // 'box' | 'cylinder' | 'sphere' | 'boolean'
    this.role = role;                       // 'solid' | 'hole'
    this.children = children;               // boolean only: array of child snapshots
    this.baseMatrix = baseMatrix;           // boolean only: pivot matrix at creation (for ungroup delta)
    this.params = kind === 'boolean' ? { ...(params || {}) } : { ...DEFAULT_PARAMS[kind], ...params };
    this.name = name || (kind === 'boolean' ? 'Group' : cap(kind));
    this.color = role === 'hole' ? HOLE_COLOR : kind === 'boolean' ? GROUP_COLOR : SOLID_COLOR;

    const geo = kind === 'boolean' ? geometry : buildGeometry(kind, this.params);
    this.mesh = new THREE.Mesh(geo, this._material());
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.userData.cadId = this.id;
  }

  _material() {
    const isHole = this.role === 'hole';
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.color),
      metalness: 0.05,
      roughness: 0.65,
      transparent: isHole,                  // holes read as translucent (TinkerCAD cue)
      opacity: isHole ? 0.35 : 1,
      depthWrite: !isHole,
    });
  }

  // Re-evaluate the recipe -> rebuild geometry. Primitives only; a boolean's
  // geometry is produced by the kernel at group time, not from scalar params.
  rebuild() {
    if (this.kind === 'boolean') return;
    const next = buildGeometry(this.kind, this.params);
    this.mesh.geometry.dispose();
    this.mesh.geometry = next;
  }

  setColor(hex) { this.color = hex; this.mesh.material.color.set(hex); }

  setRole(role) {
    this.role = role;                       // groups can be holes too
    this.color = role === 'hole' ? HOLE_COLOR : this.kind === 'boolean' ? GROUP_COLOR : SOLID_COLOR;
    this.mesh.material.dispose();
    this.mesh.material = this._material();
  }

  // In-memory snapshot — recipe + placement (+ baked geometry for booleans, so
  // undo can restore a group without re-running the async kernel).
  snapshot() {
    const { position, rotation, scale } = this.mesh;
    const s = {
      id: this.id, kind: this.kind, role: this.role, name: this.name, color: this.color,
      params: { ...this.params },
      position: position.toArray(),
      rotation: [rotation.x, rotation.y, rotation.z],
      scale: scale.toArray(),
    };
    if (this.kind === 'boolean') {
      s.children = this.children ? this.children.map((c) => ({ ...c })) : null;
      s.geometryClone = this.mesh.geometry.clone();
      s.baseMatrix = this.baseMatrix ? this.baseMatrix.toArray() : null;
    }
    return s;
  }

  applySnapshot(s) {
    this.name = s.name;
    this.role = s.role ?? this.role;
    this.setColor(s.color);
    this.mesh.position.fromArray(s.position);
    this.mesh.rotation.set(...s.rotation);
    this.mesh.scale.fromArray(s.scale);
    if (this.kind !== 'boolean') { this.params = { ...s.params }; this.rebuild(); }
  }
}

export class CadDocument extends EventTarget {
  constructor() {
    super();
    this.objects = new Map();      // id -> CadObject
    this.selection = new Set();    // multi-select set of ids
    this.selectedId = null;        // primary selection (drives gizmo + inspector)
    this._undo = [];
  }

  get selected() { return this.selectedId ? this.objects.get(this.selectedId) : null; }
  get list() { return [...this.objects.values()]; }
  get selectedObjects() { return [...this.selection].map((id) => this.objects.get(id)).filter(Boolean); }

  // Give each object a readable, unique name: "Box", "Box 2", "Box 3"…
  _uniqueName(base) {
    const taken = new Set(this.list.map((o) => o.name));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  add(kind, params, role = 'solid') {
    this.commit();
    const obj = new CadObject({ kind, params, role });
    obj.name = this._uniqueName(obj.name);
    this.objects.set(obj.id, obj);
    this._emit('add', obj);
    this.select(obj.id);
    return obj;
  }

  remove(id) {
    const obj = this.objects.get(id);
    if (!obj) return;
    this.commit();
    obj.mesh.geometry.dispose();
    obj.mesh.material.dispose();
    this.objects.delete(id);
    this.selection.delete(id);
    if (this.selectedId === id) this.select(null);
    this._emit('remove', obj);
  }

  duplicate(id) {
    const src = this.objects.get(id);
    if (!src) return;
    this.commit();

    let copy;
    if (src.kind === 'boolean') {
      // Clone the baked geometry, the child recipes, and the pivot matrix so the
      // duplicate is a fully independent, still-ungroupable group.
      copy = new CadObject({
        kind: 'boolean', role: src.role, name: `${src.name} copy`,
        geometry: src.mesh.geometry.clone(),
        children: src.children ? src.children.map((c) => ({ ...c, geometryClone: c.geometryClone?.clone() })) : null,
        baseMatrix: src.baseMatrix ? src.baseMatrix.clone() : null,
      });
    } else {
      copy = new CadObject({ kind: src.kind, params: src.params, role: src.role });
    }
    copy.name = this._uniqueName(src.name);
    this.objects.set(copy.id, copy);
    copy.setColor(src.color);
    copy.mesh.position.copy(src.mesh.position);
    copy.mesh.rotation.copy(src.mesh.rotation);
    copy.mesh.scale.copy(src.mesh.scale);

    // Nudge along +X by the object's own width so the copy is visible.
    copy.mesh.geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    copy.mesh.geometry.boundingBox.getSize(size);
    copy.mesh.position.x += Math.max(size.x * copy.mesh.scale.x, 5);

    this._emit('add', copy);
    this.select(copy.id);
    return copy;
  }

  // --- selection --------------------------------------------------------
  select(id, additive = false) {
    if (id == null) { this.selection.clear(); this.selectedId = null; }
    else if (additive) {
      if (this.selection.has(id)) {
        this.selection.delete(id);
        this.selectedId = this.selection.size ? [...this.selection].pop() : null;
      } else { this.selection.add(id); this.selectedId = id; }
    } else { this.selection = new Set([id]); this.selectedId = id; }
    this._emit('select', this.selected);
  }

  touch(obj) { this._emit('change', obj); }

  selectAll() {
    this.selection = new Set(this.objects.keys());
    this.selectedId = this.selection.size ? [...this.selection].pop() : null;
    this._emit('select', this.selected);
  }

  // Delete every selected object in a single undo step.
  removeSelected() {
    const ids = [...this.selection];
    if (!ids.length) return;
    this.commit();
    for (const id of ids) {
      const o = this.objects.get(id);
      if (!o) continue;
      o.mesh.geometry.dispose(); o.mesh.material.dispose();
      this.objects.delete(id);
    }
    this.selection.clear();
    this.selectedId = null;
    this._emit('regroup');   // scene rebuilt from the document
  }

  // --- copy / paste -----------------------------------------------------
  // Clipboard is plain serialized data (held by the caller in main.js).
  copySelection() {
    return this.selectedObjects.map(serializeObject);
  }

  paste(clip) {
    if (!clip || !clip.length) return null;
    this.commit();
    this.selection.clear();
    let last = null;
    for (const d of clip) {
      const obj = deserializeObject(d);
      obj.id = nextId();                       // fresh identity — never collide with the source
      obj.mesh.userData.cadId = obj.id;
      obj.name = this._uniqueName(obj.name);
      obj.mesh.position.x += 10;               // offset so the paste is visible
      obj.mesh.position.z += 10;
      this.objects.set(obj.id, obj);
      this.selection.add(obj.id);
      last = obj.id;
    }
    this.selectedId = last;
    this._emit('regroup');
    this._emit('select', this.selected);
    return last;
  }

  // --- boolean group / ungroup -----------------------------------------
  async group(ids) {
    const objs = ids.map((id) => this.objects.get(id)).filter(Boolean);
    if (objs.length < 2) return null;
    // Run the kernel first; if it fails, the document is left untouched.
    const result = await booleanCombine(objs.map((o) => ({ mesh: o.mesh, role: o.role })));
    if (!result) { this.commit(); this._disband(objs); this.select(null); this._emit('regroup'); return null; } // all holes
    return this._bakeGroup(objs, result.geometry, 'Group');
  }

  async intersect(ids) {
    const objs = ids.map((id) => this.objects.get(id)).filter(Boolean);
    if (objs.length < 2) return null;
    const result = await booleanIntersect(objs.map((o) => o.mesh));
    if (!result) return null;     // no shared volume — leave document untouched
    return this._bakeGroup(objs, result.geometry, 'Intersection');
  }

  _disband(objs) {
    for (const o of objs) {
      o.mesh.geometry.dispose(); o.mesh.material.dispose();
      this.objects.delete(o.id); this.selection.delete(o.id);
    }
  }

  // Consume `objs` into one watertight boolean body built from `geometry`.
  _bakeGroup(objs, geometry, name) {
    this.commit();
    const children = objs.map((o) => o.snapshot());   // world-space recipes for ungroup
    this._disband(objs);

    // Recenter so the pivot sits on the body, not at world origin — while the
    // body stays exactly where it was in the world.
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    geometry.translate(-center.x, -center.y, -center.z);

    const grp = new CadObject({ kind: 'boolean', geometry, children, name });
    grp.mesh.position.copy(center);
    grp.mesh.updateMatrix();
    grp.baseMatrix = grp.mesh.matrix.clone();   // ungroup applies only the delta from this

    this.objects.set(grp.id, grp);
    this._emit('regroup');
    this.select(grp.id);
    return grp;
  }

  ungroup(id) {
    const grp = this.objects.get(id);
    if (!grp || grp.kind !== 'boolean' || !grp.children) return;
    this.commit();

    // Apply only the DELTA the group moved since creation, so children land back
    // exactly where they were (their recipes are stored in world space).
    grp.mesh.updateMatrix();
    const base = grp.baseMatrix ? grp.baseMatrix.clone() : new THREE.Matrix4();
    const M = grp.mesh.matrix.clone().multiply(base.invert());
    grp.mesh.geometry.dispose(); grp.mesh.material.dispose();
    this.objects.delete(id); this.selection.delete(id);

    const restored = [];
    for (const s of grp.children) {
      // Children may themselves be groups (nested boolean) — restore their
      // baked geometry + child recipes so ungroup is lossless at any depth.
      const obj = new CadObject(
        s.kind === 'boolean'
          ? { kind: 'boolean', params: s.params, name: s.name, role: s.role, geometry: s.geometryClone, children: s.children }
          : { kind: s.kind, params: s.params, name: s.name, role: s.role }
      );
      obj.setColor(s.color);
      obj.mesh.position.fromArray(s.position);
      obj.mesh.rotation.set(...s.rotation);
      obj.mesh.scale.fromArray(s.scale);
      obj.mesh.applyMatrix4(M);
      this.objects.set(obj.id, obj);
      restored.push(obj);
    }
    this._emit('regroup');
    this.select(restored.length ? restored[restored.length - 1].id : null);
    return restored;
  }

  // --- undo -------------------------------------------------------------
  commit() {
    this._undo.push(this.list.map((o) => o.snapshot()));
    if (this._undo.length > 50) this._undo.shift();
  }

  undo() {
    const snap = this._undo.pop();
    if (!snap) return;
    for (const o of this.list) { o.mesh.geometry.dispose(); o.mesh.material.dispose(); }
    this.objects.clear();
    for (const s of snap) {
      const obj = new CadObject(
        s.kind === 'boolean'
          ? { kind: 'boolean', params: s.params, name: s.name, role: s.role, geometry: s.geometryClone,
              children: s.children, baseMatrix: s.baseMatrix ? new THREE.Matrix4().fromArray(s.baseMatrix) : null }
          : { kind: s.kind, params: s.params, name: s.name, role: s.role }
      );
      obj.id = s.id; obj.mesh.userData.cadId = s.id;
      obj.applySnapshot(s);
      this.objects.set(s.id, obj);
    }
    this.selection = new Set([...this.selection].filter((id) => this.objects.has(id)));
    this.selectedId = this.objects.has(this.selectedId) ? this.selectedId : null;
    this._emit('undo');
  }

  // --- save / load ------------------------------------------------------
  toJSON() {
    return { app: 'CADence', version: 1, objects: this.list.map(serializeObject) };
  }

  loadJSON(data) {
    if (!data || !Array.isArray(data.objects)) throw new Error('Not a CADence project file');
    this.commit();
    for (const o of this.list) { o.mesh.geometry.dispose(); o.mesh.material.dispose(); }
    this.objects.clear(); this.selection.clear(); this.selectedId = null;

    for (const d of data.objects) {
      const obj = deserializeObject(d);
      this.objects.set(obj.id, obj);
      ensureId(parseInt(String(obj.id).replace(/\D/g, ''), 10) || 0);
    }
    this._emit('regroup');   // main.js rebuilds the scene from the document
    this.select(null);
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

// --- (de)serialization helpers -------------------------------------------
// Primitives persist as their recipe (kind + params) and rebuild from it.
// Booleans persist their baked geometry as plain arrays + their child recipes,
// so loading is synchronous and lossless — no kernel re-run needed on open.

function geoToArrays(geo) {
  const pos = geo.getAttribute('position');
  return { position: Array.from(pos.array), index: geo.index ? Array.from(geo.index.array) : null };
}

function arraysToGeo(d) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(d.position, 3));
  if (d.index) { g.setIndex(d.index); g.computeVertexNormals(); return g; }
  const creased = toCreasedNormals(g, Math.PI / 6); // restore crisp boolean shading
  g.dispose();
  return creased;
}

// A boolean's child entries are snapshot()-shaped (may nest). Convert their
// THREE geometry clones to/from arrays recursively.
function serializeChild(s) {
  const c = {
    id: s.id, kind: s.kind, role: s.role, name: s.name, color: s.color,
    params: { ...s.params }, position: [...s.position], rotation: [...s.rotation], scale: [...s.scale],
  };
  if (s.kind === 'boolean') {
    c.baseMatrix = s.baseMatrix || null;                       // already an array from snapshot()
    c.geometry = s.geometryClone ? geoToArrays(s.geometryClone) : null;
    c.children = s.children ? s.children.map(serializeChild) : null;
  }
  return c;
}

function reviveChild(c) {
  const s = {
    id: c.id, kind: c.kind, role: c.role, name: c.name, color: c.color,
    params: { ...c.params }, position: [...c.position], rotation: [...c.rotation], scale: [...c.scale],
  };
  if (c.kind === 'boolean') {
    s.baseMatrix = c.baseMatrix || null;
    s.geometryClone = c.geometry ? arraysToGeo(c.geometry) : null;
    s.children = c.children ? c.children.map(reviveChild) : null;
  }
  return s;
}

function serializeObject(o) {
  const d = {
    id: o.id, kind: o.kind, role: o.role, name: o.name, color: o.color,
    params: { ...o.params },
    position: o.mesh.position.toArray(),
    rotation: [o.mesh.rotation.x, o.mesh.rotation.y, o.mesh.rotation.z],
    scale: o.mesh.scale.toArray(),
    visible: o.mesh.visible,
  };
  if (o.kind === 'boolean') {
    d.baseMatrix = o.baseMatrix ? o.baseMatrix.toArray() : null;
    d.geometry = geoToArrays(o.mesh.geometry);
    d.children = o.children ? o.children.map(serializeChild) : null;
  }
  return d;
}

function deserializeObject(d) {
  let obj;
  if (d.kind === 'boolean') {
    obj = new CadObject({
      kind: 'boolean', name: d.name, role: d.role,
      geometry: arraysToGeo(d.geometry),
      children: d.children ? d.children.map(reviveChild) : null,
      baseMatrix: d.baseMatrix ? new THREE.Matrix4().fromArray(d.baseMatrix) : null,
    });
  } else {
    obj = new CadObject({ kind: d.kind, params: d.params, name: d.name, role: d.role });
  }
  obj.id = d.id;
  obj.mesh.userData.cadId = d.id;
  obj.setColor(d.color);
  obj.mesh.position.fromArray(d.position);
  obj.mesh.rotation.set(...d.rotation);
  obj.mesh.scale.fromArray(d.scale);
  if (d.visible === false) obj.mesh.visible = false;
  return obj;
}
