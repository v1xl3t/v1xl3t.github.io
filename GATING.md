# Gating, how a page is kept out of search or kept actually private

Built 2026-10-28 for board item t9272. Two tiers, because they solve different
problems and only one of them is real privacy.

| | Tier 1, unlisted | Tier 2, sealed |
|---|---|---|
| What it does | Keeps the page out of search results | Makes the page unreadable without a passphrase |
| Who can read it | Anyone who has the URL | Only someone with the passphrase |
| Costs | Nothing, it already works | A build step every time the page changes |
| Use it for | Anything merely unfinished | Anything a stranger reading would actually matter |

Default to tier 1. Reach for tier 2 only when the content itself is the thing
being protected, because tier 2 means you cannot edit the live page without
resealing it.

## The thing that does not work, and why

A JavaScript check that compares a typed password against a stored hash does
not protect anything on a static site, salted or not.

GitHub Pages has no server. The browser downloads the whole page before any
script can run, so the content you are guarding has already arrived on the
visitor's machine by the time the check happens. A wrong password shows
"denied" and the full text is sitting in View Source.

Hashing protects a **password** from being stolen. It does not protect
**content**. The hash was never the weak point. The delivery order is.

A private repository does not change this either. GitHub hides the
**repository** on github.com. It does not hide the **published site**, which
Pages serves to everyone on Free, Pro and Team alike. Access controlled Pages
is an Enterprise Cloud feature. Measured on 2026-10-28: an anonymous fetch of
vi-ellis.com/v2/ returned HTTP 200 and 50,182 bytes of complete page source
with no authentication, while the repo was private.

Tier 2 flips what gets hashed. Instead of hashing a password and comparing it,
the content is **encrypted** and the passphrase **derives the decryption key**.
What ships is ciphertext, so there is nothing to deny and nothing to read.

## Tier 1, unlisted

Every page that stays out of search is registered in `site-meta.json` under
`gating.unlisted`, with a tier. `.github/scripts/pagemeta.mjs` writes the
robots tag from that register.

**Never hand edit a robots meta tag.** Edit the manifest and rerun the
generator. `shortlinks.mjs` imports the same tag, so the two generators cannot
drift apart.

```
bun .github/scripts/pagemeta.mjs         write the tags
bun .github/scripts/pagemeta.mjs check   fail if anything has drifted
```

The tiers, all defined in the manifest:

| Tier | Robots | For |
|---|---|---|
| `shim` | `noindex, follow` | A redirect page. Follow so the destination is still discovered. |
| `placeholder` | `noindex, follow` | Announced but not built. |
| `utility` | `noindex, follow` | Infrastructure, such as the 404 router. |
| `draft` | `noindex, nofollow` | **The default for anything unfinished.** Out of search, readable by anyone with the URL. |
| `sealed` | `noindex, nofollow` | Tier 2. Encrypted. |

A bare `noindex` already implies follow, so `shim`, `placeholder` and `utility`
are the same directive today. They are separate names because they record
different intent, and intent is what the next person needs.

### What the check actually catches

This is where the value is, not in the directives. The audit fails on five
things, each one a way an unlisted page has gone wrong before:

1. A page carries `noindex` but is not registered, so its intent is unrecorded.
2. A registered page has no robots tag, or the wrong one for its tier. **This
   is the one that catches a new draft shipping crawlable.**
3. A path is in both `pages` and `gating.unlisted`, so it would be put in the
   sitemap and told not to be indexed at the same time.
4. A registered path has no file, so the register is stale.
5. A page in the repo is in none of the registers, so nobody ever decided
   whether it should be in search.

Rule 5 is the important one. Rules 1 to 4 only look at pages that already carry
`noindex`, so a brand new subpage with no tag at all slipped past all of them.

Found by building this: `/arcade/` was a redirect shim with no robots tag at
all, covered only by a `robots.txt` rule.

### Open decisions

`gating.undecided` holds pages whose search status is Vi's call. They print on
every run and never fail the build, because failing CI would be making the
decision for her. Resolve one by moving it into `pages`, `gating.indexed` or
`gating.unlisted`.

### The robots.txt trap

`robots.txt` `Disallow` stops a crawler fetching a path at all, which also
stops it ever reading the `noindex`. That is right for a path that was never
indexed and **wrong** for one you are trying to get removed from an index. To
deindex something, leave it crawlable so the `noindex` can be seen.

## Tier 2, sealed

Plaintext lives in `_vault/`, which `.gitignore` excludes. Only the encrypted
output goes in the repo.

```
# seal a page
VAULT_PASS="a long passphrase" \
  bun .github/scripts/seal.mjs _vault/v3.html /v3/ --title "Protected"

# prove it, no browser
VAULT_PASS="a long passphrase" \
  bun .github/scripts/vault-check.mjs /v3/ _vault/v3.html

# prove it in a real browser, which is the code a visitor runs
VAULT_PASS="a long passphrase" NODE_PATH=/mnt/f/ClaudeCode/harness/node_modules \
  bun .github/scripts/vault-browser.mjs http://127.0.0.1:5188/v3/ _vault/v3.html
```

