// app.js — the wiring.
//
// Everything the test suite needs to drive is hung on window.playalong, the way
// CADence exposes window.cadence, so the suite can push a synthetic click track
// through the real pipeline instead of a pretend one.

import { analyze, analyzeBuffer, downmix, estimateMeter, DEFAULTS } from './analyze.js';
import { renderHits, rockPattern, demoBuffer } from './synth.js';
import { Chart, LANES, LANE_LABEL } from './chart.js';
import { writeMidi, readMidi } from './midi.js';
import { Player, bufferToWav } from './audio.js';
import { InputHub, Calibrator, Scorer, KEY_MAP, HIST_LABELS } from './input.js';
import { Highway, DEFAULT_ZOOM } from './view.js';
import { LoopRail } from './seekbar.js';
import * as library from './library.js';

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
const rail = new LoopRail($('looprail'), { onchange: (loop, info) => onRailChange(loop, info) });

/**
 * The loop, in the one place that owns it.
 *
 * The region existed in three copies before this. The player ran it, a line of
 * text described it, and the chart did not know about it at all, so any control
 * that forgot to update one of the three left the other two lying. Everything
 * that changes a loop now goes through here.
 */
function applyLoop(loop) {
  player.loop = loop && loop.b > loop.a ? { a: loop.a, b: loop.b } : null;
  player._nextClick = 0;
  view.loop = player.loop;
  rail.setLoop(player.loop);
  updateLoopNote();
}

function onRailChange(loop, info) {
  if (loop) {
    applyLoop(loop);
    setStatus(`Looping ${fmt(loop.a)} to ${fmt(loop.b)}.`);
    // Dropping the play head into a section you just marked is what everyone
    // wants next, and jumping only when the head is outside means marking a
    // loop around where you already are does not yank you backwards.
    if (player.time < loop.a || player.time > loop.b) player.seek(loop.a);
  } else {
    applyLoop(null);
    if (info && info.tooShort) {
      setStatus('That section is under a fifth of a second, so no loop was set. Drag the handles further apart.', 'bad');
    }
  }
}

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

