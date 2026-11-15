// Speed, speed ramps and freeze frames of a clip, shared by the preview and the
// backend render. Kept byte-identical in src/utils/ and backend/src/utils/
// (node scripts/check-static-mask-sync.mjs checks it).
//
// A clip's startTime / endTime are CLIP TIME. At normal speed that is simply
// the media's own time. At another speed clip time runs at the pace of the
// timeline and maps to the media through the clip's time map:
//   clip.speed      0.25..4, constant: media time = clip time x speed
//   clip.speedRamp  { points: [{ at, speed }] }: the speed changes linearly
//                   between the points (at = clip time); before the first point
//                   it is the first speed, after the last one the last
//   clip.freezeAt   media seconds: the clip is a still of that one frame
// So endTime - startTime is always the clip's length on the timeline, and a
// split, a trim or a keyframe (in clip time too) works the same at any speed.
// Old clips without these fields: media time = clip time, nothing changes.

export const MIN_SPEED = 0.25
export const MAX_SPEED = 4
export const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]

// Ramps as speed profiles over the clip's length: [fraction of the length, speed]
export const RAMP_PRESETS = [
  { id: 'montage', label: 'Montage', profile: [[0, 2.5], [0.35, 0.5], [0.65, 0.5], [1, 2.5]] },
  { id: 'hero', label: 'Hero', profile: [[0, 1], [0.4, 0.3], [0.6, 0.3], [1, 1]] },
  { id: 'speedUp', label: 'Speed up', profile: [[0, 1], [0.5, 1], [1, 3]] },
  { id: 'slowDown', label: 'Slow down', profile: [[0, 1], [1, 0.4]] }
]

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const fin = (v) => typeof v === 'number' && Number.isFinite(v)
const clampSpeed = (s) => clamp(fin(+s) && +s > 0 ? +s : 1, MIN_SPEED, MAX_SPEED)

/** { points: [{ at, speed }] } sorted, at least two points, or null */
export function normalizeRamp(ramp) {
  const list = Array.isArray(ramp?.points) ? ramp.points : []
  const points = list
    .filter(p => p && fin(+p.at) && fin(+p.speed) && +p.speed > 0)
    .map(p => ({ at: +p.at, speed: clampSpeed(p.speed) }))
    .sort((a, b) => a.at - b.at)
    .filter((p, i, all) => i === 0 || p.at - all[i - 1].at > 1e-6)
    .slice(0, 32)
  if (points.length < 2) return null
  // The preset it came from (the settings show it chosen)
  return typeof ramp.preset === 'string' && /^[a-zA-Z]{1,24}$/.test(ramp.preset) ? { points, preset: ramp.preset } : { points }
}

/**
 * The clip's time map: { kind: 'none' | 'speed' | 'ramp' | 'freeze', ... }
 * (freeze wins over a ramp, a ramp over a constant speed)
 */
export function timeMap(clip) {
  if (!clip) return { kind: 'none' }
  if (fin(clip.freezeAt) && clip.freezeAt >= 0) {
    return { kind: 'freeze', at: clip.freezeAt }
  }
  const ramp = normalizeRamp(clip.speedRamp)
  if (ramp) return { kind: 'ramp', preset: ramp.preset || null, ...rampTable(ramp.points) }
  const s = clip.speed === undefined || clip.speed === null ? 1 : clampSpeed(clip.speed)
  if (Math.abs(s - 1) > 1e-9) return { kind: 'speed', speed: s }
  return { kind: 'none' }
}

/** True when the clip does not play its media at normal speed */
export const hasTimeMap = (clip) => timeMap(clip).kind !== 'none'
export const isFrozen = (clip) => timeMap(clip).kind === 'freeze'

// Media time F at every ramp point (F = integral of the speed from clip time 0)
function rampTable(points) {
  const F = [points[0].speed * points[0].at]
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1]
    F.push(F[i] + (b.at - a.at) * (a.speed + b.speed) / 2)
  }
  return { points, F }
}

/** Media seconds shown at clip time c */
export function sourceAt(clip, c) {
  const m = timeMap(clip)
  if (m.kind === 'none') return c
  if (m.kind === 'freeze') return m.at
  if (m.kind === 'speed') return c * m.speed
  const { points: p, F } = m
  if (c <= p[0].at) return p[0].speed * c
  for (let i = 0; i + 1 < p.length; i++) {
    if (c <= p[i + 1].at) {
      const u = c - p[i].at
      const a = (p[i + 1].speed - p[i].speed) / (2 * (p[i + 1].at - p[i].at))
      return F[i] + p[i].speed * u + a * u * u
    }
  }
  const n = p.length - 1
  return F[n] + p[n].speed * (c - p[n].at)
}

