// What an audio clip's <audio> element plays at, at a timeline moment: its
// volume times its fades. Linear fades, like the render's ffmpeg afade, so the
// preview sounds like the result. `clip` carries timelineStart / timelineEnd
// (GlobalPreview's clip lists) or timelinePosition + startTime/endTime.

export const clipVolume = (clip) => Math.min(1, Math.max(0, (Number.isFinite(+clip.volume) ? +clip.volume : 100) / 100))

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