/** Analyze mono samples, off thread when the browser allows it. */
export function runAnalysis(samples, sampleRate, opts = {}) {
  const w = getWorker();
  if (!w) return Promise.resolve(analyze(samples, sampleRate, opts));
  return new Promise((resolve) => {
    const id = ++workerSeq;
    let settled = false;
    const done = (ev) => {
      if (ev.data.id !== id) return;
      settled = true;
      w.removeEventListener('message', done);
      if (ev.data.error) resolve(analyze(samples, sampleRate, opts));
      else resolve(ev.data.result);
    };
    w.addEventListener('message', done);
    const copy = samples.slice(0);
    w.postMessage({ id, samples: copy, sampleRate, opts }, [copy.buffer]);
    // If the worker never answers, do not leave the user staring at a spinner.
    setTimeout(() => {
      if (settled) return;
      w.removeEventListener('message', done);
      resolve(analyze(samples, sampleRate, opts));
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

/** Load a blob, analyze it, build a chart. The whole pipeline in one call. */
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
    setStatus(`The analyzer failed on that track${err && err.message ? ` (${err.message})` : ''}. Please tell Vi what the file was.`, 'bad');
    return null;
  }
  applyAnalysis(a);
  setStatus(`Ready. ${state.chart.notes.length} hits found in ${name}.`);
  offerSavedChart(name, buffer.duration);
  return state.chart;
}

/**
 * If a saved chart looks like it belongs to this file, offer it.
 *
 * An offer, never an action. A fresh analysis is what was asked for, and
 * silently replacing it with an old chart because two files happen to be the
 * same length would be the worst kind of clever.
 */
let pendingMatch = null;
function offerSavedChart(name, duration) {
  const el = $('match-offer');
  if (!el) return;
  const hit = library.matchChart(name, duration);
  pendingMatch = hit;
  if (!hit) { el.hidden = true; return; }
  $('match-text').textContent =
    `You have a saved chart called ${hit.name} that matches this track, with ${hit.notes} notes and your edits in it. Use it instead of the fresh analysis?`;
  el.hidden = false;
}

/** Analyze the buffer already loaded again, with the current sensitivity. */
export async function reanalyze() {
  if (!state.lastBuffer) return null;
  setStatus('Analyzing again.', 'busy');
  // Re analyzing is about the hits, not about the meter, so a signature the
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
  applyLoop(null);
  state.countingIn = false;
  view.selectedId = null;
  view._drag = null;
  view.time = 0;
  scorer.reset();
  player.seek(0);
  $('seek').value = '0';
  seeking = false;
  rail.setDuration(player.duration || 0);
  $('results').hidden = true;
  if ($('ed-note')) describeSelection();
}

/**
 * Put a chart on screen, wherever it came from.
 *
 * Three doors lead here: a fresh analysis, a chart file, and the library. They
 * used to each do their own version of this and the differences between them
 * were bugs waiting to happen, since a chart loaded by one door would arrive
 * with a live loop region or a stale selection that the other door cleared.
 */
function installChart(chart, opts = {}) {
  resetForNewTrack();
  state.chart = chart;
  chart.onchange = () => { updateSummary(); scheduleAutosave(); };
  view.chart = chart;
  state.ready = true;
  // A chart with no audio behind it is a real thing, from a chart file or from
  // the library, and a Play button that does nothing is worse than one that is
  // plainly unavailable.
  const playable = !!(player.el && state.lastBuffer);
  $('play').disabled = !playable;
  $('restart').disabled = !playable;
  $('seek').disabled = !playable;
  $('reanalyze').disabled = !state.lastBuffer;
  rail.setDuration(player.duration || chart.duration || 0);
  // A fresh track gets a fresh reading of the meter, so the manual override goes
  // back to following the detector rather than pinning the previous track's.
  if (opts.keepMeter !== true) $('timesig').value = 'auto';
  applyMeterChoice();
  updateSummary();
  updateScore();
  updateRateLabel();
  updateDuckAvailability();
  updateTempoNote();
  if ($('save-name') && !$('save-name').value) $('save-name').value = baseName();
  if (opts.autosave !== false) scheduleAutosave();
}

function applyAnalysis(a) {
  state.analysis = a;
  installChart(Chart.fromAnalysis(a));
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

/**
 * Say when the tempo is a guess.
 *
 * `tempoConfidence` has always been measured and never shown. On a track with
 * rubato, a long quiet intro or a loose drummer it comes out low, and the grid
 * that everything else is drawn against is then shaky in a way nothing on
 * screen admitted to. Snap all to grid on a track like that makes the chart
 * worse, so the warning has to arrive before the button does.
 */
function updateTempoNote() {
  const c = state.chart;
  const el = $('tempo-note');
  if (!el) return;
  if (!c || !c.notes.length) { el.hidden = true; return; }
  const conf = c.tempoConfidence || 0;
  el.hidden = false;
  el.classList.toggle('warnline', conf < TEMPO_SHAKY);
  if (conf >= TEMPO_SURE) {
    el.textContent = `The beat reads clearly here, so the grid and the bar lines can be trusted.`;
  } else if (conf >= TEMPO_SHAKY) {
    el.textContent = `The tempo is a fair guess rather than a certainty. If the bar lines drift against the track, the grid is the thing to distrust first.`;
  } else {
    el.textContent = `The tempo did not come through clearly on this track, so treat the grid and the bar lines as a rough guide. Snap all to grid is likely to make this chart worse, not better.`;
  }
}

const TEMPO_SURE = 0.45;
const TEMPO_SHAKY = 0.2;

/** Move which beat counts as beat one, for tracks with a pickup. */
function shiftBarLine(by) {
  const c = state.chart;
  if (!c) return;
  c.setMeter(c.beatsPerBar, c.barOffset + by);
  applyMeterChoice();
  updateSummary();
  const at = ((c.barOffset % c.beatsPerBar) + c.beatsPerBar) % c.beatsPerBar;
  setStatus(at === 0
    ? 'Bar one is back where the detector put it.'
    : `Bar one moved ${at} ${at === 1 ? 'beat' : 'beats'} along.`);
}

function updateZoomLabel() {
  $('zoom-out').textContent = Math.round((view.pxPerSec / DEFAULT_ZOOM) * 100) + '%';
}

// ---------------------------------------------------------------- the library

/**
 * Write the working chart back to local storage, coalesced.
 *
 * Every drag of a note fires a change, and a chart of a five minute song is
 * tens of kilobytes of JSON. Serializing that on every pointermove would be
 * felt. Half a second after the last edit is soon enough to survive a closed
 * tab and cheap enough to never notice.
 */
let autosaveTimer = null;
function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    if (!state.chart) return;
    library.saveWorking(state.chart.toJSON(), {
      name: state.fileName,
      fingerprint: library.fingerprint(state.fileName, state.chart.duration || player.duration),
    });
  }, 500);
}

function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

function renderLibrary() {
  const ul = $('library-list');
  if (!ul) return;
  const rows = library.sortedCharts();
  ul.textContent = '';
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = 'Nothing saved yet. Load a track, fix up the chart, then save it here.';
    ul.appendChild(li);
    return;
  }
  for (const r of rows) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = r.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const bpm = r.bpm ? `${Math.round(r.bpm)} BPM` : 'tempo unclear';
    meta.textContent = `${r.notes} notes, ${bpm}, saved ${timeAgo(r.saved)}`;
    left.appendChild(name);
    left.appendChild(meta);
    const btns = document.createElement('div');
    btns.className = 'row';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn small';
    open.textContent = 'Open';
    open.addEventListener('click', () => openSaved(r.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn small';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      library.deleteChart(r.id);
      renderLibrary();
      setStatus(`Deleted the saved chart ${r.name}.`);
    });
    btns.appendChild(open);
    btns.appendChild(del);
    li.appendChild(left);
    li.appendChild(btns);
    ul.appendChild(li);
  }
}

