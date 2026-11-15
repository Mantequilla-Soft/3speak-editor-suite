/**
 * MediaPipe Tasks Vision (@mediapipe/tasks-vision), self-hosted and loaded
 * only when a feature needs it: the library, its wasm runtime and the models
 * all come from the editor's own origin, never from a CDN.
 *
 * - The library is a dynamic import (its own chunk).
 * - The wasm runtime is served from public/vision/wasm/ (copied from
 *   node_modules by scripts/vision/copy-assets.mjs before dev and build);
 *   FilesetResolver picks the SIMD or the plain build.
 * - Models live in public/vision/models/ (MODEL_BASE), listed with their
 *   sha256 in the same script.
 *
 * Shared: background removal (utils/personSegmenter.js) loads through here;
 * face tracking (utils/faceTrack.js) uses the same /vision/wasm runtime.
 */

const BASE = (import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/')
export const VISION_WASM = `${BASE}vision/wasm`
export const MODEL_BASE = `${BASE}vision/models/`

let visionPromise = null

/** { vision, fileset }: the tasks-vision module and the WasmFileset for it. */
export function loadVision() {
  if (!visionPromise) {
    visionPromise = (async () => {
      const vision = await import('@mediapipe/tasks-vision')
      const fileset = await vision.FilesetResolver.forVisionTasks(VISION_WASM)
      return { vision, fileset }
    })()
    // a failed load (offline, blocked) may be retried later
    visionPromise.catch(() => { visionPromise = null })
  }
  return visionPromise
}

/**
 * Create a tasks-vision task, trying the GPU delegate first when asked and
 * falling back to the CPU. `create(vision, fileset, delegate)` builds it.
 */
export async function createVisionTask(create, { gpu = false } = {}) {
  const { vision, fileset } = await loadVision()
  if (gpu) {
    try {
      return await create(vision, fileset, 'GPU')
    } catch (err) {
      console.warn('[vision] GPU delegate unavailable, using the CPU:', err?.message || err)
    }
  }
  return create(vision, fileset, 'CPU')
}
