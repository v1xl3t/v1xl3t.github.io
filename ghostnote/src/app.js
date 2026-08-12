// app.js — the wiring.
//
// Everything the test suite needs to drive is hung on window.playalong, the way
// CADence exposes window.cadence, so the suite can push a synthetic click track
// through the real pipeline instead of a pretend one.

import { analyse, analyseBuffer, downmix, estimateMeter, DEFAULTS } from './analyse.js';
import { renderHits, rockPattern, demoBuffer } from './synth.js';
import { Chart, LANES, LANE_LABEL } from './chart.js';
import { writeMidi, readMidi } from './midi.js';
import { Player, bufferToWav } from './audio.js';
import { InputHub, Calibrator, Scorer, KEY_MAP } from './input.js';
import { Highway } from './view.js';

const $ = (id) => document.getElementById(id);

const state = {
  chart: null,
  analysis: null,
  fileName: '',
  mode: 'play',
  sensitivity: 1,
  lastBuffer: null,
  ready: false,
  countingIn: false,
};

const player = new Player();
const hub = new InputHub();
const scorer = new Scorer();
const calibrator = new Calibrator(player, hub);
const view = new Highway($('chart'));

// ------------------------------------------------------------------ analysis

let worker = null;
let workerSeq = 0;

function getWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    worker = false;   // no module workers here, run inline instead
  }
  return worker;
}

/** Analyse mono samples, off thread when the browser allows it. */
export function runAnalysis(samples, sampleRate, opts = {}) {
  const w = getWorker();
  if (!w) return Promise.resolve(analyse(samples, sampleRate, opts));
  return new Promise((resolve) => {
    const id = ++workerSeq;
    let settled = false;
    const done = (ev) => {
      if (ev.data.id !== id) return;
      settled = true;
      w.removeEventListener('message', done);
      if (ev.data.error) resolve(analyse(samples, sampleRate, opts));
      else resolve(ev.data.result);
    };
    w.addEventListener('message', done);
    const copy = samples.slice(0);
    w.postMessage({ id, samples: copy, sampleRate, opts }, [copy.buffer]);
    // If the worker never answers, do not leave the user staring at a spinner.
    setTimeout(() => {
      if (settled) return;
      w.removeEventListener('message', done);
      resolve(analyse(samples, sampleRate, opts));
    }, 30000);
  });
}