function openSaved(id) {
  const row = library.getChart(id);
  if (!row) return;
  try {
    installChart(Chart.fromJSON(row.chart));
    setStatus(`Opened the saved chart ${row.name}. Bring the same audio back in to play along to it.`);
  } catch (err) {
    setStatus(`That saved chart could not be opened (${err.message || err}).`, 'bad');
  }
}

function renderRuns() {
  const ul = $('runs-list');
  if (!ul) return;
  const rows = library.listRuns().slice(0, 12);
  ul.textContent = '';
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = 'No runs yet. Play a chart through and press Finish this run.';
    ul.appendChild(li);
    return;
  }
  for (const r of rows) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = r.name || 'a track';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const bias = r.biasMs == null ? 'timing unmeasured'
      : Math.abs(r.biasMs) < 6 ? 'right in the pocket'
      : r.biasMs < 0 ? `${Math.abs(Math.round(r.biasMs))} ms early` : `${Math.round(r.biasMs)} ms late`;
    meta.textContent = `${Math.round(r.accuracy * 100)}% accurate, best combo ${r.bestCombo}, ${bias}, ${timeAgo(r.at)}`;
    left.appendChild(name);
    left.appendChild(meta);
    li.appendChild(left);
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------- the results

const BIAS_WORDS = (ms) => ms == null ? 'no data'
  : Math.abs(ms) < 6 ? 'right in the pocket'
  : ms < 0 ? `${Math.abs(Math.round(ms))} ms early` : `${Math.round(ms)} ms late`;

/**
 * The sentence at the top of the results.
 *
 * A number nobody knows what to do with is not feedback. The most useful thing
 * a practice tool can say is which limb is behind and whether the problem is an
 * offset or a wobble, because those have different fixes. An offset is fixed by
 * calibration or by moving where you feel the beat. A wobble is fixed by
 * playing slower.
 */
function headline(s, best) {
  if (!s.total) return 'Nothing was judged in that run, so there is nothing to report.';
  const acc = Math.round(s.accuracy * 100);
  const bits = [`${acc}% accurate over ${s.total} judged hits.`];
  if (s.spreadMs != null && s.biasMs != null) {
    if (Math.abs(s.biasMs) > 18 && s.spreadMs < 70) {
      bits.push(`You are steady but consistently ${s.biasMs < 0 ? 'ahead of' : 'behind'} the beat, which calibration or a small change of feel will fix.`);
    } else if (s.spreadMs >= 70) {
      bits.push('Your hits are scattered rather than simply offset, so slowing the track down will do more than any setting here.');
    } else {
      bits.push('Timing is both centered and tight, which is the hard one.');
    }
  }
  if (s.weakest) bits.push(`The ${LANE_LABEL[s.weakest.lane].toLowerCase()} is the lane holding this back.`);
  if (best && s.accuracy > best.accuracy) bits.push('That is your best run on this track.');
  return bits.join(' ');
}

