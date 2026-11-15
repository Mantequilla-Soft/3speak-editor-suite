import { smoothPath } from './reframe'

// Face tracking for automatic reframing (utils/reframe.js): MediaPipe's Face
// Detector runs in the browser on the clip's editing copy (the 480p proxy the
// preview plays), a few frames per second, and the faces become a smoothed
// path the reframed window follows. The wasm files and the model are served by
// the editor itself (public/vision/, scripts/vision/copy-assets.mjs): nothing
// is fetched from a CDN.

const BASE = (import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/')
export const VISION_WASM = `${BASE}vision/wasm`
export const FACE_MODEL = `${BASE}vision/models/blaze_face_short_range.tflite`
// Frames looked at: 4 per second, fewer on long clips (at most MAX_SAMPLES per clip)
export const SAMPLE_FPS = 4
export const MAX_SAMPLES = 600
const SEEK_TIMEOUT_MS = 4000
const DETECT_WIDTH = 480 // px the frame is looked at (the proxy's own size)

let detectorPromise = null

/** The face detector, made once (GPU where it works, else the CPU). */
export function loadFaceDetector() {
  detectorPromise ||= (async () => {
    const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision')
    const fileset = await FilesetResolver.forVisionTasks(VISION_WASM)
    const make = (delegate) => FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5
    })
    try {
      return await make('GPU')
    } catch {
      return make('CPU')
    }
  })().catch((err) => {
    detectorPromise = null
    throw err
  })
  return detectorPromise
}

/** The media times looked at between start and end (seconds into the file). */
export function sampleTimes(start, end, fps = SAMPLE_FPS, max = MAX_SAMPLES) {
  const length = Math.max(0, end - start)
  if (!(length > 0)) return []
  const step = Math.max(1 / fps, length / max)
  const out = []
  for (let t = start; t < end - 0.001; t += step) out.push(Math.round(t * 1000) / 1000)
  if (!out.length) out.push(start)
  return out
}

/**
 * The face to follow in one frame: the biggest confident one, but the one near
 * where the last face was when it is about as big (two people: no jumping to
 * and fro). detections as MediaPipe gives them, sizes in px; returns
 * { cx, cy, size } as fractions of the frame, or null.
 */
export function pickFace(detections, width, height, prev = null) {
  const faces = (detections || [])
    .filter(d => d?.boundingBox && (d.categories?.[0]?.score ?? 1) >= 0.5)
    .map(d => {
      const b = d.boundingBox
      return {
        cx: (b.originX + b.width / 2) / width,
        cy: (b.originY + b.height / 2) / height,
        size: (b.width * b.height) / (width * height)
      }
    })
    .filter(f => [f.cx, f.cy, f.size].every(Number.isFinite))
  if (!faces.length) return null
  faces.sort((a, b) => b.size - a.size)
  if (prev) {
    const near = faces
      .filter(f => f.size >= faces[0].size * 0.6)
      .sort((a, b) => Math.hypot(a.cx - prev.cx, a.cy - prev.cy) - Math.hypot(b.cx - prev.cx, b.cy - prev.cy))[0]
    if (near) return near
  }
  return faces[0]
}

/**
 * Where to look in a frame w x h: the whole frame, and for a wide or tall one
 * also overlapping squares along it (the detector looks at a small square
 * picture, so a face in a wide shot is too small for it in the whole frame).
 * [{ x, y, w, h }] in px.
 */
export function detectTiles(w, h) {
  const tiles = [{ x: 0, y: 0, w, h }]
  const side = Math.min(w, h)
  const long = Math.max(w, h)
  if (long / side < 1.2) return tiles
  const n = Math.ceil(long / side) + 1 // overlapping, so a face on a seam is whole in one
  for (let i = 0; i < n; i++) {
    const at = Math.round(((long - side) * i) / (n - 1))
    tiles.push(w >= h ? { x: at, y: 0, w: side, h: side } : { x: 0, y: at, w: side, h: side })
  }
  return tiles
}

