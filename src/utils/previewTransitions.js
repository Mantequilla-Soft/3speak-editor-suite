// The preview's side of transitions and video fades (utils/transitions.js):
// GlobalPreview's clip lists get the overlap, its layers the CSS for the
// moment, its audio the crossfade ramps and pieces. Same states as the render.
import { transitionPlan, clipExtent, heldMediaTime, transitionState, transitionAudio, videoFades, rampGain } from './transitions'
import { sourceAt } from './clipSpeed'
import { mediaTimeAt as playMediaTimeAt } from './keyframePreview'

const hasFades = (clip) => { const f = videoFades(clip); return f.fadeIn > 0 || f.fadeOut > 0 }

/**
 * Video track clips (GlobalPreview's list, with timelineStart / timelineEnd):
 * a clip in a transition shows a little before its start / after its end.
 * Adds mediaStart (where its clip time counts from: keyframePreview's
 * clipTimeOf reads it) and xEntry (its part).
 */
export function withTransitions(videoClips, tracks) {
  const plan = transitionPlan(tracks)
  if (!plan.size) return videoClips
  return videoClips.map(clip => {
    const entry = plan.get(clip.id)
    if (!entry) return clip
    const { head, tail } = clipExtent(entry)
    return { ...clip, mediaStart: clip.timelineStart, timelineStart: clip.timelineStart - head, timelineEnd: clip.timelineEnd + tail, xEntry: entry, xHead: head, xTail: tail }
  }).sort((a, b) => a.timelineStart - b.timelineStart)
}

// The media time a clip's video shows at a timeline moment, through its speed
// (keyframePreview.js), held on its first / last frame in a transition's overlap
export function mediaTimeAt(clip, position) {
  if (clip.xEntry) {
    const held = heldMediaTime(clip, clip.xEntry, position)
    if (held != null) return sourceAt(clip, held)
  }
  return playMediaTimeAt(clip, position)
}

/**
 * Playback: a clip in its overlap is held on a frame, paused. Returns true when
 * it is (the caller then leaves the element alone).
 */
export function holdTransitionFrame(clip, el, position) {
  if (!clip.xEntry || !el) return false
  const clipHeld = heldMediaTime(clip, clip.xEntry, position)
  if (clipHeld == null) return false
  const held = sourceAt(clip, clipHeld)
  if (!el.paused) el.pause()
  if (el.readyState >= 1 && !el.seeking && Math.abs(el.currentTime - held) > 0.05) el.currentTime = held
  return true
}

// CSS for a layer at time t on top of its own (base) transform / filter / opacity
export function transitionCss(clip, t, frameH, base, canvas) {
  const s = transitionState(clip, clip.xEntry || null, t)
  const shift = s.dx || s.dy ? `translate(calc(${canvas.w} * ${s.dx.toFixed(4)}), calc(${canvas.h} * ${s.dy.toFixed(4)}))` : ''
  const grow = s.scale !== 1 ? `scale(${s.scale.toFixed(4)})` : ''
  const filters = [base.filter, s.brightness !== 1 ? `brightness(${s.brightness.toFixed(4)})` : '', s.blur > 0 ? `blur(${(s.blur * frameH).toFixed(2)}px)` : ''].filter(Boolean)
  return {
    transform: [shift, base.transform, grow].filter(Boolean).join(' ') || undefined,
    filter: filters.length ? filters.join(' ') : undefined,
    opacity: (base.opacity ?? 1) * s.opacity
  }
}

/**
 * A layer's style at the playhead (changed in place) and the data attributes
 * the playback loop uses to update it every frame. {} for clips without
 * transitions or fades.
 */
export function transitionLayerProps(clip, style, t, frameH, canvas, registry) {
  if (!clip.xEntry && !hasFades(clip)) return {}
  const base = { transform: style.transform || '', filter: style.filter || '', opacity: style.opacity ?? 1 }
  registry[clip.id] = { clip, base }
  Object.assign(style, transitionCss(clip, t, frameH, base, canvas))
  return { 'data-trans-id': clip.id }
}

// Every frame while playing: the layers in transitions or fades. A layer that
// keyframes or sticker motion moved this frame (their loops run first) takes
// the transition on top of where they put it: slide in front, zoom after.
export function applyTransitionFrames(container, t, frameH, canvas, registry) {
  container?.querySelectorAll('[data-trans-id]').forEach(el => {
    const r = registry[el.dataset.transId]
    if (!r) return
    const moved = el.dataset.kfId || el.dataset.motionId
    const base = moved
      ? { transform: el.style.transform || '', filter: r.base.filter, opacity: el.style.opacity === '' ? 1 : +el.style.opacity }
      : r.base
    const css = transitionCss(r.clip, t, frameH, base, canvas)
    el.style.transform = css.transform || ''
    el.style.filter = css.filter || ''
    el.style.opacity = String(css.opacity)
  })
}

/**
 * Audio clips (GlobalPreview's list): the linked sound of clips in a
 * transition crossfades. Adds each clip's ramp (xramp) and the pieces past the
 * cut as clips of their own (their own <audio>).
 */
export function withAudioCrossfades(audioClips, tracks) {
  const { ramps, pieces } = transitionAudio(tracks)
  if (!ramps.size) return audioClips
  const byId = new Map(audioClips.map(c => [c.id, c]))
  const out = audioClips.map(c => (ramps.has(c.id) ? { ...c, xramp: ramps.get(c.id) } : c))
  for (const p of pieces) {
    const parent = byId.get(p.of)
    if (!parent) continue
    out.push({
      ...parent, id: p.id, xPieceOf: p.of, startTime: p.startTime, endTime: p.endTime, timelinePosition: p.timelinePosition,
      timelineStart: p.timelinePosition, timelineEnd: p.timelinePosition + (p.endTime - p.startTime), fadeIn: 0, fadeOut: 0, xramp: p.ramp
    })
  }
  return out
}

export const crossfadeGain = (clip, t) => rampGain(clip.xramp, t)
