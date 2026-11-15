/**
 * Finding the person in a video, in the browser (MediaPipe selfie segmenter,
 * self-hosted through utils/vision.js; loaded the first time background
 * removal is used).
 *
 * - analyzePersonMask(): the matte track of a clip's source, frame by frame
 *   (seeks a hidden video), for the preview and the render (utils/personMask.js).
 * - createLiveMatte(): the matte of whatever frame is showing right now, for
 *   the camera recorder and for a clip whose track is still being made.
 * - encodeMaskBlob() / decodeMaskBuffer(): the gzip file that goes to the server.
 */
import { MODEL_BASE, createVisionTask } from './vision'
import { isHlsUrl, attachHls, destroyHls } from './hlsHelper'
import {
  MASK_FPS, personMaskSize, personMaskRange, personMaskFrames, buildMaskPayload, parseMaskPayload
} from './personMask'

export const SEGMENTER_MODEL = `${MODEL_BASE}selfie_segmenter.tflite`

let segmenterPromise = null

/** The shared ImageSegmenter (image mode, confidence masks), created once. */
export function getPersonSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = createVisionTask((vision, fileset, delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SEGMENTER_MODEL, delegate },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false
    }))
    segmenterPromise.catch(() => { segmenterPromise = null })
  }
  return segmenterPromise
}

/**
 * Confidence (0-1 floats, one per pixel) of "person" -> bytes 0-255. The
 * selfie model has one mask (person); multi-class models list the
 * background first, so the person is everything that is not background.
 */
export function confidenceToBytes(masks, out) {
  if (!masks?.length) return false
  const many = masks.length > 1
  const f = masks[0].getAsFloat32Array()
  const n = Math.min(out.length, f.length)
  for (let i = 0; i < n; i++) {
    const v = many ? 1 - f[i] : f[i]
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
  }
  return true
}

/** Light temporal smoothing (the segmenter flickers a little from frame to frame). */
export function smoothInto(prev, cur, weight = 0.25) {
  if (!prev) return cur
  for (let i = 0; i < cur.length; i++) cur[i] = Math.round(cur[i] * (1 - weight) + prev[i] * weight)
  return cur
}

function makeSegmentCanvas() {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  return {
    canvas,
    draw(src, w, h) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(src, 0, 0, w, h)
      return canvas
    }
  }
}

/** Segment one frame (video / canvas / image) at w x h into `out` (Uint8Array w*h). */
function segmentFrame(segmenter, frameCanvas, out) {
  let ok = false
  segmenter.segment(frameCanvas, (result) => {
    ok = confidenceToBytes(result?.confidenceMasks, out)
  })
  return ok
}

const sourceSize = (src) => (src?.videoWidth !== undefined
  ? [src.videoWidth, src.videoHeight]
  : [src?.naturalWidth || src?.width || 0, src?.naturalHeight || src?.height || 0])

/**
 * The matte of the frame showing right now. get(src) answers at once: the
 * newest matte for that source, or null while the segmenter still loads
 * (onReady is called when it is there). At most one segmentation per frame
 * time and `minInterval` ms, so a paused picture costs nothing.
 */
