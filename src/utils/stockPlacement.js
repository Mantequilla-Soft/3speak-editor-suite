// Where a stock video / photo / GIF goes on the timeline (useTimeline.addStockClip).
// Tracks are listed top first. Stock tracks carry `stock: 'broll' | 'background'`;
// they hold no sound, so they never pair with an audio track.

const EPS = 1e-3
const span = (c) => {
  const s = c.timelinePosition || 0
  return [s, s + Math.max(0, (c.endTime || 0) - (c.startTime || 0))]
}
const roomFor = (track, start, end) => track.clips.every(c => {
  const [s, e] = span(c)
  return e <= start + EPS || s >= end - EPS
})

/**
 * The tracks with `clip` placed (its startTime / endTime give its length):
 * - underClipId: as the background of that clip: same start, at most as long,
 *   on the track right below it (a new "Background" track if that one is busy)
 * - an empty timeline: on the main video track, at `at`
 * - otherwise as b-roll over the footage at `at`: a "B-roll" track with room,
 *   else a new one above the footage and earlier b-roll (stickers stay on top)
 * newTrackId() makes ids for new tracks. Returns { tracks, clip } (the clip as placed).
 */
export function placeStockClip(tracks, clip, { at = 0, underClipId = null, newTrackId }) {
  const len = Math.max(0.1, clip.endTime - clip.startTime)
  const name = (kind, n) => (kind === 'background' ? (n ? `Background ${n + 1}` : 'Background') : (n ? `B-roll ${n + 1}` : 'B-roll'))
  const fresh = (kind) => ({ id: newTrackId(), type: 'video', name: name(kind, tracks.filter(t => t.stock === kind).length), stock: kind, clips: [] })

  if (underClipId) {
    const ti = tracks.findIndex(t => t.clips.some(c => c.id === underClipId))
    if (ti >= 0) {
      const [s, e] = span(tracks[ti].clips.find(c => c.id === underClipId))
      const placed = { ...clip, timelinePosition: s, endTime: clip.startTime + Math.min(len, Math.max(0.1, e - s)) }
      const [ps, pe] = span(placed)
      const below = tracks[ti + 1]
      if (below && below.type === 'video' && below.stock === 'background' && roomFor(below, ps, pe)) {
        return { clip: placed, tracks: tracks.map((t, i) => (i === ti + 1 ? { ...t, clips: [...t.clips, placed] } : t)) }
      }
      const track = { ...fresh('background'), clips: [placed] }
      return { clip: placed, tracks: [...tracks.slice(0, ti + 1), track, ...tracks.slice(ti + 1)] }
    }
  }

  const start = Math.max(0, +at || 0)
  const placed = { ...clip, timelinePosition: start }
  const footage = tracks.filter(t => t.type === 'video' && !t.stickers && !t.stock)
  const empty = !tracks.some(t => t.type === 'video' && t.clips.length)
  if (empty && footage.length) {
    const main = footage[footage.length - 1] // the bottom video track
    return { clip: placed, tracks: tracks.map(t => (t.id === main.id ? { ...t, clips: [...t.clips, placed] } : t)) }
  }
  const end = start + len
  const free = tracks.find(t => t.type === 'video' && t.stock === 'broll' && roomFor(t, start, end))
  if (free) return { clip: placed, tracks: tracks.map(t => (t.id === free.id ? { ...t, clips: [...t.clips, placed] } : t)) }
  const track = { ...fresh('broll'), clips: [placed] }
  // above the footage and any earlier b-roll (the newest on top), under the stickers
  const topFootage = tracks.findIndex(t => t.type === 'video' && !t.stickers)
  const at2 = topFootage >= 0 ? topFootage : tracks.findIndex(t => t.type !== 'video')
  const i = at2 >= 0 ? at2 : tracks.length
  return { clip: placed, tracks: [...tracks.slice(0, i), track, ...tracks.slice(i)] }
}
