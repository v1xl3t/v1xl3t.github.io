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

import { buildGeometry, DEFAULT_PARAMS, resolveSketch, computeExtrudeReach, computeExtrudeUpTo } from './primitives.js';
import { cloneSketch, addConstraint, removeConstraint } from './sketch.js';
import { booleanCombine, booleanIntersect } from './kernel.js';
import { History } from './history.js';
import { chainBetween, canReplay, bakeOf } from './replay.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three';

let _id = 0;
const nextId = () => `obj-${++_id}`;
const ensureId = (n) => { if (n > _id) _id = n; };  // keep the counter ahead of loaded ids
const cap = (s) => s[0].toUpperCase() + s.slice(1);

const SOLID_COLOR = '#7aa2ff';
const HOLE_COLOR = '#ff8a8a';
const GROUP_COLOR = '#9ad29a';
const BREP_COLOR = '#9ad29a';

/**
 * Kinds whose mesh is BAKED by a kernel rather than built from scalar params.
 *
 * A boolean's shape comes out of Manifold and an exact solid's comes out of
 * OpenCascade, and neither can be recomputed by `buildGeometry`. Everything
 * that treats those two differently from a box asks this set rather than
 * naming 'boolean' and hoping someone remembers to add the next one. Forgetting
 * one of these is not a visible bug, it is a silently empty mesh on load.
 */
const BAKED_KINDS = new Set(['boolean', 'brep']);

// The same three colours, exported so the tiny share-link format can predict
// them instead of keeping a second copy that could drift. A colour a link does
// not carry is a colour the app already knows.
export const DEFAULT_COLORS = { solid: SOLID_COLOR, hole: HOLE_COLOR, boolean: GROUP_COLOR };

export class CadObject {
  // opts: { kind, params, name, role, geometry?, children? }
  //   geometry/children are only used for kind === 'boolean'.
  constructor({ kind, params, name, role = 'solid', geometry = null, children = null, baseMatrix = null }) {
    this.id = nextId();
    this.kind = kind;                       // 'box' | 'cylinder' | 'sphere' | 'boolean'
    this.role = role;                       // 'solid' | 'hole'
    this.children = children;               // boolean only: array of child snapshots
    this.baseMatrix = baseMatrix;           // boolean only: pivot matrix at creation (for ungroup delta)
    this.params = BAKED_KINDS.has(kind) ? { ...(params || {}) } : { ...DEFAULT_PARAMS[kind], ...params };
    this.name = name || (kind === 'boolean' ? 'Group' : kind === 'brep' ? 'Exact solid' : cap(kind));
    this.color = role === 'hole' ? HOLE_COLOR : kind === 'boolean' ? GROUP_COLOR : kind === 'brep' ? BREP_COLOR : SOLID_COLOR;

    const geo = BAKED_KINDS.has(kind) ? geometry : buildGeometry(kind, this.params);
    this.mesh = new THREE.Mesh(geo, this._material());
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.userData.cadId = this.id;
    this._tagPattern();
  }

  /**
   * Tell the kernel that this mesh is really N bodies made from one rule.
   *
   * The merged geometry a pattern draws with is only safe as CSG input while
   * its copies stay apart. Rather than police that, the kernel rebuilds the
   * copies and unions them properly, and it finds out that it should through
   * this tag rather than by knowing what a CADence object is.
   */
  _tagPattern() {
    if (this.kind === 'pattern') this.mesh.userData.patternParams = this.params;
    else delete this.mesh.userData.patternParams;
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
    if (BAKED_KINDS.has(this.kind)) return;
    const next = buildGeometry(this.kind, this.params);
    this.mesh.geometry.dispose();
    this.mesh.geometry = next;
    this._tagPattern();
  }

  setColor(hex) { this.color = hex; this.mesh.material.color.set(hex); }

  setRole(role) {
    this.role = role;                       // groups can be holes too
    this.color = role === 'hole' ? HOLE_COLOR : this.kind === 'boolean' ? GROUP_COLOR : this.kind === 'brep' ? BREP_COLOR : SOLID_COLOR;
    this.mesh.material.dispose();
    this.mesh.material = this._material();
  }

  // In-memory snapshot — recipe + placement (+ baked geometry for booleans, so
  // undo can restore a group without re-running the async kernel).
  snapshot() {
    const { position, rotation, scale } = this.mesh;
    const s = {
      id: this.id, kind: this.kind, role: this.role, name: this.name, color: this.color,
      params: deepParams(this.params),
      position: position.toArray(),
      rotation: [rotation.x, rotation.y, rotation.z],
      scale: scale.toArray(),
    };
    if (BAKED_KINDS.has(this.kind)) {
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
    if (!BAKED_KINDS.has(this.kind)) { this.params = deepParams(s.params); this.rebuild(); }
  }
}

export class CadDocument extends EventTarget {
  constructor() {
    super();
    this.objects = new Map();      // id -> CadObject
    this.selection = new Set();    // multi-select set of ids
    this.selectedId = null;        // primary selection (drives gizmo + inspector)

    // --- history TREE (replaces the old linear undo stack) ---------------
    // commit() is called just BEFORE every undoable action; we capture the
    // RESULT of that action into a node moments later (flushed by the next
    // commit, by a settle-debounce, or explicitly before any time-travel).
    this.history = new History();
    this.history.init(this.toJSON());     // root = the empty starting scene
    this._armed = false;                  // a step is in progress, awaiting capture
    this._armedLabel = 'Edit';
    this._timer = null;
    this._restoring = false;              // true while applying a snapshot (don't re-record)
    this._thumb = null;                   // optional () => dataURL provided by the view
    this._travel = null;                  // the future walked away from, if any
    this.pendingReplay = null;            // an offer to bring that future forward

    // A burst of 'change' events (a gizmo drag, rapid field edits) should settle
    // into ONE node: each change pushes the capture out to just after the last one.
    this.addEventListener('change', () => { if (this._armed) this._bump(); });
  }

