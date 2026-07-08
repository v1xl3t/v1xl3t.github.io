// Share Link — the whole project serialized, deflated, and packed into the URL
// fragment. The fragment (#d=...) never leaves the browser or reaches a server,
// so a design is only visible to people who hold the link. Opening a link loads
// the shared design read-safe: the current autosave is snapshotted to a backup
// key first, so nothing of the visitor's own work is ever lost.
//
// Payload format:  #d=z<base64url of deflate-raw JSON>   (modern browsers)
//                  #d=j<base64url of plain JSON>         (fallback)

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

// Build a copyable URL for the current design. Returns null when there is
// nothing worth sharing.
export async function buildShareLink(doc) {
  if (!doc.list.length) return null;
  const json = JSON.stringify(doc.toJSON());
  const raw = new TextEncoder().encode(json);
  let payload;
  try {
    payload = 'z' + bytesToB64url(await pipe(raw, CompressionStream, 'deflate-raw'));
  } catch {
    payload = 'j' + bytesToB64url(raw);
  }
  return `${location.origin}${location.pathname}#d=${payload}`;
}

// On boot: if the URL carries a shared design, load it. The visitor's own
// autosave is copied to a backup key before being superseded. Returns true
// when a shared design was loaded.
export async function tryLoadSharedLink(doc) {
  const m = location.hash.match(/[#&]d=([a-zA-Z0-9_\-]+)/);
  if (!m) return false;
  try {
    const kind = m[1][0], body = m[1].slice(1);
    let raw = b64urlToBytes(body);
    if (kind === 'z') raw = await pipe(raw, DecompressionStream, 'deflate-raw');
    else if (kind !== 'j') return false;
    const data = JSON.parse(new TextDecoder().decode(raw));
    if (!data || data.app !== 'CADence' || !Array.isArray(data.objects)) return false;
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