function monoOf(buffer) {
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  return chans.length === 1 ? chans[0] : downmix(chans, buffer.length);
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

/** Load a blob, analyse it, build a chart. The whole pipeline in one call. */
export async function loadBlob(blob, name = 'track') {
  state.fileName = name;
  state.ready = false;
  setStatus('Reading the file, this stays on your device.', 'busy');
  let buffer;
  try {
    buffer = await player.load(blob);
  } catch (err) {
    // Say what actually went wrong. "Nothing happened" is the worst outcome
    // there is, so every failure below has to reach the user as words.
    const why = err && err.message ? ` (${err.message})` : '';
    setStatus(`That file could not be decoded${why}. Try a WAV or an MP3.`, 'bad');
    return null;
  }
  state.lastBuffer = buffer;
  setStatus('Finding the drum hits.', 'busy');
  await new Promise((r) => setTimeout(r, 0));
  let a;
  try {
    a = await runAnalysis(monoOf(buffer), buffer.sampleRate, { sensitivity: state.sensitivity });
  } catch (err) {
    setStatus(`The analyser failed on that track${err && err.message ? ` (${err.message})` : ''}. Please tell Vi what the file was.`, 'bad');
    return null;
  }
  applyAnalysis(a);
  setStatus(`Ready. ${state.chart.notes.length} hits found in ${name}.`);
  return state.chart;
}

/** Analyse the buffer already loaded again, with the current sensitivity. */
export async function reanalyse() {
  if (!state.lastBuffer) return null;
  setStatus('Analysing again.', 'busy');
  // Re analysing is about the hits, not about the meter, so a signature the
  // user set by hand survives it. Having to choose 3/4 again every time the
  // sensitivity moves would be its own small glitch.
  const chosen = $('timesig').value;
  const a = await runAnalysis(monoOf(state.lastBuffer), state.lastBuffer.sampleRate, { sensitivity: state.sensitivity });
  applyAnalysis(a);
  if (chosen !== 'auto') {
    $('timesig').value = chosen;
    applyMeterChoice();
    updateSummary();
  }
  setStatus(`Ready. ${state.chart.notes.length} hits found.`);
  return state.chart;
}

/**
 * Everything that has to be forgotten when a different track arrives.
 *
 * A second file used to be loaded on top of the first without clearing any of
 * this, and the leftovers were most of what "the controls glitch out" meant. A
 * loop region from a six minute track survived onto a thirty second one, so the
 * play head was yanked to a point past the end and playback died on the spot
 * while the panel still read "No loop set". The selected note pointed at an id
 * that no longer existed, so Delete and Nudge quietly did nothing. The play
 * button still said Pause while the player sat stopped.
 */
function resetForNewTrack() {
  player.pause();
  player.cancelCountIn();
  player.loop = null;
  player._nextClick = 0;
  state.countingIn = false;
  view.selectedId = null;
  view._drag = null;
  view.time = 0;
  scorer.reset();
  player.seek(0);
  $('seek').value = '0';
  seeking = false;
  updateLoopNote();
  if ($('ed-note')) describeSelection();
}

function applyAnalysis(a) {
  state.analysis = a;
  resetForNewTrack();
  state.chart = Chart.fromAnalysis(a);
  state.chart.onchange = () => { updateSummary(); };
  view.chart = state.chart;
  state.ready = true;
  $('play').disabled = false;
  $('restart').disabled = false;
  $('seek').disabled = false;
  $('reanalyse').disabled = false;
  // A fresh track gets a fresh reading of the meter, so the manual override goes
  // back to following the detector rather than pinning the previous track's.
  $('timesig').value = 'auto';
  applyMeterChoice();
  updateSummary();
  updateScore();
  updateRateLabel();
  updateDuckAvailability();
}

/** 6 beats to a bar is written 6/8, everything else over a quarter. */
function signatureLabel(beatsPerBar) {
  return beatsPerBar === 6 ? '6/8' : beatsPerBar === 7 ? '7/8' : `${beatsPerBar}/4`;
}

/** Read the time signature control, and tell the chart what it says. */
function applyMeterChoice() {
  const c = state.chart;
  if (!c) return;
  const raw = $('timesig').value;
  if (raw !== 'auto') c.setMeter(parseInt(raw, 10));
  const label = signatureLabel(c.beatsPerBar);
  $('sig-out').textContent = label;
  $('sig-note').textContent = raw !== 'auto'
    ? `Set by you to ${label}. Choose Detected to hand it back to the app.`
    : c.meterDetected
      ? `Heard as ${label} from the way the pattern repeats. Change it here if that looks wrong.`
      : 'Counted in four, which is the default whenever the track does not clearly say otherwise.';
  player._nextClick = 0;
}

/** Speed in both vocabularies at once, so nobody has to translate. */
function updateRateLabel() {
  const pct = Math.round((player.rate || 1) * 100);
  const c = state.chart;
  $('rate-out').textContent = c && c.bpm
    ? `${Math.round(c.bpm * (pct / 100))} BPM · ${pct}%`
    : `${pct}%`;
}

function updateSummary() {
  const c = state.chart;
  if (!c) { $('summary').textContent = 'Nothing loaded yet.'; return; }
  const n = c.counts();
  const bpm = c.bpm ? `${Math.round(c.bpm)} BPM` : 'tempo unclear';
  $('summary').textContent =
    `${c.notes.length} notes, ${bpm} in ${signatureLabel(c.beatsPerBar)}, kick ${n.kick}, snare ${n.snare}, hi hat ${n.hat}, tom ${n.tom}.`;
  const unsure = c.unsure(0.5);
  const h = $('honesty');
  if (unsure > 0) {
    h.hidden = false;
    h.textContent = `${unsure} of these are low confidence, drawn with a dashed outline. Switch to Edit and fix or delete them, it takes seconds.`;
  } else {
    h.hidden = c.notes.length === 0;
    h.textContent = 'Every note came through with decent confidence. Edit mode is still there if something is wrong.';
  }
}

// ------------------------------------------------------------------- scoring

function playTime() {
  return player.time;
}

hub.on((e) => {
  if (e.unmapped) { offerToLearn(e.note); return; }
  litPad(e.lane);
  if (!state.chart || state.mode !== 'play' || calibrator.running) return;
  const t = playTime() - hub.offsetMs / 1000;
  const res = scorer.hit(state.chart, e.lane, t);
  view.flash(res.grade, e.lane);
  updateScore();
});

// A pad the app does not recognise. "MIDI drum kit" is not a standard: the
// General MIDI table covers a stock Alesis or Roland, but pad controllers, older
// modules and home-built kits send whatever they were told to. Rather than let
// someone conclude the app is broken, name the note and let them claim it for a
// lane by tapping one. The choice is remembered for this device.
let learnNote = null;
function offerToLearn(note) {
  learnNote = note;
  const row = $('learn-row');
  $('learn-note').textContent = String(note);
  row.hidden = false;
  setStatus(`Unrecognised pad, MIDI note ${note}. Pick the drum it should count as.`, 'busy');
}

function bindLearnRow() {
  const row = $('learn-row');
  if (!row) return;
  row.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-learn]');
    if (!b || learnNote == null) return;
    if (b.dataset.learn === 'ignore') {
      setStatus(`Ignoring MIDI note ${learnNote}.`);
    } else {
      hub.learn(learnNote, b.dataset.learn);
      setStatus(`MIDI note ${learnNote} now counts as ${b.dataset.learn}.`);
    }
    learnNote = null;
    row.hidden = true;
  });
}
bindLearnRow();