export function createLiveMatte({ onReady, minInterval = 30 } = {}) {
  let segmenter = null
  let failed = false
  let loading = false
  const frame = makeSegmentCanvas()
  let out = null
  let prev = null
  let last = { src: null, t: -1, at: 0 }
  let result = null

  const load = () => {
    if (loading || segmenter || failed) return
    loading = true
    getPersonSegmenter().then((s) => { segmenter = s; onReady?.() }).catch((err) => {
      failed = true
      console.warn('[personSegmenter] could not load the segmenter:', err?.message || err)
    }).finally(() => { loading = false })
  }

  return {
    get failed() { return failed },
    get(src) {
      if (!segmenter) { load(); return null }
      const [sw, sh] = sourceSize(src)
      if (!sw || !sh) return result
      const live = !!src.srcObject
      const t = typeof src.currentTime === 'number' ? src.currentTime : 0
      const now = performance.now()
      const same = last.src === src && last.t === t && !live
      if (result && (same || now - last.at < minInterval)) return result
      const [w, h] = personMaskSize(sw, sh)
      if (!out || out.length !== w * h) { out = new Uint8Array(w * h); prev = null }
      try {
        const cur = new Uint8Array(w * h)
        if (segmentFrame(segmenter, frame.draw(src, w, h), cur)) {
          // smooth only while playing / live (a jump to another moment starts fresh)
          if (prev && (live || Math.abs(t - last.t) < 0.2)) smoothInto(prev, cur)
          out.set(cur)
          prev = cur
          result = { mask: out, w, h }
        }
      } catch (err) {
        console.warn('[personSegmenter] segmentation failed:', err?.message || err)
      }
      last = { src, t, at: now }
      return result
    }
  }
}

function waitFor(el, event, ms = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${event}`)) }, ms)
    const ok = () => { cleanup(); resolve() }
    const bad = () => { cleanup(); reject(new Error('Could not load the video')) }
    const cleanup = () => { clearTimeout(timer); el.removeEventListener(event, ok); el.removeEventListener('error', bad) }
    el.addEventListener(event, ok, { once: true })
    el.addEventListener('error', bad, { once: true })
  })
}

/**
 * The matte track of a clip's source: { header, frames } (utils/personMask.js).
 * clip: { url, duration, startTime, endTime }. Seeks a hidden copy of the video
 * to every 1/MASK_FPS s of the range and segments each frame.
 * onProgress(0..1); signal aborts.
 */
export async function analyzePersonMask(clip, { onProgress, signal } = {}) {
  const segmenter = await getPersonSegmenter()
  const v = document.createElement('video')
  v.crossOrigin = 'anonymous'
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  let hls = null
  try {
    const loaded = waitFor(v, 'loadeddata', 30000)
    if (isHlsUrl(clip.url)) hls = attachHls(v, clip.url)
    else v.src = clip.url
    await loaded
    const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : clip.duration
    const range = personMaskRange(duration, clip.startTime, clip.endTime)
    const total = personMaskFrames(range, MASK_FPS)
    const [w, h] = personMaskSize(v.videoWidth, v.videoHeight)
    const frames = new Uint8Array(w * h * total)
    const frame = makeSegmentCanvas()
    let prev = null
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const t = Math.min(range.start + i / MASK_FPS, Math.max(0, duration - 0.04))
      if (Math.abs(v.currentTime - t) > 0.001 || i === 0) {
        const seeked = waitFor(v, 'seeked')
        v.currentTime = t
        await seeked
      }
      const cur = frames.subarray(i * w * h, (i + 1) * w * h)
      if (!segmentFrame(segmenter, frame.draw(v, w, h), cur) && prev) cur.set(prev)
      smoothInto(prev, cur)
      prev = cur
      if (i % 5 === 0) onProgress?.((i + 1) / total)
    }
    onProgress?.(1)
    return { header: { v: 1, w, h, fps: MASK_FPS, start: Math.round(range.start * 1000) / 1000, frames: total }, frames }
  } finally {
    if (hls) destroyHls(hls)
    v.removeAttribute('src')
    v.load()
  }
}

async function streamThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The matte track as the gzip file the server keeps. */
export async function encodeMaskBlob(header, frames) {
  const payload = buildMaskPayload(header, frames)
  if (typeof CompressionStream === 'undefined') return new Blob([payload], { type: 'application/octet-stream' })
  return new Blob([await streamThrough(payload, new CompressionStream('gzip'))], { type: 'application/gzip' })
}

/** A matte file (gzip, or uncompressed) -> { header, data }, or null. */
export async function decodeMaskBuffer(buffer) {
  let bytes = new Uint8Array(buffer)
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') return null
    bytes = await streamThrough(bytes, new DecompressionStream('gzip'))
  }
  return parseMaskPayload(bytes)
}
