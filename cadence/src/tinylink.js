// tinylink.js — the 100-character share link.
//
// The share link already ships recipes only (see sharelink.js), which took the
// worst case from 19,068 characters to 393. This file is the next step down: a
// bit-level format that fits the common design in under 100 characters of URL,
// with no backend, no accounts and no data collection. The payload still lives
// entirely in the fragment, which never leaves the browser.
//
// Two things make that possible, and neither of them is "compress it harder".
//
//   1. DEFLATE IS THE WRONG TOOL AT THIS SIZE. It pays for a Huffman table
//      before it saves anything, and a share payload is a couple of hundred
//      bytes. Measured on every real document in the harness, deflating these
//      packed bytes came out 2 to 3 bytes WORSE than not deflating. So this
//      format has no compression step at all.
//
//   2. THE DECODER IS THE SAME APP. Every default, every primitive definition,
//      every auto-generated name is already in code the recipient downloaded.
//      The link only carries the DIFFERENCE between this design and what the
//      app already knows. That is not compression, it is not sending the data.
//
// On top of that, three observations about what people actually draw:
//
//   A. GRID. Nobody positions a part at 12.7431mm. Coordinates land on whole
//      millimetres almost always and on 0.1mm nearly all the rest of the time,
//      so each object picks the coarsest of 1 / 0.1 / 0.01mm that is LOSSLESS
//      for it and spends 2 bits saying which.
//   B. ANGLES. Rotations are overwhelmingly 0, ±90, 180 or ±45 degrees. Three
//      bits of table index instead of twenty bits of radians. An axis that fits
//      none of the cheap shapes pays for its raw double rather than costing the
//      whole document the long format, which is what a gizmo drag needs (see
//      planAxis for why the gizmo does not land on any grid).
//   C. NEIGHBOURS. Designs are built by duplicating and nudging, so a position
//      is stored as a delta from the previous object when that is cheaper and
//      exact, and absolutely when it is not.
//
// ---------------------------------------------------------------------------
// WHAT THIS FORMAT REFUSES TO CARRY
//
// Anything it cannot reproduce EXACTLY is refused, and buildShareLink falls
// back to the older deflate format for that document. A long link is a small
// disappointment; a link that silently rounds someone's model is a corrupted
// design with no error message. The refusals are:
//
//   * SKETCHES AND EXTRUDE PROFILES. A constrained sketch's `sk` document and
//     its `profile` point array are large, irregular and nested — a solver
//     graph, not a handful of scalars. Bit-packing them is a separate piece of
//     work and is deliberately NOT attempted here. `sketch` (and `supports`,
//     whose `slabs` are the same shape of problem) are excluded automatically
//     because their defaults are not all plain numbers, so they can never be
//     silently half-encoded.
//   * Any primitive kind whose defaults this table does not know, so adding a
//     primitive to DEFAULT_PARAMS makes links fall back rather than encode
//     something wrong.
//   * Positions, scales or params that do not survive quantisation bit-for-bit
//     (see QUANTISATION below). Rotation is NOT in this list any more. Since the
//     raw-double mode landed, every finite rotation is representable exactly, so
//     an angle can no longer be the reason a document takes the long way.
//   * Booleans that still carry a baked mesh, that have no `op`, that have
//     fewer than two parts, or whose baseMatrix is not a pure translation.
//   * Imported meshes and anything else with fields this format has no slot for.
//
// QUANTISATION. The format is lossless WITHIN these grids, and refuses outside
// them — a value is only accepted when decoding it reproduces the original
// double exactly (===), not approximately:
//
//   position   1mm, 0.1mm or 0.01mm, chosen per object, per relative/absolute
//   scale      0.001
//   params     0.01 (mm, degrees or count, depending on the param)
//   rotation   per axis: one of six table angles, OR an exact whole number of
//              degrees, OR an exact multiple of 0.0001 radians, OR the raw
//              double at 64 bits when it is none of those
//
// A position of 12.7431mm therefore does NOT fit the 0.01mm grid, and the whole
// document falls back to the deflate format rather than being rounded to 12.74.
// A rotation of 12.7431 radians, by contrast, now costs eleven characters and
// arrives exact, because rotation has a mode with no grid under it at all.
//
// THE LAST LINE OF DEFENCE. buildShareLink does not trust this encoder. It
// encodes, immediately DECODES the result back, and compares the decoded
// document field by field against the one it started with. Only an exact match
// ships as a tiny link; anything else takes the old path. That makes a silent
// encoder/decoder mismatch structurally unable to reach a user, including from
// a bug in this file. See encodeVerified below.
//
// Object ids are the one field deliberately not carried. They are `obj-N`
// counters with no meaning outside the session, so the decoder mints fresh ones
// and the comparison above ignores them.

