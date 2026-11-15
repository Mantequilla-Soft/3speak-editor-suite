// Timeline edits for speed, freeze frames and keyframes (pure functions over
// the tracks or one clip, used through useTimeline's applyTracks / updateClip,
// so every one of them is a single undo step). The maths of how a clip plays
// is in clipSpeed.js and keyframes.js (shared with the backend render).

import { retime, rampUpdates, sourceAt, clipTimeAt, timeMap } from './clipSpeed'
import { KEYFRAME_PROPS, normalizeKeyframes, propAt, staticValue, keyframesOf } from './keyframes'
import { splitPair } from './transitions'
import { t as i18nT } from '../i18n'

const pos = (c) => c.timelinePosition || 0
const len = (c) => c.endTime - c.startTime
const EPS = 0.001
let idCounter = 0
export const newClipId = () => `clip_m${++idCounter}_${Date.now()}`
export const newGroupId = () => `group_m${++idCounter}_${Date.now()}`

/** Clip time under the playhead, or null when the playhead is not on the clip */
export function clipTimeAtPlayhead(clip, playhead) {
  if (!clip) return null
  const off = playhead - pos(clip)
  if (off < -EPS || off > len(clip) + EPS) return null
  return clip.startTime + Math.min(len(clip), Math.max(0, off))
}

// The clip and the clips linked to it (its group)
function membersOf(tracks, clipId) {
  const target = tracks.flatMap(t => t.clips).find(c => c.id === clipId)
  if (!target) return { target: null, ids: new Set() }
  const ids = new Set([clipId])
  if (target.groupId) for (const t of tracks) for (const c of t.clips) if (c.groupId === target.groupId) ids.add(c.id)
  return { target, ids }
}

// Give each member its updates; on every track a member is on, the clips after
// it move by how much longer (or shorter) it got, so nothing overlaps
function applyRetime(tracks, ids, updatesFor) {
  return tracks.map(track => {
    const here = track.clips.filter(c => ids.has(c.id))
    if (!here.length) return track
    const first = here[0]
    const u = updatesFor(first)
    const oldEnd = pos(first) + len(first)
    const delta = (u.endTime - u.startTime) - len(first)
    return {
      ...track,
      clips: track.clips.map(c => {
        if (ids.has(c.id)) return { ...c, ...updatesFor(c) }
        if (Math.abs(delta) > EPS && pos(c) >= oldEnd - EPS) return { ...c, timelinePosition: Math.max(0, pos(c) + delta) }
        return c
      })
    }
  })
}

/**
 * Tracks with the clip (and its linked sound) at a constant `speed`
 * (1 = normal), keeping the same stretch of media. One step for applyTracks.
 */
export function setClipSpeed(tracks, clipId, speed) {
  const { target, ids } = membersOf(tracks, clipId)
  if (!target || timeMap(target).kind === 'freeze') return tracks
  return applyRetime(tracks, ids, (c) => retime(c, { speed }))
}

/** Tracks with a speed ramp preset on the clip and its linked sound ('off' = normal speed) */
export function setClipRamp(tracks, clipId, presetId) {
  const { target, ids } = membersOf(tracks, clipId)
  if (!target || timeMap(target).kind === 'freeze') return tracks
  if (presetId === 'off') return applyRetime(tracks, ids, (c) => retime(c, {}))
  if (!rampUpdates(target, presetId)) return tracks
  return applyRetime(tracks, ids, (c) => rampUpdates(c, presetId))
}

/** How a timeline moment moves when a clip is retimed (for the caption words) */
export function retimeMapper(before, after) {
  const start = pos(before)
  const oldEnd = start + len(before)
  const delta = len(after) - len(before)
  return (t) => {
    if (t < start) return t
    if (t >= oldEnd) return t + delta
    const c = before.startTime + (t - start)
    return start + (clipTimeAt(after, sourceAt(before, c)) - after.startTime)
  }
}

// A still's clip name, "Still · <name>" in the interface language (a still of a
// still keeps one prefix, in English or in the language it was made in now)
function stillName(name) {
  const prefix = i18nT('motion.speed.stillName', { name: '' })
  let base = name || i18nT('motion.speed.stillNameFallback')
  for (const p of [prefix, 'Still · ']) if (p && base.startsWith(p)) { base = base.slice(p.length); break }
  return i18nT('motion.speed.stillName', { name: base })
}

/**
 * A still of the frame under the playhead, `seconds` long, put in at the
 * playhead: the clip (and its linked sound) is split there, the still goes in
 * between, and the rest of those tracks moves right to make room.
 * Returns { tracks, copies: [[newId, fromId]] (clips that need the File of
 * another), at, seconds } or null when the playhead is not on the video clip.
 */
