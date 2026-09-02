/* Ivy, the shape of a board. */
export const STATUS = {
  "open": {
    "label": "Open",
    "hint": "Ready to work on right now",
    "active": true,
    "tier": 1
  },
  "mine": {
    "label": "Only you can do it",
    "hint": "A task nobody else can take. Not a decision, a task",
    "active": true,
    "tier": 1
  },
  "blocked-vi": {
    "label": "Needs a decision",
    "hint": "Waiting on a judgment call, an asset, or a choice",
    "active": true,
    "tier": 1
  },
  "blocked-ext": {
    "label": "Blocked outside",
    "hint": "Waiting on something you do not control",
    "active": true,
    "tier": 2
  },
  "review": {
    "label": "Needs a look",
    "hint": "Done enough to check, not yet signed off",
    "active": true,
    "tier": 2
  },
  "triage": {
    "label": "Needs triage",
    "hint": "Imported from somewhere else, may be stale or already done",
    "active": true,
    "tier": 2,
    "pickable": false
  },
  "parked": {
    "label": "On hold",
    "hint": "Deliberately paused. Not blocked, not dropped, just not now",
    "active": true,
    "tier": 2
  },
  "done": {
    "label": "Done",
    "hint": "Finished",
    "active": false,
    "tier": 1
  },
  "dropped": {
    "label": "Dropped",
    "hint": "Deliberately not doing, the reason kept in the log",
    "active": false,
    "tier": 2
  }
};

export const STATUS_ORDER = ["blocked-vi", "mine", "open", "review", "blocked-ext", "parked", "triage", "done", "dropped"];

export const PRIORITY = {
  p1: { label: "Critical", short: "P1", hint: "Drop the other thing. This is the one" },
  p2: { label: "High", short: "P2", hint: "Ahead of the ordinary queue" },
  p3: { label: "Normal", short: "P3", hint: "The default weight, ordered by the board" },
  p4: { label: "Low", short: "P4", hint: "Real, but it can always wait" },
};

export const PRIORITY_ORDER = ["p1", "p2", "p3", "p4"];

export const PROJECTS = [
  {
    "id": "work",
    "name": "Work",
    "order": 1
  },
  {
    "id": "personal",
    "name": "Personal",
    "order": 2
  },
  {
    "id": "learning",
    "name": "Learning",
    "order": 3
  },
  {
    "id": "side",
    "name": "Side project",
    "order": 4
  },
  {
    "id": "home",
    "name": "Home",
    "order": 5
  },
  {
    "id": "misc",
    "name": "Unsorted",
    "order": 6
  }
];

export const AUTHORS = [
  "You"
];

export function emptyDoc() {
  return {
    version: 1,
    generated: new Date().toISOString(),
    projects: PROJECTS,
    items: [],
    notes: [],
  };
}

export function newItem(partial = {}) {
  return {
    id: partial.id || "",
    title: "",
    why: "",
    link: "",
    project: "misc",
    status: "open",
    priority: "",



    rank: 0,




    due: "",





    pinned: "",








    blockedBy: "",
    question: "",

    detail: [],
    log: [],
    parent: null,

    archived: false,
    needs: [],
    askHelp: false,


    mergedInto: null,


    image: "",




    source: null,
    created: "",
    closed: null,
    ...partial,
  };
}

export function validate(doc) {
  const errs = [];
  const ids = new Set();
  const projectIds = new Set(doc.projects.map((p) => p.id));
  for (const it of doc.items) {
    if (!it.id) errs.push(`item with no id: ${it.title.slice(0, 40)}`);
    if (ids.has(it.id)) errs.push(`duplicate id ${it.id}`);
    ids.add(it.id);
    if (!it.title.trim()) errs.push(`${it.id} has no title`);
    if (!STATUS[it.status]) errs.push(`${it.id} bad status ${it.status}`);
    if (!projectIds.has(it.project)) errs.push(`${it.id} bad project ${it.project}`);

    if (it.parent) {
      const par = doc.items.find((x) => x.id === it.parent);
      if (!par) errs.push(`${it.id} has unknown parent ${it.parent}`);
      else if (par.id === it.id) errs.push(`${it.id} is its own parent`);
      else {
        const seen = new Set([it.id]);
        let cur = par;
        while (cur) {
          if (seen.has(cur.id)) { errs.push(`${it.id} is in a parent loop through ${cur.id}`); break; }
          seen.add(cur.id);
          cur = cur.parent ? doc.items.find((x) => x.id === cur.parent) : null;
        }
      }
    }

    if (it.priority !== undefined && it.priority !== "" && !PRIORITY[it.priority]) {
      errs.push(`${it.id} bad priority ${it.priority}`);
    }


    if (it.askHelp !== undefined && typeof it.askHelp !== "boolean") errs.push(`${it.id} askHelp must be true or false`);



    if (it.image !== undefined && it.image !== "") {
      if (typeof it.image !== "string") errs.push(`${it.id} image must be a path`);
      else if (!/^\/thumbs\/[A-Za-z0-9._-]+$/.test(it.image)) errs.push(`${it.id} image must be a /thumbs/ path, got ${it.image}`);
    }
    if (it.due && !/^\d{4}-\d{2}-\d{2}$/.test(it.due)) errs.push(`${it.id} bad due date ${it.due}`);
    if (it.mergedInto) {
      if (it.mergedInto === it.id) errs.push(`${it.id} is merged into itself`);
      else if (!doc.items.some((x) => x.id === it.mergedInto)) errs.push(`${it.id} merged into unknown item ${it.mergedInto}`);
    }
    for (const dep of it.needs || []) {
      if (!doc.items.some((x) => x.id === dep)) errs.push(`${it.id} needs unknown item ${dep}`);
      if (dep === it.id) errs.push(`${it.id} lists itself as a prerequisite`);
    }
    for (const l of it.log) {
      if (!AUTHORS.includes(l.author)) errs.push(`${it.id} bad log author ${l.author}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date)) errs.push(`${it.id} bad log date ${l.date}`);
    }
  }
  return errs;
}
