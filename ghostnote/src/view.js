// view.js — the scrolling chart, and the editor, which are the same picture.
//
// Lanes run left to right as rows, notes travel toward a fixed play head. That
// choice is deliberate. A vertical falling highway has to be rebuilt as a
// separate screen before anyone can edit it, whereas this one becomes an editor
// simply by pausing, so the chart you are correcting is the chart you played.

import { LANES, LANE_LABEL } from './chart.js';

const LANE_COLOR = {
  hat: '#8fd3ff',
  snare: '#ffd479',
  tom: '#c9a2ff',
  kick: '#7ee787',
};

const GRADE_COLOR = {
  perfect: '#7ee787',
  great: '#8fd3ff',
  good: '#ffd479',
  miss: '#ff8f8f',
};

// How far apart two notes in the same lane have to be before they are drawn as
// two notes. A full sized note is 22px wide, so anything closer than this is
// already overlapping, and a bar of 32nds at 190 pixels per second arrives as
// one continuous smudge with no way to count what is in it.
export const DENSE_GAP = 18;
// Below this many in a row it is a couple of fast notes, not a roll, and the
// normal drawing still reads fine.
export const DENSE_RUN = 3;

export const MIN_ZOOM = 60;
export const MAX_ZOOM = 640;
export const DEFAULT_ZOOM = 190;