export function insertFreezeFrame(tracks, clipId, playhead, seconds = 1) {
  const { target, ids } = membersOf(tracks, clipId)
  if (!target || target.type !== 'video' || timeMap(target).kind === 'freeze') return null
  const c = clipTimeAtPlayhead(target, playhead)
  if (c === null) return null
  const N = Math.min(30, Math.max(0.1, +seconds || 1))
  const copies = []
  const secondGroup = target.groupId ? newGroupId() : undefined
  const atStart = c - target.startTime < 0.02
  const atEnd = target.endTime - c < 0.02
  // The still keeps how the clip looked at that moment (animated values frozen too)
  const still = { ...target, id: newClipId(), name: stillName(target.name),
    startTime: 0, endTime: N, timelinePosition: playhead, freezeAt: Number(sourceAt(target, c).toFixed(4)),
    groupId: undefined, audioEnabled: false, speed: undefined, speedRamp: undefined, keyframes: undefined,
    // no fades or transition of its own (utils/transitions.js): those stay at the clip's outer ends
    fadeIn: 0, fadeOut: 0, transition: undefined }
  for (const p of KEYFRAME_PROPS) if (keyframesOf(target, p.id).length && p.id !== 'volume') still[p.field] = Number(propAt(target, p.id, c).toFixed(3))
  copies.push([still.id, target.id])

  const next = tracks.map(track => {
    if (!track.clips.some(m => ids.has(m.id))) return track
    const clips = []
    for (const m of track.clips) {
      if (!ids.has(m.id)) {
        clips.push(pos(m) >= playhead - EPS ? { ...m, timelinePosition: pos(m) + N } : m)
        continue
      }
      const cm = m.startTime + (playhead - pos(m))
      if (atStart) { clips.push({ ...m, timelinePosition: pos(m) + N }); continue }
      if (atEnd || cm >= m.endTime - EPS) { clips.push(m); continue }
      const second = { ...m, id: newClipId(), startTime: cm, timelinePosition: playhead + N, groupId: secondGroup }
      copies.push([second.id, m.id])
      // fades stay at the outer ends, a transition goes with the second part (utils/transitions.js)
      clips.push(...splitPair({ ...m, endTime: cm }, second))
    }
    if (track.clips.some(m => m.id === target.id)) clips.push(still)
    return { ...track, clips }
  })
  return { tracks: next, copies, at: playhead, seconds: N }
}

// Keyframes ------------------------------------------------------------------

const NEAR = 1 / 30 // a keyframe this close to the playhead is "at" it (one frame)

/** Index of the keyframe at clip time t in a list, or -1 */
export function keyframeIndexAt(list, t) {
  return list.findIndex(k => Math.abs(k.t - t) <= NEAR)
}

/** keyframes object with one property's list replaced (empty = not animated) */
function withList(clip, prop, list) {
  const kf = { ...(normalizeKeyframes(clip.keyframes) || {}) }
  if (list.length) kf[prop] = list
  else delete kf[prop]
  return normalizeKeyframes(kf) || undefined
}

/** Updates that set prop's keyframe at clip time t to `value` (adds one if none is there) */
export function setKeyframe(clip, prop, t, value, extra = {}) {
  const list = keyframesOf(clip, prop)
  const i = keyframeIndexAt(list, t)
  const k = i >= 0 ? { ...list[i], v: value, ...extra } : { t, v: value, ...extra }
  // An edited preset keyframe becomes an ordinary one
  if (i >= 0 && extra.tag === undefined) delete k.tag
  const next = i >= 0 ? list.map((x, j) => (j === i ? k : x)) : [...list, k]
  return { keyframes: withList(clip, prop, next) }
}

/** Updates that add (at the current value) or remove prop's keyframe at clip time t */
export function toggleKeyframe(clip, prop, t) {
  const list = keyframesOf(clip, prop)
  const i = keyframeIndexAt(list, t)
  if (i >= 0) {
    const rest = list.filter((_, j) => j !== i)
    // The last keyframe gone: the clip keeps the value it had there
    const field = KEYFRAME_PROPS.find(p => p.id === prop).field
    return rest.length ? { keyframes: withList(clip, prop, rest) } : { keyframes: withList(clip, prop, []), [field]: list[i].v }
  }
  return setKeyframe(clip, prop, t, Number(propAt(clip, prop, t).toFixed(3)))
}

/** Updates that switch the ease of prop's keyframe at t */
export function setKeyframeEase(clip, prop, t, ease) {
  const list = keyframesOf(clip, prop)
  const i = keyframeIndexAt(list, t)
  if (i < 0) return {}
  const k = { ...list[i] }
  if (ease === 'ease') k.ease = 'ease'
  else delete k.ease
  return { keyframes: withList(clip, prop, list.map((x, j) => (j === i ? k : x))) }
}

