// settings.js — user preferences: UI style, render mode, control scheme.
//
// Pure catalog + persistence. The *application* of each setting lives in main.js
// (it needs the live scene, renderer, and controls); this module just owns the
// list of choices and reads/writes them to localStorage so they survive reload.

export const UI_STYLES = [
  { id: 'midnight',  label: 'Midnight',  note: 'soft dark (default)' },
  { id: 'graphite',  label: 'Graphite',  note: 'flat, neutral, sharp' },
  { id: 'blueprint', label: 'Blueprint', note: 'technical blue' },
  { id: 'paper',     label: 'Paper',     note: 'light mode' },
  { id: 'neon',      label: 'Neon',      note: 'playful, rounded' },
];

export const RENDER_MODES = [
  { id: 'shaded',    label: 'Shaded',    note: 'lit solids (default)' },
  { id: 'matte',     label: 'Matte',     note: 'flat clay, no shine' },
  { id: 'wireframe', label: 'Wireframe', note: 'edges only' },
  { id: 'xray',      label: 'X-ray',     note: 'see-through' },
];

// Each preset maps the three mouse buttons to a navigation verb. OrbitControls
// is button-based (no modifier nav yet), so these approximate each app's feel by
// matching which button orbits / pans / dollies. Modifier-key nav is a later pass.
export const CONTROL_PRESETS = [
  { id: 'cadence',    label: 'CADence',    map: { LEFT: 'ROTATE', MIDDLE: 'PAN',    RIGHT: 'PAN'    } },
  { id: 'blender',    label: 'Blender',    map: { LEFT: 'ROTATE', MIDDLE: 'ROTATE', RIGHT: 'PAN'    } },
  { id: 'maya',       label: 'Maya',       map: { LEFT: 'ROTATE', MIDDLE: 'PAN',    RIGHT: 'DOLLY'  } },
  { id: 'solidworks', label: 'SolidWorks', map: { LEFT: 'ROTATE', MIDDLE: 'ROTATE', RIGHT: 'PAN'    } },
  { id: 'onshape',    label: 'OnShape',    map: { LEFT: 'ROTATE', MIDDLE: 'PAN',    RIGHT: 'ROTATE' } },
];

// Per-button navigation verbs for the custom-controls mapper.
export const NAV_VERBS = [
  { id: 'ROTATE', label: 'Rotate' },
  { id: 'PAN',    label: 'Pan' },
  { id: 'DOLLY',  label: 'Dolly' },
  { id: 'NONE',   label: '—' },
];

const KEY = 'cadence.settings.v1';
const DEFAULTS = {
  ui: 'midnight', render: 'shaded', controls: 'cadence',
  map: null,          // active {LEFT,MIDDLE,RIGHT} verb map; null = derive from `controls`
  userPresets: [],    // [{ id, label, map }] saved by the user
};

export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode / quota — non-fatal */ }
}

export function controlMap(id) {
  return (CONTROL_PRESETS.find((p) => p.id === id) || CONTROL_PRESETS[0]).map;
}
