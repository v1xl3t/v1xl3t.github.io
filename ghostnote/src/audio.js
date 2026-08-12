// audio.js — playback, practice tools, and the click.
//
// Playback goes through an <audio> element rather than an AudioBufferSourceNode
// for one specific reason. Slowing a buffer source down drops its pitch, and a
// play along that transposes the song when you practise slowly is useless. A
// media element gives real time stretching through preservesPitch, and it still
// routes into the Web Audio graph so the centre channel trick below can work.
//
// Nothing here uploads anything. The file becomes an object URL in this tab and
// that is as far as it ever travels.

/**
 * Events that mean the element is usable, earliest first.
 *
 * `canplaythrough` is deliberately NOT the one we wait on. It means "the whole
 * file could play without stalling", which a phone will not promise for a file
 * it has decided not to preload, so on mobile it frequently never fires at all.
 * `loadedmetadata` is enough to know duration and to seek.
 */
const EL_READY_EVENTS = ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough'];

/** Encode an AudioBuffer as a 16 bit WAV blob, so the demo groove takes the same path as a dropped file. */
export function bufferToWav(buffer) {
  const chans = buffer.numberOfChannels;
  const len = buffer.length;
  const sr = buffer.sampleRate;
  const data = new ArrayBuffer(44 + len * chans * 2);
  const v = new DataView(data);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + len * chans * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, chans, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * chans * 2, true); v.setUint16(32, chans * 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, len * chans * 2, true);
  let off = 44;
  const ch = [];
  for (let c = 0; c < chans; c++) ch.push(buffer.getChannelData(c));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < chans; c++) {
      const s = Math.max(-1, Math.min(1, ch[c][i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([data], { type: 'audio/wav' });
}

export class Player {
  constructor() {
    this.ctx = null;
    this.el = null;
    this.url = null;
    this.buffer = null;
    this.channels = 0;
    this.duckAmount = 0;
    this.loop = null;          // {a, b} in seconds
    this.metronome = false;
    this.countInBeats = 0;
    this._nextClick = 0;
    this._countingIn = false;
  }

  ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /**
   * Point the player at a blob and decode a copy for analysis.
   *
   * This used to `await` the media element reaching `canplaythrough` before it
   * returned, and that hung the whole app on a phone. Mobile browsers
   * deliberately do NOT preload a media file to completion without a user
   * gesture, so `canplaythrough` often never fires, there was no timeout, and
   * the promise simply never settled. The user picked a file and nothing
   * happened, forever, with the status stuck on "Reading the file".
   *
   * The deeper mistake was the ordering. **Analysis does not need the media
   * element at all** — `decodeAudioData` above has already produced the
   * AudioBuffer that every stage downstream reads. Waiting on the element
   * blocked work that had no dependency on it.
   *
   * So: decode, return, and let the element warm up on its own. `whenPlayable`
   * is there for anything that genuinely needs it.
   *
   * @returns {Promise<AudioBuffer>}
   */
  async load(blob) {
    const ctx = this.ensureCtx();
    const bytes = await blob.arrayBuffer();
    // decodeAudioData detaches the buffer it is given, so hand it a copy
    this.buffer = await ctx.decodeAudioData(bytes.slice(0));
    this.channels = this.buffer.numberOfChannels;

    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    if (!this.el) {
      this.el = new Audio();
      // 'metadata' not 'auto': on mobile the full preload is ignored anyway, and
      // asking for it is what made canplaythrough look reachable when it is not.
      this.el.preload = 'metadata';
      // No crossOrigin. The source is always a same-origin blob: URL, and
      // setting it invites a tainted-media failure for nothing.
    }
    this.el.src = this.url;

    // Never rejects and never hangs. Playback readiness is a nice-to-have, the
    // decoded buffer is the thing that matters, and `play()` will fetch whatever
    // it still needs on demand.
    this.ready = new Promise((res) => {
      let settled = false;
      const finish = (how) => {
        if (settled) return;
        settled = true;
        this.readyVia = how;
        for (const t of EL_READY_EVENTS) this.el.removeEventListener(t, onReady);
        this.el.removeEventListener('error', onError);
        clearTimeout(timer);
        res(how);
      };
      const onReady = (e) => finish(e.type);
      const onError = () => finish('error');
      for (const t of EL_READY_EVENTS) this.el.addEventListener(t, onReady, { once: true });
      this.el.addEventListener('error', onError, { once: true });
      // A phone that never fires any of them still has to reach a usable app.
      const timer = setTimeout(() => finish('timeout'), 4000);
      try { this.el.load(); } catch { finish('error'); }
    });

    this._buildGraph();
    return this.buffer;
  }

  /** Resolves once the element is playable, or the wait gave up. Never rejects. */
  whenPlayable() { return this.ready || Promise.resolve('no-element'); }

  /**
   * Source, then an optional centre cut, then out.
   * The centre cut is the old karaoke trick. Kick and snare are almost always
   * panned dead centre, so subtracting the mid signal pulls most of the drums
   * down and lets you be the drummer. It also pulls down anything else in the
   * middle, usually the lead vocal, which is why the label says so plainly.
   */
  _buildGraph() {
    if (this.src) return;
    const ctx = this.ctx;
    this.src = ctx.createMediaElementSource(this.el);
    this.out = ctx.createGain();

    this.splitter = ctx.createChannelSplitter(2);
    this.merger = ctx.createChannelMerger(2);
    this.midSum = ctx.createGain(); this.midSum.gain.value = 1;
    this.midToOut = ctx.createGain(); this.midToOut.gain.value = 0;   // -duck

    this.src.connect(this.splitter);
    const halfL = ctx.createGain(); halfL.gain.value = 0.5;
    const halfR = ctx.createGain(); halfR.gain.value = 0.5;
    this.splitter.connect(halfL, 0);
    this.splitter.connect(halfR, 1);
    halfL.connect(this.midSum);
    halfR.connect(this.midSum);
    this.midSum.connect(this.midToOut);

    this.splitter.connect(this.merger, 0, 0);
    this.splitter.connect(this.merger, 1, 1);
    this.midToOut.connect(this.merger, 0, 0);
    this.midToOut.connect(this.merger, 0, 1);

    this.merger.connect(this.out);
    this.out.connect(ctx.destination);

    this.clickGain = ctx.createGain();
    this.clickGain.gain.value = 0.5;
    this.clickGain.connect(ctx.destination);
  }

  /** 0 keeps the mix untouched, 1 removes as much of the centre as this trick can. */
  setDuck(amount) {
    this.duckAmount = amount;
    if (this.midToOut) this.midToOut.gain.value = -amount;
  }

  setRate(rate) {
    if (!this.el) return;
    this.el.preservesPitch = true;
    this.el.mozPreservesPitch = true;
    this.el.webkitPreservesPitch = true;
    this.el.playbackRate = rate;
  }

  get rate() { return this.el ? this.el.playbackRate : 1; }
  get time() { return this.el ? this.el.currentTime : 0; }
  set time(t) { if (this.el) this.el.currentTime = Math.max(0, t); }
  get duration() { return this.el && isFinite(this.el.duration) ? this.el.duration : (this.buffer ? this.buffer.duration : 0); }
  get playing() { return !!this.el && !this.el.paused; }

  async play() {
    const ctx = this.ensureCtx();
    if (!this.el) return;
    // A phone starts its AudioContext suspended and only lets you resume inside
    // a real user gesture. Once createMediaElementSource has claimed the
    // element, ALL of its audio goes through the graph, so a context left
    // suspended means silence rather than quiet. Awaiting the resume here, on
    // the tap that started playback, is the one moment it is guaranteed to work.
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* reported below */ } }
    await this.el.play();
  }

  /** True when the browser is still refusing to make sound. Lets the UI say so. */
  get blocked() { return !!this.ctx && this.ctx.state === 'suspended'; }

  pause() { if (this.el) this.el.pause(); }

  seek(t) { this.time = t; }

  /** One short click, scheduled on the audio clock so it does not jitter. */
  click(at, accent = false) {
    const ctx = this.ensureCtx();
    if (!this.clickGain) { this.clickGain = ctx.createGain(); this.clickGain.gain.value = 0.5; this.clickGain.connect(ctx.destination); }
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.5, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    o.connect(g); g.connect(this.clickGain);
    o.start(at); o.stop(at + 0.08);
  }

  /**
   * Count in, then start. Returns a promise that resolves when the music starts.
   */
  async countInThenPlay(beats, period, beatsPerBar = 4, onTick) {
    if (!beats || !period) { await this.play(); return; }
    const ctx = this.ensureCtx();
    const start = ctx.currentTime + 0.15;
    const spb = period / (this.rate || 1);
    // Accent every bar, and a bar is not always four beats. Counting a waltz in
    // as one two three four is its own small way of breaking the track.
    const bpb = Math.max(1, beatsPerBar || 4);
    for (let i = 0; i < beats; i++) this.click(start + i * spb, i % bpb === 0);
    this._countingIn = true;
    const token = {};
    this._countToken = token;
    if (onTick) onTick(beats);
    await new Promise((res) => setTimeout(res, (beats * spb) * 1000 - 20));
    this._countingIn = false;
    // Pressing pause during the count in has to mean pause, not "play anyway
    // in three seconds".
    if (this._countToken !== token) return;
    await this.play();
  }

  cancelCountIn() { this._countToken = null; this._countingIn = false; }

  get countingIn() { return this._countingIn; }

  /** Keep the metronome fed. Call from the frame loop. */
  pumpMetronome(chart) {
    if (!this.metronome || !this.playing || !chart || !chart.period) return;
    const ctx = this.ctx;
    const rate = this.rate || 1;
    const lookahead = 0.25;
    const now = this.time;
    if (!this._nextClick || this._nextClick < now - 0.5) {
      const k = Math.ceil((now - chart.phase) / chart.period);
      this._nextClick = chart.phase + k * chart.period;
    }
    while (this._nextClick < now + lookahead * rate) {
      const when = ctx.currentTime + (this._nextClick - now) / rate;
      const beatIndex = Math.round((this._nextClick - chart.phase) / chart.period);
      const bpb = Math.max(1, chart.beatsPerBar || 4);
      const rel = beatIndex - (chart.barOffset || 0);
      if (when > ctx.currentTime) this.click(when, ((rel % bpb) + bpb) % bpb === 0);
      this._nextClick += chart.period;
    }
  }

  /** Section looping. Call from the frame loop. */
  pumpLoop() {
    if (!this.loop || !this.playing) return;
    const { a, b } = this.loop;
    if (b > a && (this.time >= b || this.time < a - 0.05)) {
      this.time = a;
      this._nextClick = 0;
    }
  }

  destroy() {
    this.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}
