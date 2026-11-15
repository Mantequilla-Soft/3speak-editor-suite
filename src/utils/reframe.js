// Automatic reframing ("Export as" another shape): a clip's footage is
// cover-fitted into the frame and the visible window follows the face found in
// it. Shared by the preview (src/) and the render (backend/src/), kept
// byte-identical in src/utils/ and backend/src/utils/ (node
// scripts/check-static-mask-sync.mjs checks it), so both frame the same part.
//
// clip.reframe: { path: [[t, cx, cy], ...], offsetX, offsetY, aspect }
//   path     where the face is, over the clip's MEDIA time (seconds into its
//            source file, so a split or trimmed clip keeps its part of it):
//            cx, cy = the centre the window follows, as fractions (0..1) of the
//            source width and height. Points are straight lines in between;
//            before the first and after the last point it holds. Empty: centre.
//   offsetX  the creator's own shift on top of the path, fractions of the source
//   offsetY  (-0.5..0.5)
//   aspect   the source's width / height (from the tracking pass), for the preview
//
// The window: the media is scaled to cover the frame (the larger of the two
// ratios), then cut to the frame. Across the axis that overflows the window is
// placed so the centre point sits at FACE_X / FACE_Y of it, never past the edge.

export const MAX_PATH_POINTS = 64
export const FACE_X = 0.5 // the face sits in the middle across
export const FACE_Y = 0.42 // and a little above the middle up and down
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const round = (v, k = 10000) => Math.round(v * k) / k

/** The reframe of a clip, checked (null when there is none). */
export function normalizeReframe(r) {
  if (!r || typeof r !== 'object') return null
  const raw = Array.isArray(r.path) ? r.path : []
  const path = []
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 3) continue
    const [t, cx, cy] = p.map(Number)
    if (![t, cx, cy].every(Number.isFinite) || t < 0) continue
    if (path.length && t <= path[path.length - 1][0]) continue
    path.push([round(t, 1000), round(clamp(cx, 0, 1)), round(clamp(cy, 0, 1))])
    if (path.length >= MAX_PATH_POINTS) break
  }
  const aspect = num(r.aspect, 0)
  return {
    path,
    offsetX: round(clamp(num(r.offsetX), -0.5, 0.5)),
    offsetY: round(clamp(num(r.offsetY), -0.5, 0.5)),
    aspect: aspect > 0.05 && aspect < 20 ? round(aspect) : null
  }
}

/** The centre { cx, cy } the window follows at media time t (path + offset, 0..1). */
export function centreAt(reframe, t) {
  const r = normalizeReframe(reframe)
  if (!r) return { cx: 0.5, cy: 0.5 }
  const p = r.path
  let cx = 0.5
  let cy = 0.5
  if (p.length === 1 || (p.length && t <= p[0][0])) [, cx, cy] = p[0]
  else if (p.length && t >= p[p.length - 1][0]) [, cx, cy] = p[p.length - 1]
  else if (p.length) {
    for (let i = 0; i < p.length - 1; i++) {
      const [t0, x0, y0] = p[i]
      const [t1, x1, y1] = p[i + 1]
      if (t >= t0 && t <= t1) {
        const k = (t - t0) / (t1 - t0)
        cx = x0 + (x1 - x0) * k
        cy = y0 + (y1 - y0) * k
        break
      }
    }
  }
  return { cx: round(clamp(cx + r.offsetX, 0, 1)), cy: round(clamp(cy + r.offsetY, 0, 1)) }
}

/**
 * How much bigger than the frame the cover-fitted media is, per axis
 * ({ rx, ry }, 1 = it fits that way exactly). mediaAspect, frameAspect = w / h.
 */
export function coverOverflow(mediaAspect, frameAspect) {
  if (!(mediaAspect > 0) || !(frameAspect > 0)) return { rx: 1, ry: 1 }
  return { rx: Math.max(1, mediaAspect / frameAspect), ry: Math.max(1, frameAspect / mediaAspect) }
}

/**
 * Pan (0..1, CSS object-position / the remix layout's panX, panY) that puts the
 * point c at `at` of the window, for media `r` times the frame on that axis.
 * The render does the same in pixels: clip(c * iw - at * ow, 0, iw - ow).
 */
export function panFor(c, r, at) {
  if (!(r > 1.0001)) return 0.5
  return clamp((c * r - at) / (r - 1), 0, 1)
}

/** The preview's layout box for a reframed clip at media time t: the whole frame, panned. */
export function reframeBox(reframe, t, frameAspect, mediaAspect = null) {
  const r = normalizeReframe(reframe)
  if (!r) return null
  const { cx, cy } = centreAt(r, t)
  const { rx, ry } = coverOverflow(mediaAspect || r.aspect || frameAspect, frameAspect)
  return { x: 0, y: 0, w: 1, h: 1, panX: round(panFor(cx, rx, FACE_X)), panY: round(panFor(cy, ry, FACE_Y)), full: true }
}

/**
 * Which clips are reframed when the project goes out in another shape: video
 * footage framed as it came (no remix layout box, no zoom, move or crop of its
 * own). Moved or zoomed clips (a picture in picture) keep their own framing.
 */
export function isReframable(clip) {
  if (!clip || clip.type !== 'video') return false
  const l = clip.layout
  if (l && typeof l === 'object' && Number(l.w) > 0) return false
  const z = Number(clip.zoom || 100)
  return (z === 100 || z === 1) && !clip.positionX && !clip.positionY &&
    !clip.cropX && !clip.cropY && (clip.cropWidth || 100) === 100 && (clip.cropHeight || 100) === 100
}

// ---- turning face detections into a calm path (the browser's tracking pass) ----