  setThumbnailProvider(fn) { this._thumb = fn; }

  /**
   * Resolve a scene-aware extrude ('through' / 'upTo') against the rest of the
   * model and cache the answer on the recipe.
   *
   * This exists because buildGeometry is pure: one recipe in, one geometry out,
   * no scene. That purity is worth keeping (it is why the headless suites and
   * the STEP exporter can build without a viewport), so the scene question is
   * answered here and handed to the builder as data.
   *
   * Call it before rebuild whenever the object or its neighbours move. It is a
   * no-op for every other end type, so calling it liberally is cheap.
   */
  resolveExtrudeReach(obj) {
    if (!obj || obj.kind !== 'sketch') return;
    const end = obj.params.endType;
    if (end !== 'through' && end !== 'upTo') return;
    const others = [];
    for (const o of this.objects.values()) {
      if (o.id === obj.id || !o.mesh) continue;
      o.mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(o.mesh);
      if (!box.isEmpty()) others.push(box);
    }
    obj.mesh.updateMatrixWorld(true);
    const opts = {
      start: Number(obj.params.start) || 0,
      worldInv: obj.mesh.matrixWorld.clone().invert(),
    };
    obj.params.reach = end === 'upTo'
      ? computeExtrudeUpTo(obj.params.plane, others, opts)
      : computeExtrudeReach(obj.params.plane, others, opts);
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
    this.commit('Add ' + cap(kind));
    const obj = new CadObject({ kind, params, role });
    obj.name = this._uniqueName(obj.name);
    this.objects.set(obj.id, obj);
    this._emit('add', obj);
    this.select(obj.id);
    return obj;
  }

  // ---- parametric sketch -----------------------------------------------------
  //
  // Editing a driving dimension is the whole point of a parametric sketch: the
  // number changes, the solver moves the geometry to obey every constraint
  // again, and the solid rebuilds from the new profile. Each edit is one
  // history step, so it time-travels like any other operation.

  /**
   * Change a driving dimension on a sketch object and rebuild it.
   * @returns {{ok:boolean, status:string, dof:number, reason:string}|null}
   */
  setSketchDimension(objId, constraintId, value) {
    const obj = this.objects.get(objId);
    if (!obj || obj.kind !== 'sketch' || !obj.params.sk) return null;
    if (!Number.isFinite(value)) return null;

    const con = obj.params.sk.constraints.find((c) => c.id === constraintId);
    if (!con) return null;

    this.commit(`Dimension ${con.type}`);
    const before = cloneSketch(obj.params.sk);
    con.value = value;
    const report = resolveSketch(obj.params);

    if (!report.ok) {
      // An unreachable value would leave the sketch mangled, so put it back and
      // tell the caller why rather than silently keeping bad geometry.
      obj.params.sk = before;
      resolveSketch(obj.params);
      return { ...report, ok: false };
    }

    obj.rebuild();
    this._emit('change', obj);
    return report;
  }

  /** Replace a sketch object's whole sketch document (used by the sketcher). */
  setSketchDoc(objId, sk, label = 'Edit sketch') {
    const obj = this.objects.get(objId);
    if (!obj || obj.kind !== 'sketch') return null;
    this.commit(label);
    obj.params.sk = sk;
    const report = resolveSketch(obj.params);
    if (report.closed) obj.rebuild();
    this._emit('change', obj);
    return report;
  }

  /** Add or remove a constraint on an existing sketch, then re-solve. */
  editSketchConstraint(objId, op, payload) {
    const obj = this.objects.get(objId);
    if (!obj || obj.kind !== 'sketch' || !obj.params.sk) return null;
    const sk = obj.params.sk;
    const before = cloneSketch(sk);

    this.commit(op === 'add' ? `Add ${payload.type}` : 'Remove constraint');
    if (op === 'add') addConstraint(sk, payload);
    else removeConstraint(sk, payload.id);

    const report = resolveSketch(obj.params);
    if (!report.ok && op === 'add') {
      obj.params.sk = before;                 // a constraint that cannot hold is refused
      resolveSketch(obj.params);
      return { ...report, ok: false };
    }
    obj.rebuild();
    this._emit('change', obj);
    return report;
  }

  // Register a pre-built object (e.g. an imported mesh wrapped as a CadObject).
  // It becomes a normal, selectable, movable document object. Does not commit,
  // so it won't spam undo history — callers manage that if needed.
  addImported(obj) {
    obj.name = this._uniqueName(obj.name);
    this.objects.set(obj.id, obj);
    this._emit('add', obj);
    return obj;
  }

