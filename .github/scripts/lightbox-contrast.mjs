// Lightbox contrast gate.
//
// The site-wide contrast gate only measures text that is actually rendered, and
// the media modal stays hidden until you click a thumbnail, so its caption, hint
// and counter were never audited. That is exactly how the caption shipped
// dark-on-dark in light mode: the modal keeps a dark scrim in BOTH themes, but
// its text inherited the light theme's dark ink.
//
// This opens the modal in both themes, composites the real scrim under each bit
// of bar text, and checks WCAG AA (4.5:1 for the bar text, 3:1 for the glyphs,
// which are non-text UI). Exits non-zero on failure.
//
// Usage: node .github/scripts/lightbox-contrast.mjs http://localhost:8080
//        SHOT_DIR=out node ... .mjs <base>   # also write screenshots
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8080';
const SHOT_DIR = process.env.SHOT_DIR || '';
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

const MEASURE = () => {
  const srgb = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const parse = s => {
    const m = String(s).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  };
  const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3]));

  // the bar sits directly on the .modal scrim, which sits on the page background
  const pageBg = parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255, 1];
  const html = parse(getComputedStyle(document.documentElement).backgroundColor);
  const base = pageBg[3] === 1 ? pageBg.slice(0, 3)
    : over(pageBg, html && html[3] === 1 ? html.slice(0, 3) : [255, 255, 255]);
  const scrim = parse(getComputedStyle(document.getElementById('mediaModal')).backgroundColor);
  const bg = scrim && scrim[3] > 0 ? over(scrim, base) : base;

  const out = [];
  for (const sel of ['.modal-cap', '.modal-count', '.modal-hint']) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ sel, missing: true }); continue; }
    const cs = getComputedStyle(el);
    if (cs.display === 'none') { out.push({ sel, skipped: 'display:none' }); continue; }
    const fg = parse(cs.color);
    const c = fg[3] < 1 ? over(fg, bg) : fg.slice(0, 3);
    const px = parseFloat(cs.fontSize);
    const large = px >= 24 || (px >= 18.66 && +cs.fontWeight >= 700);
    const l1 = lum(c), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    out.push({
      sel, color: cs.color, bg: `rgb(${bg.map(v => Math.round(v)).join(',')})`,
      ratio: +ratio.toFixed(2), need: large ? 3 : 4.5, pass: ratio >= (large ? 3 : 4.5),
      text: el.textContent.trim().slice(0, 48)
    });
  }
  // close / prev / next are non-text UI, measured against their own chip
  for (const sel of ['.modal-close', '.modal-nav.next']) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ sel, missing: true }); continue; }
    const cs = getComputedStyle(el);
    const chip = parse(cs.backgroundColor);
    const chipBg = chip && chip[3] < 1 ? over(chip, bg) : (chip ? chip.slice(0, 3) : bg);
    const fg = parse(cs.color);
    const c = fg[3] < 1 ? over(fg, chipBg) : fg.slice(0, 3);
    const l1 = lum(c), l2 = lum(chipBg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    out.push({
      sel, color: cs.color, bg: `rgb(${chipBg.map(v => Math.round(v)).join(',')})`,
      ratio: +ratio.toFixed(2), need: 3, pass: ratio >= 3, text: '(glyph)'
    });
  }
  return out;
};

const browser = await chromium.launch();
let failures = 0;

for (const theme of ['dark', 'light']) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });

    if (theme === 'light') {
      const toggled = await page.evaluate(() => {
        const b = document.getElementById('themeToggle');
        if (!b) return false;
        b.click();
        return document.documentElement.getAttribute('data-theme') === 'light';
      });
      // A missing toggle must fail, not silently audit dark mode twice.
      if (!toggled) throw new Error('could not switch to the light theme (#themeToggle)');
      await page.waitForTimeout(300);
    }

    const thumb = page.locator('.thumb:not(.thumb-video)').first();
    if (!await thumb.count()) throw new Error('no image thumbnail found to open the lightbox');
    await thumb.scrollIntoViewIfNeeded();
    await thumb.click();
    await page.waitForSelector('#mediaModal.open', { timeout: 5000 });
    await page.waitForTimeout(400);
  } catch (e) {
    console.log(`::error::lightbox contrast gate could not open the viewer in ${theme} mode: ${e.message}`);
    failures++;
    await page.close();
    continue;
  }

  console.log(`\n=== lightbox [${theme}] ===`);
  for (const r of await page.evaluate(MEASURE)) {
    if (r.missing) { console.log(`   ::error::${r.sel} not found in the open modal`); failures++; continue; }
    if (r.skipped) { console.log(`   ${r.sel} skipped (${r.skipped})`); continue; }
    if (!r.pass) failures++;
    console.log(`   ${r.pass ? 'PASS' : 'FAIL'}  ${String(r.ratio).padStart(6)}:1 (need ${r.need})  ` +
                `${r.sel}  ${r.color} on ${r.bg}  "${r.text}"`);
  }
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/lightbox-${theme}.png` });
  await page.close();
}

await browser.close();
if (failures) {
  console.log(`\n::error::${failures} lightbox contrast failure(s). The modal bar must clear WCAG AA in both themes.`);
  process.exit(1);
}
console.log('\nLightbox contrast gate passed in both themes.');
