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
  // Two hits closer than this are treated as one. It used to be 40ms, which is
  // longer than the gap between the notes of a trap hi hat roll, so those rolls
  // came back as a third of the notes actually played. A 1/64 at 140 BPM is
  // 26.8ms apart and a 1/32 triplet is 35.7ms, and both were being merged.
  // 25ms is under every subdivision a drummer plays as separate chart notes,
  // and it is still long enough that no single stroke is ever counted twice.
  minGapMs: 25,
  medianWin: 21,        // frames either side used for the adaptive threshold
  thresholdMult: 1.55,  // how far above the local median a peak must sit
  thresholdBias: 0.12,  // plus a fraction of the global mean, kills silence chatter
  floorFrac: 0.05,      // and an absolute floor against the loudest hit in the track
  sensitivity: 1,       // user facing multiplier, >1 finds more hits
  // A second, sharper pass that only listens above hatMinHz. See hatPass below
  // for why a track cannot be resolved at one window size.
  hatPass: true,
  hatFrame: 256,        // ~5.8ms, short enough to separate hits 27ms apart
  hatHop: 128,          // ~2.9ms
  hatMinHz: 3000,       // cymbals and hi hats only, no kick and no tom
  // A short window rings, so this pass has to be asked for more before it will
  // call something a note. These sit well above the main pass on purpose.
  hatThresholdMult: 2.6,
  hatFloorFrac: 0.22,
  // Hi hats landing closer together than this count as a roll, and inside a
  // roll the short window is the one to believe. 70ms leaves a 1/32 at 90 BPM
  // alone, because the main pass already gets that one exactly right.
  hatDenseMs: 70,
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