/**
 * samples: [{ t, cx, cy } | { t, cx: null }] in media time, in order (null: no
 * face in that frame). Returns a smoothed path [[t, cx, cy], ...]: frames with
 * no face hold the last place (before the first face: the first one; no face at
 * all: the centre), a median takes out single wrong detections, a two-way
 * moving average makes it glide, a dead zone keeps it still for small moves,
 * and the result is thinned to at most MAX_PATH_POINTS points.
 */
export function smoothPath(samples, { window = 5, deadZone = 0.03, tolerance = 0.012 } = {}) {
  const list = (samples || []).filter(s => s && Number.isFinite(s.t)).sort((a, b) => a.t - b.t)
  if (!list.length) return []
  const firstFace = list.find(s => Number.isFinite(s.cx) && Number.isFinite(s.cy))
  if (!firstFace) return []
  // hold through the frames without a face
  let last = { cx: firstFace.cx, cy: firstFace.cy }
  const held = list.map(s => {
    if (Number.isFinite(s.cx) && Number.isFinite(s.cy)) last = { cx: s.cx, cy: s.cy }
    return { t: s.t, cx: last.cx, cy: last.cy }
  })
  const half = Math.max(1, Math.floor(window / 2))
  const median = (arr, i, key) => {
    const vals = []
    for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) vals.push(arr[j][key])
    vals.sort((a, b) => a - b)
    return vals[Math.floor(vals.length / 2)]
  }
  const med = held.map((s, i) => ({ t: s.t, cx: median(held, i, 'cx'), cy: median(held, i, 'cy') }))
  const mean = (arr, i, key) => {
    let sum = 0
    let n = 0
    for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) { sum += arr[j][key]; n++ }
    return sum / n
  }
  const avg = med.map((s, i) => ({ t: s.t, cx: mean(med, i, 'cx'), cy: mean(med, i, 'cy') }))
  // dead zone: the window only moves when the face has gone a little way
  let at = { cx: avg[0].cx, cy: avg[0].cy }
  const still = avg.map(s => {
    if (Math.abs(s.cx - at.cx) > deadZone) at = { ...at, cx: s.cx - Math.sign(s.cx - at.cx) * deadZone }
    if (Math.abs(s.cy - at.cy) > deadZone) at = { ...at, cy: s.cy - Math.sign(s.cy - at.cy) * deadZone }
    return [s.t, clamp(at.cx, 0, 1), clamp(at.cy, 0, 1)]
  })
  return thinPath(still, tolerance).map(([t, cx, cy]) => [round(t, 1000), round(cx), round(cy)])
}

/**
 * A path with the points dropped that a straight line through their neighbours
 * already covers within `tolerance` (Ramer-Douglas-Peucker on both axes), made
 * coarser until at most `max` points are left.
 */
export function thinPath(path, tolerance = 0.01, max = MAX_PATH_POINTS) {
  if (path.length <= 2) return path.slice()
  const off = (p, a, b) => {
    const k = b[0] === a[0] ? 0 : (p[0] - a[0]) / (b[0] - a[0])
    return Math.max(Math.abs(p[1] - (a[1] + (b[1] - a[1]) * k)), Math.abs(p[2] - (a[2] + (b[2] - a[2]) * k)))
  }
  const rdp = (pts, eps) => {
    const keep = new Uint8Array(pts.length)
    keep[0] = 1
    keep[pts.length - 1] = 1
    const stack = [[0, pts.length - 1]]
    while (stack.length) {
      const [s, e] = stack.pop()
      let worst = -1
      let at = -1
      for (let i = s + 1; i < e; i++) {
        const d = off(pts[i], pts[s], pts[e])
        if (d > worst) { worst = d; at = i }
      }
      if (worst > eps) {
        keep[at] = 1
        stack.push([s, at], [at, e])
      }
    }
    return pts.filter((_, i) => keep[i])
  }
  let eps = tolerance
  let out = rdp(path, eps)
  while (out.length > max) {
    eps *= 1.5
    out = rdp(path, eps)
  }
  return out
}

// ---- the render: the same window as an ffmpeg filter ----

const fx = (v) => String(round(v, 1000000))

/**
 * The path on one axis (1: cx, 2: cy) plus the offset as an ffmpeg expression
 * of the media time T: the first value, plus each stretch's slope times how
 * far into it T is. Linear in the number of points, no nesting.
 */
export function pathExpr(reframe, axis, T) {
  const r = normalizeReframe(reframe)
  const off = axis === 1 ? r.offsetX : r.offsetY
  const p = r.path
  if (!p.length) return fx(clamp(0.5 + off, 0, 1))
  let expr = fx(p[0][axis] + off)
  for (let i = 0; i < p.length - 1; i++) {
    const d = p[i + 1][0] - p[i][0]
    const k = (p[i + 1][axis] - p[i][axis]) / d
    if (Math.abs(k) < 1e-9) continue
    expr += `+${fx(k)}*clip(${T}-${fx(p[i][0])},0,${fx(d)})`
  }
  return `clip(${expr},0,1)`
}

/**
 * The ffmpeg filters that cut the reframed window out of a clip, w x h, for a
 * clip that starts `startTime` seconds into its source (the clip's frames start
 * at t = 0 after the input seek). null when the clip has no reframe.
 */
export function reframeFilter(reframe, { w, h, startTime = 0 }) {
  const r = normalizeReframe(reframe)
  if (!r) return null
  const T = startTime > 0 ? `(t+${fx(startTime)})` : 't'
  const x = `clip(${pathExpr(r, 1, T)}*iw-${FACE_X}*ow,0,iw-ow)`
  const y = `clip(${pathExpr(r, 2, T)}*ih-${FACE_Y}*oh,0,ih-oh)`
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=w=${w}:h=${h}:x='${x}':y='${y}'`
}
