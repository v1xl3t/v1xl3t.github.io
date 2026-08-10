// worker.js — slicing off the main thread.
//
// Slicing a real part is seconds of solid arithmetic. On the main thread that
// is seconds of a frozen canvas, a spinner that does not spin, and a browser
// offering to kill the tab. There is nothing to optimise about that; it simply
// has to happen somewhere else.
//
// IMPORTANT: a module worker does NOT inherit the page's import map. Every
// import reachable from this file therefore has to be a relative path that
// resolves on its own. That is why the whole slicer folder is free of THREE and
// of anything else resolved through the map, and it is worth keeping that way:
// the moment one stage imports 'three' for a Vector2, the worker stops loading
// with an error that points at the import and not at the cause.

import { sliceModel, buildSettings } from './index.js';

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type !== 'slice') return;

  const started = performance.now();
  try {
    const settings = msg.settings?.machineId ? msg.settings : buildSettings(msg.settings || {});
    const positions = msg.positions instanceof Float32Array ? msg.positions : new Float32Array(msg.positions || []);

    let lastPost = 0;
    const result = sliceModel(positions, settings, (p) => {
      // Throttled: posting on every layer costs more than the slicing does.
      const now = performance.now();
      if (now - lastPost < 60 && p.frac < 1) return;
      lastPost = now;
      self.postMessage({ type: 'progress', stage: p.stage, frac: p.frac });
    });

    self.postMessage({
      type: 'done',
      plan: result.plan,
      stats: result.stats,
      gcode: result.gcode,
      warnings: result.warnings,
      notes: result.notes,
      placement: {
        offset: result.placement.offset,
        size: result.placement.size,
        fits: result.placement.fits,
      },
      elapsedMs: Math.round(performance.now() - started),
    });
  } catch (err) {
    // A slicer that throws silently leaves the UI spinning forever, which is
    // strictly worse than saying what went wrong.
    self.postMessage({
      type: 'error',
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? String(err.stack) : '',
    });
  }
};
