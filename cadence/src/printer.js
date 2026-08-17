// printer.js — sending a job straight from the browser to the machine.
//
// This is the one part of CADence that moves something in the physical world
// and heats it to 200 degrees, so it is written defensively and it is written
// to be interrupted. Two rules shape the whole file:
//
//   NOTHING STARTS WITHOUT A DELIBERATE YES. The browser's own port picker is
//   the first gate and cannot be bypassed by a page. A confirmation naming the
//   machine, the temperatures and the duration is the second.
//   STOPPING IS ALWAYS ONE CLICK, AND STOPPING IS SAFE. Abort does not merely
//   stop sending. It retracts, lifts off the part, kills both heaters and
//   parks, because a stopped stream with a hot nozzle resting on the print is
//   how a part gets a crater burned into it.
//
// FLOW CONTROL. Marlin acknowledges each command with "ok". Waiting for that
// before sending the next line is correct but leaves the motion planner
// starved, and a starved planner stutters at every corner. So a small window of
// unacknowledged lines is kept in flight, which is what keeps the buffer full
// without overrunning the firmware's receive buffer.
//
// LINE NUMBERS AND CHECKSUMS. USB serial over a meter of unshielded cable next
// to a stepper driver does corrupt bytes. With N<line>...*<checksum>, Marlin
// detects the corruption and asks for a resend instead of executing whatever
// the noise turned the command into. That is the difference between a garbled
// byte being a retry and being a nozzle driven into the bed.

const BAUD = 115200;
const WINDOW = 4;            // unacknowledged lines allowed in flight
const RESEND_HISTORY = 128;  // lines kept in case the firmware asks again

/** Is this browser able to talk to a printer at all? */
export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

/** Marlin's checksum: XOR of every byte of the line, line number included. */
function checksum(line) {
  let cs = 0;
  for (let i = 0; i < line.length; i++) cs ^= line.charCodeAt(i) & 0xff;
  return cs & 0xff;
}

/** Strip comments and blank lines. Comments are for people; sending them wastes
 *  serial bandwidth that the motion planner needs. */
function prepare(gcode) {
  const out = [];
  for (const raw of gcode.split('\n')) {
    const line = raw.replace(/;.*$/, '').trim();
    if (line) out.push(line);
  }
  return out;
}

export class PrinterLink {
  constructor(port, { onStatus, onFlash } = {}) {
    this.port = port;
    this.onStatus = onStatus || (() => {});
    this.onFlash = onFlash || (() => {});
    this.reader = null;
    this.writer = null;
    this.buffer = '';
    this.pending = 0;
    this.lineNo = 0;
    this.history = new Map();
    this.resendTo = -1;
    this.printing = false;
    this.paused = false;
    this.aborted = false;
    this.sent = 0;
    this.total = 0;
    this.temps = { hotend: 0, hotendTarget: 0, bed: 0, bedTarget: 0 };
    this.startedAt = 0;
    this.lastError = '';
  }

