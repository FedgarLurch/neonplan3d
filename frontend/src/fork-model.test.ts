// fork (fedgar): the .glb reader for custom models.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitModel, ModelError, parseGlb } from "./glb.ts";

/** A .glb with one box (12 triangles) of size sx × sy × sz, its node moved by `t` and scaled by `s`. */
export function boxGlb(sx = 2, sy = 1, sz = 0.5, t = [5, 3, -1], s = [1, 1, 1], color = [1, 0, 0, 1]): ArrayBuffer {
  const x = sx / 2, y = sy / 2, z = sz / 2;
  const v = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ].flat();
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const pos = new Float32Array(v);
  const ind = new Uint16Array(idx);
  const bin = new Uint8Array(pos.byteLength + ind.byteLength + 2);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(ind.buffer), pos.byteLength);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: t, scale: s }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: color } }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: ind.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-x, -y, -z], max: [x, y, z] },
      { bufferView: 1, componentType: 5123, count: idx.length, type: "SCALAR" },
    ],
  };
  let text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (text.length % 4)) % 4;
  text = Uint8Array.from([...text, ...Array(pad).fill(0x20)]);
  const total = 12 + 8 + text.length + 8 + bin.byteLength;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, text.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, text.length).set(text);
  dv.setUint32(20 + text.length, bin.byteLength, true);
  dv.setUint32(24 + text.length, 0x004e4942, true);
  new Uint8Array(out, 28 + text.length).set(bin);
  return out;
}

test("reads the triangles with the node transform and material colour", () => {
  const p = parseGlb(boxGlb());
  assert.equal(p.tex.length, 12);
  // moved by the node's translation
  const xs = Array.from(p.pos).filter((_, i) => i % 3 === 0);
  assert.ok(Math.abs(Math.min(...xs) - (4)) < 1e-5);
  assert.ok(Math.abs(Math.max(...xs) - (6)) < 1e-5);
  assert.deepEqual([p.col[0], p.col[1], p.col[2]], [1, 0, 0]);
});

test("fits the model into the unit box and keeps its own size", () => {
  const m = fitModel(parseGlb(boxGlb(2, 1, 0.5, [0, 0, 0], [2, 2, 2])));
  assert.ok(Math.abs(m.size[0] - (4)) < 1e-5);
  assert.ok(Math.abs(m.size[1] - (1)) < 1e-5);
  assert.ok(Math.abs(m.size[2] - (2)) < 1e-5);
  const ys = Array.from(m.pos).filter((_, i) => i % 3 === 1);
  assert.ok(Math.abs(Math.min(...ys) - (0)) < 1e-5);
  assert.ok(Math.abs(Math.max(...ys) - (1)) < 1e-5);
  // a box has 12 sharp edges, the face diagonals are not drawn
  assert.equal(m.edges.length / 6, 12);
});

test("draws a plain white material in grey, not glaring white", () => {
  const p = parseGlb(boxGlb(1, 1, 1, [0, 0, 0], [1, 1, 1], [1, 1, 1, 1]));
  assert.ok(p.col[0] < 0.7);
});

test("refuses compressed models with a clear reason", () => {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, extensionsRequired: ["KHR_draco_mesh_compression"] }));
  assert.throws(() => parseGlb(json.buffer), ModelError);
});