import { DEFAULT_PARAMS } from './primitives.js';
import { DEFAULT_COLORS } from './model.js';

// Bumping this changes the wire format, and because FORMAT_VERSION is baked into
// SCHEMA_FINGERPRINT below, it also invalidates every `t` link already sent. Old
// z / j links keep opening regardless, because they travel under a different
// payload prefix letter, not because this number is backward compatible.
//
// NOT BUMPED for the raw-double rotation mode, deliberately. The rotation mode
// field was already two bits wide with values 0, 1 and 2 used and 3 unused, and
// the old encoder could not emit a 3 at all, because planAxis returned null
// there and the document fell back. So no payload in the wild contains a 3, no
// other bit in the stream moved, and every existing `t` link decodes to the same
// document as before. Bumping would have broken all of them to describe a change
// they cannot contain. The one asymmetry is forwards, a not-yet-updated build
// meeting a new link that uses mode 3, and that build throws on the mode it does
// not know, which tryLoadSharedLink turns into a refusal to load. Loud and
// empty, never a model with the wrong angle in it.
const FORMAT_VERSION = 4;

// 4 bits of kind, so 0..14 are primitives and 15 is reserved for booleans.
const BOOLEAN_CODE = 15;

const POS_GRIDS = [[0, 1], [1, 10], [2, 100]];   // [2-bit code, multiplier]
const PARAM_MUL = 100;                            // 0.01
const SCALE_MUL = 1000;                           // 0.001
const RAD_MUL = 10000;                            // 0.0001 rad

// The six rotations that cover almost every real design. Index is 3 bits.
const ANGLES = [0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI / 4, -Math.PI / 4];

// zigzag varints are written 32-bit; anything past this would wrap silently.
const VARINT_MAX = 0x7fffffff;

// Scratch for reading a double out as bits and putting it back. One shared
// buffer, because encode and decode are both single-threaded and never hold a
// value in it across a call.
const F64 = new DataView(new ArrayBuffer(8));

/* ------------------------------------------------------------------ schema --
 *
 * Derived from the app's own DEFAULT_PARAMS rather than copied, so the format
 * cannot drift away from the primitive library. A kind is encodable only when
 * every one of its defaults is a plain finite number that survives the param
 * grid — which is exactly what excludes sketches (profile arrays, an `sk`
 * solver document, a string `op`) and supports (slab arrays).
 */
const KIND_LIST = Object.keys(DEFAULT_PARAMS);
const KIND_CODE = new Map();
const PARAM_KEYS = new Map();

for (let i = 0; i < KIND_LIST.length; i++) {
  const kind = KIND_LIST[i];
  if (i >= BOOLEAN_CODE) break;                  // no code left; those kinds fall back
  const def = DEFAULT_PARAMS[kind];
  const keys = Object.keys(def);
  const plain = keys.every((k) => {
    const v = def[k];
    return typeof v === 'number' && Number.isFinite(v) && Math.round(v * PARAM_MUL) / PARAM_MUL === v;
  });
  if (!plain || !keys.length) continue;
  KIND_CODE.set(kind, i);
  PARAM_KEYS.set(kind, keys);
}

/**
 * An 8-bit fingerprint of the schema this build encodes against: the kind
 * codes and each kind's param key order. A link written by one build and opened
 * by another whose primitive table has since changed is REFUSED rather than
 * decoded against the wrong slots. Costs one byte; buys the guarantee that a
 * future primitive cannot quietly reinterpret an old link.
 */
