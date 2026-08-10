// analyse.js — audio to drum chart, with no model download and no server.
//
// The whole pipeline is deliberately classic DSP rather than machine learning.
// A Demucs-class separator is tens of megabytes of weights before a phone plays
// a single note, and it would sink this build. Spectral flux onset detection
// plus band classification gets a playable chart in a couple of seconds, and
// where it is unsure it says so instead of inventing certainty.
//
// Everything here is pure: Float32Array in, plain objects out. No DOM, no Web
// Audio, so `bun test` can run it against a synthetic click track with known
// hit positions and check the numbers.

import { magSpectrum, hann } from './fft.js';

export const LANES = ['hat', 'snare', 'tom', 'kick'];

/** Default analysis settings. Exposed so the UI can offer a sensitivity slider. */
export const DEFAULTS = {
  frame: 1024,          // ~23ms at 44.1k, short enough to keep drum transients sharp
  hop: 256,             // ~5.8ms between flux samples
  minGapMs: 40,         // two hits closer than this are one hit
  medianWin: 21,        // frames either side used for the adaptive threshold
  thresholdMult: 1.55,  // how far above the local median a peak must sit
  thresholdBias: 0.12,  // plus a fraction of the global mean, kills silence chatter
  floorFrac: 0.05,      // and an absolute floor against the loudest hit in the track
  sensitivity: 1,       // user facing multiplier, >1 finds more hits
  minBpm: 60,
  maxBpm: 200,
  div: 4,               // grid subdivisions per beat (4 = sixteenth notes)
};

/** Mix any number of channels down to one Float32Array. */
export function downmix(channels, length) {
  const out = new Float32Array(length);
  const n = channels.length;
  for (const ch of channels) for (let i = 0; i < length; i++) out[i] += ch[i] / n;
  return out;
}

/** Convenience wrapper for a decoded Web Audio AudioBuffer. */
export function analyseBuffer(audioBuffer, opts = {}) {
  const chans = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) chans.push(audioBuffer.getChannelData(c));
  const mono = chans.length === 1 ? chans[0] : downmix(chans, audioBuffer.length);
  return analyse(mono, audioBuffer.sampleRate, opts);
}

// ---------------------------------------------------------------- onset stage

/**
 * Short time magnitude spectra, log compressed.
 * Log compression stops one loud bass note from drowning out every hi-hat.
 */
function spectrogram(x, o) {
  const { frame, hop } = o;
  const w = hann(frame);
  const bins = (frame >> 1) + 1;
  const frames = Math.max(0, Math.floor((x.length - frame) / hop) + 1);
  const mags = new Float64Array(frames * bins);
  const buf = new Float64Array(frame);
  const spec = new Float64Array(bins);
  for (let t = 0; t < frames; t++) {
    const off = t * hop;
    for (let i = 0; i < frame; i++) buf[i] = x[off + i] * w[i];
    magSpectrum(buf, spec);
    for (let k = 0; k < bins; k++) mags[t * bins + k] = Math.log1p(500 * spec[k]);
  }
  return { mags, frames, bins };
}

/** Rectified spectral flux, the sum of every bin that got louder since last frame. */
function spectralFlux(sg) {
  const { mags, frames, bins } = sg;
  const flux = new Float64Array(frames);
  for (let t = 1; t < frames; t++) {
    let s = 0;
    const a = t * bins, b = (t - 1) * bins;
    for (let k = 1; k < bins; k++) {
      const d = mags[a + k] - mags[b + k];
      if (d > 0) s += d;
    }
    flux[t] = s;
  }
  return flux;
}

function median(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) >> 1] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
}

/**
 * Adaptive peak picking. A fixed threshold either misses the quiet passage or
 * fires constantly in the loud one, so the bar is a rolling local median.
 */
