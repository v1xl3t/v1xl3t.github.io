// chart.js — the chart the analyser produced, and every edit you make to it.
//
// The detector will get things wrong. That is not a reason to hide the result,
// it is the reason this file exists. A wrong note you can drag or delete in two
// seconds is fine, a wrong note you cannot touch is what makes people close the
// tab. Everything here is plain data so it saves, loads and exports cleanly.

export const LANES = ['hat', 'snare', 'tom', 'kick'];
export const LANE_LABEL = { hat: 'Hi hat', snare: 'Snare', tom: 'Tom', kick: 'Kick' };

let nextId = 1;

export class Chart {
  constructor(init = {}) {
    this.bpm = init.bpm || 0;
    this.period = init.period || (init.bpm ? 60 / init.bpm : 0);
    this.phase = init.phase || 0;
    this.div = init.div || 4;
    this.duration = init.duration || 0;
    // The meter. Everything that draws a bar line, counts you in, accents a
    // click or stamps a MIDI time signature reads these two, and nothing
    // assumes four any more. barOffset is which beat of the bar beat one is.
    this.beatsPerBar = init.beatsPerBar || 4;
    this.barOffset = init.barOffset || 0;
    this.meterDetected = !!init.meterDetected;
    this.meterConfidence = init.meterConfidence == null ? 0 : init.meterConfidence;
    this.tempoConfidence = init.tempoConfidence == null ? 0 : init.tempoConfidence;
    this.notes = (init.notes || []).map((n) => ({ ...n, id: n.id || nextId++ }));
    this.undoStack = [];
    this.redoStack = [];
    this.onchange = null;
  }

  static fromAnalysis(a) {
    return new Chart({
      bpm: a.bpm,
      period: a.period,
      phase: a.phase,
      div: a.div,
      duration: a.duration,
      beatsPerBar: a.beatsPerBar,
      barOffset: a.barOffset,
      meterDetected: a.meterDetected,
      meterConfidence: a.meterConfidence,
      tempoConfidence: a.tempoConfidence,
      notes: a.hits.map((h) => ({
        id: nextId++,
        t: h.t,
        tq: h.tq,
        lane: h.lane,
        vel: h.vel,
        conf: h.conf,
        gridConf: h.gridConf,
        source: 'auto',
      })),
    });
  }

  get step() { return this.period ? this.period / this.div : 0; }

  /** How long one bar lasts, which is not always four beats. */
  get barLength() { return this.period * this.beatsPerBar; }

  /** The bar number and the beat within it, for any moment in the track. */
  beatAt(t) {
    if (!this.period) return { bar: 1, beat: 1, index: 0 };
    const index = Math.floor((t - this.phase) / this.period + 1e-9);
    const rel = index - this.barOffset;
    const inBar = ((rel % this.beatsPerBar) + this.beatsPerBar) % this.beatsPerBar;
    return { bar: Math.floor(rel / this.beatsPerBar) + 1, beat: inBar + 1, index };
  }

  /**
   * Change the meter by hand. The detector defaults to 4/4 and is only allowed
   * to move off it when it is sure, so this is how anyone disagrees with it.
   */
  setMeter(beatsPerBar, barOffset = this.barOffset) {
    const n = Math.max(1, Math.min(16, Math.round(beatsPerBar) || 4));
    if (n === this.beatsPerBar && barOffset === this.barOffset) return false;
    this.beatsPerBar = n;
    this.barOffset = ((Math.round(barOffset) % n) + n) % n;
    this.changed();
    return true;
  }

  /** Snapshot for undo. Cheap, a chart is a few hundred small objects. */
  snapshot() {
    return JSON.stringify(this.notes);
  }

  begin() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  changed() { if (this.onchange) this.onchange(this); }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.snapshot());
    this.notes = JSON.parse(this.undoStack.pop());
    this.changed();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.snapshot());
    this.notes = JSON.parse(this.redoStack.pop());
    this.changed();
    return true;
  }

  sort() { this.notes.sort((a, b) => a.t - b.t); }

  add(t, lane, vel = 0.8) {
    this.begin();
    const n = { id: nextId++, t: Math.max(0, t), lane, vel, conf: 1, gridConf: 1, source: 'user' };
    n.tq = this.quantiseTime(n.t);
    this.notes.push(n);
    this.sort();
    this.changed();
    return n;
  }

  remove(id) {
    const i = this.notes.findIndex((n) => n.id === id);
    if (i < 0) return false;
    this.begin();
    this.notes.splice(i, 1);
    this.changed();
    return true;
  }

  move(id, t, lane) {
    const n = this.notes.find((x) => x.id === id);
    if (!n) return false;
    this.begin();
    n.t = Math.max(0, t);
    if (lane) n.lane = lane;
    n.tq = this.quantiseTime(n.t);
    n.source = 'user';
    n.conf = 1;
    this.sort();
    this.changed();
    return true;
  }

  quantiseTime(t) {
    const s = this.step;
    if (!s) return t;
    return this.phase + Math.round((t - this.phase) / s) * s;
  }

  /** Snap every note to the grid. One undo step, so it is safe to try. */
  quantiseAll() {
    if (!this.step) return 0;
    this.begin();
    let moved = 0;
    for (const n of this.notes) {
      const q = this.quantiseTime(n.t);
      if (Math.abs(q - n.t) > 1e-6) moved++;
      n.t = q; n.tq = q; n.gridConf = 1;
    }
    this.sort();
    this.changed();
    return moved;
  }

  /** Drop everything the detector was least sure about. */
  dropBelowConfidence(min) {
    this.begin();
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => n.source === 'user' || n.conf >= min);
    this.changed();
    return before - this.notes.length;
  }

  toJSON() {
    return {
      format: 'playalong.chart',
      version: 1,
      bpm: this.bpm,
      period: this.period,
      phase: this.phase,
      div: this.div,
      duration: this.duration,
      beatsPerBar: this.beatsPerBar,
      barOffset: this.barOffset,
      notes: this.notes.map(({ id, ...rest }) => rest),
    };
  }

  static fromJSON(o) {
    if (!o || o.format !== 'playalong.chart') throw new Error('That is not a Play Along chart file.');
    return new Chart(o);
  }

  counts() {
    const c = { hat: 0, snare: 0, tom: 0, kick: 0 };
    for (const n of this.notes) c[n.lane] = (c[n.lane] || 0) + 1;
    return c;
  }

  /** How many notes the detector was not confident about, for the honesty line. */
  unsure(threshold = 0.5) {
    return this.notes.filter((n) => n.source === 'auto' && n.conf < threshold).length;
  }
}
