/*
  gating.mjs, tier 1 of the gating system. Board item t9272.

  One source of truth for which pages stay out of search. The tier table and
  the page register both live in site-meta.json under "gating", so a robots
  tag is never hand written. pagemeta.mjs writes the tags and shortlinks.mjs
  imports the same string for the pages it generates, which is why the two
  cannot drift apart.

  What this buys, stated plainly: the directives themselves barely change,
  because a bare noindex already implies follow. The value is the audit below.
  A new unfinished subpage that forgets its tag now fails the gate instead of
  shipping crawlable and being noticed months later.
*/
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const META = JSON.parse(readFileSync(join(ROOT, 'site-meta.json'), 'utf8'));

export const GATING = META.gating;
export const PAGES = META.pages;

/* Directories excluded from the audit.
     .github      build scripts and templates. Pages does not serve this path,
                  so vault-shell.html is a template and not a page.
     _vault       gitignored plaintext. It has never been published.
     sweetcream   a scraped third party archive Vi publishes as is.
     node_modules not ours. */
const SKIP = /(^|\/)(\.github|_vault|node_modules|sweetcream|\.git)(\/|$)/;

export const TAG = /<meta\s+name="robots"\s+content="([^"]*)"\s*\/?>/i;

/* The robots content for a tier. Throws rather than guessing, because a typo
   in the manifest must not quietly produce a crawlable page. */
export function robotsFor(tier) {
  const t = GATING.tiers[tier];
  if (!t) throw new Error(`unknown gating tier "${tier}". Known: ${Object.keys(GATING.tiers).join(', ')}`);
  return t.robots;
}

export function tagFor(tier) {
  return `<meta name="robots" content="${robotsFor(tier)}">`;
}

/* Site path to file on disk, matching pagemeta's rule. */
export function fileFor(p) {
  return p.endsWith('.html') ? p.replace(/^\//, '') : join(p.replace(/^\//, ''), 'index.html');
}

/* File on disk to site path, the inverse. */
export function pathFor(file) {
  const rel = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (rel === 'index.html') return '/';
  return rel.endsWith('/index.html') ? '/' + rel.slice(0, -'index.html'.length) : '/' + rel;
}

/* Every .html in the repo that is ours to judge. */
export function ownHtml(walkRoot = ROOT) {
  const out = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = full.slice(walkRoot.length + 1).replace(/\\/g, '/');
      if (SKIP.test(rel)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.html')) out.push(rel);
    }
  })(walkRoot);
  return out.sort();
}

/*
  The audit. Returns a list of problem strings, empty when clean.

  Four failures, each one a way an unlisted page has gone wrong before:
   1. A page carries noindex but is not registered. Its intent is unrecorded,
      so nothing can verify it or keep it correct.
   2. A registered page has no robots tag, or the wrong directive for its tier.
      This is the one that catches a new draft shipping crawlable.
   3. A path is registered as unlisted and also listed in pages, so it would be
      put in the sitemap and told not to be indexed at the same time.
   4. A registered path has no file, so the register is stale.
*/
export function audit() {
  const problems = [];
  const reg = GATING.unlisted;

  for (const p of Object.keys(reg)) {
    if (p in PAGES) problems.push(`${p} is registered as unlisted "${reg[p]}" and also listed in pages. Pick one.`);
    const f = join(ROOT, fileFor(p));
    if (!existsSync(f)) { problems.push(`${p} is registered as unlisted but ${fileFor(p)} does not exist. Stale register.`); continue; }
    const want = robotsFor(reg[p]);
    const found = readFileSync(f, 'utf8').match(TAG);
    if (!found) problems.push(`${p} is registered as unlisted "${reg[p]}" but carries NO robots tag. It is crawlable right now.`);
    else if (found[1].replace(/\s+/g, '') !== want.replace(/\s+/g, ''))
      problems.push(`${p} has robots "${found[1]}" but tier "${reg[p]}" requires "${want}".`);
  }

  for (const rel of ownHtml()) {
    const body = readFileSync(join(ROOT, rel), 'utf8');
    const found = body.match(TAG);
    if (!found || !/noindex/i.test(found[1])) continue;
    const p = pathFor(rel);
    if (!(p in reg)) problems.push(`${rel} carries "${found[1]}" but is not registered in site-meta.json gating.unlisted. Add it with a tier.`);
  }

  /* 5. Every page in the repo must have a DECIDED search status. This is the
        rule that catches a brand new subpage that is neither tagged nor
        registered, which the first four rules all miss because they only look
        at pages that already carry noindex. */
  const indexed = new Set(GATING.indexed || []);
  const undecided = new Set(Object.keys(GATING.undecided || {}));
  for (const rel of ownHtml()) {
    const p = pathFor(rel);
    if (p in reg || p in PAGES || indexed.has(p) || undecided.has(p)) continue;
    problems.push(`${rel} has no decided search status. Put ${p} in pages, gating.unlisted, gating.indexed or gating.undecided.`);
  }

  for (const prefix of GATING.robotsDisallow) {
    const covered = Object.keys(reg).some(p => p.startsWith(prefix));
    if (!covered) problems.push(`robots.txt disallows ${prefix} but no unlisted page sits under it. Dead rule.`);
  }

  return problems;
}

/*
  Open decisions. These are NOT failures, because the call is Vi's and failing
  CI would be making it for her. They print on every run so the decision stays
  visible instead of being forgotten.
*/
export function openDecisions() {
  return Object.entries(GATING.undecided || {}).map(([p, why]) => `${p}  ${why}`);
}
