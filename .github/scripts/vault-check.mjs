#!/usr/bin/env bun
/*
  vault-check.mjs, the gate for tier 2 of the gating system. Board item t9272.

    bun .github/scripts/vault-check.mjs                    check every sealed page
    bun .github/scripts/vault-check.mjs /v3/ _vault/v3.html  also prove it round trips
    bun .github/scripts/vault-check.mjs --self             run the self test only

  An encryption build step is worthless unless something proves the shipped
  bytes are actually opaque, so this gate reads the sealed page the way a
  stranger would and fails on anything it can understand.

  Five checks, each one a way client side encryption is usually got wrong:

   1. SHAPE. The page carries a payload with real parameters, an iteration
      count at or above the floor, AES-GCM, and a salt and IV of the right
      length. A reused or zero salt would make two pages share a key.
   2. NO PLAINTEXT. The sealed page contains none of the distinctive words
      from its source. This is the check that catches the classic mistake of
      leaving the content in the page and only hiding it with CSS or a flag.
   3. NO HASH COMPARISON. The page contains no stored digest to compare a typed
      password against, because that pattern does not protect content and must
      not creep back in.
   4. DECRYPTS. The right passphrase produces the original plaintext, byte for
      byte. A gate that only proves bytes are unreadable also passes when the
      page is permanently broken.
   5. REFUSES. A wrong passphrase fails instead of returning garbage, which is
      what AES-GCM authentication is for.

  Checks 1 to 3 run on every sealed page with no passphrase needed, so CI can
  run them. Checks 4 and 5 need VAULT_PASS and the plaintext, so they run
  locally when resealing.
*/
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto as crypto } from 'node:crypto';
import { ROOT, GATING, fileFor } from './gating.mjs';

const ITER_FLOOR = 310000;
let failures = 0;
let checks = 0;
/* During the self test the failures are deliberate, so they are captured
   rather than printed. A CI log full of the word FAIL on a green run teaches
   everyone to ignore the word. */
let capture = null;

const ok = (msg) => { checks++; if (capture) capture.push({ bad: false, msg }); else console.log('  pass  ' + msg); };
const bad = (msg) => {
  checks++;
  if (capture) { capture.push({ bad: true, msg }); return; }
  failures++;
  console.error('  FAIL  ' + msg);
};