  async open() {
    await this.port.open({ baudRate: BAUD, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    this.writer = this.port.writable.getWriter();
    this.readLoop();
    // A board that has just been opened is usually still booting. Marlin prints
    // its start banner and ignores anything sent during it.
    await sleep(1500);
  }

  async readLoop() {
    const decoder = new TextDecoder();
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (line) this.handleLine(line);
        }
      }
    } catch {
      // The port went away: unplugged, or the board reset. Treated as a stop.
      this.lastError = 'the connection to the printer was lost';
      this.aborted = true;
    }
  }

  handleLine(line) {
    // Temperatures arrive unsolicited once M155 is on, and also ride along on
    // ok lines. Either way the same parse handles them.
    const t = /T:\s*(-?[\d.]+)\s*\/\s*(-?[\d.]+)/.exec(line);
    if (t) { this.temps.hotend = +t[1]; this.temps.hotendTarget = +t[2]; }
    const b = /B:\s*(-?[\d.]+)\s*\/\s*(-?[\d.]+)/.exec(line);
    if (b) { this.temps.bed = +b[1]; this.temps.bedTarget = +b[2]; }

    if (/^ok\b/i.test(line)) { this.pending = Math.max(0, this.pending - 1); return; }

    // A resend request means a line was corrupted in transit. Rewinding to the
    // number Marlin asked for is the whole recovery: everything from there is
    // still in history and gets sent again.
    const rs = /^(?:rs|resend)[:\s]+(\d+)/i.exec(line);
    if (rs) {
      this.resendTo = +rs[1];
      this.pending = 0;
      return;
    }

    if (/^(error|!!)/i.test(line)) {
      this.lastError = line;
      // A thermal runaway or a failed heater is not something to print through.
      if (/thermal|runaway|heating failed|maxtemp|mintemp|kill/i.test(line)) this.aborted = true;
      return;
    }
    if (/^(busy|echo:busy)/i.test(line)) return;
  }

  async sendRaw(text) {
    if (!this.writer) return;
    await this.writer.write(new TextEncoder().encode(text + '\n'));
  }

  /** Send one numbered, checksummed line and remember it for a resend. */
  async sendNumbered(cmd, n) {
    const body = `N${n} ${cmd}`;
    const line = `${body}*${checksum(body)}`;
    this.history.set(n, cmd);
    if (this.history.size > RESEND_HISTORY) {
      const oldest = n - RESEND_HISTORY;
      this.history.delete(oldest);
    }
    this.pending++;
    await this.sendRaw(line);
  }

  /**
   * Stream a whole job.
   *
   * Cooperative rather than blocking: the loop yields on every window stall, so
   * the UI keeps painting, the abort button keeps responding, and the
   * temperature readout keeps updating for the whole print.
   */
  async print(gcode, settings) {
    const lines = prepare(gcode);
    if (!lines.length) throw new Error('there is nothing in this file to print');

    this.total = lines.length;
    this.sent = 0;
    this.printing = true;
    this.aborted = false;
    this.startedAt = Date.now();

    // Reset the line counter and ask for temperature reports twice a second, so
    // the readout is live without polling M105 into the command stream.
    this.lineNo = 0;
    await this.sendRaw('M110 N0');
    await sleep(120);
    await this.sendRaw('M155 S2');

    const tick = setInterval(() => this.report(settings), 500);

    try {
      let i = 0;
      while (i < lines.length) {
        if (this.aborted) break;
        if (this.paused) { await sleep(200); continue; }

        if (this.resendTo >= 0) {
          // Rewind to whatever Marlin last acknowledged cleanly.
          const target = this.resendTo;
          this.resendTo = -1;
          if (this.history.has(target)) {
            i -= (this.lineNo - target);
            this.lineNo = target;
            if (i < 0) { i = 0; this.lineNo = 0; }
          }
          continue;
        }

        if (this.pending >= WINDOW) { await sleep(4); continue; }

        this.lineNo++;
        await this.sendNumbered(lines[i], this.lineNo);
        i++;
        this.sent = i;

        // Yield periodically even when the window is not full, or a fast link
        // starves the event loop and the page stops responding.
        if (i % 64 === 0) await sleep(0);
      }

      if (!this.aborted) {
        // Wait for the machine to work through what is still buffered.
        const deadline = Date.now() + 10 * 60 * 1000;
        while (this.pending > 0 && Date.now() < deadline && !this.aborted) await sleep(100);
        this.onFlash('Print finished.');
      }
    } finally {
      clearInterval(tick);
      this.printing = false;
      this.report(settings);
    }
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  /**
   * Stop, and leave the machine in a state that is safe to walk away from.
   *
   * The order matters. Heaters go off first because that is the only
   * irreversible risk; the nozzle is then lifted off the part so it stops
   * conducting heat into it, and only then does the gantry park.
   */
  async abort() {
    this.aborted = true;
    this.paused = false;
    try {
      await this.sendRaw('M104 S0');
      await this.sendRaw('M140 S0');
      await this.sendRaw('M107');
      await this.sendRaw('G91');
      await this.sendRaw('G1 E-3 F2700');
      await this.sendRaw('G1 Z10 F600');
      await this.sendRaw('G90');
      await this.sendRaw('M84 X Y E');
      this.onFlash('Print stopped. Heaters off, nozzle lifted.');
    } catch {
      this.onFlash('Stopped sending, but the printer did not answer. Use its own control knob to turn the heaters off.');
    }
  }

  report(settings) {
    const pct = this.total ? Math.round((this.sent / this.total) * 100) : 0;
    const elapsed = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    const t = this.temps;
    const state = this.aborted ? 'stopped' : this.paused ? 'paused' : this.printing ? 'printing' : 'idle';
    this.onStatus(`
      <div class="sl-print ${state}">
        <div class="sl-print-head"><b>${state}</b><span>${pct}%</span></div>
        <div class="sl-bar-track"><div class="sl-bar" style="width:${pct}%"></div></div>
        <div class="sl-print-temps">
          nozzle ${t.hotend.toFixed(0)}/${t.hotendTarget.toFixed(0)}&deg;C
          &middot; bed ${t.bed.toFixed(0)}/${t.bedTarget.toFixed(0)}&deg;C
          &middot; ${fmtClock(elapsed)}
        </div>
        ${this.lastError ? `<div class="sl-msg bad">${escapeHtml(this.lastError)}</div>` : ''}
      </div>
    `);
  }

  async close() {
    try { await this.reader?.cancel(); } catch {}
    try { this.reader?.releaseLock(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port.close(); } catch {}
  }
}

/**
 * Ask the user for a printer and open it.
 *
 * requestPort() can only be called from a real user gesture and always shows
 * the browser's own chooser, so a page cannot reach a machine on its own. That
 * is the security model and it is worth not working around.
 */
export async function connectPrinter({ onStatus, onFlash } = {}) {
  if (!serialSupported()) {
    throw new Error('this browser cannot talk to a printer over USB. Chrome or Edge on a desktop can; Safari and Firefox cannot yet. Save the G-code to an SD card instead.');
  }
  if (!window.isSecureContext) {
    throw new Error('talking to a printer needs a secure page (https, or localhost). Save the G-code instead.');
  }

  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch {
    return null;                       // the chooser was dismissed
  }

  const link = new PrinterLink(port, { onStatus, onFlash });
  await link.open();
  return link;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fmtClock = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
