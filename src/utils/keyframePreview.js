// Preview side of speed and keyframes (GlobalPreview): which media second an
// element shows, how fast it plays, and the CSS that animates a layer. The
// maths is in clipSpeed.js and keyframes.js, shared with the render.

import { sourceAt, speedAt, isFrozen, timeMap } from './clipSpeed'
import { cssKeyframeTransform, hasVisualKeyframes, relativeAt, keyframeBase, staticValue, propAt } from './keyframes'
import { hasLayout } from './remixLayout'

/** Clip time at timeline position t (clip.timelineStart = where it starts) */
export const clipTimeOf = (clip, t) => clip.startTime + (t - (clip.timelineStart ?? clip.timelinePosition ?? 0))

/** Media second an element should be at for timeline position t */
export const mediaTimeAt = (clip, t) => sourceAt(clip, clipTimeOf(clip, t))

/** Where a clip's element is parked / pre-rolled from, `lead` seconds before it starts (null: nothing to pre-roll) */
export function prerollTime(clip, lead) {
  if (isFrozen(clip)) return null
  const t = sourceAt(clip, clip.startTime - lead)
  return t < 0 ? null : t
}
export const parkTime = (clip, lead) => Math.max(0, prerollTime(clip, lead) ?? sourceAt(clip, clip.startTime))

/**
 * Keep a playing element at the clip's speed (playbackRate; browsers keep the
 * pitch of speech by default) and, for a ramp, on its media time (the speed
 * changes all the time, so it is nudged back when it drifts, at most once a
 * second). A still never plays: it stays paused on its frame.
 * Returns true when the element must not be played.
 */
export function syncPlayback(el, clip, t, nowMs = 0) {
  if (!el) return false
  const m = timeMap(clip)
  if (m.kind === 'freeze') {
    if (!el.paused) el.pause()
    if (el.readyState >= 1 && Math.abs(el.currentTime - m.at) > 0.02 && !el.seeking) el.currentTime = m.at
    return true
  }
  const rate = m.kind === 'none' ? 1 : speedAt(clip, clipTimeOf(clip, t))
  if (Math.abs((el.playbackRate || 1) - rate) > 0.005) {
    try { el.playbackRate = rate } catch { /* out of the browser's range */ }
  }
  if (m.kind === 'ramp' && !el.paused && !el.seeking && el.readyState >= 3 && nowMs - (+el.dataset.rampSync || 0) > 1000) {
    const target = mediaTimeAt(clip, t)
    if (Math.abs(el.currentTime - target) > 0.12) {
      el.dataset.rampSync = String(nowMs)
      el.currentTime = target
    }
  }
  return false
}
export { isFrozen }

/** Keyframes apply to freely placed layers (a remix layout box stays put) */
export const animatesLayer = (clip) => !!clip && clip.type !== 'audio' && clip.type !== 'color' && !hasLayout(clip) && hasVisualKeyframes(clip)

/**
 * The CSS a layer gets from its keyframes at timeline position t:
 * { prefix (goes in front of its own transform), opacity (multiplier) }, or
 * null. Video and image layers (full frame, turning around the frame's
 * centre) turn around the clip's centre; text turns its own box, which sits
 * inside the layer's scale(zoom), so the move is divided by that zoom.
 */
export function layerKeyframeStyle(clip, t) {
  if (!animatesLayer(clip)) return null
  const c = clipTimeOf(clip, t)
  const base = keyframeBase(clip)
  const zr = staticValue(base, 'scale') / 100
  if (clip.type === 'text') {
    return { prefix: cssKeyframeTransform(clip, c, { x: 0, y: 0 }, 1 / zr), opacity: relativeAt(clip, c).opacity }
  }
  const pivot = { x: zr * staticValue(base, 'x'), y: zr * staticValue(base, 'y') }
  return { prefix: cssKeyframeTransform(clip, c, pivot), opacity: relativeAt(clip, c).opacity }
}

/** A property's value at timeline position t (what a drag on the preview starts from) */
export const valueAtTime = (clip, prop, t) => propAt(clip, prop, clipTimeOf(clip, t))

/** Extra gain of an audio clip's animated volume at timeline position t */
export const keyframeGainAt = (clip, t) => relativeAt(clip, clipTimeOf(clip, t)).gain