/** Clip time at which media second x is shown (a still: the clip's start) */
export function clipTimeAt(clip, x) {
  const m = timeMap(clip)
  if (m.kind === 'none') return x
  if (m.kind === 'freeze') return clip.startTime || 0
  if (m.kind === 'speed') return x / m.speed
  const { points: p, F } = m
  if (x <= F[0]) return x / p[0].speed
  for (let i = 0; i + 1 < p.length; i++) {
    if (x <= F[i + 1]) {
      const d = x - F[i]
      const a = (p[i + 1].speed - p[i].speed) / (2 * (p[i + 1].at - p[i].at))
      // a*u^2 + v*u = d, in the form that also holds for a = 0
      return p[i].at + (2 * d) / (p[i].speed + Math.sqrt(Math.max(0, p[i].speed * p[i].speed + 4 * a * d)))
    }
  }
  const n = p.length - 1
  return p[n].at + (x - F[n]) / p[n].speed
}

/** Playback speed at clip time c (0 for a still) */
export function speedAt(clip, c) {
  const m = timeMap(clip)
  if (m.kind === 'none') return 1
  if (m.kind === 'freeze') return 0
  if (m.kind === 'speed') return m.speed
  const p = m.points
  if (c <= p[0].at) return p[0].speed
  for (let i = 0; i + 1 < p.length; i++) {
    if (c <= p[i + 1].at) {
      const k = (c - p[i].at) / (p[i + 1].at - p[i].at)
      return p[i].speed + (p[i + 1].speed - p[i].speed) * k
    }
  }
  return p[p.length - 1].speed
}

/** [first, last] media second the clip shows */
export const sourceRange = (clip) => [sourceAt(clip, clip.startTime || 0), sourceAt(clip, clip.endTime || 0)]

/** Furthest endTime a trim may reach for media `mediaDuration` seconds long */
export function maxEndTime(clip, mediaDuration) {
  if (isFrozen(clip)) return 600
  if (!fin(+mediaDuration) || +mediaDuration <= 0) return mediaDuration
  return clipTimeAt(clip, +mediaDuration)
}

/** Short label for the timeline ('2x', 'Ramp', 'Still') or '' at normal speed */
export function speedLabel(clip) {
  const m = timeMap(clip)
  if (m.kind === 'freeze') return 'Still'
  if (m.kind === 'ramp') return 'Ramp'
  if (m.kind === 'speed') return `${Number(m.speed.toFixed(2))}x`
  return ''
}

// The time-map fields of a clip (what retiming replaces)
const MAP_FIELDS = ['speed', 'speedRamp', 'freezeAt']

/**
 * Updates that give `clip` a new time map (`next`: { speed } or { speedRamp }
 * or {} for normal speed) and keep the same stretch of media: new startTime /
 * endTime and keyframe times (clip time) moved to the same media moments.
 */
export function retime(clip, next) {
  const before = clip
  const after = { ...clip }
  for (const f of MAP_FIELDS) delete after[f]
  if (next?.speedRamp) after.speedRamp = normalizeRamp(next.speedRamp)
  else if (next?.speed !== undefined && Math.abs(clampSpeed(next.speed) - 1) > 1e-9) after.speed = clampSpeed(next.speed)
  const move = (c) => clipTimeAt(after, sourceAt(before, c))
  const updates = {
    speed: after.speed,
    speedRamp: after.speedRamp,
    freezeAt: undefined,
    startTime: Math.max(0, move(clip.startTime || 0)),
    endTime: move(clip.endTime || 0)
  }
  if (clip.keyframes && typeof clip.keyframes === 'object') {
    const kf = {}
    for (const [prop, list] of Object.entries(clip.keyframes)) {
      kf[prop] = Array.isArray(list) ? list.map(k => ({ ...k, t: Number(move(k.t).toFixed(4)) })) : list
    }
    updates.keyframes = kf
  }
  return updates
}

/**
 * Updates for a ramp preset over the clip's current stretch of media: the
 * profile's speeds over the clip's new length. null for an unknown preset.
 */
export function rampUpdates(clip, presetId) {
  const preset = RAMP_PRESETS.find(p => p.id === presetId)
  if (!preset) return null
  const [a, b] = sourceRange(clip)
  const prof = preset.profile
  // Media per unit of clip time over the whole profile
  let K = 0
  for (let i = 0; i + 1 < prof.length; i++) K += (prof[i + 1][0] - prof[i][0]) * (prof[i][1] + prof[i + 1][1]) / 2
  const length = (b - a) / K
  const start = a / prof[0][1] // before the first point the speed is the first one
  const speedRamp = { preset: preset.id, points: prof.map(([u, speed]) => ({ at: Number((start + u * length).toFixed(6)), speed })) }
  const updates = retime(clip, { speedRamp })
  return { ...updates, startTime: start, endTime: start + length }
}

