/* Ivy, the edits a board understands. */
import { STATUS, PRIORITY, AUTHORS, newItem } from "./schema.js";

const FIELDS = ["title", "why", "link", "blockedBy", "project", "status", "priority", "rank", "archived", "needs", "parent", "question", "askHelp", "mergedInto", "due", "pinned", "image"];

export const OPS = {
  patch(doc, op, today) {
    const it = doc.items.find((i) => i.id === op.id);
    if (!it) throw new Error(`unknown item ${op.id}`);
    for (const [k, v] of Object.entries(op.fields || {})) {
      if (!FIELDS.includes(k)) throw new Error(`field not editable: ${k}`);
      if (k === "status" && !STATUS[v]) throw new Error(`bad status ${v}`);


      if (k === "priority" && v !== "" && !PRIORITY[v]) throw new Error(`bad priority ${v}`);
      if (k === "rank" && (typeof v !== "number" || !Number.isFinite(v))) throw new Error("rank must be a number");
      if (typeof v === "string" && /[\r\n]/.test(v)) throw new Error(`${k} must be one line`);
      if (k === "needs" && !Array.isArray(v)) throw new Error("needs must be a list");
      if (k === "needs" && v.includes(op.id)) throw new Error("an item cannot be its own prerequisite");
      if (k === "parent" && v === op.id) throw new Error("an item cannot be its own parent");
      it[k] = v;
    }
    if (op.fields?.status && !STATUS[op.fields.status].active && !it.closed) it.closed = today;
    if (op.fields?.status && STATUS[op.fields.status].active) it.closed = null;
  },

  addLog(doc, op, today) {
    const it = doc.items.find((i) => i.id === op.id);
    if (!it) throw new Error(`unknown item ${op.id}`);
    if (!AUTHORS.includes(op.author)) throw new Error(`bad author ${op.author}`);
    const text = String(op.text).replace(/\s+/g, " ").trim();
    if (!text) throw new Error("empty log");
    it.log.push({ author: op.author, date: op.date || today, text, ...(op.at ? { at: op.at } : {}) });
  },

  add(doc, op, today) {
    const n = doc.items.reduce((m, i) => Math.max(m, Number(i.id.slice(1)) || 0), 0) + 1;
    const peers = doc.items.filter((i) => i.project === op.project);
    doc.items.push(
      newItem({
        id: `t${String(n).padStart(4, "0")}`,
        title: String(op.title).replace(/\s+/g, " ").trim(),
        project: op.project,
        status: op.status || "open",
        why: op.why || "",
        rank: peers.length + 1,
        created: today,
        source: { file: "board app", line: 0, section: "" },
      }),
    );
  },

  delete(doc, op) {
    doc.items = doc.items.filter((i) => i.id !== op.id);
  },






  reorder(doc, op) {
    const moved = op.orderedIds.map((id) => doc.items.find((x) => x.id === id)).filter(Boolean);
    moved.forEach((it) => (it.project = op.project));

    const slots = moved.map((it) => it.rank).sort((a, b) => a - b);
    moved.forEach((it, i) => (it.rank = slots[i]));

    doc.items
      .filter((i) => i.project === op.project)
      .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
      .forEach((it, i) => (it.rank = i + 1));
  },
};

export function applyOps(doc, ops, today) {
  for (const op of ops || []) {
    const fn = OPS[op.type];
    if (!fn) throw new Error(`unknown op ${op.type}`);
    fn(doc, op, today);
  }
}