/** Detections of several tiles in frame px, the same face found twice kept once (the more confident). */
export function mergeDetections(lists) {
  const all = lists.flat().filter(d => d?.boundingBox)
    .sort((a, b) => (b.categories?.[0]?.score ?? 0) - (a.categories?.[0]?.score ?? 0))
  const iou = (a, b) => {
    const x1 = Math.max(a.originX, b.originX)
    const y1 = Math.max(a.originY, b.originY)
    const x2 = Math.min(a.originX + a.width, b.originX + b.width)
    const y2 = Math.min(a.originY + a.height, b.originY + b.height)
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
    return inter / (a.width * a.height + b.width * b.height - inter || 1)
  }
  const kept = []
  for (const d of all) if (!kept.some(k => iou(k.boundingBox, d.boundingBox) > 0.3)) kept.push(d)
  return kept
}

function seek(video, t) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve() }
    const fail = () => { cleanup(); reject(new Error('The video could not be read here')) }
    const timer = setTimeout(done, SEEK_TIMEOUT_MS) // a slow seek: look at what is there
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('seeked', done)
      video.removeEventListener('error', fail)
    }
    video.addEventListener('seeked', done)
    video.addEventListener('error', fail)
    video.currentTime = t
  })
}

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    if (!/^(blob|data):/.test(url)) video.crossOrigin = 'anonymous'
    const ok = () => { video.removeEventListener('error', bad); resolve(video) }
    const bad = () => { video.removeEventListener('loadeddata', ok); reject(new Error('The video could not be opened for face tracking')) }
    video.addEventListener('loadeddata', ok, { once: true })
    video.addEventListener('error', bad, { once: true })
    video.src = url
    video.load()
  })
}

/**
 * Find the face through a clip: { path, aspect, faces } where path is the
 * smoothed [[t, cx, cy], ...] (media time), aspect the footage's width/height
 * and faces how many of the frames had one. `url` must be playable here (a
 * blob: URL or our backend's proxy, not an HLS stream). onProgress(0..1).
 */
export async function trackClipFaces({ url, start, end, onProgress = () => {}, signal = null, detector = null }) {
  const det = detector || await loadFaceDetector()
  const video = await loadVideo(url)
  try {
    const vw = video.videoWidth || 16
    const vh = video.videoHeight || 9
    const scale = Math.min(1, DETECT_WIDTH / vw)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(2, Math.round(vw * scale))
    canvas.height = Math.max(2, Math.round(vh * scale))
    const ctx = canvas.getContext('2d')
    const tiles = detectTiles(canvas.width, canvas.height)
    const tile = document.createElement('canvas')
    const tctx = tile.getContext('2d')
    // Every tile of the frame through the detector, boxes back in frame px
    const detectFrame = () => {
      const lists = tiles.map((b, i) => {
        let src = canvas
        if (i > 0) {
          tile.width = b.w
          tile.height = b.h
          tctx.drawImage(canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h)
          src = tile
        }
        return (det.detect(src)?.detections || []).map(d => ({
          ...d,
          boundingBox: { ...d.boundingBox, originX: d.boundingBox.originX + b.x, originY: d.boundingBox.originY + b.y }
        }))
      })
      return mergeDetections(lists)
    }
    const times = sampleTimes(start, Math.min(end, video.duration || end))
    const samples = []
    let prev = null
    let faces = 0
    for (let i = 0; i < times.length; i++) {
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError')
      await seek(video, times[i])
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const face = pickFace(detectFrame(), canvas.width, canvas.height, prev)
      if (face) { faces++; prev = face }
      samples.push(face ? { t: times[i], cx: face.cx, cy: face.cy } : { t: times[i], cx: null })
      onProgress((i + 1) / times.length)
    }
    return { path: smoothPath(samples), aspect: Math.round((vw / vh) * 10000) / 10000, faces, frames: times.length }
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}
