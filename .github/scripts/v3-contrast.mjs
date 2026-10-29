/* v3-contrast.mjs — WCAG AA on a page whose palette MOVES.
 *
 * The ordinary contrast gate loads a page once and measures it. That is one
 * arbitrary moment, and on /v3/ the background is a continuous function of
 * scroll position, so a single sample says almost nothing. The dangerous place
 * is never the top or the bottom, it is the middle of a crossfade, where the
 * background can pass straight through the luminance of a text colour.
 *
 * So this samples DEPTH as well as page: nine scroll positions, three skins and
 * all three navigation options, measuring every rendered text node against the
 * background actually composited behind it at that moment.
 *
 *   bun .github/scripts/v3-contrast.mjs http://localhost:8080
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const SKINS = ['standard', 'pastel', 'cyber'];
const NAVS = ['rail', 'dock', 'drawer'];
const DEPTHS = [0, 0.12, 0.25, 0.38, 0.5, 0.62, 0.75, 0.88, 1];

const MEASURE = () => {
  const srgb = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * srgb(c[0]) + 0.7152 * srgb(c[1]) + 0.0722 * srgb(c[2]);
  const parse = (s) => { const m = String(s).match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : null; };
  const alpha = (s) => { const m = String(s).match(/[\d.]+/g); return m && m.length > 3 ? Number(m[3]) : 1; };
  const over = (fg, a, bg) => [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a)));
  function bgOf(el) {
    let p = el, acc = null;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p), c = parse(cs.backgroundColor), a = alpha(cs.backgroundColor);
      if (c && a > 0) acc = acc ? over(acc, 1, over(c, a, acc)) : (a >= 1 ? c : null);
      if (c && a >= 1) return acc || c;
      p = p.parentElement;
    }
    const rc = parse(getComputedStyle(document.documentElement).backgroundColor) ||
               parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255];
    return acc || rc;
  }
  const out = [];
  document.querySelectorAll('*').forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    if (r.bottom < 0 || r.top > innerHeight) return;           // offscreen is not rendered
    const txt = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (!txt) return;
    const fg = parse(cs.color); if (!fg) return;
    const bg = bgOf(el);
    const px = parseFloat(cs.fontSize), wt = parseInt(cs.fontWeight, 10) || 400;
    const need = (px >= 24 || (px >= 18.66 && wt >= 700)) ? 3 : 4.5;
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (ratio < need) out.push({ text: txt.slice(0, 44), ratio: +ratio.toFixed(2), need, px: Math.round(px),
                                 fg: 'rgb(' + fg + ')', bg: 'rgb(' + bg + ')', sel: el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0] });
  });
  return out;
};

const browser = await chromium.launch();
let checks = 0, fails = 0;
console.log(`\n— /v3/ contrast through the crossfade — ${SKINS.length} skins x ${NAVS.length} navs x ${DEPTHS.length} depths\n`);

for (const nav of NAVS) {
  for (const skin of SKINS) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await page.goto(`${BASE}/v3/?nav=${nav}&skin=${skin}`, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(500);
    let worst = null;
    for (const d of DEPTHS) {
      await page.evaluate((f) => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f), d);
      await page.waitForTimeout(260);
      const bad = await page.evaluate(MEASURE);
      checks++;
      for (const b of bad) {
        fails++;
        console.log(`::error::${nav}/${skin} @${(d * 100).toFixed(0)}%  ${b.ratio}:1 needs ${b.need}  "${b.text}"  ${b.fg} on ${b.bg}  (${b.sel})`);
        if (!worst || b.ratio < worst.ratio) worst = b;
      }
    }
    console.log(`  ${worst ? 'FAIL' : ' ok '}  ${nav.padEnd(7)} ${skin.padEnd(9)} ${DEPTHS.length} depths`);
    await page.close();
  }
}
await browser.close();
console.log(`\n  ${checks} samples taken.`);
console.log(fails ? `\n${fails} contrast failure(s).` : `\nAA holds at every depth, in every skin, under every nav.`);
process.exit(fails ? 1 : 0);
