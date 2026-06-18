// timeline.js — the Recipe Timeline strip (the inventive UI surface).
//
// Renders the history TREE as a 5D-Chess-style multiverse: time runs left→right
// (columns), parallel branches stack downward (rows), and connectors are drawn
// from each step to its children — with an elbow where a branch forks off. Click
// any tile to time-travel there; from then on, a new action forks a new branch.

const COLW = 92;    // horizontal spacing between steps
const ROWH = 80;    // vertical spacing between branches
const TILE_W = 72;
const TILE_H = 50;
const PAD = 16;
const SVGNS = 'http://www.w3.org/2000/svg';

export class Timeline {
  constructor(doc, { onGoto } = {}) {
    this.doc = doc;
    this.onGoto = onGoto || (() => {});
    this.el = document.getElementById('timeline');
    this.scroll = this.el.querySelector('.tl-scroll');
    this.canvas = this.el.querySelector('.tl-canvas');
    this.svg = this.el.querySelector('.tl-svg');

    doc.addEventListener('history', () => this.render());
    this.render();
  }

  get visible() { return !this.el.hidden; }
  toggle(force) { this.el.hidden = force != null ? !force : !this.el.hidden; if (this.visible) this.render(); }

  render() {
    if (!this.visible) return;
    const H = this.doc.history;
    const { pos, maxRow } = H.layout();
    const active = H.activePath();

    // size the canvas to the content
    let maxCol = 0;
    for (const { col } of pos.values()) maxCol = Math.max(maxCol, col);
    const W = PAD * 2 + (maxCol + 1) * COLW;
    const Hpx = PAD * 2 + (maxRow + 1) * ROWH;
    this.canvas.style.width = W + 'px';
    this.canvas.style.height = Hpx + 'px';
    this.svg.setAttribute('viewBox', `0 0 ${W} ${Hpx}`);
    this.svg.setAttribute('width', W);
    this.svg.setAttribute('height', Hpx);

    const cx = (col) => PAD + col * COLW + TILE_W / 2;
    const cy = (row) => PAD + row * ROWH + TILE_H / 2;

    // --- connectors (drawn first, behind tiles) ---
    let paths = '';
    for (const [id, node] of H.nodes) {
      const p = pos.get(id); if (!p) continue;
      for (const kidId of node.children) {
        const k = pos.get(kidId); if (!k) continue;
        const onActive = active.has(id) && active.has(kidId);
        const x1 = cx(p.col) + TILE_W / 2 - 6, y1 = cy(p.row);
        const x2 = cx(k.col) - TILE_W / 2 + 6, y2 = cy(k.row);
        // straight along a branch; elbow when the child drops to a new row (a fork)
        const d = (k.row === p.row)
          ? `M${x1},${y1} L${x2},${y2}`
          : `M${x1},${y1} C${x1 + COLW * 0.4},${y1} ${x2 - COLW * 0.4},${y2} ${x2},${y2}`;
        paths += `<path d="${d}" class="tl-edge${onActive ? ' active' : ''}"/>`;
      }
    }
    this.svg.innerHTML = paths;

    // --- tiles ---
    // wipe old tiles (keep the svg)
    [...this.canvas.querySelectorAll('.tl-node')].forEach((n) => n.remove());
    let step = 0;
    const order = [...H.nodes.keys()];
    for (const id of order) {
      const node = H.nodes.get(id);
      const p = pos.get(id); if (!p) continue;
      const tile = document.createElement('button');
      tile.className = 'tl-node'
        + (id === H.currentId ? ' current' : '')
        + (active.has(id) ? ' on-path' : '');
      tile.style.left = (PAD + p.col * COLW) + 'px';
      tile.style.top = (PAD + p.row * ROWH) + 'px';
      tile.title = node.label;
      const thumb = node.thumb
        ? `<img class="tl-thumb" src="${node.thumb}" alt="" draggable="false"/>`
        : `<div class="tl-thumb empty"></div>`;
      tile.innerHTML = `${thumb}<span class="tl-label">${node.label}</span>`;
      tile.addEventListener('click', () => this.onGoto(id));
      this.canvas.appendChild(tile);
      step++;
    }

    // keep the current step in view
    const cur = pos.get(H.currentId);
    if (cur) {
      const tx = PAD + cur.col * COLW;
      this.scroll.scrollTo({ left: Math.max(0, tx - this.scroll.clientWidth / 2), behavior: 'smooth' });
    }
  }
}