function litPad(lane) {
  const el = document.querySelector(`.pad[data-lane="${lane}"]`);
  if (!el) return;
  el.classList.add('lit');
  setTimeout(() => el.classList.remove('lit'), 110);
}

function updateScore() {
  $('sc-score').textContent = String(scorer.score);
  $('sc-combo').textContent = String(scorer.combo);
  $('sc-acc').textContent = Math.round(scorer.accuracy() * 100) + '%';
  const b = scorer.bias();
  $('sc-bias').textContent = b == null ? 'no data yet'
    : Math.abs(b) < 6 ? 'right in the pocket'
    : b < 0 ? `${Math.abs(b)} ms early` : `${b} ms late`;
  const c = scorer.counts;
  $('sc-counts').textContent = `Perfect ${c.perfect}, great ${c.great}, good ${c.good}, missed ${c.miss}`;
}

// ----------------------------------------------------------------- transport

async function togglePlay() {
  if (!state.chart) return;
  if (player.playing || state.countingIn) {
    player.pause();
    player.cancelCountIn();
    state.countingIn = false;
    syncTransport();
    setStatus('Paused.');
    return;
  }
  // The count in is chosen in bars, and a bar is however many beats the time
  // signature says. Counting a waltz in as four was one of the ways a 3/4 track
  // felt broken before the first note even arrived.
  const bars = parseInt($('countin').value, 10) || 0;
  const bpb = state.chart.beatsPerBar || 4;
  const beats = bars * bpb;
  if (beats && state.chart.period) {
    state.countingIn = true;
    syncTransport();
    setStatus('Count in.', 'busy');
    await player.countInThenPlay(beats, state.chart.period, bpb);
    state.countingIn = false;
    setStatus('Playing.');
  } else {
    await player.play();
  }
  syncTransport();
}

/**
 * The play button reads its label off the player rather than being told.
 *
 * Every path that could stop playback used to have to remember to set the text,
 * and the ones that forgot left the button saying Pause over a stopped track.
 * Reading the truth once a frame means it cannot drift, whatever stopped it.
 */
function syncTransport() {
  const label = player.playing || state.countingIn ? 'Pause' : 'Play';
  const el = $('play');
  if (el.textContent !== label) el.textContent = label;
}

function restart() {
  player.seek(0);
  scorer.reset();
  updateScore();
  view.time = 0;
}

