// Smoke test: load the key pages in headless Chromium and fail the build if any
// throws a console/page error or is missing its core content. Keeps autonomous
// work from silently breaking the live site.
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:8080';
const failures = [];
const browser = await chromium.launch();

/* /cadence/ was dropped on 2026-10-26. It is a noindex shim now, and loading
   it in a browser follows the redirect to cadchad.com, so this gate was
   measuring a different site's title and would pass or fail on changes made
   in another repo. The shim itself is checked below without navigating. */
for (const path of ['/', '/apps/']) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  try {
    await page.goto(base + path, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    failures.push(`${path}: navigation failed (${e.message})`);
    await page.close();
    continue;
  }
  if (path === '/') {
    // Root is now the portfolio (workGrid), not the launcher.
    const cards = await page.locator('#workGrid .card').count();
    if (cards < 10) failures.push(`/: expected >=10 work cards, found ${cards}`);
    if (!(await page.locator('.hero-title').count())) failures.push('/: missing hero title');
  }
  if (path === '/apps/') {
    const tiles = await page.locator('.tile').count();
    if (tiles < 3) failures.push(`/apps/: expected >=3 launcher tiles, found ${tiles}`);
  }
  if (errs.length) failures.push(`${path}: ${errs.join(' | ')}`);
  await page.close();
}

/* The two shims, checked as FILES rather than by navigating, because loading
   them sends the browser to another origin. What matters here is that each
   still points where it should and still carries noindex, so this repo cannot
   quietly start competing with the domains the content moved to. */
{
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const [file, target] of [['cadence/index.html', 'https://cadchad.com/'],
                                ['hp/index.html', 'https://hackingparadise.com/']]) {
    let html = '';
    try { html = readFileSync(join(ROOT, file), 'utf8'); }
    catch { failures.push(`${file}: missing, the shim is gone`); continue; }
    if (!html.includes(`url=${target}`)) failures.push(`${file}: refresh does not target ${target}`);
    if (!html.includes(`rel="canonical" href="${target}"`)) failures.push(`${file}: canonical does not point at ${target}`);
    if (!/<meta name="robots"[^>]*noindex/.test(html)) failures.push(`${file}: missing noindex, it will compete with ${target}`);
    if (!html.includes('location.search') || !html.includes('location.hash'))
      failures.push(`${file}: does not carry the query and fragment, old share links would lose their payload`);
  }
}

await browser.close();
if (failures.length) {
  console.error('SMOKE FAILURES:\n' + failures.map(f => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('Smoke test passed: / and /apps/ loaded clean, both moved-path shims intact.');