`seal.mjs` registers the page as tier `sealed` itself, because forgetting to
register is the failure this system exists to prevent.

The crypto, stated so it can be audited rather than trusted:

- key derivation, PBKDF2-HMAC-SHA256, 600,000 iterations, 16 byte random salt
- encryption, AES-256-GCM, 12 byte random IV, 128 bit tag
- a passphrase under 12 characters is refused, and an iteration count under
  310,000 is refused

600,000 is the OWASP figure for PBKDF2-HMAC-SHA256. It costs about a second in
a browser, and that cost is the only thing standing between a stolen copy of
the ciphertext and an offline guessing attack. Raise it rather than lower it.

AES-GCM is authenticated, so a wrong passphrase fails to decrypt rather than
returning garbage. There is no stored hash anywhere and nothing to compare
against. `vault-check.mjs` fails the build if a stored digest ever appears in a
sealed page, so the broken pattern cannot creep back in.

### What tier 2 does not protect

- **A weak passphrase.** All of the above is undone by `password1`.
- **The title.** It ships in cleartext and is the only thing a sealed page
  reveals. Default it to something that says nothing.
- **Anyone who already has the passphrase.** There is no per person access and
  no revocation. Changing the passphrase means resealing the page.

## Sealing a multi file app, and the /ivy/ pipeline

`seal.mjs` encrypts ONE file. An app that loads its CSS and JavaScript from
separate URLs would ship a sealed entry page beside plaintext assets, and those
assets stay fetchable by their own URL. Locking the front door while the
windows are open is not a lock, so fold the app into one file first.

```
bun .github/scripts/inline-page.mjs <srcdir> _vault/app.html
```

Stylesheets become inline `<style>`, the module graph is bundled by Bun into
one inline module script, and the script refuses to write a file that still
points at a local neighbour.

**/ivy/ is sealed as of 2026-10-28.** It is generated, so updating it is three
steps and not one. The source of truth is still
`F:\ClaudeCode\NON-WEB-LOCAL-ONLY\todo\`, not this repo.

```
# 1. rebuild the public vine from the private board, and gate it
cd /mnt/f/ClaudeCode/NON-WEB-LOCAL-ONLY/todo
bun build-public.mjs
bun public-check.mjs --dir dist-ivy        # run this on the PLAINTEXT

# 2. fold it into one file
cd /mnt/c/Users/LSFXE/Documents/GitHub/v1xl3t.github.io
bun .github/scripts/inline-page.mjs /mnt/f/ClaudeCode/NON-WEB-LOCAL-ONLY/todo/dist-ivy _vault/ivy.html

# 3. seal it, and prove it
VAULT_PASS="..." bun .github/scripts/seal.mjs _vault/ivy.html /ivy/ --title "Ivy" --hint "..."
VAULT_PASS="..." bun .github/scripts/vault-check.mjs /ivy/ _vault/ivy.html
VAULT_PASS="..." NODE_PATH=/mnt/f/ClaudeCode/harness/node_modules \
  bun .github/scripts/vault-browser.mjs http://127.0.0.1:5188/ivy/ _vault/ivy.html --expect "#railticks"
```

**Run `public-check.mjs` on the plaintext, never on the sealed page.** It is the
privacy gate that proves no board content and no off origin request escapes.
Pointed at ciphertext it would be inspecting a lock screen and passing for the
wrong reason.

**`--expect` is the check that matters for an app.** Canary words alone are a
weak proof, because a script tag's own source counts as document text, so the
words are satisfied by a page that decrypted and then failed to run. `--expect`
names a selector from the app's chrome that must be absent while locked and
present after unlocking.

### Two bugs this pipeline already caught, both mine

**A string replacement ate an identifier.** The inliner first spliced the bundle
in with `html.replace(token, code)`. In a string replacement `$$` means a
literal `$`, so every `$$` in the bundle silently became `$`. In Ivy that turned

```js
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
```

into two `var $` declarations, the second winning, so every `$("#id")` returned
an array. The app died on boot and nothing in the build complained. Found by
booting the inlined page and comparing its node count against the multi file
original, 132 against 267. The fix is a function replacement, and
`inline-page.mjs` now also fails on any duplicate top level declaration,
which would have caught it in one line.

**A gate that read the wrong half of the document.** `vault-browser.mjs` looked
for its canary words in `body`. An inlined stylesheet lands in `<head>`, so the
first canaries were CSS words that body never contains, and the gate reported a
false failure on a page that was working. It reads `documentElement` now.

The lesson in both: a build step that cannot be observed running is not
verified, and a gate that has never been watched going red is not a gate.

### Gates

`vault-check.mjs --self` encrypts a fixture, then deliberately breaks each
check in turn and asserts it goes red. It needs no passphrase and no fixture in
the repo, so it runs in CI. The browser half needs the plaintext and the
passphrase, so it runs locally when a page is resealed.