function fmt(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

let seeking = false;

function frame() {
  const t = playTime();
  view.time = t;
  if (player.playing) {
    player.pumpLoop();
    player.pumpMetronome(state.chart);
    if (state.chart) { scorer.sweep(state.chart, t - hub.offsetMs / 1000); updateScore(); }
  }
  syncTransport();
  $('clock').textContent = `${fmt(t)} / ${fmt(player.duration)}`;
  if (!seeking && player.duration) $('seek').value = String(Math.round((t / player.duration) * 1000));
  view.render();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------- edit

function setMode(mode) {
  state.mode = mode;
  view.mode = mode;
  $('mode-play').classList.toggle('on', mode === 'play');
  $('mode-edit').classList.toggle('on', mode === 'edit');
  $('mode-play').setAttribute('aria-pressed', String(mode === 'play'));
  $('mode-edit').setAttribute('aria-pressed', String(mode === 'edit'));
  $('editbar').hidden = mode !== 'edit';
  if (mode === 'edit') { player.pause(); player.cancelCountIn(); state.countingIn = false; syncTransport(); }
}

function selectedNote() {
  if (!state.chart || view.selectedId == null) return null;
  return state.chart.notes.find((n) => n.id === view.selectedId) || null;
}

function describeSelection() {
  const n = selectedNote();
  const el = $('ed-note');
  if (!n) {
    el.textContent = 'Tap an empty spot to add a note, tap a note to select it, drag a note to move it.';
    return;
  }
  const conf = n.source === 'user' ? 'yours' : `${Math.round((n.conf || 0) * 100)}% confident`;
  const off = state.chart.step ? `${Math.round((n.t - state.chart.quantiseTime(n.t)) * 1000)} ms off the grid` : 'no grid';
  el.textContent = `${LANE_LABEL[n.lane]} at ${n.t.toFixed(3)} s, ${conf}, ${off}.`;
}

view.onselect = () => describeSelection();
view.onadd = (t, lane) => {
  if (!state.chart) return;
  const n = state.chart.add(t, lane);
  view.selectedId = n.id;
  describeSelection();
};
view.onmove = (id, t, lane) => {
  if (!state.chart) return;
  state.chart.move(id, t, lane);
  describeSelection();
};
view.onscrub = (t) => {
  if (!state.chart) return;
  player.seek(Math.max(0, Math.min(player.duration || state.chart.duration, t)));
};

function nudge(ms) {
  const n = selectedNote();
  if (!n) return;
  state.chart.move(n.id, n.t + ms / 1000, n.lane);
  describeSelection();
}

// -------------------------------------------------------------------- export

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function baseName() {
  return (state.fileName || 'chart').replace(/\.[^.]+$/, '').replace(/[^\w -]+/g, '') || 'chart';
}

export function exportMidiBytes(quantised = false) {
  if (!state.chart) return null;
  return writeMidi(state.chart, { quantised, name: baseName() });
}

// ----------------------------------------------------------------------- UI

function wire() {
  $('pick').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    // A phone can hand back an empty selection, and silently doing nothing is
    // indistinguishable from the app being broken.
    if (!f) { setStatus('No file came back from the picker. Try again, or use Try a demo groove.', 'bad'); return; }
    // Same input twice in a row fires no change event unless the value is
    // cleared, which reads as "I picked it and nothing happened".
    ev.target.value = '';
    loadBlob(f, f.name).catch((err) => {
      setStatus(`Something went wrong loading that file${err && err.message ? ` (${err.message})` : ''}.`, 'bad');
    });
  });

  $('demo').addEventListener('click', async () => {
    const ctx = player.ensureCtx();
    const { buffer } = demoBuffer(ctx, { bpm: 100, bars: 12 });
    // Two channels so the centre cut has something to work with.
    const stereo = ctx.createBuffer(2, buffer.length, buffer.sampleRate);
    stereo.copyToChannel(buffer.getChannelData(0), 0);
    stereo.copyToChannel(buffer.getChannelData(0), 1);
    await loadBlob(bufferToWav(stereo), 'demo groove.wav');
  });

  const drop = $('drop');
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { stop(e); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { stop(e); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) { setStatus('Nothing usable was dropped. Try the Choose a file button.', 'bad'); return; }
    loadBlob(f, f.name).catch((err) => {
      setStatus(`Something went wrong loading that file${err && err.message ? ` (${err.message})` : ''}.`, 'bad');
    });
  });
  // A whole-page tap target for the drop zone: on a phone there is no drag and
  // drop, so the dashed box has to be the button it looks like.
  drop.addEventListener('click', (e) => {
    if (e.target.closest('button, input, label')) return;
    $('file').click();
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('play').addEventListener('click', togglePlay);
  $('restart').addEventListener('click', restart);
  $('seek').addEventListener('pointerdown', () => { seeking = true; });
  $('seek').addEventListener('pointerup', () => { seeking = false; });
  $('seek').addEventListener('input', (ev) => {
    if (!player.duration) return;
    player.seek((+ev.target.value / 1000) * player.duration);
  });

  $('mode-play').addEventListener('click', () => setMode('play'));
  $('mode-edit').addEventListener('click', () => setMode('edit'));

  $('ed-del').addEventListener('click', () => {
    const n = selectedNote();
    if (n) { state.chart.remove(n.id); view.selectedId = null; describeSelection(); }
  });
  $('ed-earlier').addEventListener('click', () => nudge(-10));
  $('ed-later').addEventListener('click', () => nudge(10));
  $('ed-snap').addEventListener('click', () => {
    const moved = state.chart ? state.chart.quantiseAll() : 0;
    setStatus(`Snapped ${moved} notes to the grid. Undo is right there if you hate it.`);
  });
  $('ed-clean').addEventListener('click', () => {
    const gone = state.chart ? state.chart.dropBelowConfidence(0.5) : 0;
    setStatus(`Removed ${gone} low confidence notes.`);
  });
  $('ed-undo').addEventListener('click', () => { if (state.chart) state.chart.undo(); describeSelection(); });
  $('ed-redo').addEventListener('click', () => { if (state.chart) state.chart.redo(); describeSelection(); });

  document.querySelectorAll('.pad').forEach((p) => {
    p.addEventListener('pointerdown', (ev) => { ev.preventDefault(); hub.pad(p.dataset.lane); });
  });

  $('rate').addEventListener('input', (ev) => {
    player.setRate(+ev.target.value / 100);
    updateRateLabel();
  });

  $('timesig').addEventListener('change', () => {
    applyMeterChoice();
    updateSummary();
  });

  $('duck').addEventListener('input', (ev) => {
    const v = +ev.target.value;
    $('duck-out').textContent = v ? v + '%' : 'off';
    player.setDuck(v / 100);
  });

  $('metro').addEventListener('click', () => {
    player.metronome = !player.metronome;
    $('metro').setAttribute('aria-pressed', String(player.metronome));
    $('metro').textContent = `Click on the detected beat, ${player.metronome ? 'on' : 'off'}`;
    $('metro').classList.toggle('primary', player.metronome);
  });

  $('loop-a').addEventListener('click', () => setLoop(player.time, player.loop ? player.loop.b : player.duration));
  $('loop-b').addEventListener('click', () => setLoop(player.loop ? player.loop.a : 0, player.time));
  $('loop-off').addEventListener('click', () => { player.loop = null; updateLoopNote(); setStatus('Loop cleared.'); });

  $('ex-midi').addEventListener('click', () => {
    const bytes = exportMidiBytes(false);
    if (bytes) download(baseName() + '.mid', new Blob([bytes], { type: 'audio/midi' }));
  });
  $('ex-midi-q').addEventListener('click', () => {
    const bytes = exportMidiBytes(true);
    if (bytes) download(baseName() + ' quantised.mid', new Blob([bytes], { type: 'audio/midi' }));
  });
  $('ex-chart').addEventListener('click', () => {
    if (!state.chart) return;
    download(baseName() + '.json', new Blob([JSON.stringify(state.chart.toJSON(), null, 1)], { type: 'application/json' }));
  });
  $('im-chart').addEventListener('click', () => $('chartfile').click());
  $('chartfile').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    try {
      const c = Chart.fromJSON(JSON.parse(await f.text()));
      // Same clean slate a new audio file gets. A chart swapped in under a live
      // loop region and a stale selection is the same desync, by another door.
      resetForNewTrack();
      state.chart = c;
      c.onchange = () => updateSummary();
      view.chart = c;
      $('timesig').value = 'auto';
      applyMeterChoice();
      updateSummary();
      updateRateLabel();
      setStatus('Chart loaded. Bring the same audio back in to play along to it.');
    } catch (err) {
      setStatus(String(err.message || err), 'bad');
    }
  });

  $('midi-on').addEventListener('click', async () => {
    await hub.enableMidi();
    $('midi-note').textContent = 'MIDI is ' + hub.midiState + '.';
  });

  $('cal-run').addEventListener('click', async () => {
    $('cal-note').textContent = 'Tap along with the clicks, on any pad or key.';
    const r = await calibrator.run(8, 100, (n, total) => {
      $('cal-note').textContent = `Tap along, ${n} of ${total}.`;
    });
    if (!r.ok) {
      $('cal-note').textContent = 'Not enough taps landed near a click. Try again and hit every one.';
      return;
    }
    hub.setOffset(r.offsetMs);
    $('cal-out').textContent = `${r.offsetMs} ms`;
    $('cal-note').textContent = `Measured from ${r.usable} taps, spread ${r.spreadMs} ms. That offset is now subtracted from every judgement.`;
  });

  $('cal-clear').addEventListener('click', () => {
    hub.setOffset(0);
    $('cal-out').textContent = '0 ms';
    $('cal-note').textContent = 'Calibration reset to zero.';
  });

  $('sens').addEventListener('input', (ev) => {
    const v = +ev.target.value;
    state.sensitivity = v / 100;
    $('sens-out').textContent = v === 100 ? 'normal' : v > 100 ? 'high' : 'low';
  });

  $('reanalyse').addEventListener('click', () => reanalyse());

  window.addEventListener('keydown', (ev) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
    // Space starts and stops, the way it does in every other piece of music
    // software. A focused button gets to keep it, or one press would both click
    // the button and toggle the transport.
    if (ev.code === 'Space' && !ev.repeat) {
      const t = ev.target;
      const interactive = t && t.closest && t.closest('button, summary, a, select, input');
      if (!interactive) {
        ev.preventDefault();
        togglePlay();
        return;
      }
    }
    if (state.mode === 'edit' && (ev.key === 'Delete' || ev.key === 'Backspace')) {
      const n = selectedNote();
      if (n) { ev.preventDefault(); state.chart.remove(n.id); view.selectedId = null; describeSelection(); }
    }
  });

  window.addEventListener('resize', () => view.resize());
}