const SCHEMA_FINGERPRINT = (() => {
  let h = 0x811c9dc5;
  const text = `v${FORMAT_VERSION}|` + [...KIND_CODE.entries()]
    .map(([kind, code]) => `${code}:${kind}:${PARAM_KEYS.get(kind).join(',')}`).join('|');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0xff;
})();

const CODE_KIND = new Map([...KIND_CODE].map(([k, c]) => [c, k]));

/* ------------------------------------------------------------- bit plumbing */

class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  bit(b) {
    this.cur = (this.cur << 1) | (b ? 1 : 0);
    if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
  }
  bits(v, w) { for (let i = w - 1; i >= 0; i--) this.bit((v >>> i) & 1); }
  // Variable-length integer, 4 bits at a time with a continuation bit. CAD
  // documents are made of small numbers, so small numbers must be cheap.
  varint(v) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw refuse(`varint out of range: ${v}`);
    do { const nib = v & 0xf; v = Math.floor(v / 16); this.bit(v > 0); this.bits(nib, 4); } while (v > 0);
  }
  zigzag(v) {
    if (!Number.isInteger(v) || Math.abs(v) > VARINT_MAX) throw refuse(`value too large to encode: ${v}`);
    this.varint(v < 0 ? -v * 2 - 1 : v * 2);
  }
  // The double itself, IEEE-754, big-endian. The expensive escape hatch, for a
  // number that sits on none of this format's grids. Exact by construction, so
  // it can never round anything.
  f64(v) {
    F64.setFloat64(0, v);
    this.bits(F64.getUint32(0), 32);
    this.bits(F64.getUint32(4), 32);
  }
  done() { while (this.n) this.bit(0); return Uint8Array.from(this.bytes); }
}

class BitReader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  bit() {
    const byteIndex = this.i >> 3;
    if (byteIndex >= this.b.length) throw new Error('tinylink: payload ended mid-value');
    const v = (this.b[byteIndex] >> (7 - (this.i & 7))) & 1;
    this.i++;
    return v;
  }
  bits(w) { let v = 0; for (let i = 0; i < w; i++) v = (v << 1) | this.bit(); return v >>> 0; }
  varint() {
    let v = 0, shift = 0;
    for (;;) {
      const more = this.bit();
      const nib = this.bits(4);
      v += nib * 2 ** shift;
      shift += 4;
      if (!more) return v;
      if (shift > 32) throw new Error('tinylink: varint runs too long');
    }
  }
  zigzag() { const u = this.varint(); return (u & 1) ? -((u + 1) / 2) : u / 2; }
  f64() {
    F64.setUint32(0, this.bits(32));
    F64.setUint32(4, this.bits(32));
    return F64.getFloat64(0);
  }
}

/* ------------------------------------------------------------------ refusal */

// A refusal is not a bug: it is this format saying "the deflate path should
// carry this one". Marked so callers can tell it from a genuine crash.
function refuse(reason) {
  const e = new Error(`tinylink: ${reason}`);
  e.tinyRefused = true;
  return e;
}

/* ---------------------------------------------------------------- numbers -- */

const finite3 = (a) => Array.isArray(a) && a.length === 3 && a.every((v) => typeof v === 'number' && Number.isFinite(v));

// Quantise on a multiplier, but only accept it when decoding gives back the
// EXACT double we started from. This is the whole lossless guarantee.
function exactQ(v, mul) {
  const q = Math.round(v * mul);
  if (!Number.isFinite(q) || Math.abs(q) > VARINT_MAX) return null;
  return q / mul === v ? q : null;
}

// A quantised 3-vector, written as "which axes moved" and then only those.
// A zigzag varint costs five bits even to say zero, and a row of parts nudged
// along one axis would otherwise pay ten bits per object for two untouched
// ones. Three bits of mask is cheaper than three zeros from two axes on.
function writeVec(w, qs) {
  let mask = 0;
  for (let i = 0; i < 3; i++) if (qs[i] !== 0) mask |= 1 << (2 - i);
  w.bits(mask, 3);
  for (let i = 0; i < 3; i++) if (qs[i] !== 0) w.zigzag(qs[i]);
}

