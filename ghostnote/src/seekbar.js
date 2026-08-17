// seekbar.js — the loop region, drawn on the bar it actually refers to.
//
// Marking a section used to be Set start, then Set end, then reading a line of
// text to find out what happened. A loop is a thing with a position and a
// length, so it belongs drawn on the position bar, with a handle at each end
// you can grab.
//
// The rail is its own strip sitting directly above the position slider rather
// than an overlay on top of it. A handle laid over a range input steals the
// drag that was meant to scrub, and a scrub that sometimes moves the loop
// instead is worse than the two buttons this replaces. Same width, same left
// edge, so the two read as one control.
//
// Both handles are real buttons with slider semantics, so arrow keys move them
// and a screen reader reads out where they are. Dragging is a bonus on top of
// that, never the only way in.

const MIN_LOOP = 0.15;

/** Minutes and seconds, the way the clock says it. */
function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export class LoopRail {
  /**
   * @param {HTMLElement} el the rail element, which owns the handles
   * @param {{onchange?:(loop:{a:number,b:number}|null)=>void}} opts
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.fill = el.querySelector('.loopfill');
    this.head = el.querySelector('.loophead');
    this.handles = {
      a: el.querySelector('.loophandle[data-end="a"]'),
      b: el.querySelector('.loophandle[data-end="b"]'),
    };
    this.duration = 0;
    this.loop = null;
    this.time = 0;
    this.onchange = opts.onchange || null;
    this._drag = null;
    // Where the handles sit while no loop exists. Parking them at the two ends
    // means there is always something to grab, and grabbing one is how a loop
    // gets made in the first place.
    this._park = { a: 0, b: 0 };
    this._bind();
    this.refresh();
  }

  get armed() { return !!(this.loop && this.loop.b > this.loop.a); }

  /** Where each end currently sits, whether or not a loop is set. */
  ends() {
    if (this.armed) return { a: this.loop.a, b: this.loop.b };
    return { a: this._park.a, b: this._park.b || this.duration };
  }

  setDuration(d) {
    this.duration = isFinite(d) && d > 0 ? d : 0;
    if (!this.armed) this._park = { a: 0, b: this.duration };
    this.refresh();
  }

  /** Set the region from outside, from the buttons or from a loaded track. */
  setLoop(loop) {
    this.loop = loop && loop.b > loop.a ? { a: loop.a, b: loop.b } : null;
    if (!this.loop) this._park = { a: 0, b: this.duration };
    this.refresh();
  }

  /** Move the play head marker. Called every frame, so it stays cheap. */
  setTime(t) {
    this.time = t;
    if (!this.head || !this.duration) return;
    const pct = Math.max(0, Math.min(1, t / this.duration)) * 100;
    if (this._headPct !== pct) {
      this._headPct = pct;
      this.head.style.left = pct + '%';
    }
  }

  _pctOf(t) {
    if (!this.duration) return 0;
    return Math.max(0, Math.min(1, t / this.duration)) * 100;
  }

  refresh() {
    const { a, b } = this.ends();
    const pa = this._pctOf(a), pb = this._pctOf(b);
    if (this.fill) {
      this.fill.style.left = pa + '%';
      this.fill.style.width = Math.max(0, pb - pa) + '%';
    }
    this.el.dataset.armed = String(this.armed);
    for (const end of ['a', 'b']) {
      const h = this.handles[end];
      if (!h) continue;
      const t = end === 'a' ? a : b;
      h.style.left = this._pctOf(t) + '%';
      h.setAttribute('aria-valuemin', '0');
      h.setAttribute('aria-valuemax', String(Math.round(this.duration || 0)));
      h.setAttribute('aria-valuenow', String(Math.round(t)));
      h.setAttribute('aria-valuetext', this.armed
        ? `${end === 'a' ? 'Loop start' : 'Loop end'} at ${fmt(t)}`
        : `${end === 'a' ? 'Loop start' : 'Loop end'}, no loop set yet, at ${fmt(t)}`);
    }
  }

  /** Time under a client x position, clamped to the track. */
  timeAtClientX(x) {
    const r = this.el.getBoundingClientRect();
    if (!r.width || !this.duration) return 0;
    const f = (x - r.left) / r.width;
    return Math.max(0, Math.min(1, f)) * this.duration;
  }

  /**
   * Move one end. The two ends are kept in order here rather than at the far
   * end of a chain of buttons, so dragging start past end simply swaps which
   * handle you are holding instead of producing an inverted region that
   * silently does nothing.
   */
  moveEnd(end, t, commit = true) {
    if (!this.duration) return;
    const cur = this.ends();
    let a = end === 'a' ? t : cur.a;
    let b = end === 'b' ? t : cur.b;
    if (a > b) { const s = a; a = b; b = s; }
    a = Math.max(0, Math.min(this.duration, a));
    b = Math.max(0, Math.min(this.duration, b));
    if (b - a < MIN_LOOP) {
      // Too short to be a loop. Hold the position, do not arm anything, and let
      // the caller say so in words if it wants to.
      this._park = { a, b };
      this.loop = null;
      this.refresh();
      if (commit && this.onchange) this.onchange(null, { tooShort: true });
      return;
    }
    this.loop = { a, b };
    this.refresh();
    if (commit && this.onchange) this.onchange({ a, b }, {});
  }

  _bind() {
    for (const end of ['a', 'b']) {
      const h = this.handles[end];
      if (!h) continue;
      h.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        // Same reasoning as the chart canvas. A capture that will not take is
        // not a reason to drop the drag on the floor.
        try { h.setPointerCapture(ev.pointerId); } catch { /* carry on without it */ }
        this._drag = { end, id: ev.pointerId };
      });
      h.addEventListener('pointermove', (ev) => {
        if (!this._drag || this._drag.id !== ev.pointerId) return;
        // Live feedback while the finger is down, committed on release. A
        // half-dragged loop should look right without every frame of it being
        // announced to the rest of the app.
        this.moveEnd(this._drag.end, this.timeAtClientX(ev.clientX), false);
      });
      const done = (ev) => {
        if (!this._drag || this._drag.id !== ev.pointerId) return;
        const e = this._drag.end;
        this._drag = null;
        this.moveEnd(e, this.timeAtClientX(ev.clientX), true);
      };
      h.addEventListener('pointerup', done);
      h.addEventListener('pointercancel', () => { this._drag = null; });
      h.addEventListener('keydown', (ev) => {
        const cur = this.ends()[end];
        const big = ev.shiftKey ? 5 : 1;
        let t = null;
        if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') t = cur - big;
        else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') t = cur + big;
        else if (ev.key === 'Home') t = 0;
        else if (ev.key === 'End') t = this.duration;
        if (t == null) return;
        ev.preventDefault();
        this.moveEnd(end, t, true);
        this.handles[end].focus();
      });
    }
    // Tapping the rail itself moves whichever end is nearer. It is the fastest
    // way to mark a section and it means the rail is not dead space between two
    // small targets.
    this.el.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.loophandle')) return;
      const t = this.timeAtClientX(ev.clientX);
      const { a, b } = this.ends();
      const end = Math.abs(t - a) <= Math.abs(t - b) ? 'a' : 'b';
      this.moveEnd(end, t, true);
    });
  }
}

export { fmt, MIN_LOOP };
