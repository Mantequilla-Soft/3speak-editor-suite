// Transitions between two clips that touch on one video track, and fades in /
// out of a video, image or colour clip. Shared by the preview
// (components/GlobalPreview.jsx draws the same states with CSS) and the backend
// render (services/ffmpeg.js), kept byte-identical in src/utils/transitions.js
// and backend/src/utils/transitions.js (scripts/check-static-mask-sync.mjs).
//
// clip.transition = { type, duration, to }: from this clip into the next one,
//   `to` = that clip's id. It only applies while `to` is the very next clip on
//   the same track and starts where this one ends, so a split, a move or a
//   delete simply makes it stop applying (a split's second half carries it on).
// clip.fadeIn / clip.fadeOut (seconds): on a video, image or colour clip the
//   picture fades in / out (opacity), like an audio clip's sound does.
//
// A transition is centred on the cut: it runs from cut - d/2 to cut + d/2. The
// incoming clip shows from cut - d/2 (held on its first frame until the cut),
// the outgoing one until cut + d/2 (held on its last frame after it), the
// incoming one above. A dip to black needs no overlap: the outgoing clip goes
// to black before the cut, the incoming one comes from black after it. Linked
// sound (the clips' own audio) crossfades over the same span, using the media
// past the cut where the files have it.

export const TRANSITION_TYPES = [
  { id: 'crossfade', label: 'Crossfade' },
  { id: 'dissolve', label: 'Dip to black' },
  { id: 'slideleft', label: 'Slide left' },
  { id: 'slideright', label: 'Slide right' },
  { id: 'slideup', label: 'Slide up' },
  { id: 'zoom', label: 'Zoom' },
  { id: 'whip', label: 'Whip' }
]
const TYPE_IDS = new Set(TRANSITION_TYPES.map(t => t.id))
export const TRANSITION_MIN = 0.2
export const TRANSITION_MAX = 1.5
export const TRANSITION_DEFAULT = 0.5
export const VIDEO_FADE_MAX = 3
export const WHIP_BLUR = 0.012 // blur sigma at the whip's peak, fraction of the frame height
const ZOOM_OUT = 0.5 // the outgoing clip grows by this much
const ZOOM_IN = 0.25 // the incoming one starts this much bigger
const ADJACENT = 0.05 // s: clips this close count as touching
const FRAME = 1 / 30
const VISUAL = new Set(['video', 'image', 'color'])

const r3 = (v) => Math.round(v * 1000) / 1000
const len = (c) => Math.max(0, (c.endTime || 0) - (c.startTime || 0))
const posOf = (c) => c.timelinePosition || 0

export const canTransition = (clip) => !!clip && VISUAL.has(clip.type)

export function normalizeTransition(t) {
  if (!t || typeof t !== 'object' || !TYPE_IDS.has(t.type) || !t.to) return null
  const d = Number(t.duration)
  const duration = Math.round(Math.max(TRANSITION_MIN, Math.min(TRANSITION_MAX, Number.isFinite(d) ? d : TRANSITION_DEFAULT)) * 10) / 10
  return { type: t.type, duration, to: String(t.to) }
}

// The fades of a visual clip, seconds, never longer than the clip
export function videoFades(clip) {
  if (!canTransition(clip)) return { fadeIn: 0, fadeOut: 0 }
  const L = len(clip)
  const f = (v) => r3(Math.min(VIDEO_FADE_MAX, L, Math.max(0, +v || 0)))
  return { fadeIn: f(clip.fadeIn), fadeOut: f(clip.fadeOut) }
}

// A split clip's two halves: the first fades in and the second fades out, the
// second carries the transition into the next clip on
export function splitPair(first, second) {
  const a = { ...first }, b = { ...second }
  if (+a.fadeOut > 0) a.fadeOut = 0
  if (+b.fadeIn > 0) b.fadeIn = 0
  delete a.transition
  return [a, b]
}

// The clip right after this one on its track, when it starts where this ends
export function nextClipOf(track, clipId) {
  const sorted = [...(track?.clips || [])].sort((a, b) => posOf(a) - posOf(b))
  const i = sorted.findIndex(c => c.id === clipId)
  if (i < 0 || i === sorted.length - 1) return null
  const a = sorted[i], b = sorted[i + 1]
  return Math.abs(posOf(b) - (posOf(a) + len(a))) <= ADJACENT ? b : null
}