function pickPeaks(flux, o, sr, maxFlux) {
  const { hop, medianWin, thresholdMult, thresholdBias, minGapMs } = o;
  const sens = o.sensitivity || 1;
  const n = flux.length;
  let globalMean = 0;
  for (let i = 0; i < n; i++) globalMean += flux[i];
  globalMean /= Math.max(1, n);
  // A decaying kick sweeps its energy downward, which keeps producing real
  // positive flux long after the hit. In near silence the rolling median is
  // tiny, so without a floor tied to the loudest hit in the track those ripples
  // all become notes.
  const floor = (maxFlux * (o.floorFrac || 0)) / sens;

  const minGapFrames = Math.max(1, Math.round((minGapMs / 1000) * sr / hop));
  const peaks = [];
  const win = [];
  for (let t = 1; t < n - 1; t++) {
    // local maximum first, it is cheap
    if (!(flux[t] > flux[t - 1] && flux[t] >= flux[t + 1])) continue;
    const lo = Math.max(0, t - medianWin), hi = Math.min(n - 1, t + medianWin);
    win.length = 0;
    for (let i = lo; i <= hi; i++) win.push(flux[i]);
    win.sort((a, b) => a - b);
    const thr = Math.max(floor, (median(win) * thresholdMult + globalMean * thresholdBias) / sens);
    if (flux[t] < thr) continue;
    // a slightly wider "is this the local champion" check kills doubled triggers
    let best = true;
    for (let i = Math.max(1, t - 2); i <= Math.min(n - 2, t + 2); i++) if (flux[i] > flux[t]) { best = false; break; }
    if (!best) continue;
    if (peaks.length && t - peaks[peaks.length - 1] < minGapFrames) {
      if (flux[t] > flux[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = t;
      continue;
    }
    peaks.push(t);
  }
  return peaks;
}

/**
 * A flux frame only tells you which 23ms window the transient landed in. Walk
 * the raw samples around it and find where the envelope actually takes off, so
 * the reported time is close to the real attack rather than to a frame edge.
 */
function refineOnset(x, sr, frameIndex, o) {
  const { hop, frame } = o;
  const start = Math.max(0, frameIndex * hop - hop * 2);
  const end = Math.min(x.length, frameIndex * hop + frame);
  if (end - start < 8) return start / sr;
  // A 1ms rms envelope of the DIFFERENCED signal. Straight rms is dominated by
  // whatever bass note is sustaining, and a 55Hz sine swings a 1ms window from
  // nothing to full scale every 18ms, so the search kept locking onto the last
  // bass peak before the hit and reported every note about 26ms early. The
  // difference is a cheap high pass, and a drum attack is broadband while a
  // bass note is not.
  const step = Math.max(1, Math.round(sr / 1000));
  let peak = 0, floor = Infinity;
  const env = [];
  for (let i = start; i + step <= end; i += step) {
    let s = 0;
    for (let j = i; j < i + step; j++) { const d = x[j] - (x[j - 1] || 0); s += d * d; }
    const v = Math.sqrt(s / step);
    env.push(v);
    if (v > peak) peak = v;
    if (v < floor) floor = v;
  }
  if (peak <= 0) return (frameIndex * hop) / sr;
  // Measure the rise above whatever is already playing, not above zero. With a
  // bass note droning underneath, an absolute threshold never sees silence and
  // the search walks back to the start of the window, reporting every hit early.
  const target = floor + (peak - floor) * 0.25;
  const quiet = floor + (peak - floor) * 0.08;
  let idx = 0;
  for (let i = 0; i < env.length; i++) if (env[i] >= target) { idx = i; break; }
  const stop = Math.max(0, idx - 12);          // never back off more than 12ms
  while (idx > stop && env[idx - 1] > quiet) idx--;
  return (start + idx * step) / sr;
}

// ------------------------------------------------------------ classify stage

const BANDS = [
  ['sub', 20, 110],
  ['low', 110, 260],
  ['lowmid', 260, 900],
  ['mid', 900, 3000],
  ['high', 3000, 8000],
  ['air', 8000, 16000],
];

function specAt(x, sr, startSample, size, w) {
  const start = Math.max(0, Math.min(Math.max(0, x.length - size), Math.round(startSample)));
  const buf = new Float64Array(size);
  for (let i = 0; i < size; i++) buf[i] = (x[start + i] || 0) * w[i];
  const spec = new Float64Array((size >> 1) + 1);
  magSpectrum(buf, spec);
  return spec;
}

/**
 * Band energies plus spectral centroid for one onset.
 *
 * Measured as the RISE over the moment before the hit, not as the absolute
 * spectrum. A sustained bass note or a held synth pad sits in the window too,
 * and against the raw spectrum every hit in a bass heavy track looks like a
 * kick. Subtracting the previous window leaves only what the stick added.
 */
export function timbre(x, sr, atSample, size = 2048) {
  const w = hann(size);
  const post = specAt(x, sr, atSample, size, w);
  const pre = specAt(x, sr, atSample - size - Math.round(sr * 0.003), size, w);
  const bins = post.length;
  const spec = new Float64Array(bins);
  for (let k = 0; k < bins; k++) spec[k] = Math.max(0, post[k] - pre[k] * 0.9);
  const hz = sr / size;
  const e = {};
  let total = 0, cenNum = 0, cenDen = 0;
  for (const [name, lo, hi] of BANDS) {
    let s = 0;
    const k0 = Math.max(1, Math.round(lo / hz)), k1 = Math.min(bins - 1, Math.round(hi / hz));
    for (let k = k0; k <= k1; k++) s += spec[k] * spec[k];
    e[name] = s;
    total += s;
  }
  const kMax = Math.min(bins - 1, Math.round(16000 / hz));
  for (let k = 1; k <= kMax; k++) { const m = spec[k]; cenNum += m * k * hz; cenDen += m; }
  const centroid = cenDen > 0 ? cenNum / cenDen : 0;
  const t = total || 1e-12;
  return {
    centroid,
    total,
    r: Object.fromEntries(BANDS.map(([n]) => [n, e[n] / t])),
  };
}

/**
 * Kick, snare and hi-hat live in genuinely different parts of the spectrum, so
 * three soft scores separate them well. Toms and cymbals do not separate
 * cleanly, which is why nothing here ever claims a tom. The editor is the fix.
 */
export function classify(tb) {
  const r = tb.r;
  const c = tb.centroid;
  const lowE = r.sub + r.low;         // below 260Hz, where a kick lives
  const midE = r.lowmid + r.mid;      // 260Hz to 3kHz, snare shell and body
  const hiE = r.high + r.air;         // above 3kHz, cymbals and snare wires

  // The useful discriminator for a snare is not brightness on its own, it is
  // having energy in the middle AND up top at the same time. A hi-hat has
  // almost nothing under 3kHz, a kick has almost nothing over it.
  const both = Math.min(1, midE * 2.2) * Math.min(1, hiE * 3);
  const scores = {
    kick: lowE * 2.8 + bump(c, 0, 350) * 1.0 - hiE * 2.2,
    snare: both * 3.0 + midE * 1.2 - lowE * 1.2,
    hat: hiE * 2.6 + bump(c, 4500, 14000) * 1.0 - (lowE + midE) * 4.0,
  };
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [lane, top] = entries[0];
  const second = entries[1][1];
  const spread = Math.max(1e-6, Math.abs(top) + Math.abs(second));
  const conf = Math.max(0.05, Math.min(1, (top - second) / spread * 1.6));
  return { lane, conf, scores };
}

/** 1 inside [lo,hi], falling off smoothly outside it. */
function bump(x, lo, hi) {
  if (x >= lo && x <= hi) return 1;
  const d = x < lo ? (lo - x) / lo : (x - hi) / hi;
  return Math.max(0, 1 - d);
}

// ---------------------------------------------------------------- tempo stage

/**
 * Tempo from autocorrelating the onset envelope, with a prior around 120 so a
 * groove does not get reported at half or double speed just because the maths
 * likes the longer lag.
 */
export function estimateTempo(flux, sr, o) {
  const fps = sr / o.hop;
  const n = flux.length;
  if (n < fps * 2) return { bpm: 0, period: 0, confidence: 0 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += flux[i];
  mean /= n;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.max(0, flux[i] - mean);

  const minLag = Math.floor((60 / o.maxBpm) * fps);
  const maxLag = Math.ceil((60 / o.minBpm) * fps);
  let best = -1, bestLag = 0;
  const raw = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    s /= (n - lag);
    // log normal prior centred on 0.5s per beat, that is 120 bpm
    const secs = lag / fps;
    const w = Math.exp(-0.5 * (Math.log2(secs / 0.5) / 0.9) ** 2);
    raw[lag] = s * w;
    if (raw[lag] > best) { best = raw[lag]; bestLag = lag; }
  }
  // Prefer a related lag inside the comfortable range if it scores nearly as well.
  for (const mult of [0.5, 2]) {
    const cand = Math.round(bestLag * mult);
    if (cand >= minLag && cand <= maxLag && raw[cand] > best * 0.92) { best = raw[cand]; bestLag = cand; }
  }
  let sum = 0, cnt = 0;
  for (let lag = minLag; lag <= maxLag; lag++) { sum += raw[lag]; cnt++; }
  const confidence = cnt && sum > 0 ? Math.min(1, (best / (sum / cnt)) / 6) : 0;
  const period = bestLag / fps;
  return { bpm: 60 / period, period, confidence };
}

/** Slide the beat grid until it lines up with the loud onsets. */
export function estimatePhase(hits, period, duration) {
  if (!hits.length || !period) return 0;
  const steps = 64;
  let bestScore = -1, bestPhase = 0;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * period;
    let score = 0;
    for (const h of hits) {
      const off = ((h.t - phase) % period + period) % period;
      const d = Math.min(off, period - off) / (period / 2);
      score += h.strength * (1 - d) * (h.lane === 'kick' || h.lane === 'snare' ? 1.5 : 1);
    }
    if (score > bestScore) { bestScore = score; bestPhase = phase; }
  }
  // Nudge the phase to the nearest strong onset so the count-in feels right.
  return bestPhase;
}

// -------------------------------------------------------------------- public

/**
 * @param {Float32Array} x mono samples
 * @param {number} sr sample rate
 * @returns {{bpm,period,phase,div,duration,hits,tempoConfidence,settings}}
 */
export function analyse(x, sr, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const sg = spectrogram(x, o);
  const flux = spectralFlux(sg);
  let maxFlux = 1e-9;
  for (let i = 0; i < flux.length; i++) if (flux[i] > maxFlux) maxFlux = flux[i];
  const peaks = pickPeaks(flux, o, sr, maxFlux);

  const hits = [];
  for (const p of peaks) {
    const t = refineOnset(x, sr, p, o);
    const tb = timbre(x, sr, t * sr - Math.round(sr * 0.002));
    const { lane, conf, scores } = classify(tb);
    const strength = Math.min(1, flux[p] / maxFlux);
    hits.push({
      t,
      lane,
      conf: +(conf * 0.6 + Math.min(1, strength * 2) * 0.4).toFixed(3),
      vel: Math.max(0.15, Math.min(1, Math.sqrt(strength))),
      strength: +strength.toFixed(3),
      centroid: Math.round(tb.centroid),
      scores,
    });
  }

  const tempo = estimateTempo(flux, sr, o);
  const phase = estimatePhase(hits, tempo.period, x.length / sr);

  // Quantise against the grid, and record how far off each hit was. That number
  // is shown in the editor, it is not used to move anything without consent.
  const step = tempo.period ? tempo.period / o.div : 0;
  for (const h of hits) {
    if (!step) { h.tq = h.t; h.dev = 0; h.gridConf = 0; continue; }
    const k = Math.round((h.t - phase) / step);
    h.tq = phase + k * step;
    h.dev = h.t - h.tq;
    h.gridConf = Math.max(0, 1 - Math.abs(h.dev) / (step / 2));
  }

  return {
    bpm: tempo.bpm ? +tempo.bpm.toFixed(2) : 0,
    period: tempo.period,
    phase,
    div: o.div,
    duration: x.length / sr,
    tempoConfidence: +tempo.confidence.toFixed(3),
    hits,
    settings: o,
  };
}
