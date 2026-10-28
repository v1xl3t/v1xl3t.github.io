#!/usr/bin/env bun
/*
  inline-page.mjs, fold a multi file page into one self contained file.

    bun .github/scripts/inline-page.mjs <srcdir> <out.html>

  Why this exists. seal.mjs encrypts ONE file. A page that loads its CSS and
  JavaScript from separate URLs would ship a sealed entry page beside plaintext
  assets, and those assets stay fetchable by their own URL. For an app that is
  gated because it is unfinished, leaving 122KB of its code readable next door
  defeats the point of the lock.

  So before sealing an app, fold it into one file: stylesheets become inline
  <style>, and the module graph is bundled by Bun into one inline module
  script. Then there is exactly one file to seal and nothing beside it.

  Module format, and why it is not IIFE. The bundle keeps ESM because the app
  uses top level await, which an IIFE cannot express. An inline module script
  does run inside a document produced by document.write, which is how the
  sealed shell hands over, and vault-browser.mjs proves that on the real page
  rather than trusting it.
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [srcDir, outFile] = process.argv.slice(2);
if (!srcDir || !outFile) {
  console.error('usage: bun .github/scripts/inline-page.mjs <srcdir> <out.html>');
  process.exit(2);
}

const entry = join(srcDir, 'index.html');
if (!existsSync(entry)) { console.error('no index.html in ' + srcDir); process.exit(1); }

let html = readFileSync(entry, 'utf8');
const notes = [];

/* ---- stylesheets ----
   Only local relative hrefs. A Google Fonts link stays a link, because
   inlining a remote stylesheet would mean fetching it at build time and
   freezing it, and the page is allowed to ask for a font. */
const linkRe = /[ \t]*<link[^>]*rel="stylesheet"[^>]*>\r?\n?/gi;
html = html.replace(linkRe, (tag) => {
  const href = (tag.match(/href="([^"]+)"/) || [])[1];
  if (!href || /^https?:|^\/\//i.test(href)) { notes.push('left remote stylesheet: ' + href); return tag; }
  const file = join(srcDir, href.replace(/^\.\//, ''));
  if (!existsSync(file)) { notes.push('MISSING stylesheet, left as a link: ' + href); return tag; }
  const css = readFileSync(file, 'utf8');
  /* A closing style tag inside CSS would end the block early. It can only
     appear inside a string or a comment, so escaping the angle bracket is
     safe and changes nothing that matters. */
  notes.push(`inlined ${href}, ${css.length.toLocaleString()} bytes`);
  return `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>\n`;
});

/* ---- scripts with a src ---- */
const scriptRe = /[ \t]*<script([^>]*)\ssrc="([^"]+)"([^>]*)><\/script>\r?\n?/gi;
const pending = [];
html = html.replace(scriptRe, (tag, pre, src, post) => {
  if (/^https?:|^\/\//i.test(src)) { notes.push('left remote script: ' + src); return tag; }
  const file = join(srcDir, src.replace(/^\.\//, ''));
  if (!existsSync(file)) { notes.push('MISSING script, left as a tag: ' + src); return tag; }
  const isModule = /type="module"/i.test(pre + post);
  const token = `__INLINE_SCRIPT_${pending.length}__`;
  pending.push({ file, src, isModule, token });
  return token + '\n';
});

/* Bundling is async, so it happens after the scan. */
for (const p of pending) {
  let code;
  if (p.isModule) {
    const built = await Bun.build({ entrypoints: [p.file], format: 'esm', target: 'browser', minify: false });
    if (!built.success) {
      console.error('bundle failed for ' + p.src);
      for (const m of built.logs) console.error('  ' + m);
      process.exit(1);
    }
    code = await built.outputs[0].text();
    notes.push(`bundled ${p.src} as one module, ${code.length.toLocaleString()} bytes`);
  } else {
    code = readFileSync(p.file, 'utf8');
    notes.push(`inlined ${p.src}, ${code.length.toLocaleString()} bytes`);
  }
  const attr = p.isModule ? ' type="module"' : '';
  const tag = `<script${attr}>\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`;
  /* A FUNCTION replacement, never a string one. In a string replacement `$$`
     means a literal `$`, so passing code here directly silently collapsed
     every `$$` identifier to `$`. In Ivy that turned
       const $  = (s) => r.querySelector(s)
       const $$ = (s) => [...r.querySelectorAll(s)]
     into two `var $` declarations, the second winning, so every `$("#id")`
     returned an ARRAY. The app died on boot with "cannot read properties of
     undefined (reading 'toggle')" and nothing in the build complained.
     Found 2026-10-28 by booting the inlined page instead of trusting it. */
  html = html.replace(p.token, () => tag);
}

/* Belt and braces for the bug above, and for any other way a transform can
   mangle a declaration: a bundle must not declare the same top level name
   twice. This is cheap and it would have caught the `$$` collapse instantly. */
for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
  const seen = new Map();
  for (const d of m[1].matchAll(/^(?:var|let|const|function|class) +([A-Za-z_$][\w$]*)/gm)) {
    seen.set(d[1], (seen.get(d[1]) || 0) + 1);
  }
  const dupes = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
  if (dupes.length) {
    console.error('a bundled script declares the same top level name more than once, so a transform mangled it:');
    dupes.forEach((d) => console.error('  - ' + d));
    process.exit(1);
  }
}

/* Nothing local may be left pointing at a neighbouring file, or the seal
   would have a hole in it. */
const leftovers = [...html.matchAll(/(?:src|href)="(\.\/[^"]+|[^":/][^":]*\.(?:js|css|mjs))"/gi)].map((m) => m[1]);
if (leftovers.length) {
  console.error('these local references survived, so the page is not self contained:');
  [...new Set(leftovers)].forEach((l) => console.error('  - ' + l));
  process.exit(1);
}

writeFileSync(outFile, html);
notes.forEach((n) => console.log('  ' + n));
console.log(`\n  one file: ${outFile}, ${html.length.toLocaleString()} bytes, no local references left`);
