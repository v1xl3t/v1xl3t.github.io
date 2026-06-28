// autosave.js — keep the working project alive across reloads and tabs.
//
// CADence already has a lossless project serializer (doc.toJSON / loadJSON, see
// model.js + io.js). This module wires that serializer to localStorage so a
// session survives a refresh — and, because same-origin tabs share localStorage,
// so edits made in the portfolio "Run it here" preview iframe carry over when the
// app is opened in its own tab.
//
// Contract:
//   - scheduleAutosave(doc): debounced (~500ms) write of doc.toJSON(). Hooked to
//     the same 'history' commit path the undo system uses, so every meaningful
//     edit schedules a save. Failures (serialize error / quota / huge payload)
//     fail silently so the app never breaks.
//   - restoreAutosave(doc): on boot, load the last save via doc.loadJSON before
//     the first render. Returns true if a save was applied (so the caller skips
//     the default starter scene), false if absent/invalid.
//   - clearAutosave(): wipe the key for a deliberate fresh start.

const KEY = 'cadence:autosave:v1';

// Skip any payload larger than this. localStorage is ~5MB; a baked boolean stores
// full geometry arrays, so a runaway scene could blow the quota. Better to skip a
// tick than to throw or half-write a corrupt string.
const MAX_BYTES = 4_500_000;

let _timer = null;

// Debounced save. Serialize on the trailing edge so a burst of commits collapses
// into one write. Every step is guarded: if anything throws, we just skip.
export function scheduleAutosave(doc, delay = 500) {
  clearTimeout(_timer);
  _timer = setTimeout(() => {
    try {
      const json = doc.toJSON();
      const str = JSON.stringify(json);
      if (!str || str.length > MAX_BYTES) return;   // huge / empty-serialize — skip this tick
      localStorage.setItem(KEY, str);
    } catch {
      /* serialization error, private-mode, or quota — non-fatal, drop it */
    }
  }, delay);
}

// Restore the last autosave through the normal load path. Returns true when a
// stored project was applied; false when there's nothing valid to restore.
export function restoreAutosave(doc) {
  let raw;
  try { raw = localStorage.getItem(KEY); } catch { return false; }
  if (!raw) return false;

  let data;
  try { data = JSON.parse(raw); } catch {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }  // drop corrupt blob
    return false;
  }
  if (!data || !Array.isArray(data.objects)) return false;

  try {
    doc.loadJSON(data);
    return true;
  } catch {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    return false;
  }
}

// Forget the saved session (the New/Clear action calls this for a clean slate).
export function clearAutosave() {
  clearTimeout(_timer);
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
