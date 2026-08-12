// input.js — a real kit if you have one, your keyboard if you do not.
//
// The core loop is never gated behind owning hardware. Web MIDI is a bonus on
// top of a keyboard and four on screen pads that work with a thumb.
//
// Latency calibration lives here too. An uncalibrated play along tells good
// drummers they are bad, because the browser's output delay is counted as their
// timing error. The number is measured once, kept, and can be measured again.

import { FROM_GM } from './midi.js';

// Space used to be the kick. It is the transport now, because every other piece
// of music software on the machine starts and stops with it and a hand reaches
// for it without thinking. The kick moved one key along from the tom, so the
// four lanes sit under the fingers as D, F, J, K.
export const KEY_MAP = {
  KeyD: 'hat',
  KeyF: 'snare',
  KeyJ: 'tom',
  KeyK: 'kick',
};

const CAL_KEY = 'playalong.calibration.v1';
// Learned pad mappings live on the device, because they are a fact about the
// kit plugged into THIS machine and mean nothing on anyone else's.
const NOTE_MAP_KEY = 'playalong.notemap.v1';

export class InputHub {
  constructor() {
    this.listeners = new Set();
    this.midiAccess = null;
    this.midiInputs = [];
    this.midiState = 'not asked';
    this.noteMap = this.loadNoteMap();
    this.unmapped = new Map();          // note number -> how many times it arrived
    this.offsetMs = this.loadOffset();
    this._down = new Set();
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
  }

  loadOffset() {
    const v = parseFloat(localStorage.getItem(CAL_KEY));
    return isFinite(v) ? v : 0;
  }

  loadNoteMap() {
    try {
      const m = JSON.parse(localStorage.getItem(NOTE_MAP_KEY) || '{}');
      return m && typeof m === 'object' ? m : {};
    } catch { return {}; }
  }

  setOffset(ms) {
    this.offsetMs = ms;
    localStorage.setItem(CAL_KEY, String(ms));
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** @param {{lane:string, vel:number, source:string}} e */
  emit(e) { for (const fn of this.listeners) fn(e); }

  attachKeyboard(target = window) {
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
  }

  detachKeyboard(target = window) {
    target.removeEventListener('keydown', this._onKeyDown);
    target.removeEventListener('keyup', this._onKeyUp);
  }

  _onKeyDown(ev) {
    const tag = ev.target && ev.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const lane = KEY_MAP[ev.code];
    if (!lane) return;
    ev.preventDefault();
    if (this._down.has(ev.code)) return;   // held key must not machine gun
    this._down.add(ev.code);
    this.emit({ lane, vel: 0.85, source: 'key' });
  }

  _onKeyUp(ev) { this._down.delete(ev.code); }

  /** Called by the on screen pads. */
  pad(lane) { this.emit({ lane, vel: 0.85, source: 'pad' }); }

  async enableMidi() {
    if (!navigator.requestMIDIAccess) {
      this.midiState = 'this browser has no Web MIDI, the keyboard and pads still work';
      return false;
    }
    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      this.midiState = 'permission was refused, the keyboard and pads still work';
      return false;
    }
    const wire = () => {
      this.midiInputs = [...this.midiAccess.inputs.values()];
      for (const inp of this.midiInputs) inp.onmidimessage = (m) => this._onMidi(m);
      this.midiState = this.midiInputs.length
        ? `connected, ${this.midiInputs.map((i) => i.name).join(', ')}`
        : 'no MIDI device is plugged in yet';
    };
    wire();
    this.midiAccess.onstatechange = wire;
    return true;
  }

  _onMidi(msg) {
    const [status, d1, d2] = msg.data;
    if ((status & 0xf0) !== 0x90 || d2 === 0) return;
    const lane = this.noteMap[d1] || FROM_GM[d1];
    if (!lane) {
      // An unmapped pad used to be dropped in silence, which is the same dead
      // end as a file that loads to nothing: you hit the drum, the app does
      // nothing, and there is no way to tell a broken app from a wrong cable.
      //
      // The General MIDI table below covers a stock Alesis or Roland kit, but
      // "MIDI drum kit" is not a standard. Pad controllers, older modules and
      // anything home-built (Vi's own Arduino kit included) send whatever notes
      // they were told to. So an unknown note is reported, not swallowed, and
      // it can be claimed by a lane through learn().
      this.unmapped.set(d1, (this.unmapped.get(d1) || 0) + 1);
      this.emit({ lane: null, vel: d2 / 127, source: 'midi', note: d1, unmapped: true });
      return;
    }
    this.emit({ lane, vel: d2 / 127, source: 'midi', note: d1 });
  }

  /** Point a note number at a lane, so an unrecognised pad becomes usable. */
  learn(note, lane) {
    this.noteMap[note] = lane;
    this.unmapped.delete(note);
    try { localStorage.setItem(NOTE_MAP_KEY, JSON.stringify(this.noteMap)); } catch {}
  }

