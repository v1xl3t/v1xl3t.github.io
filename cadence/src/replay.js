// replay.js — re-running the steps that came after an edit.
//
// The Recipe Timeline keeps every path alive: going back to step three and
// changing something does not erase steps four to ten, it forks a branch and
// leaves them where they were. That is the right model, and until now it was
// only half the promise. The new branch started with one step on it. Everything
// built on top of the thing you just changed had to be built again by hand.
//
// This file closes that. It takes the steps you walked away from and re-runs
// them on the new branch, so a 20mm box that becomes 30mm carries the hole that
// was bored through it, the group it was fused into, and the fillet on that
// group, all rebuilt against the new size.
//
// HOW, given that history stores SNAPSHOTS and not operations.
//
// Each node holds the whole scene as it stood after its step. The step itself
// is not recorded, but it can be recovered: the difference between a node's
// snapshot and its parent's IS what that step did. Re-applying that difference
// to a different starting scene is the replay.
//
// The difference is taken FIELD BY FIELD on purpose, and that is the whole
// design. A step that only moved a box records a change to `position` and
// nothing else, so replaying it moves the box and leaves its new width alone.
// If it replayed whole objects instead, every forward step would paste the old
// width back over the edit and the feature would do nothing at all.
//
// WHAT IT WILL NOT DO, and says so rather than guessing:
//
//   * A step whose result cannot be rebuilt from a recipe, which today means a
//     part opened from a STEP file. There is nothing to re-run.
//   * A branch that is not an ancestor of where you are standing. Replay is
//     "bring my abandoned future forward", not "merge two unrelated timelines".

/** Fields on a serialized object that a step can change. */
const FIELDS = ['name', 'color', 'role', 'position', 'rotation', 'scale', 'visible'];

const sameJSON = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Index a snapshot's objects by id. */
export function byId(snapshot) {
  const m = new Map();
  for (const o of (snapshot && snapshot.objects) || []) m.set(o.id, o);
  return m;
}

/**
 * What one step did, as the difference between two scenes.
 *
 * @returns {{added: object[], removed: string[], changed: {id:string, fields:object, params:object|null}[]}}
 *          `fields` and `params` hold ONLY what that step actually touched.
 */
export function diffScenes(before, after) {
  const a = byId(before), b = byId(after);
  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, obj] of b) {
    if (!a.has(id)) { added.push(obj); continue; }
    const prev = a.get(id);
    const fields = {};
    for (const f of FIELDS) if (!sameJSON(prev[f], obj[f])) fields[f] = obj[f];
    // Params are compared key by key for the same reason whole objects are not
    // replayed: a step that changed only the height must not carry the old
    // width forward over an edit to it.
    let params = null;
    const keys = new Set([...Object.keys(prev.params || {}), ...Object.keys(obj.params || {})]);
    for (const k of keys) {
      if (sameJSON((prev.params || {})[k], (obj.params || {})[k])) continue;
      (params ||= {})[k] = (obj.params || {})[k];
    }
    if (Object.keys(fields).length || params) changed.push({ id, fields, params });
  }
  for (const id of a.keys()) if (!b.has(id)) removed.push(id);

  return { added, removed, changed };
}

/**
 * Is this step a bake, and of what?
 *
 * A group and an exact solid both look like "two objects vanished and one
 * appeared", and both have to be RE-RUN through their kernel rather than
 * pasted, because the whole point of the edit is that their input changed.
 * Everything else in a diff is data and can simply be applied.
 */
export function bakeOf(diff) {
  if (diff.added.length !== 1) return null;
  const o = diff.added[0];
  if (o.kind === 'boolean' && o.params && (o.params.op === 'combine' || o.params.op === 'intersect')) {
    return { type: 'boolean', op: o.params.op, consumed: diff.removed, node: o };
  }
  if (o.kind === 'brep' && o.params && o.params.src && Array.isArray(o.params.ops)) {
    return { type: 'exact', ops: o.params.ops, consumed: diff.removed, node: o };
  }
  if (o.kind === 'pattern' && o.params && o.params.src) {
    return { type: 'pattern', params: o.params, consumed: diff.removed, node: o };
  }
  return null;
}

/**
 * Can this whole chain be replayed, and if not, which step stops it and why.
 *
 * Answered before anything is rebuilt, so a chain that cannot finish is
 * reported instead of leaving the scene half rebuilt on a new branch.
 */
export function canReplay(chain) {
  for (const step of chain) {
    for (const o of step.diff.added) {
      if (o.kind === 'brep' && o.params && o.params.imported) {
        return { ok: false, reason: `step "${step.label}" opened ${o.params.imported} from a file, and a file is not something that can be re-run` };
      }
      if (o.kind === 'brep' && (!o.params || !o.params.src)) {
        return { ok: false, reason: `step "${step.label}" made an exact solid with no recipe behind it` };
      }
    }
  }
  return { ok: true };
}

/**
 * The steps between an ancestor node and a descendant, oldest first.
 *
 * Returns null when `tip` is not below `from`, which is the case replay refuses
 * rather than guessing at.
 */
export function chainBetween(history, fromId, tipId) {
  const back = [];
  let id = tipId;
  while (id != null && id !== fromId) {
    const n = history.get(id);
    if (!n) return null;
    back.push(n);
    id = n.parentId;
  }
  if (id !== fromId) return null;
  back.reverse();
  return back.map((n) => ({
    id: n.id,
    label: n.label,
    diff: diffScenes(history.get(n.parentId).snapshot, n.snapshot),
    snapshot: n.snapshot,
  }));
}

/** A deep copy of a serialized scene, so a replay cannot write into history. */
export function cloneSnapshot(s) {
  return JSON.parse(JSON.stringify(s));
}
