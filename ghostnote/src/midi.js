// midi.js — write and read a Standard MIDI File.
//
// Turning audio into drum MIDI is half the value of this app even if you never
// play along, so the export has to be a real SMF that a DAW opens, not a hopeful
// blob. The reader exists so a round trip can be checked in the tests.

/** General MIDI percussion note numbers, channel 10. */
export const GM = { kick: 36, snare: 38, hat: 42, tom: 45 };
export const FROM_GM = (() => {
  const m = {};
  // Everything a kit is likely to send, folded into the four lanes we chart.
  for (const n of [35, 36]) m[n] = 'kick';
  for (const n of [37, 38, 39, 40]) m[n] = 'snare';
  for (const n of [42, 44, 46, 49, 51, 52, 53, 55, 57, 59]) m[n] = 'hat';
  for (const n of [41, 43, 45, 47, 48, 50]) m[n] = 'tom';
  return m;
})();

const PPQ = 480;

function vlq(n) {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return bytes;
}

function str(s) { return [...s].map((c) => c.charCodeAt(0)); }
function be32(n) { return [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function be16(n) { return [(n >> 8) & 255, n & 255]; }

/**
 * @param {import('./chart.js').Chart} chart
 * @param {{quantized?:boolean, name?:string}} opts
 * @returns {Uint8Array}
 */
/**
 * The time signature to stamp on the file, and the quarter note tempo that goes
 * with it.
 *
 * Six beats to a bar is read as 6/8, because that is what six almost always
 * means and because the beat the analyzer locked onto in that case is the
 * eighth. A quarter is then two of those beats, so the tempo written into the
 * file is half the beat rate the app works in, and an eighth still lands on 240
 * ticks. Every other count is written over a quarter, so five beats is 5/4.
 */
function signature(beatsPerBar, bpm) {
  const n = Math.max(1, Math.min(16, Math.round(beatsPerBar) || 4));
  if (n === 6) return { num: 6, denomPow: 3, clicksPerBeat: 36, quarterBpm: bpm / 2 };
  return { num: n, denomPow: 2, clicksPerBeat: 24, quarterBpm: bpm };
}

export function writeMidi(chart, opts = {}) {
  const beatBpm = chart.bpm > 0 ? chart.bpm : 120;
  const sig = signature(chart.beatsPerBar || 4, beatBpm);
  const bpm = sig.quarterBpm;
  const secPerTick = 60 / bpm / PPQ;
  const useQ = !!opts.quantized;

  const events = [];
  for (const n of chart.notes) {
    const t = useQ && n.tq != null ? n.tq : n.t;
    const on = Math.max(0, Math.round(t / secPerTick));
    const note = GM[n.lane] != null ? GM[n.lane] : GM.snare;
    const vel = Math.max(1, Math.min(127, Math.round((n.vel || 0.8) * 127)));
    events.push({ tick: on, order: 1, data: [0x99, note, vel] });
    // Percussion is one shot, but a note on with no note off leaves some hosts
    // holding the voice forever, so close it a 32nd later.
    events.push({ tick: on + PPQ / 8, order: 0, data: [0x89, note, 0x40] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track = [];
  // tempo meta
  const usPerQuarter = Math.round(60000000 / bpm);
  track.push(0x00, 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 255, (usPerQuarter >> 8) & 255, usPerQuarter & 255);
  // The real time signature. This used to be 4/4 no matter what the chart said,
  // so a waltz exported into a DAW had its bar lines in the wrong place and
  // every note appeared to be on the wrong beat.
  track.push(0x00, 0xff, 0x58, 0x04, sig.num, sig.denomPow, sig.clicksPerBeat, 8);
  // track name
  const name = str(opts.name || 'Play Along drums');
  track.push(0x00, 0xff, 0x03, ...vlq(name.length), ...name);

  let last = 0;
  for (const e of events) {
    track.push(...vlq(e.tick - last), ...e.data);
    last = e.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00); // end of track

  const header = [...str('MThd'), ...be32(6), ...be16(0), ...be16(1), ...be16(PPQ)];
  const chunk = [...str('MTrk'), ...be32(track.length), ...track];
  return new Uint8Array([...header, ...chunk]);
}

/** Minimal reader, enough to prove a written file parses back to the same notes. */
export function readMidi(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const txt = (i, n) => String.fromCharCode(...b.slice(i, i + n));
  if (txt(0, 4) !== 'MThd') throw new Error('Not a MIDI file');
  const headerLen = (b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7];
  const format = (b[8] << 8) | b[9];
  const tracks = (b[10] << 8) | b[11];
  const division = (b[12] << 8) | b[13];
  let p = 8 + headerLen;
  const notes = [];
  let usPerQuarter = 500000;
  let timeSignature = null;

  for (let tr = 0; tr < tracks; tr++) {
    if (txt(p, 4) !== 'MTrk') throw new Error('Missing MTrk chunk');
    const len = (b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7];
    let i = p + 8;
    const end = i + len;
    let tick = 0, running = 0;
    while (i < end) {
      let delta = 0, byte;
      do { byte = b[i++]; delta = (delta << 7) | (byte & 0x7f); } while (byte & 0x80);
      tick += delta;
      let status = b[i];
      if (status & 0x80) { i++; running = status; } else status = running;
      if (status === 0xff) {
        const type = b[i++];
        let l = 0;
        do { byte = b[i++]; l = (l << 7) | (byte & 0x7f); } while (byte & 0x80);
        if (type === 0x51) usPerQuarter = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
        if (type === 0x58) timeSignature = { numerator: b[i], denominator: 2 ** b[i + 1] };
        i += l;
      } else if (status === 0xf0 || status === 0xf7) {
        let l = 0;
        do { byte = b[i++]; l = (l << 7) | (byte & 0x7f); } while (byte & 0x80);
        i += l;
      } else {
        const kind = status & 0xf0;
        const chan = status & 0x0f;
        const d1 = b[i++];
        const twoData = kind !== 0xc0 && kind !== 0xd0;
        const d2 = twoData ? b[i++] : 0;
        if (kind === 0x90 && d2 > 0) notes.push({ tick, channel: chan, note: d1, velocity: d2 });
      }
    }
    p = end;
  }
  const secPerTick = usPerQuarter / 1e6 / division;
  return {
    format, tracks, division, timeSignature,
    bpm: 60000000 / usPerQuarter,
    notes: notes.map((n) => ({ ...n, t: n.tick * secPerTick, lane: FROM_GM[n.note] || null })),
  };
}