/** Updates that take every keyframe of the clip off (tag: only the ones a preset made) */
export function clearKeyframes(clip, tag = null) {
  const kf = normalizeKeyframes(clip.keyframes)
  if (!kf) return {}
  if (!tag) return { keyframes: undefined }
  const next = {}
  for (const [prop, list] of Object.entries(kf)) next[prop] = list.filter(k => k.tag !== tag)
  return { keyframes: normalizeKeyframes(next) || undefined }
}

/** Clip times of every keyframe of the clip (sorted, each moment once) */
export function allKeyframeTimes(clip) {
  const kf = normalizeKeyframes(clip?.keyframes)
  if (!kf) return []
  const times = Object.values(kf).flat().map(k => k.t).sort((a, b) => a - b)
  return times.filter((t, i) => i === 0 || t - times[i - 1] > 1e-3)
}

/**
 * An edit of a clip's own value (a slider, dragging it on the preview) on a
 * property that has keyframes goes to the keyframe at the playhead instead,
 * as in other editors (a new one when there is none). Other updates pass.
 */
export function routeAnimatedEdits(clip, updates, playhead) {
  const kf = normalizeKeyframes(clip?.keyframes)
  if (!kf || !updates) return updates
  const t = clipTimeAtPlayhead(clip, playhead)
  if (t === null) return updates
  let out = updates
  for (const p of KEYFRAME_PROPS) {
    if (!kf[p.id] || !(p.field in updates) || 'keyframes' in updates) continue
    const v = +updates[p.field]
    if (!Number.isFinite(v)) continue
    const { [p.field]: _drop, ...rest } = out // eslint-disable-line no-unused-vars
    out = { ...rest, ...setKeyframe({ ...clip, keyframes: out.keyframes || clip.keyframes }, p.id, t, v) }
  }
  return out
}

/** The value a property shows at the playhead (keyframes or its own) */
export const valueAtPlayhead = (clip, prop, playhead) => {
  const t = clipTimeAtPlayhead(clip, playhead)
  return t === null ? staticValue(clip, prop) : propAt(clip, prop, t)
}

// Ken Burns: a slow zoom / pan over the whole clip (images), tag 'kenburns'
export const KEN_BURNS = [
  { id: 'in', get label() { return i18nT('motion.kenBurns.in') } },
  { id: 'out', get label() { return i18nT('motion.kenBurns.out') } },
  { id: 'pan', get label() { return i18nT('motion.kenBurns.pan') } }
]

/** Updates for a Ken Burns preset; `frameW` = the preview frame width (px) */
export function kenBurns(clip, variant, frameW = 360) {
  const a = clip.startTime
  const b = clip.endTime
  const z = staticValue(clip, 'scale')
  const shift = Math.round(frameW * 0.04)
  const kf = { ...(normalizeKeyframes(clearKeyframes(clip, 'kenburns').keyframes) || {}) }
  const k = (t, v) => ({ t, v, ease: 'ease', tag: 'kenburns' })
  if (variant === 'in') kf.scale = [k(a, z), k(b, Math.round(z * 1.2))]
  else if (variant === 'out') kf.scale = [k(a, Math.round(z * 1.2)), k(b, z)]
  else {
    const x = staticValue(clip, 'x')
    kf.scale = [k(a, Math.round(z * 1.15)), k(b, Math.round(z * 1.15))]
    kf.x = [k(a, x + shift), k(b, x - shift)]
  }
  return { keyframes: normalizeKeyframes(kf) || undefined }
}

/**
 * What a clip sends to the render for its speed and keyframes (only the
 * fields it has; an ordinary clip sends nothing new).
 */
export function motionFields(clip) {
  const out = {}
  const m = timeMap(clip)
  if (m.kind === 'freeze') out.freezeAt = m.at
  else if (m.kind === 'ramp') out.speedRamp = m.preset ? { preset: m.preset, points: m.points } : { points: m.points }
  else if (m.kind === 'speed') out.speed = m.speed
  const kf = normalizeKeyframes(clip.keyframes)
  if (kf) out.keyframes = kf
  return out
}

/**
 * The clip with startTime / endTime in media seconds (what Auto cut measures
 * the file in); the same clip at normal speed. mediaPartsToClip turns parts
 * found in media seconds back into clip time.
 */
export function mediaView(clip) {
  if (!clip || timeMap(clip).kind === 'none') return clip
  return { ...clip, startTime: sourceAt(clip, clip.startTime), endTime: sourceAt(clip, clip.endTime) }
}
export const mediaPartsToClip = (clip, parts) => (!clip || timeMap(clip).kind === 'none'
  ? parts
  : parts.map(p => ({ ...p, start: clipTimeAt(clip, p.start), end: clipTimeAt(clip, p.end) })))
