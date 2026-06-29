// outliner.js — the Objects panel (scene tree).
//
// A flat list of every object: click to select (Shift-click to multi-select),
// eye toggles visibility, and a badge shows Add / Cut / group at a glance. Reads
// the same document the viewport and inspector do, and re-renders on any change.

import { ROLE_LABELS } from './primitives.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Outliner {
  constructor(doc) {
    this.doc = doc;
    this.root = document.getElementById('outliner-list');
    // Multi-select mode: when on, tapping a row toggles it in/out of the selection
    // with no Shift key. This is the touch path (no keyboard), and a convenience on
    // desktop too. Wired once here; the header button persists across list re-renders.
    this.multi = false;
    this.multiBtn = document.getElementById('multi-btn');
    this.panel = document.getElementById('outliner');
    if (this.multiBtn) {
      this.multiBtn.addEventListener('click', () => this.setMulti(!this.multi));
    }
    for (const ev of ['add', 'remove', 'select', 'regroup', 'undo', 'change']) {
      doc.addEventListener(ev, () => this.render());
    }
    this.render();
  }

  setMulti(on) {
    this.multi = on;
    this.multiBtn?.classList.toggle('active', on);
    this.panel?.classList.toggle('multi', on);
  }

  render() {
    const objs = this.doc.list;
    if (!objs.length) {
      this.root.innerHTML = '<div class="muted">No objects yet.</div>';
      return;
    }
    this.root.innerHTML = objs.map((o) => {
      const sel = this.doc.selection.has(o.id) ? ' sel' : '';
      const isBool = o.kind === 'boolean';
      const label = isBool ? 'group' : o.role === 'hole' ? ROLE_LABELS.hole : ROLE_LABELS.solid;
      const cls = isBool ? 'b-group' : o.role === 'hole' ? 'b-cut' : 'b-add';
      return `<div class="orow${sel}" data-id="${o.id}">
        <button class="eye" data-eye="${o.id}" title="Show / hide">${o.mesh.visible ? '◉' : '◯'}</button>
        <span class="oname">${esc(o.name)}</span>
        <span class="badge ${cls}">${label}</span>
      </div>`;
    }).join('');

    this.root.querySelectorAll('.orow').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.eye')) return;
        // additive (toggle) when Multi mode is on or Shift is held; otherwise single-select
        this.doc.select(row.dataset.id, this.multi || e.shiftKey);
      });
    });
    this.root.querySelectorAll('.eye').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const o = this.doc.objects.get(btn.dataset.eye);
        if (o) { o.mesh.visible = !o.mesh.visible; this.render(); }
      });
    });
  }
}
