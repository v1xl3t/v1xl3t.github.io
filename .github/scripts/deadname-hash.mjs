// Helper for adding a pattern to the deadname gate without the word itself ever
// touching the repo, the shell history, or your terminal scrollback.
//
// Run it, type the word, press Enter. It prints only the hash line to append to
// .github/deadname-hashes.txt. Input is not echoed back.
//
// Usage: node .github/scripts/deadname-hash.mjs
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const HASH_FILE = '.github/deadname-hashes.txt';
let salt = '';
if (existsSync(HASH_FILE)) {
  const m = readFileSync(HASH_FILE, 'utf8').match(/^#\s*salt:\s*(\S+)/m);
  if (m) salt = m[1];
}
if (!salt) {
  console.error('No salt found in ' + HASH_FILE + '. Add a "# salt: <random>" header first.');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
rl.question('word to add (not echoed, not stored): ', word => {
  rl.close();
  const t = word.trim().toLowerCase();
  if (!t) { console.error('nothing entered'); process.exit(1); }
  console.log(createHash('sha256').update(salt + ':' + t).digest('hex'));
  console.error(`\nAppend the line above to ${HASH_FILE}. The word itself is not saved anywhere.`);
});
