// fork (fedgar): custom 3D models. A small reader for glTF 2.0 binaries (.glb) and .gltf files with embedded
// buffers, without three's GLTFLoader (it would cost ~60 KB in every bundle that draws furniture). It reads the
// triangles of the default scene with their node transforms, the material colours, vertex colours and texture
// coordinates. Textures are sampled by the caller (the browser decodes the images), see viewer/models.ts.
// Not supported: Draco / meshopt compression, morph targets, skins (the rest pose is drawn).

export interface ParsedModel {
  /** Triangle corners in model units (y up), 9 numbers per triangle. */
  pos: Float32Array;
  /** Linear rgb per corner, 9 numbers per triangle (material colour times vertex colour). */
  col: Float32Array;
  /** Texture coordinates per corner (6 per triangle); only meaningful where `tex` is not -1. */
  uv: Float32Array;
  /** Image index per triangle (-1: no texture). */
  tex: Int32Array;
  /** The images textures refer to, as bytes with their type. */
  images: { mime: string; bytes: Uint8Array }[];
}

export interface ModelMesh {
  /** Triangle corners fitted into the unit box: x and z -0.5..0.5, y 0..1. */
  pos: Float32Array;
  /** Linear rgb per corner. */
  col: Float32Array;
  /** Feature edges (sharp creases and open borders) in the same unit box, 6 numbers per segment. */
  edges: Float32Array;
  /** The model's own size in its units (metres for most models): width x, depth z, height y. */
  size: [number, number, number];
  tris: number;
}

/** Most triangles one model may have (the whole plan is one buffer; low-poly models have a few thousand). */
export const MAX_MODEL_TRIS = 80_000;

export class ModelError extends Error {
  readonly code: "format" | "compressed" | "empty" | "too_big";
  constructor(code: ModelError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

type Json = Record<string, any>;
type Mat = Float64Array;

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const UNSUPPORTED = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_meshopt_compression"];

/** Read a .glb (or a .gltf whose buffers are data: URIs). */
export function parseGlb(data: ArrayBuffer): ParsedModel {
  const view = new DataView(data);
  let json: Json;
  let bin: Uint8Array | null = null;
  if (data.byteLength >= 12 && view.getUint32(0, true) === 0x46546c67) {
    if (view.getUint32(4, true) !== 2) throw new ModelError("format", "Only glTF 2.0 is supported");
    let at = 12;
    json = {};
    while (at + 8 <= data.byteLength) {
      const len = view.getUint32(at, true);
      const type = view.getUint32(at + 4, true);
      const body = new Uint8Array(data, at + 8, len);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
      else if (type === 0x004e4942) bin = body;
      at += 8 + len + ((4 - (len % 4)) % 4);
    }
  } else {
    try {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(data)));
    } catch {
      throw new ModelError("format", "Not a glTF file");
    }
  }
  for (const ext of json.extensionsRequired ?? []) {
    if (UNSUPPORTED.includes(ext)) throw new ModelError("compressed", `Compressed models (${ext}) are not supported, export without compression`);
  }
  const buffers: Uint8Array[] = (json.buffers ?? []).map((b: Json, i: number) => {
    if (b.uri === undefined) {
      if (i === 0 && bin) return bin;
      throw new ModelError("format", "Missing binary chunk");
    }
    const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(b.uri);
    if (!m) throw new ModelError("format", "External buffers are not supported, export as .glb");
    return m[1] ? b64(m[2]) : new TextEncoder().encode(decodeURIComponent(m[2]));
  });

  const viewBytes = (i: number): { bytes: Uint8Array; stride: number | undefined } => {
    const bv = json.bufferViews?.[i];
    if (!bv) throw new ModelError("format", "Bad buffer view");
    const buf = buffers[bv.buffer];
    return { bytes: new Uint8Array(buf.buffer, buf.byteOffset + (bv.byteOffset ?? 0), bv.byteLength), stride: bv.byteStride };
  };