function renderResults(s, name, best = library.personalBest(name)) {
  $('res-headline').textContent = headline(s, best);
  $('res-acc').textContent = Math.round(s.accuracy * 100) + '%';
  $('res-combo').textContent = String(s.bestCombo);
  $('res-bias').textContent = BIAS_WORDS(s.biasMs);
  $('res-spread').textContent = s.spreadMs == null ? 'no data' : `${Math.round(s.spreadMs)} ms spread`;

  const ul = $('res-hist');
  ul.textContent = '';
  const peak = Math.max(1, ...s.hist);
  s.hist.forEach((n, i) => {
    const li = document.createElement('li');
    if (HIST_LABELS[i] === 'on it') li.className = 'mid';
    const label = document.createElement('span');
    label.textContent = HIST_LABELS[i];
    const track = document.createElement('span');
    track.className = 'bartrack';
    const fill = document.createElement('span');
    fill.className = 'barfill';
    fill.style.width = Math.round((n / peak) * 100) + '%';
    track.appendChild(fill);
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(n);
    li.appendChild(label);
    li.appendChild(track);
    li.appendChild(count);
    ul.appendChild(li);
  });

  const tbody = $('res-lanes').querySelector('tbody');
  tbody.textContent = '';
  for (const lane of LANES) {
    const v = s.lanes[lane];
    const tr = document.createElement('tr');
    if (s.weakest && s.weakest.lane === lane) tr.className = 'weak';
    const cells = [
      LANE_LABEL[lane],
      v ? String(v.played) : '0',
      v && v.accuracy != null ? Math.round(v.accuracy * 100) + '%' : 'not played',
      v ? BIAS_WORDS(v.biasMs) : 'no data',
      v ? String(v.miss) : '0',
    ];
    cells.forEach((text, i) => {
      const cell = document.createElement(i === 0 ? 'th' : 'td');
      if (i === 0) cell.scope = 'row';
      cell.textContent = text;
      tr.appendChild(cell);
    });
    tbody.appendChild(tr);
  }

  $('res-best').textContent = best
    ? `Your best on this track so far is ${Math.round(best.accuracy * 100)}% accurate, from ${timeAgo(best.at)}.`
    : 'This is the first run recorded for this track.';
  $('results').hidden = false;
}

/** End the run, report it, keep it, and reset for the next one. */
function finishRun() {
  const s = scorer.summary();
  const name = baseName();
  // Read the previous best BEFORE this run joins the history, or the run is
  // compared against itself and can never be a personal best.
  const prevBest = library.personalBest(name);
  if (s.total) {
    library.addRun({
      name,
      accuracy: s.accuracy,
      score: s.score,
      bestCombo: s.bestCombo,
      biasMs: s.biasMs,
      spreadMs: s.spreadMs,
      total: s.total,
    });
  }
  renderResults(s, name, prevBest);
  renderRuns();
  player.pause();
  scorer.reset();
  updateScore();
  $('results').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return s;
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

// A pad the app does not recognize. "MIDI drum kit" is not a standard: the
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
  setStatus(`Unrecognized pad, MIDI note ${note}. Pick the drum it should count as.`, 'busy');
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
  updateBarClock(t);
  rail.setTime(t);
  if (!seeking && player.duration) $('seek').value = String(Math.round((t / player.duration) * 1000));
  view.render();
  requestAnimationFrame(frame);
}

/**
 * Bars and beats beside the clock.
 *
 * A drummer thinks in bars, not in seconds, and this also makes a wrong time
 * signature obvious immediately rather than as a vague feeling that the chart
 * looks off. Written only when it changes, since this runs every frame.
 */
