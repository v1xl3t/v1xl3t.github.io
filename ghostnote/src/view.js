// view.js — the scrolling chart, and the editor, which are the same picture.
//
// Lanes run left to right as rows, notes travel toward a fixed play head. That
// choice is deliberate. A vertical falling highway has to be rebuilt as a
// separate screen before anyone can edit it, whereas this one becomes an editor
// simply by pausing, so the chart you are correcting is the chart you played.

import { LANES, LANE_LABEL } from './chart.js';

const LANE_COLOUR = {
  hat: '#8fd3ff',
  snare: '#ffd479',
  tom: '#c9a2ff',
  kick: '#7ee787',
};

const GRADE_COLOUR = {
  perfect: '#7ee787',
  great: '#8fd3ff',
  good: '#ffd479',
  miss: '#ff8f8f',
};

export class Highway {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.chart = null;
    this.time = 0;
    this.pxPerSec = 190;
    this.mode = 'play';
    this.selectedId = null;
    this.flashes = [];
    this.showGrid = true;
    this.labelW = 62;
    this.headFrac = 0.3;
    this.onadd = null;
    this.onselect = null;
    this.onmove = null;
    this.onscrub = null;
    this._drag = null;
    this._bind();
  }

  get laneH() { return Math.max(38, Math.min(64, (this.canvas.clientHeight - 26) / LANES.length)); }
  get headX() { return this.labelW + Math.max(60, (this.canvas.clientWidth - this.labelW) * this.headFrac); }

  timeAt(x) { return this.time + (x - this.headX) / this.pxPerSec; }
  xAt(t) { return this.headX + (t - this.time) * this.pxPerSec; }
  laneAt(y) {
    const i = Math.floor((y - 22) / this.laneH);
    return LANES[Math.max(0, Math.min(LANES.length - 1, i))];
  }
  yAt(lane) { return 22 + LANES.indexOf(lane) * this.laneH + this.laneH / 2; }

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
      c.setPointerCapture(ev.pointerId);
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
    c.addEventListener('pointercancel', () => { this._drag = null; });
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
      ctx.fillStyle = LANE_COLOUR[lane];
      ctx.fillRect(0, y, 4, laneH);
      ctx.fillStyle = '#e8edf3';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(LANE_LABEL[lane], 10, y + laneH / 2);
    });

    // grid
    if (this.showGrid && this.chart && this.chart.period) {
      const { period, phase } = this.chart;
      const step = period / (this.chart.div || 4);
      const t0 = this.timeAt(this.labelW), t1 = this.timeAt(w);
      let k = Math.floor((t0 - phase) / step) - 1;
      const top = 22, bot = 22 + LANES.length * laneH;
      for (let t = phase + k * step; t < t1 + step; t += step, k++) {
        const x = this.xAt(t);
        if (x < this.labelW) continue;
        const beat = Math.round((t - phase) / period * 4) / 4;
        const isBeat = Math.abs((t - phase) / period - Math.round((t - phase) / period)) < 1e-6;
        const isBar = isBeat && ((Math.round((t - phase) / period) % 4) + 4) % 4 === 0;
        ctx.strokeStyle = isBar ? '#5b6675' : isBeat ? '#39424f' : '#242c36';
        ctx.lineWidth = isBar ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, top);
        ctx.lineTo(Math.round(x) + 0.5, bot);
        ctx.stroke();
        if (isBar) {
          const bar = Math.round((t - phase) / period / 4) + 1;
          ctx.fillStyle = '#9aa7b6';
          ctx.font = '11px system-ui, sans-serif';
          ctx.fillText(String(bar), x + 4, 11);
        }
      }
    }

    // notes
    if (this.chart) {
      const t0 = this.timeAt(this.labelW - 40), t1 = this.timeAt(w + 40);
      for (const n of this.chart.notes) {
        if (n.t < t0 || n.t > t1) continue;
        const x = this.xAt(n.t), y = this.yAt(n.lane);
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
        ctx.fillStyle = LANE_COLOUR[n.lane] || '#ccc';
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
      ctx.fillStyle = GRADE_COLOUR[f.grade] || '#fff';
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