// Every cut on a video track that could take a transition: [{ from, to, cut }]
export function trackCuts(track) {
  if (!track || track.type !== 'video') return []
  const sorted = [...track.clips].sort((a, b) => posOf(a) - posOf(b))
  const out = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i], b = sorted[i + 1]
    if (!canTransition(a) || !canTransition(b)) continue
    if (Math.abs(posOf(b) - (posOf(a) + len(a))) > ADJACENT) continue
    out.push({ from: a, to: b, cut: posOf(b) })
  }
  return out
}

// The transitions that apply on a track: [{ from, to, type, half, cut }]
export function trackTransitions(track) {
  const out = []
  for (const { from, to, cut } of trackCuts(track)) {
    const t = normalizeTransition(from.transition)
    if (!t || t.to !== to.id) continue
    // half the length, never more than half of either clip
    const half = r3(Math.min(t.duration / 2, len(from) / 2, len(to) / 2))
    if (half < 0.05) continue
    out.push({ from: from.id, to: to.id, type: t.type, half, cut: r3(cut) })
  }
  return out
}

/**
 * Each clip's part in the transitions of the visible video tracks:
 * Map clip id -> { in, out } (the transition it comes in with / goes out with).
 */
export function transitionPlan(tracks) {
  const plan = new Map()
  for (const track of tracks || []) {
    if (track.type !== 'video' || track.visible === false) continue
    for (const tr of trackTransitions(track)) {
      if (!plan.has(tr.from)) plan.set(tr.from, { in: null, out: null })
      if (!plan.has(tr.to)) plan.set(tr.to, { in: null, out: null })
      plan.get(tr.from).out = tr
      plan.get(tr.to).in = tr
    }
  }
  return plan
}

// How long a clip shows before its start (head, on its first frame) and after
// its end (tail, on its last frame)
export function clipExtent(entry) {
  const overlap = (tr) => (tr && tr.type !== 'dissolve' ? tr.half : 0)
  return { head: overlap(entry?.in), tail: overlap(entry?.out) }
}

// The media time a video shows while held (before its start / after its end),
// or null when it plays normally
export function heldMediaTime(clip, entry, t) {
  const { head, tail } = clipExtent(entry)
  const start = posOf(clip)
  if (head && t < start) return clip.startTime
  if (tail && t >= start + len(clip)) return Math.max(clip.startTime, clip.endTime - FRAME)
  return null
}

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smooth = (p) => p * p * (3 - 2 * p)
const cubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
// whip blur: off at the ends, half, then full in the middle (steps, so the
// render's enable windows give exactly the same)
const WHIP_STEPS = [[0.1, 0.25, 0.5], [0.25, 0.75, 1], [0.75, 0.9, 0.5]]
const whipLevel = (p) => (WHIP_STEPS.find(([a, b]) => p >= a && p < b) || [0, 0, 0])[2]

/**
 * What a visual clip looks like at timeline time t: { opacity, brightness,
 * dx, dy (fractions of the canvas width / height), scale (around the clip's
 * centre), blur (sigma, fraction of the frame height) }.
 */
export function transitionState(clip, entry, t) {
  const s = { opacity: 1, brightness: 1, dx: 0, dy: 0, scale: 1, blur: 0 }
  const start = posOf(clip), end = start + len(clip)
  const { fadeIn, fadeOut } = videoFades(clip)
  if (fadeIn > 0) s.opacity *= clamp01((t - start) / fadeIn)
  if (fadeOut > 0) s.opacity *= clamp01((end - t) / fadeOut)
  for (const role of ['in', 'out']) {
    const tr = entry?.[role]
    if (!tr) continue
    const p = clamp01((t - (tr.cut - tr.half)) / (2 * tr.half))
    const incoming = role === 'in'
    switch (tr.type) {
      case 'crossfade':
        if (incoming) s.opacity *= p
        break
      case 'dissolve':
        s.brightness *= incoming ? clamp01(2 * p - 1) : clamp01(1 - 2 * p)
        break
      case 'slideleft': s.dx += incoming ? 1 - smooth(p) : -smooth(p); break
      case 'slideright': s.dx += incoming ? smooth(p) - 1 : smooth(p); break
      case 'slideup': s.dy += incoming ? 1 - smooth(p) : -smooth(p); break
      case 'zoom':
        if (incoming) { s.opacity *= p; s.scale *= 1 + ZOOM_IN * (1 - smooth(p)) } else s.scale *= 1 + ZOOM_OUT * smooth(p)
        break
      case 'whip':
        s.dx += incoming ? 1 - cubic(p) : -cubic(p)
        s.blur = Math.max(s.blur, WHIP_BLUR * whipLevel(p))
        break
    }
  }
  return s
}

