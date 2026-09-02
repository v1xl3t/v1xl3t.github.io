

const LOCAL = !!globalThis.IVY_LOCAL;

function serverStore() {
  return {
    local: false,
    canClose: true,
    async load() {
      const r = await fetch("/api/doc");
      if (!r.ok) throw new Error("the board would not load, is the server still up?");
      return r.json();
    },
    async ops(revision, ops) {
      const r = await fetch("/api/ops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, ops }),
      });
      const j = await r.json();
      return r.ok ? { ok: true, doc: j } : { ok: false, message: j.message || j.error || "that did not save" };
    },
    async close() { await fetch("/api/shutdown", { method: "POST" }).catch(() => {}); },
  };
}

const KEY = "ivy:board:v1";
const BACKUP = "ivy:board:pre-share-backup";

async function localStore() {

  const [{ applyOps }, schema] = await Promise.all([import("./ops.js"), import("./schema.js")]);
  const { STATUS, STATUS_ORDER, PRIORITY, PRIORITY_ORDER, AUTHORS, emptyDoc, validate } = schema;


  const rev = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ":" + s.length;
  };


  let seeded = null;
  const read = () => {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch {  }
    if (raw) {
      try { return JSON.parse(raw); } catch {  }
    }
    if (!seeded) seeded = emptyDoc();
    return JSON.parse(JSON.stringify(seeded));
  };

  const write = (doc) => {
    try { localStorage.setItem(KEY, JSON.stringify(doc)); return true; }
    catch { return false; }
  };


  const dress = (doc) => ({
    ...doc,
    revision: rev(JSON.stringify(doc)),
    statuses: STATUS,
    statusOrder: STATUS_ORDER,
    priorities: PRIORITY,
    priorityOrder: PRIORITY_ORDER,
    authors: AUTHORS,
  });

  const today = () => new Date().toLocaleDateString("en-CA");

  return {
    local: true,
    canClose: false,
    async load() {
      const shared = await readSharedLink();
      if (shared) {

        try {
          const prev = localStorage.getItem(KEY);
          if (prev) localStorage.setItem(BACKUP, prev);
        } catch {  }
        write(shared);
        history.replaceState(null, "", location.pathname + location.search);
        return dress(shared);
      }
      return dress(read());
    },

    async ops(revision, ops) {
      const current = read();
      const dressed = JSON.stringify(dress(current));

      if (revision && JSON.parse(dressed).revision !== revision) {
        return { ok: false, message: "this board changed in another tab, reload before saving" };
      }
      const next = JSON.parse(JSON.stringify(current));
      try {
        applyOps(next, ops, today());
      } catch (err) {
        return { ok: false, message: String(err.message) };
      }
      const errs = validate(next);
      if (errs.length) return { ok: false, message: errs.slice(0, 3).join(" | ") };
      next.generated = new Date().toISOString();
      if (!write(next)) {
        return { ok: false, message: "this browser will not let the page save, check that site data is allowed" };
      }
      return { ok: true, doc: dress(next) };
    },


    async shareLink() {
      const doc = read();
      if (!doc.items.length) return null;
      const raw = new TextEncoder().encode(JSON.stringify(doc));
      let payload;
      try {
        payload = "z" + bytesToB64url(await pipe(raw, CompressionStream, "deflate-raw"));
      } catch {
        payload = "j" + bytesToB64url(raw);
      }
      return `${location.origin}${location.pathname}#d=${payload}`;
    },


    forget() {
      try { localStorage.removeItem(KEY); localStorage.removeItem(BACKUP); } catch {}
    },

    hasBackup() {
      try { return !!localStorage.getItem(BACKUP); } catch { return false; }
    },
    restoreBackup() {
      try {
        const b = localStorage.getItem(BACKUP);
        if (!b) return false;
        localStorage.setItem(KEY, b);
        localStorage.removeItem(BACKUP);
        return true;
      } catch { return false; }
    },
  };
}

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pipe(bytes, Ctor, mode) {
  const stream = new Blob([bytes]).stream().pipeThrough(new Ctor(mode));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readSharedLink() {
  const m = location.hash.match(/[#&]d=([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  try {
    const kind = m[1][0], body = m[1].slice(1);
    let raw = b64urlToBytes(body);
    if (kind === "z") raw = await pipe(raw, DecompressionStream, "deflate-raw");
    else if (kind !== "j") return null;
    const doc = JSON.parse(new TextDecoder().decode(raw));

    if (!doc || !Array.isArray(doc.items) || !Array.isArray(doc.projects)) return null;
    return doc;
  } catch {
    return null;
  }
}

export const store = LOCAL ? await localStore() : serverStore();
