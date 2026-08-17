// synth.js — drum sounds rendered straight into a Float32Array.
//
// Two jobs. It gives the app a demo groove so you can try the whole loop with
// no file of your own, and it gives the test suite a click track whose hit
// times are known exactly, which is the only way to say the analyzer works
// rather than that it looked about right.
//
// Pure maths so it runs identically under Bun and in the browser.

/** Deterministic noise so a fixture is the same every run. */
function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s / 4294967296) * 2 - 1;
  };
}

// Every voice fades over its final stretch. Cutting a decaying tone off mid
// cycle leaves a step in the waveform, and a step is a broadband transient, so
// an untapered fixture invents onsets that no drummer played and then blames
// the detector for finding them.
const taper = (i, dur) => {
  const fade = Math.max(1, Math.round(dur * 0.2));
  return i > dur - fade ? 0.5 - 0.5 * Math.cos((Math.PI * (dur - i)) / fade) : 1;
};

const VOICES = {
  // Pitch sweep from about 155Hz down to 45Hz, the shape of a real kick, plus a
  // short beater click.
  kick(out, i0, sr, gain, rand) {
    const dur = Math.round(sr * 0.4);
    let ph = 0;
    for (let i = 0; i < dur && i0 + i < out.length; i++) {
      const tt = i / sr;
      const f = 45 + 110 * Math.exp(-tt * 55);
      ph += (2 * Math.PI * f) / sr;
      const env = Math.exp(-tt * 14) * (1 - Math.exp(-tt * 4000));
      const click = Math.exp(-tt * 900) * rand() * 0.2;
      out[i0 + i] += (Math.sin(ph) * env + click) * gain * taper(i, dur);
    }
  },
  // Two shell modes near 185 and 330Hz under band limited wire noise, which is
  // where a real snare puts its energy.
  snare(out, i0, sr, gain, rand) {
    const dur = Math.round(sr * 0.28);
    let p1 = 0, p2 = 0, lpFast = 0, lpSlow = 0;
    for (let i = 0; i < dur && i0 + i < out.length; i++) {
      const tt = i / sr;
      p1 += (2 * Math.PI * 185) / sr;
      p2 += (2 * Math.PI * 331) / sr;
      const env = Math.exp(-tt * 26) * (1 - Math.exp(-tt * 6000));
      const n = rand();
      lpFast += (n - lpFast) * 0.3;           // roughly 2kHz roll off on top
      lpSlow += (n - lpSlow) * 0.04;          // roughly 300Hz, removed below
      const band = lpFast - lpSlow;
      const tone = (Math.sin(p1) * 0.6 + Math.sin(p2) * 0.35) * Math.exp(-tt * 34);
      out[i0 + i] += (tone * 0.55 + band * 0.85) * env * gain * taper(i, dur);
    }
  },
  // Differentiated noise, so the energy sits well above 6kHz like a closed hat.
  hat(out, i0, sr, gain, rand) {
    const dur = Math.round(sr * 0.09);
    let prev = 0;
    for (let i = 0; i < dur && i0 + i < out.length; i++) {
      const tt = i / sr;
      const n = rand();
      const hp = n - prev; prev = n;
      const env = Math.exp(-tt * 70) * (1 - Math.exp(-tt * 9000));
      out[i0 + i] += hp * env * gain * 0.7 * taper(i, dur);
    }
  },
  tom(out, i0, sr, gain, rand) {
    const dur = Math.round(sr * 0.34);
    let ph = 0;
    for (let i = 0; i < dur && i0 + i < out.length; i++) {
      const tt = i / sr;
      const f = 120 + 90 * Math.exp(-tt * 20);
      ph += (2 * Math.PI * f) / sr;
      const env = Math.exp(-tt * 12) * (1 - Math.exp(-tt * 3000));
      out[i0 + i] += (Math.sin(ph) * 0.9 + rand() * 0.1 * Math.exp(-tt * 60)) * env * gain * taper(i, dur);
    }
  },
};

/**
 * Render a list of hits into mono samples.
 * @param {{t:number,lane:string,gain?:number}[]} hits
 * @param {{sampleRate?:number,duration?:number,seed?:number,noise?:number,bassTone?:number}} opts
 * @returns {{samples:Float32Array,sampleRate:number,truth:{t:number,lane:string}[]}}
 */
export function renderHits(hits, opts = {}) {
  const sr = opts.sampleRate || 44100;
  const last = hits.reduce((m, h) => Math.max(m, h.t), 0);
  const duration = opts.duration || last + 1;
  const out = new Float32Array(Math.ceil(duration * sr));
  const rand = rng(opts.seed || 12345);

  if (opts.noise) for (let i = 0; i < out.length; i++) out[i] += rand() * opts.noise;
  if (opts.bassTone) {
    // A sustained bass note, the classic way to fool a naive low band detector.
    for (let i = 0; i < out.length; i++) out[i] += Math.sin((2 * Math.PI * 82 * i) / sr) * opts.bassTone;
  }

  const sorted = [...hits].sort((a, b) => a.t - b.t);
  for (const h of sorted) {
    const v = VOICES[h.lane] || VOICES.snare;
    v(out, Math.round(h.t * sr), sr, h.gain == null ? 1 : h.gain, rand);
  }
  // keep headroom, clipping would smear the transients we are about to detect
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.98) for (let i = 0; i < out.length; i++) out[i] *= 0.98 / peak;

  return { samples: out, sampleRate: sr, truth: sorted.map((h) => ({ t: h.t, lane: h.lane })) };
}

/**
 * A straight rock beat. Kick on 1 and 3, snare on 2 and 4, eighth note hats.
 * @returns {{t:number,lane:string,gain:number}[]}
 */
export function rockPattern({ bpm = 100, bars = 8, startAt = 0.25, hats = true } = {}) {
  const beat = 60 / bpm;
  const hits = [];
  for (let bar = 0; bar < bars; bar++) {
    const b0 = startAt + bar * 4 * beat;
    hits.push({ t: b0, lane: 'kick', gain: 1 });
    hits.push({ t: b0 + beat, lane: 'snare', gain: 0.9 });
    hits.push({ t: b0 + 2 * beat, lane: 'kick', gain: 1 });
    hits.push({ t: b0 + 3 * beat, lane: 'snare', gain: 0.9 });
    if (hats) for (let e = 0; e < 8; e++) hits.push({ t: b0 + e * beat * 0.5, lane: 'hat', gain: 0.55 });
  }
  return hits;
}

/** Build the demo groove as a real AudioBuffer for the browser. */
export function demoBuffer(ctx, opts = {}) {
  const bpm = opts.bpm || 100;
  const { samples, sampleRate, truth } = renderHits(rockPattern({ bpm, bars: opts.bars || 8 }), {
    sampleRate: ctx.sampleRate,
  });
  const buf = ctx.createBuffer(1, samples.length, sampleRate);
  buf.copyToChannel(samples, 0);
  return { buffer: buf, truth, bpm };
}