  const accCache = new Map<number, Float64Array>();
  const accessor = (i: number): { v: Float64Array; n: number } => {
    const a = json.accessors?.[i];
    if (!a) throw new ModelError("format", "Bad accessor");
    const n = COMPONENTS[a.type] ?? 1;
    let v = accCache.get(i);
    if (!v) {
      v = new Float64Array(a.count * n);
      if (a.bufferView !== undefined) {
        const { bytes, stride } = viewBytes(a.bufferView);
        const dv = new DataView(bytes.buffer, bytes.byteOffset + (a.byteOffset ?? 0));
        const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType as 5120];
        if (!size) throw new ModelError("format", "Bad component type");
        const step = stride ?? size * n;
        const norm = !!a.normalized;
        for (let k = 0; k < a.count; k++) {
          for (let c = 0; c < n; c++) {
            const o = k * step + c * size;
            let x: number;
            switch (a.componentType) {
              case 5126: x = dv.getFloat32(o, true); break;
              case 5125: x = dv.getUint32(o, true); break;
              case 5123: x = dv.getUint16(o, true); if (norm) x /= 65535; break;
              case 5122: x = dv.getInt16(o, true); if (norm) x = Math.max(x / 32767, -1); break;
              case 5121: x = dv.getUint8(o); if (norm) x /= 255; break;
              default: x = dv.getInt8(o); if (norm) x = Math.max(x / 127, -1);
            }
            v[k * n + c] = x;
          }
        }
      }
      accCache.set(i, v);
    }
    return { v, n };
  };

  // the images textures point at (embedded in the binary or as data: URIs)
  const images: ParsedModel["images"] = (json.images ?? []).map((img: Json) => {
    if (img.bufferView !== undefined) return { mime: img.mimeType ?? "image/png", bytes: viewBytes(img.bufferView).bytes };
    const m = typeof img.uri === "string" ? /^data:([^;,]*)(;base64)?,(.*)$/s.exec(img.uri) : null;
    return m && m[2] ? { mime: m[1] || "image/png", bytes: b64(m[3]) } : { mime: "", bytes: new Uint8Array() };
  });
  const textureImage = (t: number | undefined): number => {
    if (t === undefined) return -1;
    const tex = json.textures?.[t];
    const src = tex?.source ?? tex?.extensions?.EXT_texture_webp?.source ?? tex?.extensions?.KHR_texture_basisu?.source;
    return src !== undefined && images[src]?.bytes.length ? src : -1;
  };

  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const tex: number[] = [];

  const drawMesh = (meshIndex: number, m: Mat) => {
    const mesh = json.meshes?.[meshIndex];
    if (!mesh) return;
    const flip = det3(m) < 0;
    for (const prim of mesh.primitives ?? []) {
      const mode = prim.mode ?? 4;
      if (mode !== 4 && mode !== 5 && mode !== 6) continue;
      if (prim.attributes?.POSITION === undefined) continue;
      const P = accessor(prim.attributes.POSITION);
      const count = P.v.length / 3;
      const C = prim.attributes.COLOR_0 !== undefined ? accessor(prim.attributes.COLOR_0) : null;
      const mat = prim.material !== undefined ? json.materials?.[prim.material] : null;
      const pbr = mat?.pbrMetallicRoughness ?? {};
      const spec = mat?.extensions?.KHR_materials_pbrSpecularGlossiness;
      const f: number[] = pbr.baseColorFactor ?? spec?.diffuseFactor ?? [1, 1, 1, 1];
      const texInfo = pbr.baseColorTexture ?? spec?.diffuseTexture;
      const img = textureImage(texInfo?.index);
      const uvSet = texInfo?.texCoord ?? 0;
      const T = img >= 0 && prim.attributes[`TEXCOORD_${uvSet}`] !== undefined ? accessor(prim.attributes[`TEXCOORD_${uvSet}`]) : null;
      // without a texture or colour of its own, a plain white material is drawn in a soft grey (it would glare)
      const plain = !C && img < 0 && f[0] > 0.97 && f[1] > 0.97 && f[2] > 0.97;
      const base = plain ? [0.55, 0.57, 0.6] : f;
      let idx: number[];
      if (prim.indices !== undefined) idx = Array.from(accessor(prim.indices).v);
      else idx = Array.from({ length: count }, (_, k) => k);
      const tris: number[] = [];
      if (mode === 4) tris.push(...idx);
      else if (mode === 5) for (let k = 0; k + 2 < idx.length; k++) tris.push(...(k % 2 ? [idx[k + 1], idx[k], idx[k + 2]] : [idx[k], idx[k + 1], idx[k + 2]]));
      else for (let k = 1; k + 1 < idx.length; k++) tris.push(idx[0], idx[k], idx[k + 1]);
      for (let t = 0; t + 2 < tris.length; t += 3) {
        const corners = flip ? [tris[t], tris[t + 2], tris[t + 1]] : [tris[t], tris[t + 1], tris[t + 2]];
        for (const k of corners) {
          const x = P.v[k * 3];
          const y = P.v[k * 3 + 1];
          const z = P.v[k * 3 + 2];
          pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
          const cr = C ? C.v[k * C.n] : 1;
          const cg = C ? C.v[k * C.n + 1] : 1;
          const cb = C ? C.v[k * C.n + 2] : 1;
          col.push(base[0] * cr, base[1] * cg, base[2] * cb);
          uv.push(T ? T.v[k * 2] : 0, T ? T.v[k * 2 + 1] : 0);
        }
        tex.push(T ? img : -1);
        if (tex.length > MAX_MODEL_TRIS) throw new ModelError("too_big", `More than ${MAX_MODEL_TRIS} triangles, use a simpler (low-poly) model`);
      }
    }
  };

  const walk = (n: number, parent: Mat, depth: number) => {
    const node = json.nodes?.[n];
    if (!node || depth > 64) return;
    const m = mul(parent, local(node));
    if (node.mesh !== undefined) drawMesh(node.mesh, m);
    for (const c of node.children ?? []) walk(c, m, depth + 1);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  const roots: number[] = scene?.nodes ?? (json.nodes ?? []).map((_: unknown, i: number) => i).filter((i: number) => !(json.nodes as Json[]).some((p) => p.children?.includes(i)));
  for (const r of roots) walk(r, identity(), 0);
  if (!tex.length) throw new ModelError("empty", "The model has no triangles");
  return { pos: Float32Array.from(pos), col: Float32Array.from(col), uv: Float32Array.from(uv), tex: Int32Array.from(tex), images };
}

