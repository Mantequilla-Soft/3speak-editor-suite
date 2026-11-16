// Transitions and video fades in the render (services/ffmpeg.js): the
// composite's per-layer filters and overlay offsets, and the sound's
// crossfades. The maths is utils/transitions.js, shared with the preview.
import { ffmpegTransition, transitionAudio, ffmpegRampVolume } from './transitions.js'

// "x:y" of an overlay plus offsets (expressions of the main frame's W, H, t)
export function shiftOverlay(pos, dx, dy) {
  if (!dx && !dy) return pos
  const parts = pos.split(/(?<!\\):/)
  if (parts.length !== 2) return pos
  const esc = (e) => e.replace(/,/g, '\\,')
  const x = dx ? `${parts[0]}+(${esc(dx)})` : parts[0]
  const y = dy ? `${parts[1]}+(${esc(dy)})` : parts[1]
  return `${x}:${y}`
}

/**
 * A composite layer's transition: pushes its filters (if any) onto
 * filterParts and returns the label to overlay and the overlay position.
 * Clips without a transition or fades come back unchanged.
 */
export function transitionLayer(filterParts, i, label, pos, clip, entry, opts) {
  const tx = ffmpegTransition(clip, entry, opts)
  let out = label
  if (tx.filters.length) {
    filterParts.push(`${label}${tx.filters.join(',')}[tx${i}]`)
    out = `[tx${i}]`
  }
  return { label: out, pos: shiftOverlay(pos, tx.x, tx.y) }
}

/**
 * The sound's crossfades at transitions: each source of a clip in one gets a
 * volume ramp (source.gain, an ffmpeg filter), and the bits of media past the
 * cut become extra sources. sources: [{ file, volume, offset, clipId }] (the
 * mix so far, changed in place). processPiece(clip) cuts a piece of a clip's
 * sound and resolves with its file.
 */
export async function transitionAudioSources(tracks, sources, processPiece) {
  const { ramps, pieces } = transitionAudio(tracks, { withVideoAudio: true })
  if (!ramps.size) return sources
  const byClip = new Map()
  for (const src of sources) {
    if (!src.clipId || !ramps.has(src.clipId)) continue
    src.gain = ffmpegRampVolume(ramps.get(src.clipId), src.offset || 0)
    byClip.set(src.clipId, src)
  }
  const clips = new Map((tracks || []).flatMap(t => t.clips).map(c => [c.id, c]))
  for (const piece of pieces) {
    const parent = byClip.get(piece.of)
    const clip = clips.get(piece.of)
    if (!parent || !clip) continue
    try {
      const file = await processPiece({ ...clip, id: piece.id, type: 'audio', trackType: 'audio', startTime: piece.startTime, endTime: piece.endTime, fadeIn: 0, fadeOut: 0 })
      sources.push({ file, volume: parent.volume, offset: piece.timelinePosition, clipId: piece.id, gain: ffmpegRampVolume(piece.ramp, piece.timelinePosition) })
    } catch (err) {
      if (err?.message === 'Job aborted') throw err
      console.warn(`[ffmpeg] Crossfade piece ${piece.id} left out: ${err?.message}`)
    }
  }
  return sources
}
