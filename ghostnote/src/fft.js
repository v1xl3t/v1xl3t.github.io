// fft.js — a small iterative radix-2 FFT.
//
// Pure maths, no DOM and no Web Audio, so the analyzer that sits on top of it
// can be run under `bun test` against a synthetic signal instead of only being
// eyeballed in a browser.

/** Bit-reversal permutation table for a transform of size n (n must be 2^k). */
function reverseTable(n) {
  const bits = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  return rev;
}

const cache = new Map();

/** Cached twiddles and permutation for a given size. */
export function plan(n) {
  if (cache.has(n)) return cache.get(n);
  if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two, got ' + n);
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  const p = { n, cos, sin, rev: reverseTable(n) };
  cache.set(n, p);
  return p;
}

/**
 * In-place complex FFT. re and im are Float64Array of length n.
 */
export function fft(re, im) {
  const n = re.length;
  const p = plan(n);
  const { rev, cos, sin } = p;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = i, k = 0; j < i + half; j++, k += step) {
        const c = cos[k], s = sin[k];
        const lr = re[j + half], li = im[j + half];
        const tr = lr * c - li * s;
        const ti = lr * s + li * c;
        re[j + half] = re[j] - tr;
        im[j + half] = im[j] - ti;
        re[j] += tr;
        im[j] += ti;
      }
    }
  }
}

/**
 * Magnitude spectrum of a real windowed frame.
 * @param {Float32Array|Float64Array} frame length n, already windowed
 * @param {Float64Array} out length n/2+1
 */
export function magSpectrum(frame, out) {
  const n = frame.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i];
  fft(re, im);
  const half = n >> 1;
  for (let k = 0; k <= half; k++) out[k] = Math.hypot(re[k], im[k]);
  return out;
}

/** Periodic Hann window of length n. */
export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
