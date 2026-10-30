/* apps-thumbs.mjs — regenerate and police the /apps/ card thumbnails.
 *
 * WHY THIS EXISTS. The eleven tiles on /apps/ were hand-shot JPEGs with
 * nothing to regenerate them, so every app update widened the gap between
 * the card and the thing it links to. Vi spotted it on 2026-10-28: the
 * CADchad card still showed the old CADence UI, because cadence.jpg was shot
 * on 2026-07-07 and the rename happened on 2026-10-26. The stale name was
 * baked into image pixels and into the filename, which is the one place a
 * text rename cannot reach.
 *
 * apps/index.html IS THE MANIFEST. The pairs are parsed out of the page
 * rather than listed here, because a second list is a second thing to drift.
 * A tile's href is what gets shot and its <img src> is where the shot lands.
 *
 *   bun .github/scripts/apps-thumbs.mjs check          no browser, CI safe
 *   bun .github/scripts/apps-thumbs.mjs shoot [base]   regenerate every tile
 *   bun .github/scripts/apps-thumbs.mjs shoot [base] perch cadchad
 *
 * check asserts the wiring only: every tile has a thumb, every thumb has a
 * tile, and no filename contradicts the card it sits on. It deliberately does
 * NOT judge whether a shot LOOKS current, because nothing on disk can know
 * that. Freshness is what shoot is for, and a stale picture is still the
 * failure mode this cannot catch. Say so rather than imply coverage.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = join(ROOT, 'apps', 'index.html');
const mode = process.argv[2] || 'check';

/* A tile is <a class="tile ..." href="..."> ... <img class="shot" src="thumbs/x.jpg" alt="..."> */
function tiles() {
  const html = readFileSync(PAGE, 'utf8');
  const out = [];
  /* data-shot is optional and overrides WHAT GETS SHOT, never where the card
     goes. cadchad.com is a prose landing page now, because a canvas app has no
     text and a page with no text cannot rank, so the card has to link there.
     A picture of a landing page is a bad advert for a 3D modeller though, so
     the card links to the prose and shows the app. */
  const re = /<a class="tile[^"]*"\s+href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const attrs = m[2] || '';
    const body = m[3];
    const shotAttr = attrs.match(/data-shot="([^"]+)"/);
    const img = body.match(/<img class="shot" src="(thumbs\/[^"]+)" alt="([^"]*)"/);
    const h2 = body.match(/<h2>([\s\S]*?)<\/h2>/);
    if (!img) { out.push({ href, shot: href, thumb: null, alt: null, title: h2 ? h2[1] : '' }); continue; }
    out.push({
      href,
      shot: shotAttr ? shotAttr[1] : href,
      thumb: img[1],
      alt: img[2],
      title: (h2 ? h2[1] : '').replace(/<[^>]+>/g, '').trim(),
    });
  }
  return out;
}

let bad = 0;
const fail = (m) => { bad++; console.log(`::error::${m}`); };
const ok = (m) => console.log(`  ok   ${m}`);

const found = tiles();
if (!found.length) { fail('parsed apps/index.html and found no tiles at all, the pattern must have changed'); process.exit(1); }

if (mode === 'check') {
  console.log(`\n/apps/ thumbnails — ${found.length} tiles parsed from apps/index.html\n`);

  for (const t of found) {
    if (!t.thumb) { fail(`the tile for "${t.title || t.href}" has no <img class="shot">`); continue; }
    const p = join(ROOT, 'apps', t.thumb);
    if (!existsSync(p)) { fail(`${t.thumb} is referenced by "${t.title}" and does not exist`); continue; }
    if (statSync(p).size < 2000) fail(`${t.thumb} is only ${statSync(p).size} bytes, that is not a screenshot`);
  }

  /* A filename that contradicts its own card is how cadence.jpg survived the
     rename. Compare the slug against the card title and the alt text. */
  const slugOf = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const t of found) {
    if (!t.thumb) continue;
    const stem = basename(t.thumb).replace(/\.[a-z]+$/i, '');
    const hay = slugOf(`${t.title} ${t.alt} ${t.href}`);
    if (!hay.includes(slugOf(stem))) {
      fail(`${t.thumb} does not match the card it sits on. Card is "${t.title}" (${t.href}). `
         + `A filename that contradicts its card is exactly how cadence.jpg outlived the CADchad rename.`);
    }
  }

  /* Orphans. A thumb nothing references is dead weight that still looks live. */
  const referenced = new Set(found.filter((t) => t.thumb).map((t) => basename(t.thumb)));
  const dir = join(ROOT, 'apps', 'thumbs');
  if (existsSync(dir)) {
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(dir)) {
      if (!/\.(jpg|jpeg|png|webp)$/i.test(f)) continue;
      if (!referenced.has(f)) fail(`apps/thumbs/${f} is not referenced by any tile. Delete it or wire it up.`);
    }
  }

  if (!bad) {
    ok(`every tile has a thumb, every thumb has a tile, and no filename contradicts its card`);
    console.log(`\n  NOTE this checks the WIRING, not the picture. Nothing on disk can tell`);
    console.log(`  whether a shot still looks like the live app. Run "shoot" for that.`);
  }
  console.log(bad ? `\n${bad} failure(s).` : '\nThumbnail wiring is sound.');
  process.exit(bad ? 1 : 0);
}

