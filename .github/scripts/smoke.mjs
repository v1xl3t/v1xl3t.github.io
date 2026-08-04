// Smoke test: load the key pages in headless Chromium and fail the build if any
// throws a console/page error or is missing its core content. Keeps autonomous
// work from silently breaking the live site.
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:8080';
const failures = [];
const browser = await chromium.launch();

for (const path of ['/', '/apps/', '/cadence/']) {
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
  if (path === '/cadence/') {
    const title = await page.title();
    if (!/CADence/i.test(title)) failures.push(`/cadence/: unexpected title "${title}"`);
  }
  if (errs.length) failures.push(`${path}: ${errs.join(' | ')}`);
  await page.close();
}

await browser.close();
if (failures.length) {
  console.error('SMOKE FAILURES:\n' + failures.map(f => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('Smoke test passed: /, /apps/, /cadence/ all loaded clean.');
