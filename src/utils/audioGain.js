// What an audio clip's <audio> element plays at, at a timeline moment: its
// volume times its fades. Linear fades, like the render's ffmpeg afade, so the
// preview sounds like the result. `clip` carries timelineStart / timelineEnd
// (GlobalPreview's clip lists) or timelinePosition + startTime/endTime.

// Clip volume in % (100 = as recorded). The audio editor goes up to 200%
// (+6 dB) to make quiet pieces louder; the render applies it as is.
export const MAX_CLIP_VOLUME = 200

export const clipVolume = (clip) => Math.min(MAX_CLIP_VOLUME / 100, Math.max(0, (Number.isFinite(+clip.volume) ? +clip.volume : 100) / 100))

// An <audio> element's volume stops at 1: louder than that comes from a gain
// node after it. Splits a gain into the two.
export const splitGain = (g) => {
  const gain = Number.isFinite(g) ? Math.max(0, g) : 1
  return { element: Math.min(1, gain), boost: Math.max(1, gain) }
}

export function fadeFactor(clip, position) {
  const start = clip.timelineStart ?? (clip.timelinePosition || 0)
  const end = clip.timelineEnd ?? start + (clip.endTime - clip.startTime)
  const length = Math.max(0, end - start)
  const t = Math.min(length, Math.max(0, position - start))
  const fi = Math.min(length, Math.max(0, +clip.fadeIn || 0))
  const fo = Math.min(length, Math.max(0, +clip.fadeOut || 0))
  let f = 1
  if (fi > 0 && t < fi) f = Math.min(f, t / fi)
  if (fo > 0 && t > length - fo) f = Math.min(f, (length - t) / fo)
  return Math.max(0, Math.min(1, f))
}

export const clipGainAt = (clip, position) => clipVolume(clip) * fadeFactor(clip, position)
