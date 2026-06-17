// io.js — export.
//
// We export world-space geometry: each object's mesh is baked with its world
// matrix, then serialized. Two formats:
//   - STL  (binary)  — universal, geometry only.
//   - 3MF  (zip/OPC) — modern: declares millimetre units, single clean container.
//
// Loose holes (role 'hole') are skipped — a bare negative-space part isn't a
// printable solid; holes only mean something once consumed by a Group.

import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { zipSync, strToU8 } from 'fflate';

// CADence works Y-up; slicers expect Z-up. Bake this rotation into exports so
// parts drop onto the print bed upright instead of lying on their side.
// +90° about X sends CADence's +Y (up) to the slicer's +Z (up); the -90° we
// used before sent it to -Z, which landed parts upside down on the bed.
const Z_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2);

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function printable(objects) {
  // Skip loose holes (negative space) and hidden objects.
  return objects.filter((o) => o.role !== 'hole' && o.mesh.visible !== false);
}

export function exportSTL(objects, filename = 'cadence-part.stl') {
  const group = new THREE.Group();
  for (const obj of printable(objects)) {
    obj.mesh.updateWorldMatrix(true, false);
    const baked = obj.mesh.geometry.clone();
    baked.applyMatrix4(obj.mesh.matrixWorld);
    baked.applyMatrix4(Z_UP);
    group.add(new THREE.Mesh(baked, obj.mesh.material));
  }
  if (!group.children.length) return false;

  const data = new STLExporter().parse(group, { binary: true });
  triggerDownload(new Blob([data], { type: 'model/stl' }), filename);
  group.children.forEach((m) => m.geometry.dispose());
  return true;
}

// --- 3MF ------------------------------------------------------------------

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

// Merge every printable object into one world-space triangle soup. Everything is
// de-indexed, so each consecutive trio of vertices is one triangle.
function gatherWorldMesh(objects) {
  const verts = [];
  const tris = [];
  let base = 0;
  for (const obj of printable(objects)) {
    obj.mesh.updateWorldMatrix(true, false);
    const g = obj.mesh.geometry.index ? obj.mesh.geometry.toNonIndexed() : obj.mesh.geometry.clone();
    g.applyMatrix4(obj.mesh.matrixWorld);
    g.applyMatrix4(Z_UP);
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) verts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    for (let i = 0; i < pos.count; i += 3) tris.push(base + i, base + i + 1, base + i + 2);
    base += pos.count;
    g.dispose();
  }
  return { verts, tris };
}

const f = (n) => +n.toFixed(4); // trim float noise to keep the file lean

function buildModelXML(verts, tris) {
  const v = [];
  for (let i = 0; i < verts.length; i += 3) v.push(`<vertex x="${f(verts[i])}" y="${f(verts[i + 1])}" z="${f(verts[i + 2])}"/>`);
  const t = [];
  for (let i = 0; i < tris.length; i += 3) t.push(`<triangle v1="${tris[i]}" v2="${tris[i + 1]}" v3="${tris[i + 2]}"/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>${v.join('')}</vertices>
        <triangles>${t.join('')}</triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1"/></build>
</model>`;
}

export function export3MF(objects, filename = 'cadence-part.3mf') {
  const { verts, tris } = gatherWorldMesh(objects);
  if (!tris.length) return false;

  const zipped = zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': strToU8(buildModelXML(verts, tris)),
  });
  triggerDownload(new Blob([zipped], { type: 'model/3mf' }), filename);
  return true;
}

// --- project save (JSON) --------------------------------------------------
export function downloadJSON(data, filename = 'project.cadence.json') {
  triggerDownload(new Blob([JSON.stringify(data)], { type: 'application/json' }), filename);
}