function payloadOf(html, label) {
  const m = html.match(/<script type="application\/json" id="vault-payload">([\s\S]*?)<\/script>/);
  if (!m) { bad(`${label}: no vault payload. Is this a sealed page?`); return null; }
  try { return JSON.parse(m[1].replace(/<\\\//g, '</')); }
  catch (e) { bad(`${label}: payload is not valid JSON. ${e.message}`); return null; }
}

/* ---- 1. shape ---- */
function checkShape(p, label) {
  if (p.kdf !== 'PBKDF2' || p.hash !== 'SHA-256') { bad(`${label}: expected PBKDF2 with SHA-256, got ${p.kdf}/${p.hash}`); return false; }
  if (!(p.iter >= ITER_FLOOR)) { bad(`${label}: iteration count ${p.iter} is below the ${ITER_FLOOR} floor`); return false; }
  const salt = Buffer.from(p.salt, 'base64');
  const iv = Buffer.from(p.iv, 'base64');
  const ct = Buffer.from(p.ct, 'base64');
  if (salt.length !== 16) { bad(`${label}: salt is ${salt.length} bytes, expected 16`); return false; }
  if (iv.length !== 12) { bad(`${label}: IV is ${iv.length} bytes, expected 12 for AES-GCM`); return false; }
  if (salt.every((b) => b === 0) || iv.every((b) => b === 0)) { bad(`${label}: salt or IV is all zeroes, so the key is not unique to this page`); return false; }
  if (ct.length < 17) { bad(`${label}: ciphertext is ${ct.length} bytes, too short to be a page plus a GCM tag`); return false; }
  ok(`${label}: PBKDF2-SHA256 x${p.iter.toLocaleString()}, AES-256-GCM, 16 byte salt, 12 byte IV, ${ct.length} bytes of ciphertext`);
  return true;
}

/* ---- 2. no plaintext ---- */
/* Distinctive words only. Common HTML and English would false positive on the
   shell itself, which legitimately contains a doctype and a body tag. */
function distinctive(plain) {
  const words = plain
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .split(/[^A-Za-z0-9'-]+/)
    .filter((w) => w.length >= 7 && !/^\d+$/.test(w));
  return [...new Set(words.map((w) => w.toLowerCase()))];
}

function checkNoPlaintext(html, plain, label) {
  const hay = html.toLowerCase();
  const shell = readFileSync(join(ROOT, '.github/scripts/vault-shell.html'), 'utf8').toLowerCase();
  const words = distinctive(plain).filter((w) => !shell.includes(w));
  if (!words.length) { ok(`${label}: source has no distinctive words to leak`); return; }
  const leaked = words.filter((w) => hay.includes(w));
  if (leaked.length) bad(`${label}: ${leaked.length} word(s) from the plaintext appear in the sealed page: ${leaked.slice(0, 8).join(', ')}`);
  else ok(`${label}: none of ${words.length} distinctive source words appear in the sealed page`);
}

/* ---- 3. no hash comparison ---- */
function checkNoHashCompare(html, label) {
  /* The broken pattern looks like a stored digest plus an equality test. A
      64 hex character literal is the signature of a stored SHA-256. */
  const digest = html.match(/['"][0-9a-f]{64}['"]/i);
  const compares = /\bdigest\s*===|\bhash\s*===|=== *(?:HASH|DIGEST|PASS_HASH)\b/.test(html);
  if (digest) bad(`${label}: contains what looks like a stored 64 character digest. A stored hash does not protect content, see vault-shell.html`);
  else if (compares) bad(`${label}: contains a hash equality comparison. That pattern was deliberately not built, see vault-shell.html`);
  else ok(`${label}: no stored digest and no hash comparison`);
}

/* ---- 4 and 5. round trip ---- */
async function decrypt(p, phrase) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: Buffer.from(p.salt, 'base64'), iterations: p.iter, hash: p.hash },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(p.iv, 'base64') }, key, Buffer.from(p.ct, 'base64'));
  return new TextDecoder().decode(plain);
}

async function checkRoundTrip(p, plain, phrase, label) {
  try {
    const got = await decrypt(p, phrase);
    if (got === plain) ok(`${label}: the right passphrase recovers the plaintext exactly, ${got.length} bytes`);
    else bad(`${label}: decrypted ${got.length} bytes but they do not match the ${plain.length} byte source`);
  } catch (e) {
    bad(`${label}: the right passphrase did NOT decrypt the page. ${e.message}`);
    return;
  }
  try {
    await decrypt(p, phrase + 'x');
    bad(`${label}: a WRONG passphrase decrypted the page. AES-GCM authentication is not working.`);
  } catch {
    ok(`${label}: a wrong passphrase is rejected rather than returning garbage`);
  }
}

/* ---- self test, so the gate is proven to have teeth ---- */
async function selfTest() {
  console.log('self test, proving each check can actually fail:\n');
  const shell = readFileSync(join(ROOT, '.github/scripts/vault-shell.html'), 'utf8');
  const phrase = 'a passphrase long enough';
  const plain = '<!doctype html><p>Thaumaturgy quintessence Burbank unpublished zine spread.</p>';

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER_FLOOR, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
  const good = { v: 1, kdf: 'PBKDF2', hash: 'SHA-256', iter: ITER_FLOOR, salt: Buffer.from(salt).toString('base64'), iv: Buffer.from(iv).toString('base64'), ct: Buffer.from(ct).toString('base64'), hint: '' };
  const sealed = shell.replaceAll('__TITLE__', 'Protected').replace('__PAYLOAD__', JSON.stringify(good));

  const expect = async (name, want, fn) => {
    capture = [];
    await fn();
    const got = capture.some((c) => c.bad);
    const why = capture.find((c) => c.bad === want)?.msg || capture[0]?.msg || '';
    capture = null;
    if (got === want) {
      console.log(`  teeth  ${name}: ${want ? 'went red as it should' : 'stayed green as it should'}`);
      if (want) console.log(`           caught: ${why}`);
    } else {
      failures++;
      console.error(`  BLUNT  ${name}: expected ${want ? 'a failure' : 'a pass'} and got the opposite. ${why}`);
    }
  };

  await expect('shape, honest page', false, () => checkShape(good, 'self'));
  await expect('shape, iterations too low', true, () => checkShape({ ...good, iter: 1000 }, 'self'));
  await expect('shape, zero salt', true, () => checkShape({ ...good, salt: Buffer.alloc(16).toString('base64') }, 'self'));
  await expect('shape, wrong IV length', true, () => checkShape({ ...good, iv: Buffer.alloc(16).toString('base64') }, 'self'));
  await expect('no plaintext, sealed page', false, () => checkNoPlaintext(sealed, plain, 'self'));
  await expect('no plaintext, content left in the page', true, () => checkNoPlaintext(sealed + plain, plain, 'self'));
  await expect('no hash compare, sealed page', false, () => checkNoHashCompare(sealed, 'self'));
  await expect('no hash compare, stored digest present', true, () => checkNoHashCompare(sealed + `\nconst HASH="${'a'.repeat(64)}";`, 'self'));
  await expect('round trip, honest page', false, () => checkRoundTrip(good, plain, phrase, 'self'));
  await expect('round trip, wrong passphrase given as right', true, () => checkRoundTrip(good, plain, phrase + 'nope', 'self'));
  console.log('');
}

/* ---- main ---- */
const args = process.argv.slice(2);
if (args.includes('--self')) {
  await selfTest();
  console.log(failures ? `self test: ${failures} check(s) wrong` : 'self test: every check has teeth.');
  process.exit(failures ? 1 : 0);
}

const sealedPaths = Object.entries(GATING.unlisted).filter(([, t]) => t === 'sealed').map(([p]) => p);
const [onePath, onePlain] = args.filter((a) => !a.startsWith('--'));

if (!sealedPaths.length) {
  console.log('No pages are registered at tier "sealed" yet, so there is nothing to check.');
  console.log('Seal one with: bun .github/scripts/seal.mjs _vault/page.html /path/');
  console.log('\nProving the gate itself works anyway:\n');
  await selfTest();
  process.exit(failures ? 1 : 0);
}

for (const p of sealedPaths) {
  const file = join(ROOT, fileFor(p));
  console.log(`\n${p}  (${fileFor(p)})`);
  if (!existsSync(file)) { bad(`${p}: registered as sealed but the file does not exist`); continue; }
  const html = readFileSync(file, 'utf8');
  const payload = payloadOf(html, p);
  if (!payload) continue;
  checkShape(payload, p);
  checkNoHashCompare(html, p);

  const plainFile = p === onePath ? onePlain : null;
  if (plainFile && existsSync(plainFile)) {
    const plain = readFileSync(plainFile, 'utf8');
    checkNoPlaintext(html, plain, p);
    if (process.env.VAULT_PASS) await checkRoundTrip(payload, plain, process.env.VAULT_PASS, p);
    else console.log(`  skip  ${p}: set VAULT_PASS to also prove it decrypts and refuses`);
  } else {
    console.log(`  skip  ${p}: pass the plaintext path to also check for leaked words`);
  }
}

console.log(`\n${checks} check(s), ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
