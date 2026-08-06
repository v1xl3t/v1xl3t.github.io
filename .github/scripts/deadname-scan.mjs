// Deadname gate.
//
// This repo is public, so the thing we are scanning FOR must never appear in
// it. Writing `grep -i <name>` into a workflow would publish the deadname
// permanently, in the repo and in every CI log, which is the exact thing the
// gate exists to prevent.
//
// So the pattern is never stored in plaintext. Each candidate word is hashed
// and compared against a list of hashes. On a hit the script prints the file
// and line only, never the matched text, so a public CI log stays clean.
//
// Two sources for the pattern, in priority order:
//   1. env DEADNAME_PATTERNS, comma separated (set it as a GitHub Actions
//      secret). Strongest, since nothing lands in the repo at all.
//   2. .github/deadname-hashes.txt, salted hashes committed to the repo.
//      Works with zero setup. Note that a hash of a short common name is
//      brute-forceable by anyone motivated, so prefer the secret if that
//      matters to you.
//
// Matching is whole-token, not substring, which is what makes it usable:
// a substring scan flags "television" for containing a 4-letter name.
// Tokens split on punctuation, on camelCase, and between letters and digits,
// so "name-photo.jpg", "nameEllis" and "name2020" are all still caught.
//
// Usage: node .github/scripts/deadname-scan.mjs [root]
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.argv[2] || '.';
const HASH_FILE = join(ROOT, '.github/deadname-hashes.txt');

let salt = '';
const hashes = new Set();

if (existsSync(HASH_FILE)) {
  for (const raw of readFileSync(HASH_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      const m = line.match(/^#\s*salt:\s*(\S+)/);
      if (m) salt = m[1];
      continue;
    }
    hashes.add(line.toLowerCase());
  }
}

const digest = tok => createHash('sha256').update(salt + ':' + tok).digest('hex');

// the secret path, if provided, is hashed with the same salt so both agree
if (process.env.DEADNAME_PATTERNS) {
  for (const p of process.env.DEADNAME_PATTERNS.split(',')) {
    const t = p.trim().toLowerCase();
    if (t) hashes.add(digest(t));
  }
}

if (!hashes.size) {
  console.log('::error::deadname gate is not configured. Add hashes to .github/deadname-hashes.txt ' +
              '(generate with: node .github/scripts/deadname-hash.mjs) or set the DEADNAME_PATTERNS secret.');
  process.exit(1);
}

// Split into whole words. Punctuation, camelCase and letter/digit boundaries all
// count as breaks, so a name buried in a filename or an identifier still surfaces.
const tokenize = s => s
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
  .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter(Boolean);

const TEXT = /\.(html?|js|mjs|cjs|css|md|json|svg|txt|ya?ml|xml|webmanifest)$/i;

let files;
try {
  files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n').map(s => s.trim()).filter(Boolean);
} catch (e) {
  console.log(`::error::deadname gate could not list tracked files: ${e.message}`);
  process.exit(1);
}

const hits = [];

for (const rel of files) {
  // the path itself counts, a deadname-era filename is just as public
  for (const tok of tokenize(rel)) {
    if (hashes.has(digest(tok))) { hits.push({ file: rel, line: 0, where: 'filename' }); break; }
  }
  if (!TEXT.test(rel)) continue;
  let body;
  try { body = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const tok of tokenize(lines[i])) {
      if (hashes.has(digest(tok))) { hits.push({ file: rel, line: i + 1, where: 'content' }); break; }
    }
  }
}

if (hits.length) {
  console.log(`\n${hits.length} deadname hit(s). Text is withheld on purpose, open the location to see it.\n`);
  // dedupe noisy repeats within one file
  const seen = new Set();
  for (const h of hits) {
    const key = `${h.file}:${h.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`   ${h.file}${h.line ? ':' + h.line : ''}  (${h.where})`);
  }
  console.log(`\n::error::${hits.length} deadname hit(s) in tracked files. Nothing ships until these are gone.`);
  process.exit(1);
}

console.log(`Deadname gate passed. ${files.length} tracked files scanned, ${hashes.size} pattern(s).`);
