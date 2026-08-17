// library.js — charts and practice runs, kept on this device.
//
// Editing a chart is the whole mitigation for a detector that gets things
// wrong, and until now every minute of that work evaporated when the tab
// closed. A chart is a few hundred small objects, so it fits in local storage
// with room to spare, and keeping it there means the second session on a song
// starts where the first one stopped.
//
// Everything here stays local, the same promise the analyzer makes. There is no
// account and nothing is uploaded, so "your library" means the library in this
// browser on this machine, which is worth saying plainly in the UI.

const LIB_KEY = 'ghostnote.library.v1';
const HIST_KEY = 'ghostnote.history.v1';
const WORK_KEY = 'ghostnote.working.v1';

// Local storage is usually 5MB per origin. A chart of a five minute song is a
// few tens of kilobytes, so the cap is generous, but an unbounded list would
// eventually start throwing on save with no warning.
const MAX_CHARTS = 40;
const MAX_RUNS = 60;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch { return fallback; }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return { ok: true };
  } catch (err) {
    // Private mode and a full quota both land here, and both need to reach the
    // user as words rather than as a save button that appears to work.
    const full = err && /quota|exceeded/i.test(err.name + ' ' + err.message);
    return {
      ok: false,
      reason: full
        ? 'This browser is out of local storage room. Delete a saved chart and try again.'
        : 'This browser will not let the page store anything, which private browsing usually causes.',
    };
  }
}

/**
 * What makes two loads "the same track".
 *
 * Deliberately not a hash of the audio. Hashing megabytes on the main thread to
 * match a chart is a lot of work for a guess, and a name plus a duration to a
 * tenth of a second is already specific enough that a false match is unlikely
 * and harmless when it happens, since the offer is a question and not an
 * action.
 */
export function fingerprint(name, duration) {
  const clean = String(name || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/\s+/g, ' ').trim();
  return `${clean}|${Math.round((duration || 0) * 10)}`;
}

export function listCharts() {
  const list = read(LIB_KEY, []);
  return Array.isArray(list) ? list : [];
}

/** Newest first, which is the order anyone looks for a chart in. */
export function sortedCharts() {
  return listCharts().slice().sort((x, y) => (y.saved || 0) - (x.saved || 0));
}

export function getChart(id) {
  return listCharts().find((c) => c.id === id) || null;
}

/**
 * Save under a name. Saving the same name twice replaces rather than piles up,
 * because "save" after a few more edits is the common case and a library full
 * of nine copies of one song is nobody's idea of a library.
 */
export function saveChart(name, chartJSON, meta = {}) {
  const list = listCharts();
  const label = String(name || 'Untitled chart').slice(0, 80);
  const fp = meta.fingerprint || '';
  const entry = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: label,
    saved: Date.now(),
    fingerprint: fp,
    notes: (chartJSON.notes || []).length,
    bpm: chartJSON.bpm || 0,
    beatsPerBar: chartJSON.beatsPerBar || 4,
    duration: chartJSON.duration || 0,
    chart: chartJSON,
  };
  const i = list.findIndex((c) => c.name === label);
  if (i >= 0) { entry.id = list[i].id; list[i] = entry; }
  else list.unshift(entry);
  list.sort((x, y) => (y.saved || 0) - (x.saved || 0));
  if (list.length > MAX_CHARTS) list.length = MAX_CHARTS;
  const r = write(LIB_KEY, list);
  return r.ok ? { ok: true, entry } : r;
}

export function deleteChart(id) {
  const list = listCharts().filter((c) => c.id !== id);
  return write(LIB_KEY, list);
}

/** The saved chart most likely to belong to the track just loaded. */
export function matchChart(name, duration) {
  const fp = fingerprint(name, duration);
  const list = sortedCharts();
  const exact = list.find((c) => c.fingerprint === fp);
  if (exact) return exact;
  // Same length, different file name. Renaming a download is common enough that
  // ignoring it would waste the match, and a second of slack covers the way
  // different decoders round the end of an MP3.
  return list.find((c) => c.duration && Math.abs(c.duration - duration) < 1) || null;
}

// ------------------------------------------------------- the working chart

/**
 * The chart currently on screen, written back on every edit.
 *
 * This is the crash net rather than the library. It survives a reload, a closed
 * tab and a phone deciding to drop the page out of memory, none of which are
 * moments anybody would have thought to press Save.
 */
export function saveWorking(chartJSON, meta = {}) {
  return write(WORK_KEY, { saved: Date.now(), name: meta.name || '', fingerprint: meta.fingerprint || '', chart: chartJSON });
}

export function loadWorking() {
  const w = read(WORK_KEY, null);
  return w && w.chart ? w : null;
}

export function clearWorking() {
  try { localStorage.removeItem(WORK_KEY); } catch { /* nothing to do */ }
}

// ------------------------------------------------------------- run history

/** One finished practice run, so progress on a song is visible over weeks. */
export function addRun(run) {
  const list = read(HIST_KEY, []);
  const rows = Array.isArray(list) ? list : [];
  rows.unshift({ ...run, at: Date.now() });
  if (rows.length > MAX_RUNS) rows.length = MAX_RUNS;
  return write(HIST_KEY, rows);
}

export function listRuns(forName = null) {
  const rows = read(HIST_KEY, []);
  const all = Array.isArray(rows) ? rows : [];
  return forName ? all.filter((r) => r.name === forName) : all;
}

export function clearRuns() {
  return write(HIST_KEY, []);
}

/** Best accuracy seen on a track before this run, or null on a first attempt. */
export function personalBest(name) {
  const rows = listRuns(name);
  if (!rows.length) return null;
  return rows.reduce((best, r) => (r.accuracy > best.accuracy ? r : best), rows[0]);
}
