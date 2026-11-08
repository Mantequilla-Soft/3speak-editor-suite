// Where a clip added "here" goes: at the playhead, on the track the person
// chose (the track's + menu).

const EPS = 1e-3
// Less room than this at the playhead is no room
export const MIN_ROOM = 0.1

const spanOf = (c) => {
  const start = c.timelinePosition || 0
  return [start, start + Math.max(0, (c.endTime || 0) - (c.startTime || 0))]
}

/**
 * A clip of `length` seconds starting at `at` on a track holding `clips`.
 * Free at `at`: { position: at, length } (cut short where the next clip
 * starts, so nothing overlaps). A clip already sits at `at`: null (the caller
 * puts it on a new track at `at` instead).
 */
export function fitAt(clips, at, length) {
  const start = Math.max(0, +at || 0)
  const spans = (clips || []).map(spanOf)
  if (spans.some(([s, e]) => start >= s - EPS && start < e - EPS)) return null
  const next = Math.min(Infinity, ...spans.map(([s]) => s).filter(s => s > start - EPS))
  const room = next - start
  if (room < MIN_ROOM) return null
  return { position: start, length: Math.min(length, room) }
}

/**
 * Put `clip` (its startTime set, endTime = startTime + its full length) on
 * `trackId` at `at`. Returns the new track list: on that track when there is
 * room at `at` (shortened to the room), else on a new track of the same kind
 * right below it. `makeTrack(track)` builds that new track (id, name, flags).
 */
export function placeOnTrack(tracks, trackId, clip, at, makeTrack) {
  const track = tracks.find(t => t.id === trackId)
  if (!track) return null
  const full = Math.max(0, clip.endTime - clip.startTime)
  const fit = fitAt(track.clips, at, full)
  if (fit) {
    const placed = { ...clip, timelinePosition: fit.position, endTime: clip.startTime + fit.length }
    return tracks.map(t => (t.id === track.id ? { ...t, clips: [...t.clips, placed] } : t))
  }
  const placed = { ...clip, timelinePosition: Math.max(0, +at || 0) }
  const fresh = { ...makeTrack(track), clips: [placed] }
  const i = tracks.findIndex(t => t.id === track.id)
  return [...tracks.slice(0, i + 1), fresh, ...tracks.slice(i + 1)]
}
