/* origin-check.mjs — nothing may leave the origin.
 *
 * WHY. A third party that answers a request learns the visitor's IP before
 * first paint. That is the same reason the fonts are self-hosted and the CDNs
 * are vendored. The scraped Sweet Cream archive was the hole: two of its
 * seventeen pages still pulled CSS, page data and a YouTube thumbnail from
 * static.parastorage.com, siteassets.parastorage.com and i.ytimg.com, which
 * also carried Sweet Cream's Wix siteId in the query string. Found 2026-10-29,
 * only because every page was booted rather than the two obvious ones. The two
 * obvious ones were clean.
 *
 * A LEAK IS A RESPONSE, NOT AN ATTEMPT. The first version of this counted
 * requests the page tried to make, so a Content-Security-Policy that refused
 * every one of them still read as leaking. The attempt is what the page wanted.
 * The response is what the third party actually learned. Only the second is a
 * leak, and only the second is counted here.
 *
 *   bun .github/scripts/origin-check.mjs http://localhost:8080
 *   bun .github/scripts/origin-check.mjs http://localhost:8080 /some/page/
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const ARGS = process.argv.slice(3).filter((a) => !a.startsWith('--'));

/* Scope, stated rather than implied. Every page the manifest calls public,
   plus every page of the scraped archive, which is the part that was never
   written by hand and so is the part most likely to phone out. */
function pages() {
  if (ARGS.length) return ARGS;
  const meta = JSON.parse(readFileSync(join(ROOT, 'site-meta.json'), 'utf8'));
  /* The manifest's `pages` is only what is INDEXED. A draft in gating.unlisted is
     still a live page a person can open, and /v2/ and /v3/ both shipped a Google
     Fonts stylesheet because neither was ever in this list. Scope is not
     announced, so it is stated here. */
  const DRAFTS = [];  /* /v2/ and /v3/ removed from the site 2026-10-29 */
  const manifest = [...Object.keys(meta.pages || {}), ...((meta.gating || {}).indexed || []), ...DRAFTS];
  let archive = [];
  try {
    archive = execSync('git ls-files sweetcream', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((f) => f.endsWith('.html')).map((f) => '/' + f);
  } catch { /* not a git checkout, manifest only */ }
  return [...new Set([...manifest, ...archive])].sort();
}

const PAGES = pages();
const browser = await chromium.launch();
let leaking = 0, booted = 0, requests = 0;
console.log(`\n— nothing leaves the origin — ${PAGES.length} page(s)\n`);

for (const path of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const answered = new Map();
  const local = (h) => h === 'localhost' || h === '127.0.0.1';
  page.on('request', () => { requests++; });
  page.on('response', (r) => {
    let u; try { u = new URL(r.url()); } catch { return; }
    if (u.protocol === 'data:' || u.protocol === 'blob:' || local(u.hostname)) return;
    answered.set(u.hostname, (answered.get(u.hostname) || 0) + 1);
  });
  const res = await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => null);
  await page.waitForTimeout(1500);
  booted++;
  if (!res) {
    console.log(`::error::${path} did not load at all, so nothing about it was measured`);
    leaking++;
  } else if (answered.size) {
    leaking++;
    for (const [h, n] of answered)
      console.log(`::error::${path} let ${n} request(s) reach ${h}. That host now has the visitor's IP.`);
  } else {
    console.log(`  ok   ${String(res.status()).padEnd(4)} ${path}`);
  }
  await page.close();
}
await browser.close();

console.log(`\n  ${booted} page(s) booted, ${requests} request(s) observed, ${leaking} leaking.`);
console.log(`  NOTE this measures PAGE LOAD. A request made only after a click, such as`);
console.log(`  playing an embedded video, is outside what this looked at.`);
console.log(leaking ? `\n${leaking} page(s) leak off-origin.` : `\nNothing left the origin.`);
process.exit(leaking ? 1 : 0);