function readVec(r) {
  const mask = r.bits(3);
  return [0, 1, 2].map((i) => ((mask & (1 << (2 - i))) ? r.zigzag() : 0));
}

// The coarsest of 1 / 0.1 / 0.01mm on which every one of `vals` is exact, and
// on which `base[i] + val` reproduces `target[i]` exactly. Null when none is.
function chooseGrid(vals, base, target) {
  for (const [code, mul] of POS_GRIDS) {
    const qs = vals.map((v) => exactQ(v, mul));
    if (qs.some((q) => q === null)) continue;
    if (qs.every((q, i) => base[i] + q / mul === target[i])) return { code, mul, qs };
  }
  return null;
}

/* ------------------------------------------------------------------- names --
 *
 * A mirror of CadDocument._uniqueName. Names are only carried when they differ
 * from what the app would have generated, which is why the default "Box",
 * "Box 2", "Cylinder" cost nothing at all.
 */
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function baseNameFor(kind, op) {
  if (kind !== 'boolean') return cap(kind);
  return op === 'intersect' ? 'Intersection' : 'Group';
}

function predictName(base, taken) {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

/* ------------------------------------------------------------------ colour */

const HEX6 = /^#[0-9a-f]{6}$/;

function defaultColor(kind, role) {
  if (role === 'hole') return DEFAULT_COLORS.hole;
  return kind === 'boolean' ? DEFAULT_COLORS.boolean : DEFAULT_COLORS.solid;
}

/* ------------------------------------------------------------------ encode */

/**
 * Pack a `toJSON({ recipeOnly: true })` document into bytes.
 * Throws a marked refusal (e.tinyRefused) when the document cannot be
 * represented exactly. Never returns a lossy encoding.
 */
export function encodeTiny(data) {
  if (!data || !Array.isArray(data.objects) || !data.objects.length) throw refuse('nothing to encode');
  const w = new BitWriter();
  w.bits(FORMAT_VERSION, 4);
  w.bits(SCHEMA_FINGERPRINT, 8);
  w.varint(data.objects.length);
  const taken = new Set();
  let prev = null;
  for (const o of data.objects) { writeObj(w, o, taken, prev, false); prev = o; }
  return w.done();
}

function writeObj(w, o, taken, prev, isChild) {
  const kind = o && o.kind;
  const isBool = kind === 'boolean';
  const code = isBool ? BOOLEAN_CODE : KIND_CODE.get(kind);
  if (code === undefined) {
    // Sketches land here, and so does any primitive added to DEFAULT_PARAMS
    // that this format has not been taught. Both fall back rather than guess.
    throw refuse(`${kind === 'sketch' ? 'a sketch profile' : `kind "${kind}"`} cannot be packed`);
  }
  w.bits(code, 4);

  // The operation goes first for booleans, because the auto-name prediction
  // below depends on it ("Group" vs "Intersection") and the decoder has to be
  // able to make the same prediction at the same point in the stream.
  let op = null;
  if (isBool) {
    op = o.params && o.params.op;
    if (op !== 'combine' && op !== 'intersect') throw refuse('a group with no recorded operation');
    if (o.geometry) throw refuse('a group that still carries its baked mesh');
    if (!Array.isArray(o.children) || o.children.length < 2) throw refuse('a group with fewer than two parts');
    if (Object.keys(o.params).length !== 1) throw refuse('a group with extra params');
    w.bit(op === 'intersect');
  }

  if (o.role !== 'solid' && o.role !== 'hole') throw refuse(`unknown role "${o.role}"`);
  if (!finite3(o.position) || !finite3(o.rotation) || !finite3(o.scale)) throw refuse('a non-finite transform');
  if (typeof o.name !== 'string') throw refuse('a missing name');
  if (typeof o.color !== 'string' || !HEX6.test(o.color)) throw refuse(`colour "${o.color}" is not #rrggbb`);

  // --- position: relative to the previous sibling when that works, else absolute
  const base = prev ? prev.position : [0, 0, 0];
  let posPlan = null, relative = true;
  const rel = o.position.map((v, i) => v - base[i]);
  posPlan = chooseGrid(rel, base, o.position);
  if (!posPlan) { relative = false; posPlan = chooseGrid(o.position, [0, 0, 0], o.position); }
  if (!posPlan) throw refuse(`position ${o.position.join(', ')} is finer than the 0.01mm grid`);

  // --- rotation
  // Unreachable for a finite rotation, which finite3 above has already checked.
  // Kept so that a future change to planAxis cannot start writing garbage.
  const rotPlan = planRotation(o.rotation);
  if (!rotPlan) throw refuse(`rotation ${o.rotation.join(', ')} is not a finite angle`);

  // --- scale
  const scl = o.scale.map((s) => exactQ(s, SCALE_MUL));
  if (scl.some((q) => q === null)) throw refuse(`scale ${o.scale.join(', ')} is finer than 0.001`);

  // --- params
  let paramPlan = null;
  if (!isBool) {
    paramPlan = planParams(kind, o.params);
    if (!paramPlan) throw refuse(`params on a ${kind} do not fit the 0.01 grid`);
  }

  const expectName = predictName(baseNameFor(kind, op), taken);
  const expectColor = defaultColor(kind, o.role);
  const nameBytes = new TextEncoder().encode(o.name);

  const f = {
    pos: posPlan.qs.some((q) => q !== 0) || !relative,
    rot: o.rotation.some((v) => v !== 0),
    scl: scl.some((q) => q !== SCALE_MUL),
    par: !!paramPlan && paramPlan.mask !== 0,
    col: o.color !== expectColor,
    nam: o.name !== expectName,
    hole: o.role === 'hole',
    hid: !isChild && o.visible === false,
  };
  if (isChild && 'visible' in o) throw refuse('a group part carrying a visibility flag');
  if (!isChild && typeof o.visible !== 'boolean') throw refuse('an object with no visibility flag');
  for (const k of ['pos', 'rot', 'scl', 'par', 'col', 'nam', 'hole', 'hid']) w.bit(f[k]);

  if (f.pos) {
    w.bit(relative);
    w.bits(posPlan.code, 2);
    writeVec(w, posPlan.qs);
  }
  if (f.rot) {
    w.bit(rotPlan.allTable);
    for (const a of rotPlan.axes) {
      if (!rotPlan.allTable) w.bits(a.mode, 2);
      if (a.mode === 0) w.bits(a.value, 3);
      else if (a.mode === 3) w.f64(a.value);
      else w.zigzag(a.value);
    }
  }
  if (f.scl) {
    const uniform = scl[0] === scl[1] && scl[1] === scl[2];
    w.bit(uniform);
    for (const q of uniform ? [scl[0]] : scl) w.zigzag(q - SCALE_MUL);
  }
  if (f.par) {
    w.bits(paramPlan.mask, paramPlan.keys.length);
    for (const d of paramPlan.deltas) w.zigzag(d);
  }
  if (f.col) w.bits(parseInt(o.color.slice(1), 16), 24);
  if (f.nam) { w.varint(nameBytes.length); for (const b of nameBytes) w.bits(b, 8); }

  taken.add(o.name);

  if (isBool) {
    writeBaseMatrix(w, o.baseMatrix, o.position);
    w.varint(o.children.length);
    const childTaken = new Set();
    let cp = null;
    for (const c of o.children) { writeObj(w, c, childTaken, cp, true); cp = c; }
  }
}

// baseMatrix is always a pure translation: _bakeGroup and rebakeGroupChild both
// build it from a position-only matrix. Overwhelmingly it is the translation of
// the object's own position (a group that has not been dragged since it was
// made), which is one bit. A group that HAS been moved stores the difference,
// on the same grid as everything else.
const IDENTITY_16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function writeBaseMatrix(w, bm, position) {
  if (bm == null) { w.bit(0); return; }
  if (!Array.isArray(bm) || bm.length !== 16 || bm.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw refuse('a group with a malformed baseMatrix');
  }
  for (let i = 0; i < 16; i++) {
    if (i === 12 || i === 13 || i === 14) continue;
    if (bm[i] !== IDENTITY_16[i]) throw refuse('a group whose baseMatrix is not a pure translation');
  }
  w.bit(1);
  const t = [bm[12], bm[13], bm[14]];
  const same = t[0] === position[0] && t[1] === position[1] && t[2] === position[2];
  w.bit(same);
  if (same) return;
  // Same relative-then-absolute ladder as a position, for the same reason: the
  // difference between two on-grid numbers is not always itself on the grid.
  let relative = true;
  let plan = chooseGrid(t.map((v, i) => v - position[i]), position, t);
  if (!plan) { relative = false; plan = chooseGrid(t, [0, 0, 0], t); }
  if (!plan) throw refuse('a moved group whose original pivot is finer than the 0.01mm grid');
  w.bit(relative);
  w.bits(plan.code, 2);
  writeVec(w, plan.qs);
}

// Rotation, cheapest mode first, CHOSEN PER AXIS. Per axis matters more than it
// looks: "stood on end and nudged" is [-90°, 0.3 rad, 0], and a single mode for
// all three would refuse that whole object over one axis. Every mode is checked
// by reconstructing the value and demanding an exact match, so a snapped angle
// still cannot arrive 0.0001 rad from where it was drawn.
//
//   mode 0  index into ANGLES        3 bits
//   mode 1  whole degrees            zigzag varint, r === k * PI / 180
//   mode 2  multiples of 0.0001 rad  zigzag varint
//   mode 3  the raw double           64 bits
//
// One leading bit says "all three axes are table angles", which is the common
// case and pays for itself immediately.
//
// WHY MODE 3 EXISTS. Modes 0 to 2 are all grids, and the gizmo does not land on
// grids. TransformControls rounds the drag to the 15 degree snap, builds a
// quaternion from an axis and that angle, and Three then derives object.rotation
// back out of the quaternion with atan2 and asin. That last step is where the
// exactness goes. Measured against Three r160, a 45 degree turn about Y comes
// back as 0.7853981633974484 where PI/4 is 0.7853981633974483, one unit in the
// last place adrift, and a 90 degree turn about X comes back as
// 1.5707963267948963 rather than 1.5707963267948966. Past 90 degrees on Y the
// Euler triple flips representation entirely, so a 135 degree turn arrives as
// [-PI, 0.7853981633974485, -PI], three arbitrary doubles for one snapped drag.
//
// None of those sit on any grid, and before mode 3 every one of them cost the
// user the long format for the whole document. Rotating a part by 45 degrees
// with the gizmo is not an exotic action, so the fix is not a coarser grid, it
// is a mode that has no grid at all. 64 bits is about eleven characters of
// base64 for the one axis that needs it, and no axis that already encodes well
// is ever offered it, because it is only reached once the three cheaper modes
// have each failed their exact-match check.
function planAxis(r) {
  const t = ANGLES.indexOf(r);
  if (t >= 0) return { mode: 0, value: t };
  const k = Math.round((r * 180) / Math.PI);
  if (Number.isInteger(k) && Math.abs(k) <= VARINT_MAX && (k * Math.PI) / 180 === r) return { mode: 1, value: k };
  const q = exactQ(r, RAD_MUL);
  if (q !== null) return { mode: 2, value: q };
  // Every finite double reaches here intact, so rotation is no longer a reason
  // for a document to fall back. Non-finite values are already refused by the
  // finite3 check in writeObj, and the guard is repeated here because a mode
  // that claims to be exact must not quietly write a NaN.
  if (Number.isFinite(r)) return { mode: 3, value: r };
  return null;
}

function planRotation(rot) {
  const axes = rot.map(planAxis);
  if (axes.some((a) => a === null)) return null;
  return { allTable: axes.every((a) => a.mode === 0), axes };
}

// One bit per param saying whether it deviates from the app's own default, then
// only the deviations. A cylinder with a changed radius pays for one number,
// not for `height`, `segments` and `round` as well.
function planParams(kind, params) {
  const keys = PARAM_KEYS.get(kind);
  const def = DEFAULT_PARAMS[kind];
  const p = params || {};
  for (const k of Object.keys(p)) if (!keys.includes(k)) throw refuse(`a ${kind} carrying an extra param "${k}"`);
  let mask = 0;
  const deltas = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = k in p ? p[k] : def[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    if (v === def[k] && k in p) continue;
    if (!(k in p)) return null;                    // a missing param would come back as the default
    const q = exactQ(v, PARAM_MUL);
    if (q === null) return null;
    const d = q - Math.round(def[k] * PARAM_MUL);
    if ((d + Math.round(def[k] * PARAM_MUL)) / PARAM_MUL !== v) return null;
    mask |= 1 << (keys.length - 1 - i);
    deltas.push(d);
  }
  if (Object.keys(p).length !== keys.length) return null;
  return { keys, mask, deltas };
}

/* ------------------------------------------------------------------ decode */

/**
 * The inverse of encodeTiny. Returns a document in exactly the shape
 * `toJSON({ recipeOnly: true })` produces, ready for rebakeBooleans + loadJSON.
 * Throws on anything malformed rather than returning a half-read design.
 */
export function decodeTiny(bytes) {
  const r = new BitReader(bytes);
  const version = r.bits(4);
  if (version !== FORMAT_VERSION) throw new Error(`tinylink: unknown format version ${version}`);
  const fp = r.bits(8);
  if (fp !== SCHEMA_FINGERPRINT) {
    // Written against a different primitive table than this build has. Decoding
    // it would put the right numbers in the wrong fields.
    throw new Error('tinylink: this link was made by a different build of CADence');
  }
  const count = r.varint();
  if (count < 1 || count > 100000) throw new Error(`tinylink: implausible object count ${count}`);
  const ctx = { nextId: 0 };
  const taken = new Set();
  const objects = [];
  let prev = null;
  for (let i = 0; i < count; i++) {
    const o = readObj(r, taken, prev, false, ctx);
    objects.push(o);
    prev = o;
  }
  return { app: 'CADence', version: 1, objects };
}

function readObj(r, taken, prev, isChild, ctx) {
  const code = r.bits(4);
  const isBool = code === BOOLEAN_CODE;
  const kind = isBool ? 'boolean' : CODE_KIND.get(code);
  if (!kind) throw new Error(`tinylink: unknown kind code ${code}`);

  let op = null;
  if (isBool) op = r.bit() ? 'intersect' : 'combine';

  const f = {};
  for (const k of ['pos', 'rot', 'scl', 'par', 'col', 'nam', 'hole', 'hid']) f[k] = !!r.bit();

  const role = f.hole ? 'hole' : 'solid';

  let position = prev ? [...prev.position] : [0, 0, 0];
  if (f.pos) {
    const relative = !!r.bit();
    const mul = POS_GRIDS[r.bits(2)][1];
    const base = relative ? (prev ? prev.position : [0, 0, 0]) : [0, 0, 0];
    const qs = readVec(r);
    position = [0, 1, 2].map((i) => base[i] + qs[i] / mul);
  }

  let rotation = [0, 0, 0];
  if (f.rot) {
    const allTable = !!r.bit();
    rotation = [0, 1, 2].map(() => {
      const mode = allTable ? 0 : r.bits(2);
      if (mode === 0) {
        const i = r.bits(3);
        if (i >= ANGLES.length) throw new Error(`tinylink: angle index ${i} is not in the table`);
        return ANGLES[i];
      }
      if (mode === 1) return (r.zigzag() * Math.PI) / 180;
      if (mode === 2) return r.zigzag() / RAD_MUL;
      return r.f64();                          // mode 3, the raw double
    });
  }

  let scale = [1, 1, 1];
  if (f.scl) {
    const uniform = !!r.bit();
    if (uniform) { const s = (r.zigzag() + SCALE_MUL) / SCALE_MUL; scale = [s, s, s]; }
    else scale = [0, 1, 2].map(() => (r.zigzag() + SCALE_MUL) / SCALE_MUL);
  }

  let params;
  if (isBool) params = { op };
  else {
    const keys = PARAM_KEYS.get(kind);
    const def = DEFAULT_PARAMS[kind];
    params = {};
    for (const k of keys) params[k] = def[k];
    if (f.par) {
      const mask = r.bits(keys.length);
      for (let i = 0; i < keys.length; i++) {
        if (!(mask & (1 << (keys.length - 1 - i)))) continue;
        const k = keys[i];
        params[k] = (r.zigzag() + Math.round(def[k] * PARAM_MUL)) / PARAM_MUL;
      }
    }
  }

  let color;
  if (f.col) color = '#' + r.bits(24).toString(16).padStart(6, '0');
  else color = defaultColor(kind, role);

  let name;
  if (f.nam) {
    const len = r.varint();
    if (len > 1 << 16) throw new Error('tinylink: implausible name length');
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) buf[i] = r.bits(8);
    name = new TextDecoder().decode(buf);
  } else {
    name = predictName(baseNameFor(kind, op), taken);
  }
  taken.add(name);

  const out = { id: `obj-${++ctx.nextId}`, kind, role, name, color, params, position, rotation, scale };
  if (!isChild) out.visible = !f.hid;

  if (isBool) {
    out.baseMatrix = readBaseMatrix(r, position);
    const n = r.varint();
    if (n < 2 || n > 100000) throw new Error(`tinylink: implausible part count ${n}`);
    const childTaken = new Set();
    const children = [];
    let cp = null;
    for (let i = 0; i < n; i++) { const c = readObj(r, childTaken, cp, true, ctx); children.push(c); cp = c; }
    out.children = children;
    out.geometry = null;                    // rebakeBooleans puts the mesh back
  }
  return out;
}