/**
 * Set the loop region, and say what happened either way.
 *
 * Marking the end before the start left {a: 3, b: 1} sitting in the player. The
 * loop only runs while b is greater than a, so nothing happened, and the panel
 * still read "No loop set" even though two buttons had been pressed. Pressing a
 * control twice and being told nothing was set is exactly what "the controls
 * glitch out" describes. The region is put in order here instead, and a region
 * too short to be a loop says so in words.
 */
const MIN_LOOP = 0.15;

function setLoop(a, b) {
  const dur = player.duration || (state.chart ? state.chart.duration : 0);
  let lo = Math.max(0, Math.min(a, b));
  let hi = Math.min(dur || Math.max(a, b), Math.max(a, b));
  if (hi - lo < MIN_LOOP) {
    player.loop = null;
    updateLoopNote();
    setStatus('That loop would be shorter than a fifth of a second, so it was not set. Move the play head and mark the other end.', 'bad');
    return false;
  }
  player.loop = { a: lo, b: hi };
  player._nextClick = 0;
  updateLoopNote();
  setStatus(`Looping ${fmt(lo)} to ${fmt(hi)}.`);
  return true;
}

function updateLoopNote() {
  const l = player.loop;
  $('loop-note').textContent = l && l.b > l.a
    ? `Looping ${fmt(l.a)} to ${fmt(l.b)}.`
    : 'No loop set.';
}

