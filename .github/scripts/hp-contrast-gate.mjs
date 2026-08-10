/**
 * HACKING PARADISE contrast gate.
 *
 * WHY THIS EXISTS
 * The generic crawler (ci-contrast-local.mjs) cannot measure /hp/. That page
 * animates --bg continuously from scroll depth and reveals sections through an
 * IntersectionObserver, and the crawler scrolls to the bottom and back before
 * taking one sample. So it samples a different moment every run. On 2026-08-06
 * six runs against UNCHANGED HP reported 28, 62, 92, 94, 109 and 146 failures,
 * and a good fix was very nearly reverted on the strength of one of those pairs.
 *
 * WHAT THIS DOES INSTEAD
 *  1. Freezes the page. reducedMotion makes .r reveals render at their final
 *     state through the site's own accessibility rule, and every .r is forced
 *     .in as a belt-and-braces second path. Transient .fx sparkles are skipped,
 *     since they are decoration that exists for under a second.
 *  2. Sweeps a FIXED ladder of scroll depths, dense across the 0.66-0.80 band
 *     where the palette crossfades to paradise fastest, and audits at each one.
 *  3. Keys each failure by element identity plus its text, NOT by ratio, and
 *     keeps the WORST ratio that key reaches anywhere in the sweep. Ratio is a
 *     continuous function of depth here, so the key is the stable part.
 *  4. Runs the whole sweep TWICE and compares. If the two passes disagree the
 *     instrument reports itself unstable and gates nothing, rather than emitting
 *     a number nobody can trust. That was the original sin.
 *
 * THE BASELINE
 * HP has one known band that no flat colour can fix. Where the background
 * crosses luminance ~0.199 on its way to paradise, the best contrast any ink can
 * reach is about 3.5:1, and the page already flips --ink at the mathematically
 * optimal crossover point. Failing the build on a known-optimal band would just
 * teach everyone to ignore the gate, so accepted failures live in
 * hp-contrast-baseline.json. The gate fails on anything NEW, or on an accepted
 * failure that gets materially worse. That makes it a ratchet: HP can only
 * improve.
 *
 * Usage:
 *   bun hp-contrast-gate.mjs <base-url> [--update-baseline] [--quiet]
 *   e.g. bun hp-contrast-gate.mjs http://localhost:5185
 *
 * Exit codes: 0 pass, 1 new or worsened failures, 2 instrument unstable.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = (process.argv[2] || 'http://localhost:5185').replace(/\/$/, '');
const UPDATE = process.argv.includes('--update-baseline');
const QUIET = process.argv.includes('--quiet');
// Not import.meta.dir: that is a Bun extension, and the CI copy of this script
// runs under Node.
const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, 'hp-contrast-baseline.json');

// A ratio may drift a little between runs from sub-pixel layout. Anything inside
// this band is the same number for our purposes.
const TOLERANCE = 0.05;

// Fixed ladder. Coarse everywhere, dense through the paradise crossfade, and
// pinned exactly on the palette stops from the page itself.
const DEPTHS = [...new Set([
  ...Array.from({ length: 21 }, (_, i) => +(i * 0.05).toFixed(2)),
  ...Array.from({ length: 15 }, (_, i) => +(0.66 + i * 0.01).toFixed(2)),
  0.34, 0.50, 0.73,
])].sort((a, b) => a - b);

// Kept self-contained on purpose: this function is serialised into the page, and
// the CI copy of it has to run from a checkout with no harness on disk. It is the
// same algorithm as contrast-audit.mjs, including the two corrections that one
// learned the hard way (gradient backgrounds, and text sitting over media the
// ancestor walk cannot see). If you fix a scoring bug here, fix it there too.
const AUDIT = () => {
  const srgb = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const parse = s => {
    const m = String(s).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  };
  const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3]));

  // A gradient paints a real background but leaves backgroundColor transparent.
  // Without this the ancestor walk sails straight past it and scores against
  // whatever is further up, which is how HP's dark avatar initials on a bright
  // gradient measured 1:1 while really being high contrast.
  const gradientStops = s => {
    if (!s || s === 'none' || !/gradient\(/.test(s)) return [];
    const out = [];
    const re = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/g;
    let m;
    while ((m = re.exec(s))) out.push([+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]]);
    return out;
  };

  // Every plausible background behind this text. Usually one colour, but a
  // gradient contributes each of its stops so the caller can score the worst.
  const effBg = el => {
    let n = el;
    const stack = [];
    let base = [255, 255, 255];
    let grads = [];
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      // Record the nearest gradient but keep walking. A decorative wash is often
      // semi-transparent and means nothing until composited over the opaque
      // colour beneath it.
      if (!grads.length) grads = gradientStops(cs.backgroundImage);
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) stack.push(c);
      if (c && c[3] === 1) { base = [c[0], c[1], c[2]]; break; }
      n = n.parentElement;
    }
    let acc = base;
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i][3] < 1) acc = over(stack[i], acc);
    if (!grads.length) return [acc];
    return grads.map(g => (g[3] < 1 ? over(g, acc) : [g[0], g[1], g[2]]));
  };

  // Text can also sit on something the ancestor walk never sees: a sibling
  // canvas, an img, or a painted background-image. effBg then reports the page
  // background and invents a failure. Flag those rather than scoring them.
  const painters = [...document.querySelectorAll('canvas, img, video, svg')].filter(n => {
    const cs = getComputedStyle(n);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).map(n => ({ n, r: n.getBoundingClientRect() }));
  const coversText = el => {
    const r = el.getBoundingClientRect();
    for (const p of painters) {
      if (p.n === el || p.n.contains(el) || el.contains(p.n)) continue;
      if (p.r.left <= r.left && p.r.top <= r.top && p.r.right >= r.right && p.r.bottom >= r.bottom) return true;
    }
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const bi = getComputedStyle(n).backgroundImage;
      if (bi && bi !== 'none' && !/^(linear|radial|conic)-gradient/.test(bi)) return true;
    }
    return false;
  };

  const out = [];
  document.querySelectorAll('body *').forEach(el => {
    // Transient decoration. Spawned and removed inside a second, so including it
    // is exactly the non-determinism this gate exists to remove.
    if (el.closest('.fx')) return;
    const txt = [...el.childNodes].filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim()).join(' ').trim();
    if (!txt || txt.length < 2) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // Off-screen text is not being painted against the current palette moment,
    // and the palette is what we are sweeping. Score it at the depth where it
    // is actually visible.
    if (r.bottom < 0 || r.top > window.innerHeight) return;

    const px = parseFloat(cs.fontSize);
    const large = px >= 24 || (px >= 18.66 && +cs.fontWeight >= 700);
    const need = large ? 3 : 4.5;
    const bgs = effBg(el);
    const key = `${el.tagName.toLowerCase()}.${String(el.className || '').trim().replace(/\s+/g, '.')}|${txt.slice(0, 40)}`;
    // Not a pass, an admission: something paints under this that we cannot
    // sample, so any number we produced would be fiction.
    const overMedia = coversText(el);

    // Gradient TEXT paints through the background image, so `color` is usually
    // transparent and says nothing. Score the worst colour stop instead.
    const clipsText = cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text';
    if (clipsText) {
      const stops = gradientStops(cs.backgroundImage);
      if (!stops.length) return;
      let worst = Infinity;
      for (const st of stops) {
        for (const bg of bgs) {
          const cc = st[3] < 1 ? over(st, bg) : [st[0], st[1], st[2]];
          const l1 = lum(cc), l2 = lum(bg);
          const rr = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          if (rr < worst) worst = rr;
        }
      }
      if (worst < need) out.push({ key, txt: txt.slice(0, 55), ratio: +worst.toFixed(2), need, px: +px.toFixed(1), color: 'gradient', overMedia });
      return;
    }

    const fg = parse(cs.color);
    if (!fg || fg[3] === 0) return;
    // Worst candidate background wins. A gradient that is legible at one end and
    // not the other is still a failure.
    let ratio = Infinity;
    for (const bg of bgs) {
      const fgc = fg[3] < 1 ? over(fg, bg) : [fg[0], fg[1], fg[2]];
      const l1 = lum(fgc), l2 = lum(bg);
      const rr = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      if (rr < ratio) ratio = rr;
    }
    if (ratio < need) out.push({ key, txt: txt.slice(0, 55), ratio: +ratio.toFixed(2), need, px: +px.toFixed(1), color: cs.color, overMedia });
  });
  return out;
};

// One full sweep. Returns { key -> {worst ratio, need, depth, txt, color} }.
async function sweep(browser, label) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/hp/', { waitUntil: 'networkidle', timeout: 45000 });
  // Belt and braces: reducedMotion already lands .r at its final state via the
  // page's own media query, but forcing .in removes any dependence on that rule
  // surviving a refactor.
  await page.evaluate(() => document.querySelectorAll('.r').forEach(e => e.classList.add('in')));
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => (d.open = true)));

  const worst = new Map();
  const unmeasurable = new Set();
  for (const frac of DEPTHS) {
    await page.evaluate(async f => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.round(f * max));
      // The palette is written inside a rAF-throttled scroll handler. Two frames
      // plus a settle covers the handler and the style recalc it triggers.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise(r => setTimeout(r, 220));
    }, frac);
    const found = await page.evaluate(AUDIT);
    for (const f of found) {
      if (f.overMedia) { unmeasurable.add(f.key); continue; }
      const prev = worst.get(f.key);
      if (!prev || f.ratio < prev.ratio) worst.set(f.key, { ...f, depth: frac });
    }
  }
  await page.close();
  if (!QUIET) {
    console.log(`  sweep ${label}: ${worst.size} distinct failing element(s) across ${DEPTHS.length} depths` +
      (unmeasurable.size ? `, plus ${unmeasurable.size} over media that cannot be sampled` : ''));
  }
  return { worst, unmeasurable, errors };
}

const browser = await chromium.launch();
const a = await sweep(browser, 'A');
const b = await sweep(browser, 'B');
await browser.close();

// ---- determinism self-check -------------------------------------------------
const keysA = [...a.worst.keys()].sort();
const keysB = [...b.worst.keys()].sort();
const onlyA = keysA.filter(k => !b.worst.has(k));
const onlyB = keysB.filter(k => !a.worst.has(k));
const drifted = keysA.filter(k => b.worst.has(k) && Math.abs(a.worst.get(k).ratio - b.worst.get(k).ratio) > TOLERANCE);
if (onlyA.length || onlyB.length || drifted.length) {
  console.log('\nINSTRUMENT UNSTABLE. The two sweeps disagree, so this run gates nothing.');
  onlyA.slice(0, 8).forEach(k => console.log(`   only in sweep A: ${k}`));
  onlyB.slice(0, 8).forEach(k => console.log(`   only in sweep B: ${k}`));
  drifted.slice(0, 8).forEach(k => console.log(`   ratio drifted: ${k}  ${a.worst.get(k).ratio} vs ${b.worst.get(k).ratio}`));
  process.exit(2);
}
if (!QUIET) console.log(`  stable: both sweeps agree on ${keysA.length} key(s)\n`);

// Worst of the two sweeps, so a borderline case is never rounded in our favour.
const current = {};
for (const k of keysA) {
  const x = a.worst.get(k), y = b.worst.get(k);
  const w = x.ratio <= y.ratio ? x : y;
  current[k] = { ratio: w.ratio, need: w.need, px: w.px, depth: w.depth, txt: w.txt, color: w.color };
}

if (UPDATE) {
  writeFileSync(BASELINE, JSON.stringify({
    note: 'Accepted HP contrast failures. Regenerate with: bun hp-contrast-gate.mjs <url> --update-baseline. Everything in here is a deliberate acceptance, not a pass.',
    recorded: new Date().toISOString().slice(0, 10),
    url: BASE,
    accepted: current,
  }, null, 2) + '\n');
  console.log(`Baseline written: ${Object.keys(current).length} accepted failure(s) -> ${BASELINE}`);
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).accepted || {} : null;
if (!baseline) {
  console.log('No baseline yet. Run once with --update-baseline to record the accepted state.');
  process.exit(1);
}

const introduced = Object.keys(current).filter(k => !(k in baseline));
const worsened = Object.keys(current).filter(k => k in baseline && current[k].ratio < baseline[k].ratio - TOLERANCE);
const fixed = Object.keys(baseline).filter(k => !(k in current));

console.log(`HP contrast gate: ${Object.keys(current).length} failing element(s), ${Object.keys(baseline).length} accepted in baseline.`);
if (fixed.length) {
  console.log(`\n  ${fixed.length} accepted failure(s) no longer fail. Re-record the baseline to lock the win in:`);
  fixed.slice(0, 10).forEach(k => console.log(`     fixed  ${k}`));
}
if (introduced.length) {
  console.log(`\n  ${introduced.length} NEW contrast failure(s):`);
  introduced.forEach(k => {
    const f = current[k];
    console.log(`     ${f.ratio}:1 (need ${f.need})  ${f.px}px at depth ${f.depth}  "${f.txt}"  color=${f.color}`);
  });
}
if (worsened.length) {
  console.log(`\n  ${worsened.length} accepted failure(s) got WORSE:`);
  worsened.forEach(k => console.log(`     ${baseline[k].ratio}:1 -> ${current[k].ratio}:1  "${current[k].txt}"`));
}
if (introduced.length || worsened.length) {
  console.log('\nFAILED. HP is a ratchet: it may improve, it may not regress.');
  process.exit(1);
}
console.log('\nHP contrast gate passed. Nothing new, nothing worse.');