let lastBarText = '';
function updateBarClock(t) {
  const c = state.chart;
  let text = 'Bar 1, beat 1';
  if (c && c.period) {
    const b = c.beatAt(t);
    text = `Bar ${b.bar}, beat ${b.beat}`;
  }
  if (text === lastBarText) return;
  lastBarText = text;
  $('barclock').textContent = text;
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
  const off = state.chart.step ? `${Math.round((n.t - state.chart.quantizeTime(n.t)) * 1000)} ms off the grid` : 'no grid';
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

export function exportMidiBytes(quantized = false) {
  if (!state.chart) return null;
  return writeMidi(state.chart, { quantized, name: baseName() });
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
    // Two channels so the center cut has something to work with.
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
    const moved = state.chart ? state.chart.quantizeAll() : 0;
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
  $('loop-off').addEventListener('click', () => { applyLoop(null); setStatus('Loop cleared.'); });

  $('bar-back').addEventListener('click', () => shiftBarLine(-1));
  $('bar-fwd').addEventListener('click', () => shiftBarLine(1));

  $('zoom-wider').addEventListener('click', () => { view.zoomBy(1 / 1.35); updateZoomLabel(); });
  $('zoom-closer').addEventListener('click', () => { view.zoomBy(1.35); updateZoomLabel(); });
  $('zoom-reset').addEventListener('click', () => { view.setZoom(DEFAULT_ZOOM); updateZoomLabel(); });
  view.onzoom = () => updateZoomLabel();

  $('run-end').addEventListener('click', () => finishRun());
  $('res-close').addEventListener('click', () => { $('results').hidden = true; });

  $('match-use').addEventListener('click', () => {
    if (pendingMatch) openSaved(pendingMatch.id);
    $('match-offer').hidden = true;
    pendingMatch = null;
  });
  $('match-skip').addEventListener('click', () => {
    $('match-offer').hidden = true;
    pendingMatch = null;
    setStatus('Keeping the fresh analysis. Your saved chart is still in the library.');
  });

  $('save-chart').addEventListener('click', () => {
    if (!state.chart) { setStatus('There is no chart to save yet.', 'bad'); return; }
    const name = ($('save-name').value || '').trim() || baseName();
    const r = library.saveChart(name, state.chart.toJSON(), {
      fingerprint: library.fingerprint(state.fileName, state.chart.duration || player.duration),
    });
    if (!r.ok) { setStatus(r.reason, 'bad'); return; }
    renderLibrary();
    setStatus(`Saved ${name} to this browser.`);
  });

  $('runs-clear').addEventListener('click', () => {
    library.clearRuns();
    renderRuns();
    setStatus('Run history cleared.');
  });

  $('ex-midi').addEventListener('click', () => {
    const bytes = exportMidiBytes(false);
    if (bytes) download(baseName() + '.mid', new Blob([bytes], { type: 'audio/midi' }));
  });
  $('ex-midi-q').addEventListener('click', () => {
    const bytes = exportMidiBytes(true);
    if (bytes) download(baseName() + ' quantized.mid', new Blob([bytes], { type: 'audio/midi' }));
  });
  $('ex-chart').addEventListener('click', () => {
    if (!state.chart) return;
    download(baseName() + '.json', new Blob([JSON.stringify(state.chart.toJSON(), null, 1)], { type: 'application/json' }));
  });
  $('im-chart').addEventListener('click', () => $('chartfile').click());
  $('chartfile').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    ev.target.value = '';
    try {
      // Same clean slate a new audio file gets. A chart swapped in under a live
      // loop region and a stale selection is the same desync, by another door.
      installChart(Chart.fromJSON(JSON.parse(await f.text())));
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

  $('reanalyze').addEventListener('click', () => reanalyze());

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
    applyLoop(null);
    setStatus('That loop would be shorter than a fifth of a second, so it was not set. Move the play head and mark the other end.', 'bad');
    return false;
  }
  applyLoop({ a: lo, b: hi });
  setStatus(`Looping ${fmt(lo)} to ${fmt(hi)}.`);
  return true;
}

function updateLoopNote() {
  const l = player.loop;
  $('loop-note').textContent = l && l.b > l.a
    ? `Looping ${fmt(l.a)} to ${fmt(l.b)}, which is ${(l.b - l.a).toFixed(1)} seconds.`
    : 'No loop set. Drag either handle on the bar above to mark a section.';
}

function updateDuckAvailability() {
  const stereo = player.channels >= 2;
  $('duck').disabled = !stereo;
  if (!stereo) $('duck-note').textContent = 'This file is mono, so there is no center to remove. Load a stereo track to use this.';
}

// -------------------------------------------------------------------- start

hub.attachKeyboard();
wire();
view.resize();
$('cal-out').textContent = `${hub.offsetMs} ms`;
updateZoomLabel();
renderLibrary();
renderRuns();

/**
 * Bring back whatever was on screen last time.
 *
 * The audio cannot come back, since keeping someone's music in local storage
 * would be both rude and far too large, but the chart is the part that took
 * work. Restoring it means the second session on a song starts where the first
 * one stopped rather than at a blank drop zone.
 */
(function restoreWorking() {
  const w = library.loadWorking();
  if (!w) return;
  try {
    const c = Chart.fromJSON(w.chart);
    if (!c.notes.length) return;
    state.fileName = w.name || '';
    installChart(c, { autosave: false });
    setStatus(`Picked up the chart you were working on${w.name ? ` for ${w.name}` : ''}. Bring the audio back in to play along to it.`);
  } catch { /* a chart from an older format is not worth an error message */ }
})();

requestAnimationFrame(frame);

// Everything the tests drive, and anything a curious user wants in the console.
window.playalong = {
  state, player, hub, scorer, view, calibrator, rail, library,
  analyze, analyzeBuffer, runAnalysis, estimateMeter,
  renderHits, rockPattern,
  writeMidi, readMidi, exportMidiBytes,
  Chart, LANES, LANE_LABEL, KEY_MAP, DEFAULTS,
  loadBlob, reanalyze, setMode, restart, togglePlay,
  setLoop, signatureLabel, applyMeterChoice, updateSummary,
  openSaved, offerSavedChart, finishRun, shiftBarLine, installChart,
  renderLibrary, renderRuns,
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
  /** Analyze without touching playback, for measuring detection on its own. */
  analyzeSamples(samples, sampleRate = 44100, opts = {}) {
    const f32 = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    return analyze(f32, sampleRate, opts);
  },
};
