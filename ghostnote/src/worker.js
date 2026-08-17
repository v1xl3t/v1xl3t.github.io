// worker.js — run the analysis off the main thread.
//
// A five minute track is a few thousand FFTs. Done inline that is a visibly
// frozen page, and a frozen page reads as a broken app. The caller falls back
// to running it inline if module workers are unavailable.

import { analyze } from './analyze.js';

self.onmessage = (ev) => {
  const { samples, sampleRate, opts, id } = ev.data;
  try {
    const result = analyze(samples, sampleRate, opts);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