// ---- sound ----

const sameSpan = (a, b) => Math.abs(posOf(a) - posOf(b)) < 0.02 && Math.abs(len(a) - len(b)) < 0.02

/**
 * Crossfades of the clips' own sound at each transition: the audio track clips
 * linked to the two video clips (same group, same span) and, with
 * withVideoAudio, a video clip's own sound when it plays it. Returns
 * { ramps: Map clip id -> ramp, pieces: [...] }: a ramp is { t0, g0, t1, g1 }
 * in timeline seconds (linear, held outside), pieces are the extra bits of
 * media past the cut that the crossfade plays: { id, of, startTime, endTime,
 * timelinePosition, ramp } (only where the file has them: `duration`).
 */
export function transitionAudio(tracks, { withVideoAudio = false } = {}) {
  const ramps = new Map()
  const pieces = []
  const plan = transitionPlan(tracks)
  const audioClips = (tracks || []).filter(t => t.type === 'audio' && t.muted !== true).flatMap(t => t.clips).filter(c => c.audioEnabled !== false)
  const videoById = new Map((tracks || []).filter(t => t.type === 'video').flatMap(t => t.clips).map(c => [c.id, c]))
  const partners = (v) => {
    const out = audioClips.filter(a => v.groupId && a.groupId === v.groupId && sameSpan(a, v))
    if (withVideoAudio && v.type === 'video' && v.audioEnabled !== false) out.push(v)
    return out
  }
  const seen = new Set()
  for (const entry of plan.values()) {
    const tr = entry.out
    if (!tr || seen.has(tr.from)) continue
    seen.add(tr.from)
    const a = videoById.get(tr.from), b = videoById.get(tr.to)
    if (!a || !b) continue
    const t0 = r3(tr.cut - tr.half), t1 = r3(tr.cut + tr.half)
    const outRamp = { t0, g0: 1, t1, g1: 0 }
    const inRamp = { t0, g0: 0, t1, g1: 1 }
    for (const c of partners(a)) {
      ramps.set(c.id, outRamp)
      const extra = Number.isFinite(+c.duration) ? Math.min(tr.half, +c.duration - c.endTime) : 0
      if (extra > 0.02) pieces.push({ id: `${c.id}~xfade-tail`, of: c.id, startTime: r3(c.endTime), endTime: r3(c.endTime + extra), timelinePosition: r3(tr.cut), ramp: outRamp })
    }
    for (const c of partners(b)) {
      ramps.set(c.id, inRamp)
      const extra = Math.min(tr.half, c.startTime || 0)
      if (extra > 0.02) pieces.push({ id: `${c.id}~xfade-head`, of: c.id, startTime: r3(c.startTime - extra), endTime: r3(c.startTime), timelinePosition: r3(tr.cut - extra), ramp: inRamp })
    }
  }
  return { ramps, pieces }
}

export function rampGain(ramp, t) {
  if (!ramp) return 1
  const p = clamp01((t - ramp.t0) / Math.max(1e-6, ramp.t1 - ramp.t0))
  return ramp.g0 + (ramp.g1 - ramp.g0) * p
}

// ---- render (ffmpeg) ----

const n = (v) => Number(Number(v).toFixed(4))

// ffmpeg volume expression for a ramp, `offset` = where the source starts on the timeline
export function ffmpegRampVolume(ramp, offset = 0) {
  const T = `(t+${n(offset)})`
  const d = n(Math.max(1e-6, ramp.t1 - ramp.t0))
  return `volume='max(0,min(1,${n(ramp.g0)}+${n(ramp.g1 - ramp.g0)}*min(1,max(0,(${T}-${n(ramp.t0)})/${d}))))':eval=frame`
}

const P = (tr) => `min(1,max(0,(t-${n(tr.cut - tr.half)})/${n(2 * tr.half)}))`
const smoothExpr = (p) => `(${p}*${p}*(3-2*${p}))`
const cubicExpr = (p) => `if(lt(${p},0.5),4*${p}*${p}*${p},1-pow(2-2*${p},3)/2)`