// ffmpeg ----------------------------------------------------------------------
const num = (v) => Number(Number(v).toFixed(6))

// Clip time of media second X (an expression): a sum of the ramp's pieces,
// each switched on only for its media seconds (ffmpeg's parser refuses deep
// nesting, so no chain of ifs)
function inverseExpr(m, X) {
  const { points: p, F } = m
  const n = p.length - 1
  const terms = [`lte(${X},${num(F[0])})*${X}/${num(p[0].speed)}`]
  for (let i = 0; i < n; i++) {
    const a = (p[i + 1].speed - p[i].speed) / (2 * (p[i + 1].at - p[i].at))
    const d = `(${X}-${num(F[i])})`
    const seg = `(${num(p[i].at)}+2*${d}/(${num(p[i].speed)}+sqrt(max(0,${num(p[i].speed * p[i].speed)}+${num(4 * a)}*${d}))))`
    terms.push(`gt(${X},${num(F[i])})*lte(${X},${num(F[i + 1])})*${seg}`)
  }
  terms.push(`gt(${X},${num(F[n])})*(${num(p[n].at)}+(${X}-${num(F[n])})/${num(p[n].speed)})`)
  return terms.join('+')
}

/**
 * How the render reads a video clip: { seek, filter } where `seek` is the
 * media second to start at (-ss) and `filter` goes first in its filter chain
 * (frames then carry timeline time from 0; an fps filter after it evens them
 * out). null at normal speed.
 */
export function ffmpegVideoTiming(clip) {
  const m = timeMap(clip)
  const start = clip.startTime || 0
  const length = Math.max(0, (clip.endTime || 0) - start)
  if (m.kind === 'none') return null
  if (m.kind === 'freeze') {
    return { seek: m.at, filter: `trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${num(length + 1)}` }
  }
  const seek = Math.max(0, sourceAt(clip, start))
  if (m.kind === 'speed') return { seek, filter: `setpts=(PTS-STARTPTS)/${num(m.speed)}` }
  // Ramp: each frame's media time X -> its clip time, minus where the clip starts
  const X = 'ld(0)'
  return { seek, filter: `setpts='st(0,${num(seek)}+(PTS-STARTPTS)*TB);(${inverseExpr(m, X)}-${num(start)})/TB'` }
}

// atempo takes 0.5..100 per instance (older builds 0.5..2): chain them
function atempoChain(s) {
  const parts = []
  let left = s
  while (left < 0.5 - 1e-9) { parts.push('atempo=0.5'); left /= 0.5 }
  while (left > 2 + 1e-9) { parts.push('atempo=2'); left /= 2 }
  if (Math.abs(left - 1) > 1e-6) parts.push(`atempo=${num(left)}`)
  return parts
}

// A ramp's sound is retimed in short steps of timeline time
const RAMP_STEP = 0.2
const MAX_RAMP_STEPS = 120

/**
 * How the render reads a clip's sound: { seek, filter, silent } where `filter`
 * (comma-separated, for -af) changes its tempo and keeps the pitch (atempo).
 * A still has no sound (silent). null at normal speed.
 */
export function ffmpegAudioTiming(clip) {
  const m = timeMap(clip)
  if (m.kind === 'none') return null
  if (m.kind === 'freeze') return { seek: 0, filter: '', silent: true }
  const start = clip.startTime || 0
  const length = Math.max(0, (clip.endTime || 0) - start)
  const seek = Math.max(0, sourceAt(clip, start))
  if (m.kind === 'speed') return { seek, filter: atempoChain(m.speed).join(','), silent: false }
  // Ramp: two atempo instances (sqrt of the speed each, so 0.25..4 stays in
  // range), set per step by asendcmd at the step's media time
  const steps = Math.max(1, Math.min(MAX_RAMP_STEPS, Math.ceil(length / RAMP_STEP)))
  const cmds = []
  let first = 1
  for (let k = 0; k < steps; k++) {
    const c0 = start + (length * k) / steps
    const c1 = start + (length * (k + 1)) / steps
    const s0 = sourceAt(clip, c0) - seek
    const s1 = sourceAt(clip, c1) - seek
    const speed = clamp((s1 - s0) / ((c1 - c0) || 1), MIN_SPEED, MAX_SPEED)
    const t = num(Math.sqrt(speed))
    if (k === 0) { first = t; continue }
    cmds.push(`${num(Math.max(0, s0))} [enter] atempo@ra tempo ${t}, [enter] atempo@rb tempo ${t}`)
  }
  const send = cmds.length ? `asendcmd=c='${cmds.join(';')}',` : ''
  return { seek, filter: `${send}atempo@ra=tempo=${first},atempo@rb=tempo=${first}`, silent: false }
}
