#!/usr/bin/env bun
/*
  seal.mjs, tier 2 of the gating system. Board item t9272.

  Encrypts a page at publish time so the repo and the live site carry only
  ciphertext. A passphrase derives the decryption key in the visitor's browser.

    VAULT_PASS="a long passphrase" bun .github/scripts/seal.mjs _vault/v3.html /v3/
    bun .github/scripts/seal.mjs _vault/v3.html /v3/ --title "Protected" --hint "the usual one"

  The passphrase comes from the VAULT_PASS environment variable, or from one
  line on stdin. It is never written to disk and never stored in the page,
  because there is nothing in the page to compare it against. See
  vault-shell.html for why a stored hash would not work.

  Plaintext sources live in _vault/, which .gitignore excludes. The sealed
  output is the only thing that goes in the repo.

  Crypto, stated so it can be audited rather than trusted:
    key derivation  PBKDF2-HMAC-SHA256, 600,000 iterations, 16 byte random salt
    encryption      AES-256-GCM, 12 byte random IV, 128 bit tag

  600,000 is the OWASP figure for PBKDF2-HMAC-SHA256. It costs about a second
  in a browser, which is the point. It is the only thing standing between a
  stolen copy of the ciphertext and an offline guessing attack, so the cost is
  deliberate. Raise it rather than lower it.

  What this does NOT protect against: a weak passphrase. Everything above is
  undone by "password1", so the script refuses anything under 12 characters.
*/
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { webcrypto as crypto } from 'node:crypto';
import { ROOT, fileFor } from './gating.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i < 0 ? dflt : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [src, destPath] = positional;

if (!src || !destPath) {
  console.error('usage: bun .github/scripts/seal.mjs <plaintext.html> <site/path/> [--title T] [--hint H] [--iter N]');
  process.exit(2);
}

const ITER = Number(flag('iter', 600000));
const TITLE = flag('title', 'Protected');
const HINT = flag('hint', '');

if (!existsSync(src)) { console.error('no such file: ' + src); process.exit(1); }
if (!destPath.startsWith('/')) { console.error('the site path must start with /, got: ' + destPath); process.exit(1); }
if (!Number.isFinite(ITER) || ITER < 310000) {
  console.error(`--iter ${flag('iter', 600000)} is below the 310,000 floor. Raise it, do not lower it.`);
  process.exit(1);
}

/* The title ships in cleartext, so it is the one thing a sealed page leaks.
   Default to something that says nothing. */
if (/\b(v3|draft|private|secret|confidential)\b/i.test(TITLE)) {
  console.warn(`note: the title "${TITLE}" ships in cleartext and is the only thing this page reveals.`);
}

async function passphrase() {
  if (process.env.VAULT_PASS) return process.env.VAULT_PASS;
  process.stderr.write('Passphrase (one line on stdin, not stored): ');
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.split('\n')[0];
}

const b64 = (u8) => Buffer.from(u8).toString('base64');

const phrase = await passphrase();
if (phrase.length < 12) {
  console.error(`that passphrase is ${phrase.length} characters. Under 12, the 600,000 iterations buy you nothing. Refusing.`);
  process.exit(1);
}

const plain = readFileSync(src, 'utf8');
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
  base, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));

const payload = JSON.stringify({
  v: 1, kdf: 'PBKDF2', hash: 'SHA-256', iter: ITER,
  salt: b64(salt), iv: b64(iv), ct: b64(ct), hint: HINT,
});

const shell = readFileSync(join(ROOT, '.github/scripts/vault-shell.html'), 'utf8');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* The payload sits inside a <script type="application/json">, so the only
   sequence that can break out is a literal closing script tag. Base64 cannot
   contain one and the hint is the only free text, so neutralize it anyway. */
const out = shell
  .replaceAll('__TITLE__', esc(TITLE))
  .replace('__PAYLOAD__', payload.replace(/<\//g, '<\\/'));

const dest = join(ROOT, fileFor(destPath));
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, out);

/*
  Register it, because forgetting to register is the exact failure this whole
  system exists to prevent. Read, modify, write, then read back and verify
  that nothing but the gating register moved. Writing a manifest from two
  different scripts is how a manifest gets truncated.
*/
const metaFile = join(ROOT, 'site-meta.json');
const before = JSON.parse(readFileSync(metaFile, 'utf8'));
if (destPath in before.pages) {
  console.error(`${destPath} is listed in site-meta.json pages, which would put a sealed page in the sitemap. Remove it there first.`);
  process.exit(1);
}
if (before.gating.unlisted[destPath] !== 'sealed') {
  const next = JSON.parse(JSON.stringify(before));
  next.gating.unlisted[destPath] = 'sealed';
  next.gating.unlisted = Object.fromEntries(Object.entries(next.gating.unlisted).sort());
  writeFileSync(metaFile, JSON.stringify(next, null, 2) + '\n');

  const after = JSON.parse(readFileSync(metaFile, 'utf8'));
  const keysOk = JSON.stringify(Object.keys(after)) === JSON.stringify(Object.keys(before));
  const pagesOk = JSON.stringify(after.pages) === JSON.stringify(before.pages);
  if (!keysOk || !pagesOk) {
    writeFileSync(metaFile, JSON.stringify(before, null, 2) + '\n');
    console.error('the manifest write changed more than the gating register. Rolled back, nothing registered.');
    process.exit(1);
  }
  console.log(`registered ${destPath} as tier "sealed" in site-meta.json`);
}

const ratio = (out.length / plain.length).toFixed(2);
console.log(`sealed ${src} -> ${fileFor(destPath)}`);
console.log(`  plaintext ${plain.length} bytes, sealed page ${out.length} bytes (${ratio}x)`);
console.log(`  PBKDF2-SHA256 x${ITER.toLocaleString()}, AES-256-GCM`);
console.log(`\nVerify it with: bun .github/scripts/vault-check.mjs ${destPath} ${src}`);
