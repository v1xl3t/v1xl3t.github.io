// Narrow / vertical viewport gate.
//
// Hard rule: on any vertical viewport (a phone, or Vi's vertical desktop
// monitor) everything must be readable without zooming or scrolling sideways.
// This loads each page at both shapes, in both themes, and fails if the
// document is wider than the viewport.
//
// It also names the widest offending element, because "the page scrolls
// sideways" is useless without knowing what is sticking out.
//
// Usage: node .github/scripts/viewport.mjs http://localhost:8080 [path ...]
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:8080';
const PATHS = process.argv.slice(3);
const PAGES = PATHS.length ? PATHS : ['/', '/apps/'];

// phone, and a vertical desktop monitor (1080x1920 rotated)
const SHAPES = [
  { name: '390x844', width: 390, height: 844 },
  { name: '1080x1920 (vertical monitor)', width: 1080, height: 1920 }
];

// 1px of slack absorbs subpixel rounding, anything real overflows by far more
const SLACK = 1;

const PROBE = (slack) => {
  const doc = document.documentElement;
  const vw = window.innerWidth;
  if (doc.scrollWidth <= vw + slack) return null;

  // find what actually sticks out past the right edge
  const worst = [];
  document.querySelectorAll('body *').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const right = r.right + window.scrollX;
    if (right > vw + slack) {
      // an element inside its own horizontal scroller is allowed to be wide
      let n = el.parentElement, contained = false;
      while (n && n !== document.body) {
        const o = getComputedStyle(n).overflowX;
        if (o === 'auto' || o === 'scroll') { contained = true; break; }
        n = n.parentElement;
      }
      if (!contained) worst.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 40),
        overflow: +(right - vw).toFixed(1)
      });
    }
  });
  worst.sort((a, b) => b.overflow - a.overflow);
  return { scrollWidth: doc.scrollWidth, innerWidth: vw, worst: worst.slice(0, 5) };
};

const browser = await chromium.launch();
let failures = 0;

for (const path of PAGES) {
  for (const shape of SHAPES) {
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({
        viewport: { width: shape.width, height: shape.height },
        deviceScaleFactor: 1
      });
      let res;
      try {
        await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 });
        if (theme === 'light') {
          await page.evaluate(() => { const b = document.getElementById('themeToggle'); if (b) b.click(); });
          await page.waitForTimeout(250);
        }
        // let lazy content and reveal animations settle, then look at the whole page
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(700);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(250);
        res = await page.evaluate(PROBE, SLACK);
      } catch (e) {
        console.log(`::error::viewport gate could not load ${path} at ${shape.name} (${theme}): ${e.message}`);
        failures++;
        await page.close();
        continue;
      }

      const label = `${path} @ ${shape.name} [${theme}]`;
      if (!res) {
        console.log(`   OK    ${label}`);
      } else {
        failures++;
        console.log(`   FAIL  ${label} -- document is ${res.scrollWidth}px wide in a ${res.innerWidth}px viewport`);
        res.worst.forEach(w => console.log(`           +${w.overflow}px past the edge: <${w.tag} class="${w.cls}">`));
        console.log(`::error::${label} scrolls horizontally.`);
      }
      await page.close();
    }
  }
}

await browser.close();
if (failures) {
  console.log(`\n::error::${failures} viewport failure(s). Vertical viewports must never need sideways scrolling.`);
  process.exit(1);
}
console.log('\nViewport gate passed: no horizontal scroll at any tested shape.');