/**
 * The render's filters for a clip in a transition or with fades, in timeline
 * time (after the clip is delayed to its place): { filters: [...], x, y }
 * where x / y are added to the overlay position (null = none). zoom: the
 * clip's zoom (blur is sized like the preview's, before its CSS scale);
 * frameH: output height; fps: frame rate; start: when the layer's first frame
 * shows (its position minus its head).
 */
export function ffmpegTransition(clip, entry, { frameH, zoom = 1, fps = 30, start = null }) {
  const filters = []
  let x = null, y = null
  const pos = posOf(clip), end = pos + len(clip)
  const { fadeIn, fadeOut } = videoFades(clip)
  const alphaFades = []
  if (fadeIn > 0) alphaFades.push(`fade=t=in:st=${n(pos)}:d=${n(fadeIn)}:alpha=1`)
  if (fadeOut > 0) alphaFades.push(`fade=t=out:st=${n(end - fadeOut)}:d=${n(fadeOut)}:alpha=1`)
  const scaleExprs = []
  const blurs = []
  for (const role of ['in', 'out']) {
    const tr = entry?.[role]
    if (!tr) continue
    const incoming = role === 'in'
    const a = n(tr.cut - tr.half), d = n(2 * tr.half)
    const p = P(tr)
    switch (tr.type) {
      case 'crossfade':
        if (incoming) alphaFades.push(`fade=t=in:st=${a}:d=${d}:alpha=1`)
        break
      case 'dissolve':
        filters.push(incoming ? `fade=t=in:st=${n(tr.cut)}:d=${n(tr.half)}` : `fade=t=out:st=${a}:d=${n(tr.half)}`)
        break
      case 'slideleft': x = incoming ? `W*(1-${smoothExpr(p)})` : `-W*${smoothExpr(p)}`; break
      case 'slideright': x = incoming ? `W*(${smoothExpr(p)}-1)` : `W*${smoothExpr(p)}`; break
      case 'slideup': y = incoming ? `H*(1-${smoothExpr(p)})` : `-H*${smoothExpr(p)}`; break
      case 'zoom':
        if (incoming) {
          alphaFades.push(`fade=t=in:st=${a}:d=${d}:alpha=1`)
          scaleExprs.push({ tr, expr: (q) => `(1+${ZOOM_IN}*(1-${smoothExpr(q)}))` })
        } else {
          scaleExprs.push({ tr, expr: (q) => `(1+${ZOOM_OUT}*${smoothExpr(q)})` })
        }
        break
      case 'whip':
        x = incoming ? `W*(1-${cubicExpr(p)})` : `-W*${cubicExpr(p)}`
        for (const [pa, pb, level] of WHIP_STEPS) {
          blurs.push({ sigma: Math.max(0.3, WHIP_BLUR * level * frameH * zoom), from: n(tr.cut - tr.half + pa * 2 * tr.half), to: n(tr.cut - tr.half + pb * 2 * tr.half) })
        }
        break
    }
  }
  // Scale around the layer's centre (perspective: same frame size, per frame;
  // its expressions count frames, `in`, from the layer's first frame)
  for (const { tr, expr } of scaleExprs) {
    const T = `(in/${n(fps)}+${n(start ?? pos)})`
    const q = `min(1,max(0,(${T}-${n(tr.cut - tr.half)})/${n(2 * tr.half)}))`
    const S = expr(q)
    const X = (cx) => `W/2+(${cx}-W/2)*${S}`
    const Y = (cy) => `H/2+(${cy}-H/2)*${S}`
    const corners = [['0', '0'], ['W', '0'], ['0', 'H'], ['W', 'H']]
    filters.push(`perspective=${corners.map(([cx, cy], i) => `x${i}='${X(cx)}':y${i}='${Y(cy)}'`).join(':')}:sense=destination:eval=frame:interpolation=linear:enable='between(t,${n(tr.cut - tr.half)},${n(tr.cut + tr.half)})'`)
  }
  for (const b of blurs) filters.push(`gblur=sigma=${n(b.sigma)}:enable='between(t,${b.from},${b.to})'`)
  if (alphaFades.length) filters.push('format=yuva420p', ...alphaFades)
  return { filters, x, y }
}
