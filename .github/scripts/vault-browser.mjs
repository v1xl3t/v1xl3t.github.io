#!/usr/bin/env bun
/*
  vault-browser.mjs, the browser half of the tier 2 gate. Board item t9272.

  vault-check.mjs proves the ciphertext is sound using Node's WebCrypto. That
  is not the code a visitor runs. This drives the real sealed page in a real
  browser, because the decrypt path lives in vault-shell.html and a gate that
  never runs it would pass a page nobody can open.

    # serve the repo on a port the main session owns, then:
    VAULT_PASS="the passphrase" \
    NODE_PATH=/mnt/f/ClaudeCode/harness/node_modules \
    bun .github/scripts/vault-browser.mjs http://127.0.0.1:5188/_sealtest/ _vault/sealtest.html

  Do NOT start or kill a server by pattern from a lane. Use
  harness/lane.sh serve, which reuses a live one.

  The NODE_PATH prefix is required: a bare import of playwright from the C:
  drive resolves a cached copy with no browser installed.
*/
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const expectSel = (() => { const i = argv.indexOf('--expect'); return i < 0 ? null : argv[i + 1]; })();
const [url, plainFile] = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--expect');
const pass = process.env.VAULT_PASS;

if (!url || !plainFile) {
  console.error('usage: VAULT_PASS=... bun .github/scripts/vault-browser.mjs <url> <plaintext.html> [--expect <css selector>]');
  console.error('  --expect names a selector that must be ABSENT while locked and PRESENT after unlocking.');
  console.error('  For an app, pass something from its own chrome. Canary words alone are a weak proof,');
  console.error('  because a script tag\'s source counts as body text and would satisfy them either way.');
  process.exit(2);
}
if (!pass) { console.error('set VAULT_PASS. Without the passphrase there is nothing to prove.'); process.exit(2); }
if (!existsSync(plainFile)) { console.error('no such plaintext: ' + plainFile); process.exit(1); }

const plain = readFileSync(plainFile, 'utf8');

/* Canary words taken from the real source, so this cannot pass by checking
   for words that were never in the page. */
const shell = readFileSync(new URL('./vault-shell.html', import.meta.url), 'utf8').toLowerCase();
const canaries = [...new Set(
  plain.replace(/<[^>]*>/g, ' ').split(/[^A-Za-z0-9'-]+/)
    .filter((w) => w.length >= 8 && !/^\d+$/.test(w) && !shell.includes(w.toLowerCase())),
)].slice(0, 12);

if (!canaries.length) { console.error('the plaintext has no distinctive long words, so this test could not fail. Pick a better fixture.'); process.exit(1); }

let fails = 0;
const ok = (m) => console.log('  pass  ' + m);
const bad = (m) => { fails++; console.error('  FAIL  ' + m); };

const browser = await chromium.launch();
/* 390 wide, Vi's standing no-horizontal-scroll rule. */
const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(url, { waitUntil: 'networkidle' });

/* For an app, the canary words sit inside a script tag, and a script tag's
   text counts as body text. So the words alone would be satisfied by a page
   that decrypted and then failed to run. --expect is the real proof. */
if (expectSel) {
  const present = await page.$(expectSel);
  if (present) bad(`locked: ${expectSel} is already in the DOM, so the page is not actually gated`);
  else ok(`locked: ${expectSel} absent, as it must be`);
}

/* The whole document, not just body. An inlined stylesheet lands in <head>,
   so body alone would miss it, and "none visible in body" would be a weaker
   claim than it sounds. */
const locked = await page.evaluate(() => document.documentElement.textContent);
const visible = canaries.filter((w) => locked.includes(w));
if (visible.length) bad(`${visible.length} secret word(s) visible before unlocking: ${visible.join(', ')}`);
else ok(`locked page shows none of the ${canaries.length} canary words`);

/* The source is in the DOM too, not just the rendered text. */
const html = await page.content();
const inSource = canaries.filter((w) => html.includes(w));
if (inSource.length) bad(`${inSource.length} secret word(s) readable in View Source: ${inSource.join(', ')}`);
else ok('nothing readable in View Source either');

const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
if (overflow > 1) bad(`horizontal overflow of ${overflow}px at 390 wide`);
else ok('no horizontal scroll at 390px');

/* Wrong passphrase first, because "it opens" is the easy half. */
await page.fill('#pass', 'definitely not the passphrase');
await page.click('#go');
await page.waitForFunction(() => document.getElementById('note')?.dataset.state === 'bad', null, { timeout: 90000 });
ok('wrong passphrase is refused: ' + (await page.textContent('#note')).trim());

const stillLocked = await page.content();
const leakedAfterWrong = canaries.filter((w) => stillLocked.includes(w));
if (leakedAfterWrong.length) bad(`content appeared after a WRONG passphrase: ${leakedAfterWrong.join(', ')}`);
else ok('still nothing readable after a wrong passphrase');

/* Right passphrase. */
await page.fill('#pass', pass);
await page.click('#go');
try {
  /* documentElement, for the same reason as above: this page's first canary
     words come from its inlined CSS, which sits in <head>. Waiting on body
     reported a false failure here before this was fixed. */
  await page.waitForFunction((w) => document.documentElement.textContent.includes(w), canaries[0], { timeout: 90000 });
} catch {
  bad('the right passphrase did not open the page in the browser');
  await browser.close();
  console.log(`\n${fails} failure(s).`);
  process.exit(1);
}
const opened = await page.evaluate(() => document.documentElement.textContent);
const missing = canaries.filter((w) => !opened.includes(w));
if (missing.length) bad(`unlocked, but ${missing.length} word(s) are missing: ${missing.join(', ')}`);
else ok(`right passphrase decrypts and renders all ${canaries.length} canary words`);

if (expectSel) {
  try {
    await page.waitForSelector(expectSel, { timeout: 90000 });
    await page.waitForTimeout(1500);
    const nodes = await page.evaluate(() => document.querySelectorAll('*').length);
    ok(`unlocked: ${expectSel} rendered, ${nodes} nodes in the document`);
  } catch { bad(`unlocked, but ${expectSel} never appeared. The page decrypted and then failed to run.`); }
}

if (page.url().replace(/\/$/, '') === url.replace(/\/$/, '')) ok('URL unchanged, so relative asset paths still resolve');
else bad('URL changed to ' + page.url());

if (errors.length) bad('uncaught page errors: ' + errors.join(' | '));
else ok('no uncaught page errors');

await browser.close();
console.log(`\n${fails} failure(s).`);
process.exit(fails ? 1 : 0);
