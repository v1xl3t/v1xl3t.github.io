// history.js — the Recipe Timeline's data model: a TREE of modeling steps.
//
// Why a tree, not a stack: classic undo is one destructive line — go back, do
// something new, and the old future is gone. CADence instead keeps every path
// alive. Editing from a past step doesn't erase what came after; it FORKS a new
// branch that lives alongside the original (the "5D Chess" multiverse model).
// Linear history is simply a tree that hasn't forked yet, so we pay nothing now
// to unlock branching later.
//
// Each node stores the full scene snapshot AFTER its step (so jumping to a node
// is a restore), plus a human label and an optional thumbnail for the strip.

let _hid = 0;

export class History {
  constructor() {
    this.nodes = new Map();   // id -> node
    this.rootId = null;
    this.currentId = null;
  }

  _make(label, snapshot, parentId, thumb) {
    const id = `h-${++_hid}`;
    const node = { id, label, snapshot, parentId, children: [], thumb: thumb || null, t: Date.now() };
    this.nodes.set(id, node);
    if (parentId != null) this.nodes.get(parentId)?.children.push(id);
    return node;
  }

  // Seed the root (the empty/initial scene). Called once at document creation.
  init(snapshot) {
    const n = this._make('New scene', snapshot, null);
    this.rootId = n.id;
    this.currentId = n.id;
    return n;
  }

  // Record a step as a child of the current node, and advance the cursor to it.
  // If the cursor is on a past node, this is exactly where a branch forks.
  record(label, snapshot, thumb) {
    const n = this._make(label, snapshot, this.currentId, thumb);
    this.currentId = n.id;
    return n;
  }

  get current() { return this.nodes.get(this.currentId) || null; }
  get(id) { return this.nodes.get(id) || null; }
  goto(id) { if (this.nodes.has(id)) this.currentId = id; return this.current; }

  // The chain of node ids from the current node back to the root — the "active
  // timeline" the user is standing in. Used to highlight the live path.
  activePath() {
    const path = new Set();
    let id = this.currentId;
    while (id != null) { path.add(id); id = this.nodes.get(id)?.parentId; }
    return path;
  }

  // Lay the tree out for the multiverse strip: time → column (depth from root),
  // branches → rows. A node's first child stays on the parent's row; each extra
  // child claims a fresh row below. Returns Map<id, {col,row}> and the max row.
  layout() {
    const pos = new Map();
    let maxRow = 0;
    const visit = (id, col, row) => {
      pos.set(id, { col, row });
      maxRow = Math.max(maxRow, row);
      const kids = this.nodes.get(id).children;
      kids.forEach((kid, i) => visit(kid, col + 1, i === 0 ? row : ++maxRow));
    };
    if (this.rootId != null) visit(this.rootId, 0, 0);
    return { pos, maxRow };
  }

  get size() { return this.nodes.size; }
}
