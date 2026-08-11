// Share Link — the whole project serialized, deflated, and packed into the URL
// fragment. The fragment (#d=...) never leaves the browser or reaches a server,
// so a design is only visible to people who hold the link. Opening a link loads
// the shared design read-safe: the current autosave is snapshotted to a backup
// key first, so nothing of the visitor's own work is ever lost.
//
// Payload format:  #d=t<base64url of the packed tiny format>   (see tinylink.js)
//                  #d=z<base64url of deflate-raw JSON>         (fallback)
//                  #d=j<base64url of plain JSON>               (last resort)
//
// SIZE, PART TWO (2026-08-11). Recipes-only got a one-box link to 245
// characters, which pastes anywhere but is not a link you would read out. The
// `t` format packs the same recipes at the bit level against the app's own
// defaults, and takes that box to 68 characters of URL. It refuses anything it
// cannot reproduce exactly — sketch profiles, off-grid coordinates, an unknown
// primitive — and this file quietly falls back to `z` for those. Links already
// sent under `z` and `j` keep opening exactly as before; nothing below the
// prefix letter changed for them.
//
// SIZE (2026-08-11). A boolean used to travel as its finished mesh, every
// vertex a decimal number, *alongside* the recipe that made it. Measured, that
// mesh was 95% of a drilled box and 100% of a sphere cut by a sphere: 2,289 and
// 19,068 characters of URL, against Discord's 2,000 character paste limit. No
// encoder gets you out of that — deflate already took the sphere from 178,000
// characters to 19,000 and it was still unusable.
//
// So the link ships recipes only and re-runs the kernel on open (see
// rebakeBooleans). 2,289 → 407 and 19,068 → 375, and link length now tracks how
// many shapes you used rather than how curved they are. The price is a moment
// of rebuild on open, paid by the visitor who is already waiting on a page
// load; saving a file still bakes the mesh so opening your own work is instant.

import { rebakeBooleans } from './model.js';
import { encodeVerified, decodeTiny } from './tinylink.js';

const AUTOSAVE_KEY = 'cadence:autosave:v1';
const BACKUP_KEY   = 'cadence:autosave:pre-share-backup';

/* ---------- base64url over binary, chunked so big scenes don't blow the stack ---------- */
function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes, TransformCtor, mode) {
  const stream = new Blob([bytes]).stream().pipeThrough(new TransformCtor(mode));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ---------- public API ---------- */

// The prefix is dead weight inside a hundred-character budget: `/cadence/`
// spends nine characters before the design starts. The Pages repo forwards
// `/c/` to the same app with the fragment intact, so the canonical site emits
// the short form and everything after `#d=` is untouched by this.
//
// DERIVED, never pasted. The harness serves this app from localhost, and a
// hard-coded production URL would make every round-trip test either navigate to
// the live site or fail outright. Anywhere that is not the canonical path, the
// link is exactly the address you are already on.
const CANONICAL_PATH = '/cadence/';
const SHORT_PATH = '/c/';

const link = (payload) => {
  const p = location.pathname;
  const path = p.endsWith(CANONICAL_PATH) ? p.slice(0, -CANONICAL_PATH.length) + SHORT_PATH : p;
  return `${location.origin}${path}#d=${payload}`;
};

// Build a copyable URL for the current design. Returns null when there is
// nothing worth sharing.
export async function buildShareLink(doc) {
  if (!doc.list.length) return null;
  const data = doc.toJSON({ recipeOnly: true });

  // Tiny first. encodeVerified decodes its own output and compares it to `data`
  // before handing anything back, so a null here means "this document cannot be
  // carried exactly", never "it was carried approximately".
  const tiny = encodeVerified(data);
  if (tiny.bytes) return link('t' + bytesToB64url(tiny.bytes));
  if (tiny.reason) console.info('share link: using the long format —', tiny.reason);

  const raw = new TextEncoder().encode(JSON.stringify(data));
  let payload;
  try {
    payload = 'z' + bytesToB64url(await pipe(raw, CompressionStream, 'deflate-raw'));
  } catch {
    payload = 'j' + bytesToB64url(raw);
  }
  return link(payload);
}

// On boot: if the URL carries a shared design, load it. The visitor's own
// autosave is copied to a backup key before being superseded. Returns true
// when a shared design was loaded.
export async function tryLoadSharedLink(doc) {
  const m = location.hash.match(/[#&]d=([a-zA-Z0-9_\-]+)/);
  if (!m) return false;
  try {
    const kind = m[1][0], body = m[1].slice(1);
    let data;
    if (kind === 't') {
      data = decodeTiny(b64urlToBytes(body));
    } else {
      // Untouched: every link ever sent under `z` or `j` still opens this way.
      let raw = b64urlToBytes(body);
      if (kind === 'z') raw = await pipe(raw, DecompressionStream, 'deflate-raw');
      else if (kind !== 'j') return false;
      data = JSON.parse(new TextDecoder().decode(raw));
    }
    if (!data || data.app !== 'CADence' || !Array.isArray(data.objects)) return false;
    // Put the meshes back before the document sees the data, so loadJSON stays
    // synchronous and cannot tell a shared design from a saved file.
    await rebakeBooleans(data);
    try {
      const prev = localStorage.getItem(AUTOSAVE_KEY);
      if (prev) localStorage.setItem(BACKUP_KEY, prev);
    } catch {}
    doc.loadJSON(data, 'Shared link');
    return true;
  } catch (e) {
    console.warn('share link failed to load', e);
    return false;
  }
}
