// Ripple (G / the Ripple button): close the gap at the playhead on ONE track,
// the selected clip's (or, with nothing selected, the topmost track that has a
// gap there). Other tracks stay where they are, except clips grouped with the
// ones that move (voices recorded together keep in sync).

const EPS = 0.01
const startOf = (c) => c.timelinePosition || 0
const endOf = (c) => startOf(c) + (c.endTime - c.startTime)

/** The gap the playhead `t` sits in on `track`: { start, end }, or null (on a clip, nothing after it, no real gap). */
export function gapAt(track, t) {
  if (!track || !track.clips.length) return null
  let prevEnd = 0
  let nextStart = Infinity
  for (const c of track.clips) {
    if (t >= startOf(c) - EPS && t < endOf(c) - EPS) return null // on a clip
    if (endOf(c) <= t + EPS) prevEnd = Math.max(prevEnd, endOf(c))
  }
  for (const c of track.clips) {
    const s = startOf(c)
    if (s >= t - EPS && s > prevEnd - EPS) nextStart = Math.min(nextStart, s)
  }
  if (nextStart === Infinity || nextStart - prevEnd < EPS) return null
  return { start: prevEnd, end: nextStart }
}

/**
 * Which track Ripple works on at `t`: the selected clip's track when it has a
 * gap there (else none), or with nothing selected the topmost track with one.
 * `tracks` in the order they are shown.
 */
export function rippleTrackId(tracks, t, selectedClipId = null) {
  if (selectedClipId) {
    const own = tracks.find(tr => tr.clips.some(c => c.id === selectedClipId))
    return own && gapAt(own, t) ? own.id : null
  }
  return tracks.find(tr => gapAt(tr, t))?.id || null
}

/** Close the gap at `t` on `trackId`: its later clips (and their group mates) move left. */
export function rippleTrack(tracks, trackId, t) {
  const track = tracks.find(tr => tr.id === trackId)
  const gap = gapAt(track, t)
  if (!gap) return tracks
  const shift = gap.end - gap.start
  const moving = new Set(track.clips.filter(c => startOf(c) >= gap.end - EPS).map(c => c.id))
  const groups = new Set(track.clips.filter(c => moving.has(c.id) && c.groupId).map(c => c.groupId))
  return tracks.map(tr => {
    const touched = tr.clips.some(c => moving.has(c.id) || (c.groupId && groups.has(c.groupId)))
    if (!touched) return tr
    return {
      ...tr,
      clips: tr.clips.map(c => (moving.has(c.id) || (c.groupId && groups.has(c.groupId))
        ? { ...c, timelinePosition: Math.max(0, startOf(c) - shift) }
        : c))
    }
  })
}