function readBaseMatrix(r, position) {
  if (!r.bit()) return null;
  let t;
  if (r.bit()) t = [...position];
  else {
    const relative = !!r.bit();
    const mul = POS_GRIDS[r.bits(2)][1];
    const base = relative ? position : [0, 0, 0];
    const qs = readVec(r);
    t = [0, 1, 2].map((i) => base[i] + qs[i] / mul);
  }
  const m = IDENTITY_16.slice();
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
}

/* ------------------------------------------------ the round-trip guarantee */

// A canonical projection of a document for comparison: every field this format
// is responsible for, in a fixed order, with ids dropped (they are per-session
// counters the decoder mints fresh) and -0 folded to 0 (JSON has one zero).
function canonicalize(data) {
  const zero = (v) => (v === 0 ? 0 : v);
  const node = (o, isChild) => {
    const out = {
      kind: o.kind, role: o.role, name: o.name, color: o.color,
      params: Object.keys(o.params || {}).sort().map((k) => [k, zero(o.params[k])]),
      position: o.position.map(zero), rotation: o.rotation.map(zero), scale: o.scale.map(zero),
    };
    if (!isChild) out.visible = o.visible;
    if (o.kind === 'boolean') {
      out.baseMatrix = o.baseMatrix ? o.baseMatrix.map(zero) : null;
      out.children = o.children ? o.children.map((c) => node(c, true)) : null;
      out.geometry = o.geometry ?? null;
    }
    return out;
  };
  return JSON.stringify(data.objects.map((o) => node(o, false)));
}

/**
 * Encode, decode the result straight back, and only hand over bytes that
 * reproduce the document exactly.
 *
 * This is the guarantee the whole feature rests on. A silent encoder/decoder
 * mismatch would corrupt someone's design with no error, so buildShareLink does
 * not take this encoder's word for anything: it checks the inverse, on the real
 * document, every single time. A design is cheap to encode twice; a corrupted
 * model is not.
 *
 * @returns {{bytes: Uint8Array|null, reason: string|null}}
 */
export function encodeVerified(data) {
  let bytes;
  try {
    bytes = encodeTiny(data);
  } catch (e) {
    return { bytes: null, reason: e && e.message ? e.message : String(e) };
  }
  try {
    const back = decodeTiny(bytes);
    if (canonicalize(back) !== canonicalize(data)) {
      return { bytes: null, reason: 'tinylink: round-trip check failed, falling back' };
    }
  } catch (e) {
    return { bytes: null, reason: `tinylink: decode check failed (${e && e.message})` };
  }
  return { bytes, reason: null };
}

// Exposed for the harness, which asserts the two really are inverses over
// several hundred randomly generated documents.
export { canonicalize as canonicalizeForTest, SCHEMA_FINGERPRINT };
