// fork (fedgar): custom 3D models (.glb) as furniture. The plan is built synchronously into one buffer, so models
// are fetched and read ahead: an item whose model is not ready yet is drawn as a box, and the viewer rebuilds the
// plan once the model arrived (onModelReady).

import { fitModel, ModelError, parseGlb, type ModelMesh } from "../glb.ts";

type Entry = { state: "loading" } | { state: "ready"; mesh: ModelMesh } | { state: "error"; error: string };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let pending: ReturnType<typeof setTimeout> | null = null;

/** Called (once, a little delayed so several models arriving together rebuild once) when a model is ready. */
export function onModelReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    for (const fn of listeners) fn();
  }, 60);
}

/** The model of `url` when it is ready; starts loading it otherwise (null meanwhile and on errors). */
export function modelMesh(url: string | null | undefined): ModelMesh | null {
  if (!url) return null;
  const e = cache.get(url);
  if (e?.state === "ready") return e.mesh;
  if (!e) load(url);
  return null;
}

/** Why a model failed to load (null while it loads or once it is ready). */
export function modelError(url: string): string | null {
  const e = cache.get(url);
  return e?.state === "error" ? e.error : null;
}

/** Forget a model so it is fetched anew (after a new upload under the same name). */
export function forgetModel(url: string): void {
  cache.delete(url);
}

/** Load a model now and wait for it (the editor's "use the model's size"). */
export async function loadModel(url: string): Promise<ModelMesh> {
  const e = cache.get(url);
  if (e?.state === "ready") return e.mesh;
  if (e?.state === "error") cache.delete(url);
  return load(url);
}

const inflight = new Map<string, Promise<ModelMesh>>();

function load(url: string): Promise<ModelMesh> {
  const running = inflight.get(url);
  if (running) return running;
  cache.set(url, { state: "loading" });
  const p = (async () => {
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseGlb(await res.arrayBuffer());
      const textures = await Promise.all(parsed.images.map((img) => decode(img.mime, img.bytes).catch(() => null)));
      const mesh = fitModel(parsed, (i, u, v) => sample(textures[i], u, v));
      cache.set(url, { state: "ready", mesh });
      notify();
      return mesh;
    } catch (err) {
      const msg = err instanceof ModelError ? err.message : String((err as Error)?.message ?? err);
      cache.set(url, { state: "error", error: msg });
      console.warn(`NeonPlan 3D: model ${url} could not be loaded: ${msg}`);
      throw err;
    } finally {
      inflight.delete(url);
    }
  })();
  // nobody waits on a load started by the viewer: keep its rejection quiet
  p.catch(() => undefined);
  inflight.set(url, p);
  return p;
}

interface Texture {
  w: number;
  h: number;
  /** Linear rgb, 3 floats per pixel. */
  px: Float32Array;
}

/** Decode an image into a small (at most 256 px) table of linear colours. */
async function decode(mime: string, bytes: Uint8Array): Promise<Texture | null> {
  if (!bytes.length || typeof createImageBitmap !== "function") return null;
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime || "image/png" }));
  const k = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const data = ctx.getImageData(0, 0, w, h).data;
  const px = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) for (let a = 0; a < 3; a++) px[i * 3 + a] = toLinear(data[i * 4 + a] / 255);
  return { w, h, px };
}

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Nearest texel at (u, v), repeating outside 0..1 (the glTF default). */
function sample(t: Texture | null, u: number, v: number): [number, number, number] | null {
  if (!t) return null;
  const fu = u - Math.floor(u);
  const fv = v - Math.floor(v);
  const x = Math.min(t.w - 1, Math.floor(fu * t.w));
  const y = Math.min(t.h - 1, Math.floor(fv * t.h));
  const i = (y * t.w + x) * 3;
  return [t.px[i], t.px[i + 1], t.px[i + 2]];
}