  remove(id) {
    const obj = this.objects.get(id);
    if (!obj) return;
    this.commit('Delete');
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
    this.commit('Duplicate');

    let copy;
    if (BAKED_KINDS.has(src.kind)) {
      // Clone the baked geometry, the child recipes, and the pivot matrix so the
      // duplicate is a fully independent, still-ungroupable group.
      copy = new CadObject({
        kind: src.kind, role: src.role, name: `${src.name} copy`,
        params: { ...src.params },          // carries `op`, so the copy is rebakeable too
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
    this.commit(ids.length > 1 ? `Delete ${ids.length}` : 'Delete');
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
    this.commit('Paste');
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
    if (!result) { this.commit('Cut (holes only)'); this._disband(objs); this.select(null); this._emit('regroup'); return null; } // all holes
    return this._bakeGroup(objs, result.geometry, 'Group', 'combine');
  }

  async intersect(ids) {
    const objs = ids.map((id) => this.objects.get(id)).filter(Boolean);
    if (objs.length < 2) return null;
    const result = await booleanIntersect(objs.map((o) => o.mesh));
    if (!result) return null;     // no shared volume — leave document untouched
    return this._bakeGroup(objs, result.geometry, 'Intersection', 'intersect');
  }

  // ---- patterns --------------------------------------------------------------
  //
  // Vi's framing, 2026-08-11: we encode the RESULT, a list of objects, when the
  // thing that actually happened was one instruction. Six bolt holes are six
  // objects here and one sentence out loud, "six of these, twenty apart". A
  // pattern stores the sentence. The count stays a number you can change, the
  // whole thing is one row in the outliner instead of six, and a share link
  // carries a rule rather than six copies of the same box.

  /**
   * Turn an object into a pattern of itself.
   *
   * The object does not move. Copy zero is the identity, so this reads as an
   * edit to the thing already on the plate rather than as a new thing appearing
   * somewhere else, and the pattern inherits its place, its role and its
   * colour.
   */
  makePattern(id, mode = 'linear') {
    const src = this.objects.get(id);
    if (!src || src.kind === 'pattern') return null;
    this.commit('Pattern');

    const desc = src.kind === 'boolean'
      ? {
          kind: 'boolean',
          params: { ...src.params },
          geo: geoToArrays(src.mesh.geometry),
          children: src.children ? src.children.map((c) => serializeChild(c)) : null,
        }
      : { kind: src.kind, params: deepParams(src.params) };

    // A first step of one and a half bounding boxes, so the copies land clear
    // of each other. A default of zero would draw every copy inside the first
    // one and look exactly like nothing happened.
    src.mesh.geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    src.mesh.geometry.boundingBox.getSize(size);
    const step = Math.max(1, Math.round(size.x * Math.abs(src.mesh.scale.x) * 1.5));

    const obj = new CadObject({
      kind: 'pattern',
      role: src.role,
      params: { ...DEFAULT_PARAMS.pattern, mode, dx: step, radius: Math.max(step, 30), src: desc },
    });
    obj.name = this._uniqueName(`${src.name} pattern`);
    obj.mesh.position.copy(src.mesh.position);
    obj.mesh.rotation.copy(src.mesh.rotation);
    obj.mesh.scale.copy(src.mesh.scale);
    obj.setColor(src.color);

    this._disband([src]);
    this.objects.set(obj.id, obj);
    this._emit('regroup');
    this.select(obj.id);
    return obj;
  }

  /**
   * Give the source back and throw the rule away.
   *
   * The inverse of makePattern, and the reason a pattern is safe to try. It
   * lands exactly where copy zero was, because copy zero is the identity.
   */
  releasePattern(id) {
    const pat = this.objects.get(id);
    if (!pat || pat.kind !== 'pattern' || !pat.params.src) return null;
    this.commit('Release pattern');
    const s = pat.params.src;
    const obj = s.kind === 'boolean'
      ? new CadObject({
          kind: 'boolean', role: pat.role, params: { ...s.params },
          geometry: arraysToGeo(s.geo),
          children: s.children ? s.children.map(reviveChild) : null,
        })
      : new CadObject({ kind: s.kind, role: pat.role, params: deepParams(s.params) });
    obj.name = this._uniqueName(pat.name.replace(/ pattern.*$/, '') || obj.name);
    obj.mesh.position.copy(pat.mesh.position);
    obj.mesh.rotation.copy(pat.mesh.rotation);
    obj.mesh.scale.copy(pat.mesh.scale);
    obj.setColor(pat.color);
    if (obj.kind === 'boolean') { obj.mesh.updateMatrix(); obj.baseMatrix = obj.mesh.matrix.clone(); }

    this._disband([pat]);
    this.objects.set(obj.id, obj);
    this._emit('regroup');
    this.select(obj.id);
    return obj;
  }

  /** Change one pattern parameter and rebuild, as one history step. */
  setPatternParam(id, key, value) {
    const pat = this.objects.get(id);
    if (!pat || pat.kind !== 'pattern') return false;
    this.commit('Pattern ' + key);
    pat.params[key] = value;
    pat.rebuild();
    this.touch(pat);
    return true;
  }

  // ---- the exact kernel -------------------------------------------------------
  //
  // Rounding the edge of a finished solid is the one thing the mesh half cannot
  // do at any radius, because a fillet is a new analytic surface tangent to two
  // old ones and a triangle soup has no analytic surfaces. So these two go
  // through OpenCascade instead, and the result comes back as a `brep` object:
  // a baked mesh for the screen, plus the recipe and the list of operations
  // that produced it, so it can be re-run, undone, saved and exported to STEP
  // as a real parametric part rather than as a scan of one.

  /**
   * Round or bevel the edges of the selected solid.
   *
   * @param {string} id
   * @param {{type:'fillet'|'chamfer', size:number, select:string}} op
   * @param {*} brep the loaded brep module, passed in so model.js never pulls
   *        an eleven megabyte kernel into the initial load by importing it
   * @param {*} R the replicad namespace from that module
   */
  async applyExactOp(id, op, brep, R) {
    const obj = this.objects.get(id);
    if (!obj) return null;

    // Applying a second fillet re-runs the whole chain from the original recipe
    // rather than filleting the filleted mesh. That is what makes the radius of
    // the FIRST rounding still editable afterwards, and it is the difference
    // between a feature list and a pile of destructive edits.
    const src = obj.kind === 'brep' ? obj.params.src : nodeRecipe(obj);
    const ops = obj.kind === 'brep' ? [...(obj.params.ops || []), op] : [op];
    return this._bakeExact(obj, src, ops, brep, R, op.type === 'chamfer' ? 'Bevel edges' : 'Round edges');
  }

  /**
   * Change one operation in an exact solid's chain and re-run the whole thing.
   *
   * Re-run, not patched. The chain is the definition of the part, so editing
   * step one and replaying steps two and three is the only answer that stays
   * true. Patching the mesh would make the second fillet depend on a shape the
   * first one no longer produces.
   */
  async editExactOp(id, index, patch, brep, R) {
    const obj = this.objects.get(id);
    if (!obj || obj.kind !== 'brep' || !obj.params.src) return null;
    const ops = (obj.params.ops || []).map((o, i) => (i === index ? { ...o, ...patch } : o));
    if (!ops[index]) return null;
    return this._bakeExact(obj, obj.params.src, ops, brep, R, 'Change a rounding');
  }

  async _bakeExact(obj, src, ops, brep, R, label) {
    // One call, because everything it builds is freed on the way out. OCCT
    // shapes are not garbage collected, and a modeller that leaks one solid per
    // fillet kills the tab somewhere around the twentieth.
    const geometry = brep.geometryFor(R, src, ops);

    this.commit(label);

    // A part that has been dragged since it was rounded keeps that move, or
    // editing a radius would teleport it back to where it was first baked.
    const drift = obj.kind === 'brep' && obj.baseMatrix
      ? new THREE.Matrix4().copy(obj.baseMatrix).invert().premultiply(obj.mesh.matrixWorld)
      : null;

    // Recentre on the body, exactly as _bakeGroup does, so the pivot sits on
    // the part and the world position is unchanged.
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    geometry.translate(-center.x, -center.y, -center.z);

    const out = new CadObject({
      kind: 'brep',
      role: obj.role,
      geometry,
      params: { src, ops },
      name: obj.kind === 'brep' ? obj.name : `${obj.name} rounded`,
    });
    out.name = obj.kind === 'brep' ? obj.name : this._uniqueName(out.name);
    out.mesh.position.copy(center);
    out.mesh.updateMatrix();
    out.baseMatrix = out.mesh.matrix.clone();
    if (drift) {
      out.mesh.applyMatrix4(drift);
      out.mesh.updateMatrix();
    }

    this._disband([obj]);
    this.objects.set(out.id, out);
    this._emit('regroup');
    this.select(out.id);
    return out;
  }

  /** Throw the rounding away and give the original part back. */
  releaseExact(id) {
    const obj = this.objects.get(id);
    if (!obj || obj.kind !== 'brep' || !obj.params.src) return null;
    this.commit('Undo the rounding');
    const src = obj.params.src;
    const back = new CadObject({
      kind: src.kind,
      role: obj.role,
      params: deepParams(src.params),
      geometry: src.kind === 'boolean' ? arraysToGeo(src.geometry) : null,
      children: src.children ? src.children.map(reviveChild) : null,
    });
    back.name = this._uniqueName(src.name || back.name);
    back.mesh.position.fromArray(src.position || [0, 0, 0]);
    back.mesh.rotation.set(...(src.rotation || [0, 0, 0]));
    back.mesh.scale.fromArray(src.scale || [1, 1, 1]);
    if (back.kind === 'boolean') { back.mesh.updateMatrix(); back.baseMatrix = back.mesh.matrix.clone(); }

    this._disband([obj]);
    this.objects.set(back.id, back);
    this._emit('regroup');
    this.select(back.id);
    return back;
  }

  _disband(objs) {
    for (const o of objs) {
      o.mesh.geometry.dispose(); o.mesh.material.dispose();
      this.objects.delete(o.id); this.selection.delete(o.id);
    }
  }

  // Consume `objs` into one watertight boolean body built from `geometry`.
  //
  // `op` records WHICH kernel call produced the body ('combine' or 'intersect').
  // The children alone are not enough to reproduce it — the same two shapes give
  // a different solid under union and under intersection — and without that one
  // word a share link cannot drop the baked mesh and rebuild it on open. It
  // lives in `params` so it rides along on every existing save, snapshot and
  // history entry for free.
  _bakeGroup(objs, geometry, name, op) {
    this.commit(name === 'Intersection' ? 'Intersect' : 'Group');
    const children = objs.map((o) => o.snapshot());   // world-space recipes for ungroup
    this._disband(objs);

    // Recenter so the pivot sits on the body, not at world origin — while the
    // body stays exactly where it was in the world.
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    geometry.translate(-center.x, -center.y, -center.z);

    const grp = new CadObject({ kind: 'boolean', geometry, children, name, params: { op } });
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
    this.commit('Ungroup');

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

  // --- parametric propagation: re-edit a baked group's part ------------
  // The genuine parametric dependency in CADence: a boolean body is computed
  // FROM its parts. This edits one part's recipe and re-runs the kernel, so the
  // group recomputes in place — "change a feature, everything downstream rebuilds"
  // without ungrouping. Returns the updated group, or null if the edit fails.
  async rebakeGroupChild(id, childIndex, key, value) {
    const grp = this.objects.get(id);
    if (!grp || grp.kind !== 'boolean' || !grp.children || !grp.children[childIndex]) return null;
    const child = grp.children[childIndex];
    if (child.kind === 'boolean') return null;          // nested-group params: Phase 3
    const prevParams = { ...child.params };
    child.params = { ...child.params, [key]: value };

    // Rebuild every part in the group's CURRENT world frame — children are stored
    // in the frame at group time, so apply the same delta ungroup() uses.
    grp.mesh.updateMatrix();
    const base = grp.baseMatrix ? grp.baseMatrix.clone() : new THREE.Matrix4();
    const M = grp.mesh.matrix.clone().multiply(base.invert());
    const parts = grp.children.map((s) => {
      const o = new CadObject(
        s.kind === 'boolean'
          ? { kind: 'boolean', params: s.params, name: s.name, role: s.role, geometry: s.geometryClone, children: s.children }
          : { kind: s.kind, params: s.params, name: s.name, role: s.role }
      );
      o.mesh.position.fromArray(s.position);
      o.mesh.rotation.set(...s.rotation);
      o.mesh.scale.fromArray(s.scale);
      o.mesh.applyMatrix4(M);
      o.mesh.updateMatrixWorld(true);
      return o;
    });

    let result;
    try {
      result = await booleanCombine(parts.map((o) => ({ mesh: o.mesh, role: o.role })));
    } catch (err) {
      child.params = prevParams;                        // restore on kernel failure
      parts.forEach((o) => { o.mesh.geometry.dispose(); o.mesh.material.dispose(); });
      throw err;
    }
    // Bake the applied delta back into the recipes (now current-frame) so repeated
    // edits and a later ungroup stay consistent, then free the temp meshes.
    parts.forEach((o, i) => {
      const s = grp.children[i];
      s.position = o.mesh.position.toArray();
      s.rotation = [o.mesh.rotation.x, o.mesh.rotation.y, o.mesh.rotation.z];
      s.scale = o.mesh.scale.toArray();
      o.mesh.geometry.dispose(); o.mesh.material.dispose();
    });
    if (!result) { child.params = prevParams; return null; }

    this.commit('Edit part');                           // record AFTER the async work
    const geometry = result.geometry;
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    geometry.translate(-center.x, -center.y, -center.z);

    grp.mesh.geometry.dispose();
    grp.mesh.geometry = geometry;
    grp.mesh.position.copy(center);
    grp.mesh.rotation.set(0, 0, 0);
    grp.mesh.scale.set(1, 1, 1);
    grp.mesh.updateMatrix();
    grp.baseMatrix = grp.mesh.matrix.clone();           // delta is now baked in

    this._emit('regroup');
    this.select(grp.id);
    this.touch(grp);                                    // settles the history capture
    return grp;
  }

  // --- history (commit / undo / time-travel) ---------------------------
  // Called just before an undoable action, with a label for the step it's about
  // to perform. We first flush the previous step (whose result is now settled),
  // then arm capture of this one.
  commit(label = 'Edit') {
    if (this._restoring) return;
    this._flush();
    this._armed = true;
    this._armedLabel = label;
    this._bump();
  }

  _bump() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), 200);
  }

  // Write the armed step's result (the live scene) as a new history node.
  _flush() {
    if (!this._armed) return;
    this._armed = false;
    clearTimeout(this._timer);
    const thumb = this._thumb ? this._thumb() : null;
    const parentId = this.history.currentId;
    const node = this.history.record(this._armedLabel, this.toJSON(), thumb);
    // An edit made from a past step has just forked. The steps that used to
    // follow are still there on the old branch, and they are almost certainly
    // what the user wants brought forward. Offered, never done automatically,
    // because a replay rebuilds real geometry and doing that without being
    // asked is the kind of helpfulness nobody wants.
    if (this._travel && this._travel.from === parentId && this._travel.tip !== node.id) {
      this.pendingReplay = { from: parentId, tip: this._travel.tip, landedOn: node.id };
    }
    this._travel = null;
    this._emit('history');
  }

  /** How many abandoned steps could be brought forward, or null if none. */
  get replayOffer() {
    if (!this.pendingReplay) return null;
    const chain = chainBetween(this.history, this.pendingReplay.from, this.pendingReplay.tip);
    if (!chain || !chain.length) return null;
    return { steps: chain.length, labels: chain.map((c) => c.label) };
  }

  dismissReplay() { this.pendingReplay = null; this._emit('history'); }

  /**
   * Re-run the steps that were abandoned when this branch forked.
   *
   * Each step is re-applied as the field-level difference it originally made,
   * so an edit to a past dimension survives every step after it instead of
   * being pasted over. Steps that BAKED something, a group or an exact solid,
   * are re-run through their kernel rather than pasted, because their input is
   * exactly what changed.
   *
   * @param {{brep?:object, R?:object}} kernels the exact kernel, if it is
   *        loaded. Passed in rather than imported so replaying a model with no
   *        fillets in it never pulls an eleven megabyte download.
   * @returns {Promise<{ok:boolean, steps:number, reason?:string, rebuilt:number}>}
   */
  async replayForward(kernels = {}) {
    const p = this.pendingReplay;
    if (!p) return { ok: false, steps: 0, rebuilt: 0, reason: 'there is nothing to bring forward' };
    const chain = chainBetween(this.history, p.from, p.tip);
    if (!chain || !chain.length) {
      this.pendingReplay = null;
      return { ok: false, steps: 0, rebuilt: 0, reason: 'those steps are no longer in the timeline' };
    }
    const check = canReplay(chain);
    if (!check.ok) return { ok: false, steps: chain.length, rebuilt: 0, reason: check.reason };

    this.pendingReplay = null;
    let rebuilt = 0;
    // A bake makes a NEW object with a NEW id, and every step after it refers to
    // the one the old branch made. Without this map, "group these two, then move
    // the group" replays the group and silently drops the move, because the id
    // the move names no longer exists. Found by the suite doing exactly that.
    const remap = new Map();
    for (const step of chain) {
      const done = await this._applyStep(step, kernels, remap);
      if (!done.ok) {
        this._emit('history');
        return { ok: false, steps: chain.length, rebuilt, reason: `${done.reason}, at the step called "${step.label}"` };
      }
      rebuilt++;
      this.commit(step.label);
      this._flush();
    }
    this._emit('history');
    return { ok: true, steps: chain.length, rebuilt };
  }

  /** Apply one recovered step to the live scene. */
  async _applyStep(step, kernels, remap = new Map()) {
    const d = step.diff;
    // Every id in a recovered step is an id from the OLD branch. Anything a
    // bake has already rebuilt answers to a different one now.
    const live = (id) => remap.get(id) ?? id;

    // Field level changes first, so anything a bake is about to consume is
    // already carrying this step's edits.
    for (const c of d.changed) {
      const obj = this.objects.get(live(c.id));
      if (!obj) continue;                       // the step edited something the edit removed
      if (c.fields.name != null) obj.name = c.fields.name;
      if (c.fields.role != null) obj.setRole(c.fields.role);
      if (c.fields.color != null) obj.setColor(c.fields.color);
      if (c.fields.position) obj.mesh.position.fromArray(c.fields.position);
      if (c.fields.rotation) obj.mesh.rotation.set(...c.fields.rotation);
      if (c.fields.scale) obj.mesh.scale.fromArray(c.fields.scale);
      if (c.fields.visible != null) obj.mesh.visible = c.fields.visible;
      if (c.params) {
        Object.assign(obj.params, deepParams(c.params));
        if (obj.kind === 'sketch') resolveSketch(obj.params);
        obj.rebuild();
      }
      obj.mesh.updateMatrixWorld(true);
      this._emit('change', obj);
    }

    const bake = bakeOf(d);
    if (bake) {
      // The inputs as they stand NOW, which is the whole point: they carry the
      // edit made further back.
      const ids = bake.consumed.map(live).filter((id) => this.objects.has(id));
      if (bake.type === 'boolean') {
        if (ids.length < 2) return { ok: false, reason: 'the parts that group consumed are not all here any more' };
        const grp = bake.op === 'intersect' ? await this.intersect(ids) : await this.group(ids);
        if (!grp) return { ok: false, reason: 'the kernel produced nothing from those parts' };
        grp.name = bake.node.name;
        remap.set(bake.node.id, grp.id);
        return { ok: true };
      }
      if (bake.type === 'pattern') {
        if (ids.length !== 1) return { ok: false, reason: 'the part that pattern repeats is not here any more' };
        const pat = this.makePattern(ids[0], bake.params.mode);
        if (!pat) return { ok: false, reason: 'that pattern could not be rebuilt' };
        // The rule is data and comes across whole. Only the SOURCE had to be
        // rebuilt from the live object, which is what carries the edit.
        for (const k of ['count', 'dx', 'dy', 'dz', 'radius', 'sweep', 'follow', 'axis', 'plane', 'mode']) {
          if (bake.params[k] !== undefined) pat.params[k] = bake.params[k];
        }
        pat.rebuild();
        pat.name = bake.node.name;
        remap.set(bake.node.id, pat.id);
        this._emit('change', pat);
        return { ok: true };
      }
      if (bake.type === 'exact') {
        if (!kernels.brep || !kernels.R) {
          return { ok: false, reason: 'that step rounded an edge and the exact kernel is not loaded' };
        }
        if (ids.length !== 1) return { ok: false, reason: 'the part that rounding was applied to is not here any more' };
        let out = await this.applyExactOp(ids[0], bake.ops[0], kernels.brep, kernels.R);
        if (!out) return { ok: false, reason: 'that rounding could not be rebuilt' };
        for (let i = 1; i < bake.ops.length; i++) {
          out = await this.applyExactOp(out.id, bake.ops[i], kernels.brep, kernels.R) || out;
        }
        remap.set(bake.node.id, out.id);
        return { ok: true };
      }
    }

    // Not a bake: plain additions and removals.
    for (const id of d.removed) {
      const real = live(id);
      const obj = this.objects.get(real);
      if (!obj) continue;
      obj.mesh.geometry.dispose(); obj.mesh.material.dispose();
      this.objects.delete(real); this.selection.delete(real);
      if (this.selectedId === real) this.selectedId = null;
      this._emit('remove', obj);
    }
    for (const o of d.added) {
      if (this.objects.has(o.id)) continue;
      const obj = deserializeObject(o);
      this.objects.set(obj.id, obj);
      this._emit('add', obj);
    }
    if (d.removed.length || d.added.length) this._emit('regroup');
    return { ok: true };
  }

  // Ctrl+Z = step to the parent node (non-destructive: the children remain, so
  // you can branch back into them).
  undo() {
    this._flush();
    const cur = this.history.current;
    if (!cur || cur.parentId == null) return;
    this.goToHistory(cur.parentId);
    this._redoHint = cur.id;          // remember which branch we stepped out of
  }

  // Ctrl+Y / Ctrl+Shift+Z = step forward again.
  //
  // In a branching history "forward" is ambiguous the moment a node has more
  // than one child, so undo leaves a breadcrumb and redo follows it. That makes
  // undo then redo land you exactly where you were, which is the only behaviour
  // people actually expect. With no breadcrumb we take the newest child, since
  // that is the branch the user was most recently working in.
  redo() {
    this._flush();
    const cur = this.history.current;
    if (!cur || !cur.children.length) return;
    const hinted = this._redoHint && cur.children.includes(this._redoHint) ? this._redoHint : null;
    const next = hinted || cur.children[cur.children.length - 1];
    this._redoHint = null;
    this.goToHistory(next);
  }

  /** True when there is a step forward to take. Lets the UI disable the button. */
  get canRedo() {
    const cur = this.history.current;
    return !!(cur && cur.children.length);
  }

  /** True when there is a step back to take. The root has no parent. */
  get canUndo() {
    const cur = this.history.current;
    return !!(cur && cur.parentId != null);
  }

  // Jump the scene to any node in the tree. Acting after this forks a branch.
  goToHistory(id) {
    const node = this.history.get(id);
    if (!node) return;
    this._flush();
    this._redoHint = null;            // any deliberate jump retires the breadcrumb
    // Remember the future being walked away from. Going back to step three to
    // change something is almost never a wish to throw away steps four to ten,
    // and until the next step is actually taken there is no way to know whether
    // this is a look around or the start of an edit. So the tip is remembered
    // cheaply here and only turned into an offer once an edit really happens.
    const leaving = this.history.currentId;
    this._travel = (leaving && leaving !== id && this._isDescendant(leaving, id))
      ? { from: id, tip: leaving }
      : null;
    this.history.goto(id);
    this._restoreSnapshot(node.snapshot);
    this._emit('history');
  }

  _isDescendant(id, ancestorId) {
    let cur = this.history.get(id);
    while (cur && cur.parentId != null) {
      if (cur.parentId === ancestorId) return true;
      cur = this.history.get(cur.parentId);
    }
    return false;
  }

  // Apply a serialized scene without recording a step (used by time-travel and
  // file load). Mirrors loadJSON's rebuild, guarded so it can't re-trigger capture.
  _restoreSnapshot(data) {
    this._restoring = true;
    for (const o of this.list) { o.mesh.geometry.dispose(); o.mesh.material.dispose(); }
    this.objects.clear(); this.selection.clear(); this.selectedId = null;
    for (const d of (data.objects || [])) {
      const obj = deserializeObject(d);
      this.objects.set(obj.id, obj);
      ensureId(parseInt(String(obj.id).replace(/\D/g, ''), 10) || 0);
    }
    this._emit('regroup');     // the view rebuilds the scene from the document
    this.select(null);
    this._restoring = false;
  }

  // --- save / load ------------------------------------------------------
  //
  // opts.recipeOnly drops a boolean's baked mesh when the recipe can rebuild it.
  // Files and history snapshots keep the mesh (opening your own work stays
  // instant, and undo must not depend on the async kernel). Share links set it,
  // because there the mesh is 95-100% of the payload and the URL is the budget.
  toJSON(opts = {}) {
    return { app: 'CADence', version: 1, objects: this.list.map((o) => serializeObject(o, opts)) };
  }

  loadJSON(data) {
    if (!data || !Array.isArray(data.objects)) throw new Error('Not a CADence project file');
    this._flush();                       // close out any in-flight step first
    this._restoreSnapshot(data);         // apply without recording…
    // …then record the load as its own history step so it's on the timeline.
    const thumb = this._thumb ? this._thumb() : null;
    this.history.record('Load file', this.toJSON(), thumb);
    this._emit('history');
  }

  // Wipe to a blank document and reset the history tree to a fresh root. This is
  // the deliberate "New / Clear" action: unlike undo it forgets everything, so the
  // caller pairs it with clearing the autosave for a true clean slate.
  newScene() {
    this._flush();                       // close out any in-flight step first
    this._restoreSnapshot({ objects: [] });   // dispose + clear the live scene
    this.history = new History();
    this.history.init(this.toJSON());    // fresh root = the empty scene
    this._emit('history');
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

// Can this boolean's mesh be thrown away and rebuilt from its parts?
//
// Only if we know both the parts and the operation. `op` was added in 2026-08,
// so a group made before that (still sitting in someone's autosave) has no `op`
// and must keep its baked mesh — a link that opens wrong is worse than a link
// that is long. Fewer than two children means there is nothing to re-run.
function rebakeable(node) {
  const op = node?.params?.op;
  return (op === 'combine' || op === 'intersect') && Array.isArray(node.children) && node.children.length >= 2;
}

// A boolean's child entries are snapshot()-shaped (may nest). Convert their
// THREE geometry clones to/from arrays recursively.
function serializeChild(s, opts = {}) {
  const c = {
    id: s.id, kind: s.kind, role: s.role, name: s.name, color: s.color,
    params: deepParams(s.params), position: [...s.position], rotation: [...s.rotation], scale: [...s.scale],
  };
  if (BAKED_KINDS.has(s.kind)) {
    c.baseMatrix = s.baseMatrix || null;                       // already an array from snapshot()
    c.children = s.children ? s.children.map((k) => serializeChild(k, opts)) : null;
    c.geometry = (opts.recipeOnly && rebakeable(c)) ? null
               : s.geometryClone ? geoToArrays(s.geometryClone) : null;
  }
  return c;
}

function reviveChild(c) {
  const s = {
    id: c.id, kind: c.kind, role: c.role, name: c.name, color: c.color,
    params: deepParams(c.params), position: [...c.position], rotation: [...c.rotation], scale: [...c.scale],
  };
  if (BAKED_KINDS.has(c.kind)) {
    s.baseMatrix = c.baseMatrix || null;
    s.geometryClone = c.geometry ? arraysToGeo(c.geometry) : null;
    s.children = c.children ? c.children.map(reviveChild) : null;
  }
  return s;
}

// Params are flat numbers for every primitive except a constrained sketch, whose
// `sk` document and `profile` array are nested. Clone those so snapshots really
// are snapshots.
function deepParams(p) {
  const out = { ...p };
  if (out.sk) out.sk = cloneSketch(out.sk);
  if (Array.isArray(out.profile)) out.profile = out.profile.map((pt) => [...pt]);
  // A pattern's source is a whole recipe living inside params. A shallow copy
  // would let an edit made after a history snapshot reach back and rewrite the
  // snapshot that was supposed to have frozen it, which is the same trap the
  // sketch document above is cloned to avoid.
  if (out.src) {
    // Built key by key rather than by spreading, so an absent `geo` stays
    // absent instead of becoming a key holding undefined. The share link
    // encoder verifies itself by comparing the decoded document against this
    // one, and a key that exists on one side and not the other fails that
    // comparison for no reason anybody could act on.
    const s = { kind: out.src.kind };
    if (out.src.params) s.params = deepParams(out.src.params);
    if (out.src.geo) s.geo = { position: Array.from(out.src.geo.position), index: out.src.geo.index ? Array.from(out.src.geo.index) : null };
    if (out.src.children) s.children = out.src.children.map((c) => ({ ...c }));
    out.src = s;
  }
  return out;
}

/**
 * The recipe an exact solid remembers it was made from.
 *
 * Exactly the save format, deliberately. An exact solid has to survive being
 * written to a file and read back, and keeping a second private shape for the
 * same information is how the two drift apart and a reloaded part stops being
 * re-editable.
 */
function nodeRecipe(o) { return serializeObject(o); }

function serializeObject(o, opts = {}) {
  const d = {
    id: o.id, kind: o.kind, role: o.role, name: o.name, color: o.color,
    // Deep, not shallow: a sketch document is a nested object, and a shallow
    // copy would let a later dimension edit reach back and rewrite the history
    // snapshots that were supposed to have frozen it.
    params: deepParams(o.params),
    position: o.mesh.position.toArray(),
    rotation: [o.mesh.rotation.x, o.mesh.rotation.y, o.mesh.rotation.z],
    scale: o.mesh.scale.toArray(),
    visible: o.mesh.visible,
  };
  if (BAKED_KINDS.has(o.kind)) {
    d.baseMatrix = o.baseMatrix ? o.baseMatrix.toArray() : null;
    d.children = o.children ? o.children.map((c) => serializeChild(c, opts)) : null;
    d.geometry = (opts.recipeOnly && rebakeable(d)) ? null : geoToArrays(o.mesh.geometry);
  }
  return d;
}

// --- rebuilding a stripped boolean ----------------------------------------
//
// The inverse of `toJSON({ recipeOnly: true })`. Given decoded document data,
// re-run the kernel on any boolean whose mesh was left out and fill it back in,
// so what reaches loadJSON() is indistinguishable from a full save. That keeps
// the load path synchronous and untouched: all the async lives out here.
//
// Deliberately tolerant. If one group cannot be rebuilt, the rest of the design
// still opens — a missing group is a visible, recoverable disappointment, a
// thrown exception is a blank page.
export async function rebakeBooleans(data) {
  if (!data || !Array.isArray(data.objects)) return data;
  const failed = [];
  for (const o of data.objects) await rebakeNode(o, failed);
  if (failed.length) console.warn('share link: could not rebuild', failed.length, 'group(s)');
  data.objects = data.objects.filter((o) => !failed.includes(o));
  return data;
}

async function rebakeNode(node, failed) {
  if (!node || node.kind !== 'boolean') return;
  // Depth first: a nested group must have its own mesh back before it can be
  // handed to the kernel as one of its parent's parts.
  if (node.children) for (const c of node.children) await rebakeNode(c, failed);
  if (node.geometry) return;                       // shipped baked, nothing to do

  const built = [];
  try {
    for (const c of node.children) {
      const obj = new CadObject(
        c.kind === 'boolean'
          ? { kind: 'boolean', params: deepParams(c.params), name: c.name, role: c.role, geometry: arraysToGeo(c.geometry) }
          : { kind: c.kind, params: deepParams(c.params), name: c.name, role: c.role }
      );
      obj.mesh.position.fromArray(c.position);
      obj.mesh.rotation.set(...c.rotation);
      obj.mesh.scale.fromArray(c.scale);
      obj.mesh.updateMatrixWorld(true);            // the kernel reads matrixWorld
      built.push(obj);
    }

    const result = node.params.op === 'intersect'
      ? await booleanIntersect(built.map((o) => o.mesh))
      : await booleanCombine(built.map((o) => ({ mesh: o.mesh, role: o.role })));
    if (!result?.geometry) throw new Error(`kernel returned nothing for op ${node.params.op}`);

    // Recentre exactly as _bakeGroup did, so the rebuilt mesh sits in the same
    // local space the saved position/rotation/scale were recorded against.
    const geometry = result.geometry;
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    geometry.translate(-center.x, -center.y, -center.z);

    node.geometry = geoToArrays(geometry);
    geometry.dispose();
  } catch (e) {
    console.warn('share link: rebuild failed for', node.name, e);
    failed.push(node);
  } finally {
    for (const o of built) { o.mesh.geometry?.dispose(); o.mesh.material?.dispose(); }
  }
}

function deserializeObject(d) {
  let obj;
  if (BAKED_KINDS.has(d.kind)) {
    obj = new CadObject({
      kind: d.kind, name: d.name, role: d.role,
      params: deepParams(d.params),
      geometry: arraysToGeo(d.geometry),
      children: d.children ? d.children.map(reviveChild) : null,
      baseMatrix: d.baseMatrix ? new THREE.Matrix4().fromArray(d.baseMatrix) : null,
    });
  } else {
    obj = new CadObject({ kind: d.kind, params: deepParams(d.params), name: d.name, role: d.role });
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