/**
 * Fit a parsed model into the unit box (x, z -0.5..0.5 around its middle, y 0..1 from its lowest point) and find
 * its feature edges. `colorAt(image, u, v)` returns a texture's linear colour (or null when it is not decoded).
 */
export function fitModel(p: ParsedModel, colorAt: ((image: number, u: number, v: number) => [number, number, number] | null) | null = null): ModelMesh {
  const n = p.pos.length / 3;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
    const v = p.pos[i * 3 + a];
    if (v < lo[a]) lo[a] = v;
    if (v > hi[a]) hi[a] = v;
  }
  const size: [number, number, number] = [hi[0] - lo[0], hi[2] - lo[2], hi[1] - lo[1]];
  const sx = 1 / Math.max(size[0], 1e-6);
  const sy = 1 / Math.max(size[2], 1e-6);
  const sz = 1 / Math.max(size[1], 1e-6);
  const cx = (lo[0] + hi[0]) / 2;
  const cz = (lo[2] + hi[2]) / 2;
  const pos = new Float32Array(p.pos.length);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (p.pos[i * 3] - cx) * sx;
    pos[i * 3 + 1] = (p.pos[i * 3 + 1] - lo[1]) * sy;
    pos[i * 3 + 2] = (p.pos[i * 3 + 2] - cz) * sz;
  }
  const col = Float32Array.from(p.col);
  if (colorAt) {
    for (let t = 0; t < p.tex.length; t++) {
      if (p.tex[t] < 0) continue;
      for (let k = 0; k < 3; k++) {
        const i = t * 3 + k;
        const c = colorAt(p.tex[t], p.uv[i * 2], p.uv[i * 2 + 1]);
        if (c) for (let a = 0; a < 3; a++) col[i * 3 + a] *= c[a];
      }
    }
  }
  return { pos, col, edges: featureEdges(pos, size), size, tris: n / 3 };
}

/** Edges where two faces meet at a sharp angle (over ~35°) or a face has no neighbour (an open border). */
export function featureEdges(pos: Float32Array, size: [number, number, number], maxSegments = 12_000): Float32Array {
  const tris = pos.length / 9;
  // the angle is judged at the model's real proportions, not in the stretched unit box
  const S = [size[0], size[2], size[1]];
  const key = (i: number) => `${Math.round(pos[i * 3] * 4096)},${Math.round(pos[i * 3 + 1] * 4096)},${Math.round(pos[i * 3 + 2] * 4096)}`;
  const normals = new Float32Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const ax = (pos[o + 3] - pos[o]) * S[0], ay = (pos[o + 4] - pos[o + 1]) * S[1], az = (pos[o + 5] - pos[o + 2]) * S[2];
    const bx = (pos[o + 6] - pos[o]) * S[0], by = (pos[o + 7] - pos[o + 1]) * S[1], bz = (pos[o + 8] - pos[o + 2]) * S[2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    normals.set([nx / l, ny / l, nz / l], t * 3);
  }
  const edges = new Map<string, { a: number; b: number; faces: number[] }>();
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const a = t * 3 + k;
      const b = t * 3 + ((k + 1) % 3);
      const ka = key(a);
      const kb = key(b);
      if (ka === kb) continue;
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = edges.get(id);
      if (e) e.faces.push(t);
      else edges.set(id, { a, b, faces: [t] });
    }
  }
  const out: number[] = [];
  const cos = Math.cos((35 * Math.PI) / 180);
  for (const e of edges.values()) {
    let sharp = e.faces.length !== 2;
    if (!sharp) {
      const [f, g] = e.faces;
      sharp = normals[f * 3] * normals[g * 3] + normals[f * 3 + 1] * normals[g * 3 + 1] + normals[f * 3 + 2] * normals[g * 3 + 2] < cos;
    }
    if (!sharp) continue;
    out.push(pos[e.a * 3], pos[e.a * 3 + 1], pos[e.a * 3 + 2], pos[e.b * 3], pos[e.b * 3 + 1], pos[e.b * 3 + 2]);
    if (out.length / 6 >= maxSegments) break;
  }
  return Float32Array.from(out);
}

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function identity(): Mat {
  return Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/** Column-major 4×4 product a·b. */
function mul(a: Mat, b: Mat): Mat {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

function local(node: Json): Mat {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return Float64Array.from(node.matrix);
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return Float64Array.from([
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

function det3(m: Mat): number {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}