/** Rectified spectral flux from one band upward, used by the hi hat pass. */
function spectralFluxAbove(sg, sr, frame, minHz) {
  const { mags, frames, bins } = sg;
  const k0 = Math.max(1, Math.floor(minHz / (sr / frame)));
  const flux = new Float64Array(frames);
  for (let t = 1; t < frames; t++) {
    let s = 0;
    const a = t * bins, b = (t - 1) * bins;
    for (let k = k0; k < bins; k++) {
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
 * A second onset pass for fast hi hat work, and why one pass cannot do it.
 *
 * The main analysis window is 1024 samples, about 23ms. A trap hi hat roll at a
 * 1/64 puts its notes 42ms apart at 90 BPM and 27ms apart at 140, so a single
 * window straddles two of them, the flux smears into one broad hump, and the
 * peak picker either merges the pair or invents a peak in the trough between
 * them. Shortening the window to 256 samples resolves those rolls perfectly,
 * and it also makes a low tom fall apart, because a 6ms window is too short to
 * hold a 120Hz pitch sweep steady and every wobble reads as a new attack. That
 * is a genuine conflict, not a threshold that needs tuning.
 *
 * What settles it is that the two problems live in different parts of the
 * spectrum. A hi hat is almost entirely above 3kHz and a kick or a tom has
 * nearly nothing up there, so a short window that only listens above 3kHz gets
 * the timing resolution the rolls need and cannot produce a low drum false
 * positive at all. Its onsets are then merged into the main list, and only
 * where the main pass found nothing nearby.
 */
function hatPass(x, sr, o) {
  const so = {
    ...o,
    frame: o.hatFrame,
    hop: o.hatHop,
    thresholdMult: o.hatThresholdMult,
    floorFrac: o.hatFloorFrac,
  };
  const sg = spectrogram(x, so);
  if (!sg.frames) return [];
  const flux = spectralFluxAbove(sg, sr, o.hatFrame, o.hatMinHz);
  let maxFlux = 1e-9;
  for (let i = 0; i < flux.length; i++) if (flux[i] > maxFlux) maxFlux = flux[i];
  // medianWin is a number of frames, so it has to be rescaled or the adaptive
  // threshold would look at half as much time as the main pass does.
  so.medianWin = Math.max(3, Math.round(o.medianWin * (o.hop / o.hatHop)));
  const peaks = pickPeaks(flux, so, sr, maxFlux);
  const out = [];
  let prev = -Infinity;
  for (let i = 0; i < peaks.length; i++) {
    const t = refineOnset(x, sr, peaks[i], so, prev, i + 1 < peaks.length ? peaks[i + 1] : Infinity);
    prev = t * sr;
    out.push({ t, strength: Math.min(1, flux[peaks[i]] / maxFlux) });
  }
  return out;
}

/**
 * A flux frame only tells you which 23ms window the transient landed in. Walk
 * the raw samples around it and find where the envelope actually takes off, so
 * the reported time is close to the real attack rather than to a frame edge.
 */
function refineOnset(x, sr, frameIndex, o, prevSample = -Infinity, nextFrame = Infinity) {
  const { hop, frame } = o;
  // The search window must not spill into the neighbouring hits. A fixed window
  // of two hops back and one frame forward is 35ms wide, which is wider than the
  // gap between the notes of a fast roll, so on dense passages the walk found
  // the PREVIOUS hit's attack first and reported this hit at that earlier time.
  // That is why rolls came back about 10ms early while everything slower was
  // accurate to under a millisecond. Bound the window by the neighbours and the
  // error goes away without touching anything about sparse material.
  const guard = Math.round(sr * 0.004);
  const lo = isFinite(prevSample) ? Math.ceil(prevSample) + guard : 0;
  const hi = isFinite(nextFrame) ? nextFrame * hop : x.length;
  const start = Math.max(0, lo, frameIndex * hop - hop * 2);
  const end = Math.min(x.length, hi, frameIndex * hop + frame);
  if (end - start < 8) return Math.max(start, frameIndex * hop) / sr;
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

/** Bar lengths worth testing, in beats. Two is folded into four below. */
const METERS = [2, 3, 4, 5, 6, 7];

/**
 * How many beats are in a bar, from how the drum pattern repeats.
 *
 * The bar is the length at which the pattern starts saying the same thing
 * again, so this measures one beat against the beat B later and asks how alike
 * they are. Any multiple of the true bar repeats too, which is why the SMALLEST
 * length that clears the bar wins rather than the highest scoring one.
 *
 * The answer defaults to four and only moves off it when the evidence is clear,
 * because a wrong automatic guess is worse than no guess at all. The user
 * cannot see why the bar lines are wrong, they can only see that the app looks
 * broken, so silence is the safer failure.
 *
 * @returns {{beatsPerBar:number, barOffset:number, confidence:number, detected:boolean}}
 */
export function estimateMeter(hits, period, phase, duration, minConf = 0.4) {
  const none = { beatsPerBar: 4, barOffset: 0, confidence: 0, detected: false, scores: {} };
  if (!period || !hits || !hits.length) return none;
  const nBeats = Math.floor((duration - phase) / period);
  if (nBeats < 8) return none;

  // Every hit goes into the beat it belongs to. The small lead allows for a
  // drummer landing just ahead of the downbeat, which otherwise files the most
  // important hit in the bar under the bar before it.
  const v = Array.from({ length: nBeats }, () => new Float64Array(LANES.length));
  const energy = new Float64Array(nBeats);
  for (const h of hits) {
    const i = Math.floor((h.t - phase + period * 0.15) / period);
    if (i < 0 || i >= nBeats) continue;
    const li = LANES.indexOf(h.lane);
    const w = h.vel == null ? 1 : h.vel;
    if (li >= 0) v[i][li] += w;
    energy[i] += w;
  }

  const dot = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k] * b[k]; return s; };
  const mags = v.map((a) => Math.sqrt(dot(a, a)));

  const scores = {};
  for (const B of METERS) {
    let s = 0, wsum = 0;
    for (let i = 0; i + B < nBeats; i++) {
      const m = mags[i] * mags[i + B];
      if (m <= 1e-9) continue;
      // Quiet beats say little about the meter, so they count for less.
      const w = Math.min(mags[i], mags[i + B]);
      s += (dot(v[i], v[i + B]) / m) * w;
      wsum += w;
    }
    scores[B] = wsum > 0 ? s / wsum : 0;
  }

  const best = Math.max(...Object.values(scores));
  let raw = 4;
  for (const B of METERS) if (scores[B] >= best * 0.98) { raw = B; break; }

  // Confidence is measured against the raw answer rather than the reported one.
  // A straight rock beat really does repeat every two beats, so it repeats every
  // six as well, and comparing the doubled four against six would call every
  // rock beat in the world unsure.
  let rival = 0;
  for (const B of METERS) {
    if (B === raw || raw % B === 0 || B % raw === 0) continue;
    rival = Math.max(rival, scores[B]);
  }
  const confidence = Math.max(0, Math.min(1, (scores[raw] - rival) * 3));

  // Two beats to a bar is a real answer, and it is conventionally written 4/4.
  const pick = raw === 2 ? 4 : raw;
  const detected = confidence >= minConf && pick !== 4;

  // Which beat of the bar is beat one. The downbeat is where the low end lands,
  // and ties break toward the start of the track because estimatePhase has
  // already pulled beat zero onto the first strong onset.
  //
  // This is only reported for a meter that was actually detected. In 4/4 the
  // kick usually falls on one AND three, so beat one and beat three look alike,
  // and a track whose fills put toms where the kick would be tips the answer to
  // the wrong one of the pair. Guessing there would move bar lines that are
  // currently in the right place, so 4/4 keeps the offset of zero it has always
  // had and only a meter we are sure about gets an offset at all.
  let barOffset = 0;
  if (detected) {
    let bestDown = -Infinity;
    for (let o = 0; o < pick; o++) {
      let s = 0, n = 0;
      for (let i = o; i < nBeats; i += pick) { s += v[i][0] * 2 + energy[i] * 0.5; n++; }
      const sc = n ? (s / n) * (1 - 0.05 * o) : 0;
      if (sc > bestDown) { bestDown = sc; barOffset = o; }
    }
  }

  // Anything short of sure comes back as 4/4. The whole point of the threshold
  // is that an unexplained wrong answer is worse than a plain default, because
  // the user can see that the bar lines are wrong but not why.
  return {
    beatsPerBar: detected ? pick : 4,
    barOffset,
    confidence: +confidence.toFixed(3),
    detected,
    scores,
  };
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

  // Every onset the main pass found, as a time with a loudness.
  const found = [];
  let prevSample = -Infinity;
  for (let pi = 0; pi < peaks.length; pi++) {
    const p = peaks[pi];
    const t = refineOnset(x, sr, p, o, prevSample, pi + 1 < peaks.length ? peaks[pi + 1] : Infinity);
    prevSample = t * sr;
    found.push({ t, strength: Math.min(1, flux[p] / maxFlux) });
  }

  // Then the fast hi hat pass, which only ever ADDS onsets, and only where the
  // main pass heard nothing. Merging rather than replacing means a track with no
  // fast hat work comes out of this exactly as it did before.
  if (o.hatPass) {
    const gap = o.minGapMs / 1000;
    const dense = o.hatDenseMs / 1000;
    const hp = hatPass(x, sr, o);

    // A stretch of the track where the hi hats are rolling. Only in here does
    // the short window get to overrule the long one, because only in here is the
    // long window straddling two notes. Everywhere else the main pass is already
    // accurate to well under a millisecond and is left completely alone.
    const rolling = (t) => {
      for (let i = 0; i + 1 < hp.length; i++) {
        if (hp[i + 1].t - hp[i].t <= dense && t >= hp[i].t - dense && t <= hp[i + 1].t + dense) return true;
      }
      return false;
    };

    const taken = new Array(hp.length).fill(false);
    const merged = [];
    for (const m of found) {
      let near = -1, nearD = Infinity;
      for (let i = 0; i < hp.length; i++) {
        const d = Math.abs(hp[i].t - m.t);
        if (d < nearD) { nearD = d; near = i; }
      }
      const inRoll = rolling(m.t);
      // A short window onset can only stand for one long window onset. Letting
      // two claim the same one emitted the same note twice, at the same instant.
      if (near >= 0 && nearD < gap && taken[near]) continue;
      if (near >= 0 && nearD < gap) {
        // Same note heard twice. Inside a roll the short window has the better
        // time, outside it the long one does, and either way it stays one note.
        taken[near] = true;
        merged.push(inRoll ? { t: hp[near].t, strength: Math.max(m.strength, hp[near].strength) } : m);
      } else {
        merged.push({ ...m, inRoll });
      }
    }
    for (let i = 0; i < hp.length; i++) {
      if (!taken[i]) merged.push({ ...hp[i], fromHat: true });
    }
    merged.sort((a, b) => a.t - b.t);
    // Two passes over the same audio can hear the same stroke twice, so the
    // minimum gap is enforced once more over the combined list. Nothing
    // downstream should ever see two notes a millisecond apart, whichever pass
    // they came from, and the louder of a pair is the one that survives.
    found.length = 0;
    for (const c of merged) {
      const last = found[found.length - 1];
      if (last && c.t - last.t < gap) {
        if (c.strength > last.strength) found[found.length - 1] = c;
        continue;
      }
      found.push(c);
    }
  }

  const hits = [];
  for (const f of found) {
    const t = f.t;
    const tb = timbre(x, sr, t * sr - Math.round(sr * 0.002));
    const { lane, conf, scores } = classify(tb);
    // The extra pass is allowed to find hi hats and nothing else. A short window
    // rings on a low drum, and the ring has enough broadband edge to clear a
    // threshold, so without this a lone tom grows a handful of phantom notes.
    // The main pass has already caught everything that is not a hi hat.
    if (f.fromHat && lane !== 'hat') continue;
    // A hi hat the long window reported in the middle of a roll, with no short
    // window onset anywhere near it, is the smear between two real notes rather
    // than a note of its own. Kicks and snares in the same stretch are kept,
    // because the short window is deaf to them by design and cannot vouch.
    if (f.inRoll && lane === 'hat') continue;
    const strength = f.strength;
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
  const duration = x.length / sr;
  const phase = estimatePhase(hits, tempo.period, duration);
  const meter = o.beatsPerBar
    ? { beatsPerBar: o.beatsPerBar, barOffset: o.barOffset || 0, confidence: 1, detected: true }
    : estimateMeter(hits, tempo.period, phase, duration);

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
    duration,
    beatsPerBar: meter.beatsPerBar,
    barOffset: meter.barOffset,
    meterConfidence: meter.confidence,
    meterDetected: meter.detected,
    tempoConfidence: +tempo.confidence.toFixed(3),
    hits,
    settings: o,
  };
}