  /** The notes that have arrived and gone nowhere, most-hit first. */
  unmappedNotes() {
    return [...this.unmapped.entries()].sort((a, b) => b[1] - a[1]).map(([note, hits]) => ({ note, hits }));
  }
}

/**
 * Latency calibration. Plays a steady click and records where your taps landed
 * relative to it. The median of those offsets is what gets subtracted from
 * every judgement afterwards.
 */
export class Calibrator {
  constructor(player, hub) {
    this.player = player;
    this.hub = hub;
    this.taps = [];
    this.clicks = [];
    this.running = false;
  }

  /** @param {number} beats how many clicks to play @param {number} bpm */
  async run(beats = 8, bpm = 100, onProgress) {
    const ctx = this.player.ensureCtx();
    const period = 60 / bpm;
    const start = ctx.currentTime + 0.8;
    this.taps = [];
    this.clicks = [];
    this.running = true;
    for (let i = 0; i < beats; i++) {
      const at = start + i * period;
      this.clicks.push(at);
      this.player.click(at, i % 4 === 0);
    }
    const off = this.hub.on(() => {
      if (!this.running) return;
      this.taps.push(ctx.currentTime);
      if (onProgress) onProgress(this.taps.length, beats);
    });
    await new Promise((res) => setTimeout(res, (beats * period + 0.9) * 1000));
    this.running = false;
    off();
    return this.result();
  }

  result() {
    const offsets = [];
    for (const t of this.taps) {
      let best = Infinity;
      for (const c of this.clicks) if (Math.abs(t - c) < Math.abs(best)) best = t - c;
      if (Math.abs(best) < 0.25) offsets.push(best * 1000);
    }
    if (offsets.length < 3) return { ok: false, taps: this.taps.length, usable: offsets.length, offsetMs: 0, spreadMs: 0 };
    offsets.sort((a, b) => a - b);
    const mid = offsets.length % 2
      ? offsets[(offsets.length - 1) >> 1]
      : 0.5 * (offsets[offsets.length / 2 - 1] + offsets[offsets.length / 2]);
    const spread = offsets[offsets.length - 1] - offsets[0];
    return { ok: true, taps: this.taps.length, usable: offsets.length, offsetMs: +mid.toFixed(1), spreadMs: +spread.toFixed(1) };
  }
}

/** Judgement windows, in seconds, after calibration is applied. */
export const WINDOWS = [
  ['perfect', 0.025, 100],
  ['great', 0.05, 60],
  ['good', 0.09, 30],
];
export const MISS_WINDOW = 0.14;

export class Scorer {
  constructor() { this.reset(); }

  reset() {
    this.score = 0;
    this.combo = 0;
    this.best = 0;
    this.counts = { perfect: 0, great: 0, good: 0, miss: 0 };
    this.judged = new Set();
    this.offsets = [];
    this.last = null;
  }

  /**
   * @param {import('./chart.js').Chart} chart
   * @param {string} lane
   * @param {number} t the moment of the hit, already latency corrected
   */
  hit(chart, lane, t) {
    let best = null, bestD = Infinity;
    for (const n of chart.notes) {
      if (n.lane !== lane || this.judged.has(n.id)) continue;
      const d = t - n.t;
      if (Math.abs(d) < Math.abs(bestD)) { bestD = d; best = n; }
    }
    if (!best || Math.abs(bestD) > MISS_WINDOW) {
      this.combo = 0;
      this.counts.miss++;
      this.last = { grade: 'miss', delta: null, lane };
      return this.last;
    }
    this.judged.add(best.id);
    this.offsets.push(bestD);
    let grade = 'good', points = 30;
    for (const [g, w, p] of WINDOWS) if (Math.abs(bestD) <= w) { grade = g; points = p; break; }
    this.combo++;
    this.best = Math.max(this.best, this.combo);
    this.score += points + Math.min(50, this.combo) * 2;
    this.counts[grade]++;
    this.last = { grade, delta: bestD, lane, id: best.id };
    return this.last;
  }

  /** Notes that sailed past without being played. */
  sweep(chart, now) {
    for (const n of chart.notes) {
      if (this.judged.has(n.id)) continue;
      if (now - n.t > MISS_WINDOW) {
        this.judged.add(n.id);
        this.counts.miss++;
        this.combo = 0;
      }
    }
  }

  /** Are you consistently early or late, in milliseconds. */
  bias() {
    if (this.offsets.length < 4) return null;
    const s = [...this.offsets].sort((a, b) => a - b);
    const mid = s.length % 2 ? s[(s.length - 1) >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]);
    return +(mid * 1000).toFixed(1);
  }

  accuracy() {
    const total = this.counts.perfect + this.counts.great + this.counts.good + this.counts.miss;
    if (!total) return 0;
    return (this.counts.perfect + this.counts.great * 0.7 + this.counts.good * 0.4) / total;
  }
}