if (mode !== 'shoot') { console.error(`unknown mode "${mode}", expected check or shoot`); process.exit(2); }

/* ---------------- shoot ---------------- */
const base = (process.argv[3] || 'http://localhost:8099').replace(/\/$/, '');
const only = process.argv.slice(4).map((s) => s.toLowerCase());
const { chromium } = await import('playwright');

/* The grid renders every thumb as aspect-ratio:1/1, object-fit:cover,
   object-position:top, so a square shot of the top of the page is exactly the
   tile with nothing cropped. 900x900 matches the shots already on disk, so one
   card does not resample differently from the rest of the grid. */
const browser = await chromium.launch();
let shot = 0;
for (const t of found) {
  if (!t.thumb) continue;
  const stem = basename(t.thumb).replace(/\.[a-z]+$/i, '');
  if (only.length && !only.includes(stem.toLowerCase())) continue;
  const url = /^https?:/.test(t.shot) ? t.shot : base + t.shot;
  const out = join(ROOT, 'apps', t.thumb);
  // reducedMotion so the shot is the page at rest, not a frame mid-animation
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, reducedMotion: 'reduce' });
  const notes = [];
  page.on('pageerror', (e) => notes.push(`pageerror: ${e.message}`));
  /* An app on someone else's host gets a longer leash and a weaker wait.
     The HuggingFace Space sleeps on the free tier, so it needs well over the
     local budget to wake, and it streams, so it may never reach networkidle
     at all. domcontentloaded plus a settle beats a timeout that produces no
     shot. Local pages keep networkidle, which is stricter and free. */
  const external = /^https?:/.test(t.shot) && !t.shot.startsWith(base);
  try {
    await page.goto(url, {
      waitUntil: external ? 'domcontentloaded' : 'networkidle',
      timeout: external ? 120000 : 45000,
    });
    if (external) await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(external ? 6000 : 2500);
    /* Dismiss first-run overlays. A card is meant to show the app, and a
       coach mark or a cookie bar is what a FIRST visit looks like, not what
       the app looks like. Every reshoot would otherwise catch the tour.
       Best effort and silent: a selector that is not there is not an error. */
    await page.evaluate(() => {
      const sels = ['.cm-skip', '[data-tour-skip]', '.tour-skip', '.onboarding-skip',
                    '[aria-label="Skip"]', '.cookie-accept', '#cookie-accept'];
      for (const s of sels) document.querySelectorAll(s).forEach((el) => el.click());
      /* A welcome sheet that offers a choice, like Resume Studio's 'Start from
         sample / Start blank', has no skip selector. Take the sample, which is
         what shows the app with something in it. Found 2026-10-30 when the
         reshoot caught the sheet instead of the editor. */
      const pick = [...document.querySelectorAll('button')].find((el) =>
        /^(start from sample|try the sample|load sample|got it|skip)$/i.test(el.textContent.trim()));
      if (pick) pick.click();
    }).catch(() => {});
    await page.waitForTimeout(700);
    await page.screenshot({ path: out, type: 'jpeg', quality: 82 });
    shot++;
    console.log(`  shot  ${t.thumb.padEnd(26)} <- ${url}${notes.length ? `   (${notes.length} page error(s))` : ''}`);
    for (const n of notes.slice(0, 2)) console.log(`          ${n}`);
  } catch (e) {
    fail(`could not shoot ${url} for ${t.thumb}: ${e.message.split('\n')[0]}`);
  } finally {
    await page.close();
  }
}
await browser.close();
console.log(bad ? `\n${shot} shot, ${bad} failed.` : `\n${shot} thumbnail(s) regenerated.`);
process.exit(bad ? 1 : 0);