function updateDuckAvailability() {
  const stereo = player.channels >= 2;
  $('duck').disabled = !stereo;
  if (!stereo) $('duck-note').textContent = 'This file is mono, so there is no centre to remove. Load a stereo track to use this.';
}

// -------------------------------------------------------------------- start

hub.attachKeyboard();
wire();
view.resize();
$('cal-out').textContent = `${hub.offsetMs} ms`;
requestAnimationFrame(frame);

// Everything the tests drive, and anything a curious user wants in the console.
window.playalong = {
  state, player, hub, scorer, view, calibrator,
  analyse, analyseBuffer, runAnalysis, estimateMeter,
  renderHits, rockPattern,
  writeMidi, readMidi, exportMidiBytes,
  Chart, LANES, LANE_LABEL, KEY_MAP, DEFAULTS,
  loadBlob, reanalyse, setMode, restart, togglePlay,
  setLoop, signatureLabel, applyMeterChoice, updateSummary,
  get chart() { return state.chart; },
  /** Push raw samples through the whole pipeline, the way a real file goes. */
  async loadSamples(samples, sampleRate = 44100, name = 'fixture.wav') {
    const ctx = player.ensureCtx();
    const buf = ctx.createBuffer(2, samples.length, sampleRate);
    const f32 = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    buf.copyToChannel(f32, 0);
    buf.copyToChannel(f32, 1);
    return loadBlob(bufferToWav(buf), name);
  },
  /** Analyse without touching playback, for measuring detection on its own. */
  analyseSamples(samples, sampleRate = 44100, opts = {}) {
    const f32 = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    return analyse(f32, sampleRate, opts);
  },
};
