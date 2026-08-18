/**
 * WCAG AA contrast gate.
 *
 * Walks every text-bearing element on a page, composites its real background
 * (including translucent layers stacked over an opaque ancestor), and checks the
 * contrast ratio against the correct threshold for that text's size and weight
 * (3:1 for large text, 4.5:1 otherwise). Runs in both themes, with every <details>
 * forced open so collapsed copy is audited too.
 *
 * Exits non-zero if anything fails, so a push that breaks legibility fails CI.
 *
 * Usage: node .github/scripts/contrast.mjs http://localhost:8080 [path ...]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:8080';
const PATHS = process.argv.slice(3);
const PAGES = PATHS.length ? PATHS : ['/', '/apps/'];

const AUDIT = () => {
  const srgb = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const parse = s => {
    const m = String(s).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  };
  const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  // A gradient sets background-IMAGE and leaves background-COLOR transparent, so a
  // walk that reads only backgroundColor sails straight past it and measures the
  // text against the page instead. That is how the "Vi" wordmark reported 1.14:1
  // when it really sits between 5.24 and 12.60, and it kept CI red for two days
  // on false positives.
  //
  // A gradient is not one colour, so it cannot collapse to one backdrop. The
  // stops are returned instead and the caller checks the WORST of them, which is
  // exactly what the gradient-TEXT branch below already does in the other
  // direction. Same blind spot, opposite side of the glyph.
  const gradientStops = cs => {
    const img = cs.backgroundImage || '';
    if (!/gradient\(/.test(img)) return null;
    const stops = (img.match(/rgba?\([^)]*\)/g) || []).map(parse).filter(Boolean);
    return stops.length ? stops : null;
  };

  /**
   * Every backdrop this text could be sitting on, opaque and composited.
   *
   * Usually one colour. More than one only when a gradient paints behind the
   * text, and then the caller checks the worst stop.
   *
   * The subtlety that matters: a gradient composites over its OWN element's
   * background colour, not over whatever is behind that element. `body` here
   * carries an opaque dark colour AND a 7% green glow on top of it. Compositing
   * that glow over the page instead of over the dark colour turns a dark
   * backdrop into a near-white one and fails every paragraph on the page. So
   * the walk carries on to the end to build the base, and the stops are laid
   * over that base at the finish.
   */
  const effBgs = el => {
    let n = el;
    let acc = [255, 255, 255];
    const stack = [];
    let fan = null;
    while (n && n.nodeType === 1) {
      const ncs = getComputedStyle(n);
      // The nearest gradient wins, because it paints on top of any further out.
      // One clipped to its own text is painting glyphs, not ground, and the
      // gradient-text branch below handles that case instead.
      if (!fan && ncs.backgroundClip !== 'text' && ncs.webkitBackgroundClip !== 'text') {
        fan = gradientStops(ncs);
      }
      const c = parse(ncs.backgroundColor);
      if (c && c[3] > 0) stack.push(c);
      if (c && c[3] === 1) { acc = [c[0], c[1], c[2]]; break; }
      n = n.parentElement;
    }
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i][3] < 1) acc = over(stack[i], acc);
    if (!fan) return [acc];
    return fan.map(c => (c[3] < 1 ? over(c, acc) : [c[0], c[1], c[2]]));
  };

  // The single-colour view, for the callers that genuinely want one.
  const effBg = el => effBgs(el)[0];

  const out = [];
  document.querySelectorAll('body *').forEach(el => {
    const txt = [...el.childNodes].filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim()).join(' ').trim();
    if (!txt || txt.length < 2) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const fg = parse(cs.color); if (!fg) return;

    // Gradient text (background-clip:text) is painted by the background image, not
    // `color`, so `color` is usually transparent and tells us nothing. Instead pull
    // every colour stop out of the gradient and check the WORST one. Missing this is
    // how a 2.53:1 headline shipped twice.
    const clipsText = cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text';
    if (clipsText) {
      const stops = (cs.backgroundImage || '').match(/rgba?\([^)]*\)/g) || [];
      if (!stops.length) return;
      const bg2 = effBg(el);
      const px2 = parseFloat(cs.fontSize);
      const large2 = px2 >= 24 || (px2 >= 18.66 && +cs.fontWeight >= 700);
      const need2 = large2 ? 3 : 4.5;
      let worst = Infinity, worstStop = null;
      for (const st of stops) {
        const c = parse(st); if (!c) continue;
        const cc = c[3] < 1 ? over(c, bg2) : [c[0], c[1], c[2]];
        const l1 = lum(cc), l2 = lum(bg2);
        const r2 = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        if (r2 < worst) { worst = r2; worstStop = st; }
      }
      if (worst < need2) out.push({
        txt: txt.slice(0, 60), ratio: +worst.toFixed(2), need: need2, px: +px2.toFixed(1),
        color: `gradient stop ${worstStop}`, tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 40),
      });
      return;
    }
    if (fg[3] === 0) return;
    // Worst backdrop wins. On a flat colour there is only one; on a gradient the
    // text has to stay legible over every stop, not just the flattering end.
    const bgs = effBgs(el);
    let ratio = Infinity, bg = bgs[0];
    for (const cand of bgs) {
      const c = fg[3] < 1 ? over(fg, cand) : [fg[0], fg[1], fg[2]];
      const a = lum(c), b2 = lum(cand);
      const r2 = (Math.max(a, b2) + 0.05) / (Math.min(a, b2) + 0.05);
      if (r2 < ratio) { ratio = r2; bg = cand; }
    }
    const px = parseFloat(cs.fontSize);
    const large = px >= 24 || (px >= 18.66 && +cs.fontWeight >= 700);
    const need = large ? 3 : 4.5;
    if (ratio < need) out.push({
      txt: txt.slice(0, 60), ratio: +ratio.toFixed(2), need, px: +px.toFixed(1),
      color: cs.color, tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 40),
    });
  });
  return out;
};

const browser = await chromium.launch();
let total = 0;

for (const path of PAGES) {
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    let res = [];
    try {
      await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 45000 });
      await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
      await page.evaluate(() => document.querySelectorAll('details').forEach(d => (d.open = true)));
      await page.evaluate(async () => {
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise(r => setTimeout(r, 900));
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 400));
      });
      res = await page.evaluate(AUDIT);
    } catch (e) {
      console.error(`::error::contrast audit could not load ${path} (${theme}): ${e.message}`);
      process.exitCode = 1;
      await page.close();
      continue;
    }
    total += res.length;
    if (res.length) {
      console.log(`\n${path} [${theme}] -- ${res.length} contrast failure(s):`);
      res.slice(0, 20).forEach(f => console.log(
        `   ${f.ratio}:1 (need ${f.need})  ${f.px}px  <${f.tag} class="${f.cls}">  "${f.txt}"  color=${f.color}`));
      console.log(`::error::${res.length} WCAG AA contrast failure(s) on ${path} in ${theme} mode.`);
    } else {
      console.log(`${path} [${theme}] -- contrast OK`);
    }
    await page.close();
  }
}

await browser.close();
if (total > 0) {
  console.log(`\nFAILED: ${total} contrast issue(s). Text must clear WCAG AA (4.5:1, or 3:1 for large text).`);
  process.exit(1);
}
console.log('\nContrast gate passed in both themes.');