export class Highway {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.chart = null;
    this.time = 0;
    this.pxPerSec = DEFAULT_ZOOM;
    this.mode = 'play';
    this.selectedId = null;
    this.flashes = [];
    this.showGrid = true;
    this.labelW = 62;
    this.headFrac = 0.3;
    this.loop = null;          // {a, b} in seconds, shaded so a section is visible
    this.onadd = null;
    this.onselect = null;
    this.onmove = null;
    this.onscrub = null;
    this.onzoom = null;
    this._drag = null;
    this._pointers = new Map();
    this._pinch = null;
    this._bind();
  }

  /**
   * Horizontal zoom, in pixels per second.
   *
   * A 1/64 roll in a 44px lane was drawn as a smear, which is a drawing problem
   * and not a detection one. Two things fix it together. Dense passages get
   * their own drawing below, and the whole highway can be stretched out until
   * whatever you are looking at has room. The play head keeps its position on
   * screen, so zooming never moves where you are in the track.
   */
  setZoom(px) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, px));
    if (next === this.pxPerSec) return this.pxPerSec;
    this.pxPerSec = next;
    if (this.onzoom) this.onzoom(next);
    return next;
  }

  zoomBy(factor) { return this.setZoom(this.pxPerSec * factor); }

  get laneH() { return Math.max(38, Math.min(64, (this.canvas.clientHeight - 26) / LANES.length)); }
  get headX() { return this.labelW + Math.max(60, (this.canvas.clientWidth - this.labelW) * this.headFrac); }

  timeAt(x) { return this.time + (x - this.headX) / this.pxPerSec; }
  xAt(t) { return this.headX + (t - this.time) * this.pxPerSec; }
  laneAt(y) {
    const i = Math.floor((y - 22) / this.laneH);
    return LANES[Math.max(0, Math.min(LANES.length - 1, i))];
  }
  yAt(lane) { return 22 + LANES.indexOf(lane) * this.laneH + this.laneH / 2; }

  get beatsPerBar() { return (this.chart && this.chart.beatsPerBar) || 4; }
  get barOffset() { return (this.chart && this.chart.barOffset) || 0; }

  /** Does a bar start on this beat. Kept out of render so it can be tested. */
  barAt(beatIndex) {
    const b = this.beatsPerBar;
    return (((beatIndex - this.barOffset) % b) + b) % b === 0;
  }

  /** Which bar number this beat starts, counting from one. */
  barNumber(beatIndex) {
    return Math.round((beatIndex - this.barOffset) / this.beatsPerBar) + 1;
  }

  resize() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  flash(grade, lane) {
    this.flashes.push({ grade, lane, at: performance.now() });
    if (this.flashes.length > 24) this.flashes.shift();
  }

  noteAt(x, y) {
    if (!this.chart) return null;
    const lane = this.laneAt(y);
    let best = null, bestD = Infinity;
    for (const n of this.chart.notes) {
      if (n.lane !== lane) continue;
      const d = Math.abs(this.xAt(n.t) - x);
      if (d < bestD) { bestD = d; best = n; }
    }
    return bestD <= 22 ? best : null;
  }

  _bind() {
    const c = this.canvas;
    const pos = (ev) => {
      const r = c.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    c.addEventListener('pointerdown', (ev) => {
      // Capture is an optimization, not a requirement. It throws when the
      // pointer has already been released, and letting that throw abandon the
      // rest of this handler would drop the gesture entirely.
      try { c.setPointerCapture(ev.pointerId); } catch { /* carry on without it */ }
      this._pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      // Two fingers means zoom, and it must cancel whatever the first finger
      // had started. A pinch that also drags a note leaves the chart edited by
      // a gesture nobody meant as an edit.
      if (this._pointers.size === 2) {
        const [p1, p2] = [...this._pointers.values()];
        this._pinch = { dist: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1, zoom: this.pxPerSec };
        this._drag = null;
        return;
      }
      const p = pos(ev);
      const note = this.noteAt(p.x, p.y);
      this._drag = { start: p, at: performance.now(), note, moved: false, startTime: this.time };
      if (note) {
        this.selectedId = note.id;
        if (this.onselect) this.onselect(note);
      }
      ev.preventDefault();
    });
    c.addEventListener('pointermove', (ev) => {
      if (this._pointers.has(ev.pointerId)) this._pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (this._pinch && this._pointers.size === 2) {
        const [p1, p2] = [...this._pointers.values()];
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1;
        this.setZoom(this._pinch.zoom * (d / this._pinch.dist));
        ev.preventDefault();
        return;
      }
      if (!this._drag) return;
      const p = pos(ev);
      const dx = p.x - this._drag.start.x, dy = p.y - this._drag.start.y;
      if (!this._drag.moved && Math.hypot(dx, dy) > 8) this._drag.moved = true;
      if (!this._drag.moved) return;
      if (this._drag.note && this.mode === 'edit') {
        const t = this.timeAt(p.x);
        const lane = this.laneAt(p.y);
        this._drag.pending = { id: this._drag.note.id, t, lane };
        this._drag.note.t = t;
        this._drag.note.lane = lane;
      } else if (this.onscrub) {
        this.onscrub(this._drag.startTime - dx / this.pxPerSec);
      }
    });
    const end = (ev) => {
      this._pointers.delete(ev.pointerId);
      if (this._pointers.size < 2) this._pinch = null;
      if (!this._drag) return;
      const d = this._drag;
      this._drag = null;
      if (d.moved && d.pending && this.onmove) {
        this.onmove(d.pending.id, d.pending.t, d.pending.lane);
        return;
      }
      if (!d.moved) {
        if (d.note) return;                       // a tap on a note only selects
        if (this.mode === 'edit' && this.onadd) {
          const p = pos(ev);
          if (p.x > this.labelW) this.onadd(this.timeAt(p.x), this.laneAt(p.y));
        }
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', (ev) => {
      this._pointers.delete(ev.pointerId);
      if (this._pointers.size < 2) this._pinch = null;
      this._drag = null;
    });
    // Plain wheel is left alone so the page still scrolls with the chart under
    // the cursor. Zooming asks for a modifier, the way it does in every editor.
    c.addEventListener('wheel', (ev) => {
      if (!(ev.ctrlKey || ev.metaKey || ev.altKey)) return;
      ev.preventDefault();
      this.zoomBy(ev.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });
  }

  /**
   * Split one lane's visible notes into runs that are too tight to draw whole.
   *
   * Returned as {notes, dense} groups in time order, so the renderer draws each
   * group in one style and there is no per note decision that could disagree
   * with its neighbor. Kept out of render so the rule can be tested rather
   * than eyeballed against a trap track.
   */
  runsOf(notes) {
    const out = [];
    let cur = null;
    for (const n of notes) {
      const x = this.xAt(n.t);
      if (cur && x - cur.lastX < DENSE_GAP) {
        cur.notes.push(n);
        cur.lastX = x;
      } else {
        cur = { notes: [n], lastX: x, firstX: x };
        out.push(cur);
      }
    }
    for (const g of out) {
      g.dense = g.notes.length >= DENSE_RUN;
      g.firstX = this.xAt(g.notes[0].t);
      g.lastX = this.xAt(g.notes[g.notes.length - 1].t);
    }
    return out;
  }

  /** One note at full size, the way it is drawn whenever there is room. */
  _drawNote(ctx, n, y, laneH, color) {
    const x = this.xAt(n.t);
    const nh = Math.min(26, laneH - 10);
    const nw = 22;
    const sure = n.conf == null ? 1 : n.conf;
    ctx.save();
    ctx.beginPath();
    const r = 6;
    const x0 = x - nw / 2, y0 = y - nh / 2;
    ctx.moveTo(x0 + r, y0);
    ctx.arcTo(x0 + nw, y0, x0 + nw, y0 + nh, r);
    ctx.arcTo(x0 + nw, y0 + nh, x0, y0 + nh, r);
    ctx.arcTo(x0, y0 + nh, x0, y0, r);
    ctx.arcTo(x0, y0, x0 + nw, y0, r);
    ctx.closePath();
    ctx.globalAlpha = 0.35 + 0.65 * Math.max(0.25, sure);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (sure < 0.5) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (n.id === this.selectedId) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * A run of notes too tight to draw whole.
   *
   * Borrowed from how the music is written. Fast notes get beamed together and
   * the beam tells you at a glance how long the burst is, which is exactly the
   * information a smear destroys. Each hit still gets its own tick underneath,
   * so the count survives and any one of them can be selected and dragged, and
   * the number over the beam saves anyone from counting two pixel ticks.
   */
  _drawRun(ctx, run, y, laneH, color) {
    const nh = Math.min(26, laneH - 10);
    const top = y - nh / 2;
    const span = Math.max(4, run.lastX - run.firstX + 4);
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = color;
    ctx.fillRect(run.firstX - 2, top, span, 4);
    const pitch = (run.lastX - run.firstX) / Math.max(1, run.notes.length - 1);
    const tickW = Math.max(2, Math.min(8, pitch - 2));
    for (const n of run.notes) {
      const x = this.xAt(n.t);
      const sure = n.conf == null ? 1 : n.conf;
      ctx.globalAlpha = 0.45 + 0.55 * Math.max(0.25, sure);
      ctx.fillStyle = color;
      ctx.fillRect(x - tickW / 2, top + 5, tickW, nh - 5);
      if (n.id === this.selectedId) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x - tickW / 2 - 1.5, top + 3.5, tickW + 3, nh - 2);
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e8edf3';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(run.notes.length), run.firstX, top - 1);
    ctx.restore();
  }

  render() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const laneH = this.laneH;
    const headX = this.headX;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#11151b';
    ctx.fillRect(0, 0, w, h);

    // lane stripes and labels
    LANES.forEach((lane, i) => {
      const y = 22 + i * laneH;
      ctx.fillStyle = i % 2 ? '#161b23' : '#131820';
      ctx.fillRect(0, y, w, laneH);
      ctx.fillStyle = LANE_COLOR[lane];
      ctx.fillRect(0, y, 4, laneH);
      ctx.fillStyle = '#e8edf3';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(LANE_LABEL[lane], 10, y + laneH / 2);
    });

    // the loop region. A marked section used to exist only as a sentence under
    // the transport, which is a strange place to keep a fact about a picture.
    if (this.loop && this.loop.b > this.loop.a) {
      const top = 22, bot = 22 + LANES.length * laneH;
      const xa = this.xAt(this.loop.a), xb = this.xAt(this.loop.b);
      const l = Math.max(this.labelW, xa), r = Math.min(w, xb);
      if (r > l) {
        ctx.fillStyle = 'rgba(143, 211, 255, 0.10)';
        ctx.fillRect(l, top, r - l, bot - top);
      }
      ctx.strokeStyle = '#8fd3ff';
      ctx.lineWidth = 2;
      for (const x of [xa, xb]) {
        if (x < this.labelW || x > w) continue;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, top);
        ctx.lineTo(Math.round(x) + 0.5, bot);
        ctx.stroke();
      }
    }

    // grid
    if (this.showGrid && this.chart && this.chart.period) {
      const { period, phase } = this.chart;
      // The bar is whatever the chart says it is. This used to be four beats no
      // matter what the music did, so on a waltz the bar lines walked steadily
      // out of step with the track and the whole chart read as broken.
      const step = period / (this.chart.div || 4);
      const t0 = this.timeAt(this.labelW), t1 = this.timeAt(w);
      let k = Math.floor((t0 - phase) / step) - 1;
      const top = 22, bot = 22 + LANES.length * laneH;
      for (let t = phase + k * step; t < t1 + step; t += step, k++) {
        const x = this.xAt(t);
        if (x < this.labelW) continue;
        const beatPos = (t - phase) / period;
        const isBeat = Math.abs(beatPos - Math.round(beatPos)) < 1e-6;
        const isBar = isBeat && this.barAt(Math.round(beatPos));
        ctx.strokeStyle = isBar ? '#5b6675' : isBeat ? '#39424f' : '#242c36';
        ctx.lineWidth = isBar ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, top);
        ctx.lineTo(Math.round(x) + 0.5, bot);
        ctx.stroke();
        if (isBar) {
          const bar = this.barNumber(Math.round(beatPos));
          ctx.fillStyle = '#9aa7b6';
          ctx.font = '11px system-ui, sans-serif';
          ctx.fillText(String(bar), x + 4, 11);
        }
      }
    }

    // notes, in runs, so a roll is drawn as a roll rather than as a smudge
    if (this.chart) {
      const t0 = this.timeAt(this.labelW - 40), t1 = this.timeAt(w + 40);
      const visible = {};
      for (const lane of LANES) visible[lane] = [];
      for (const n of this.chart.notes) {
        if (n.t < t0 || n.t > t1) continue;
        if (visible[n.lane]) visible[n.lane].push(n);
      }
      for (const lane of LANES) {
        const list = visible[lane];
        if (!list.length) continue;
        const y = this.yAt(lane);
        const color = LANE_COLOR[lane] || '#ccc';
        for (const g of this.runsOf(list)) {
          if (g.dense) this._drawRun(ctx, g, y, laneH, color);
          else for (const n of g.notes) this._drawNote(ctx, n, y, laneH, color);
        }
      }
    }

    // play head
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(headX, 18);
    ctx.lineTo(headX, 22 + LANES.length * laneH);
    ctx.stroke();

    // judgements
    const now = performance.now();
    this.flashes = this.flashes.filter((f) => now - f.at < 700);
    for (const f of this.flashes) {
      const age = (now - f.at) / 700;
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = GRADE_COLOR[f.grade] || '#fff';
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.fillText(f.grade, headX + 8, this.yAt(f.lane) - 14 - age * 12);
      ctx.globalAlpha = 1;
    }

    if (!this.chart || !this.chart.notes.length) {
      ctx.fillStyle = '#9aa7b6';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('No chart yet. Drop in a track or try the demo groove.', this.labelW + 16, h - 14);
    }
  }
}
