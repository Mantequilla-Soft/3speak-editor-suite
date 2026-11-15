// Ripple (G / the Ripple button): close the gap at the playhead on ONE track,
// the selected clip's (or, with nothing selected, the topmost track that has a
// gap there). Other tracks stay where they are, except clips grouped with the
// ones that move (voices recorded together keep in sync).

import { splitPair, nextClipOf } from './transitions.js'

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

// ---- Cutting stretches of time out of everything (edit by text, fillers) ----

let cutIds = 0
const cutClipId = () => `clip_cut_${++cutIds}_${Date.now()}`
const cutGroupId = () => `group_cut_${++cutIds}_${Date.now()}`

// Music, sound effects and the picture-only parts (text, stickers, colours,
// pictures) keep playing straight through a cut and only end earlier: cutting
// a bar out of a song or a word out of a title helps no one. Speech and video
// lose exactly the stretch that was cut.
const continuous = (track, clip) => (track.type === 'audio' && (track.music || track.sfx)) || (track.type === 'video' && clip.type !== 'video')

function cutOne(tracks, a, b, copies, newId, newGroupId, touchedIds) {
  const d = b - a
  const groupMap = new Map() // old group -> the group of the pieces after the cut
  const groupAfter = (g) => {
    if (!g) return g
    if (!groupMap.has(g)) groupMap.set(g, newGroupId())
    return groupMap.get(g)
  }
  return tracks.map(track => {
    let touched = false
    const clips = []
    for (const c of track.clips) {
      const s = startOf(c)
      const e = endOf(c)
      if (e <= a + EPS / 10) { clips.push(c); continue }
      touched = true
      touchedIds.add(c.id)
      if (s >= b - EPS / 10) { clips.push({ ...c, timelinePosition: Math.max(0, s - d) }); continue }
      const overlap = Math.min(e, b) - Math.max(s, a)
      if (continuous(track, c)) {
        const left = (e - s) - overlap
        if (left >= 0.05) clips.push({ ...c, timelinePosition: Math.min(s, a), endTime: c.endTime - overlap })
        continue
      }
      const before = s < a - 0.02 ? { ...c, endTime: c.startTime + (a - s), fadeOut: 0 } : null
      const after = e > b + 0.02
        ? { ...c, id: before ? newId() : c.id, startTime: c.startTime + (b - s), timelinePosition: a, fadeIn: 0, groupId: before ? groupAfter(c.groupId) : c.groupId }
        : null
      if (before && after) {
        // a split (utils/transitions.js): the transition into the next clip goes with the second half
        copies.push([after.id, c.id])
        touchedIds.add(after.id)
        clips.push(...splitPair(before, after))
      } else if (before) clips.push(before)
      else if (after) clips.push(after)
    }
    return touched ? { ...track, clips } : track
  })
}

/**
 * Cut timeline stretches `ranges` ([[from, to]], seconds) out of every track
 * and close them up (a ripple delete). Speech and video clips lose the
 * stretch (split in two when it is in their middle; linked clips such as a
 * video and its sound, or voices grouped together, stay linked piece by
 * piece); everything after a stretch moves left by its length. Music, sound
 * effects and overlays play on and end earlier. Returns { tracks, copies:
 * [[newId, fromId]] } (new pieces that need the original's file).
 */
export function rippleCutRanges(tracks, ranges, { newId = cutClipId, newGroupId = cutGroupId } = {}) {
  const list = (ranges || [])
    .filter(r => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] - r[0] > 0.01)
    .map(([x, y]) => [Math.max(0, x), y])
    .sort((p, q) => p[0] - q[0])
  // joined where they overlap, then cut from the last to the first (earlier times stay put)
  const merged = []
  for (const [x, y] of list) {
    const last = merged[merged.length - 1]
    if (last && x <= last[1]) last[1] = Math.max(last[1], y)
    else merged.push([x, y])
  }
  const copies = []
  const touchedIds = new Set()
  let out = tracks
  for (let i = merged.length - 1; i >= 0; i--) out = cutOne(out, merged[i][0], merged[i][1], copies, newId, newGroupId, touchedIds)
  out = mendTransitions(out, touchedIds)
  // a piece copied from a piece made earlier in this call needs the first original's file
  const origin = new Map(copies)
  const resolved = copies.map(([id, from]) => {
    let f = from
    while (origin.has(f)) f = origin.get(f)
    return [id, f]
  })
  return { tracks: out, copies: resolved }
}

/**
 * After a cut, a transition (utils/transitions.js) of a clip the cut reached,
 * or into one, goes into the clip that now follows it: the same one when the
 * cut only moved or trimmed it, the next one when the cut took it away
 * altogether. With no clip touching it any more, it goes.
 */
function mendTransitions(tracks, touchedIds) {
  if (!touchedIds.size) return tracks
  return tracks.map(track => {
    if (track.type !== 'video' || !track.clips.some(c => c.transition && (touchedIds.has(c.id) || touchedIds.has(c.transition.to)))) return track
    return {
      ...track,
      clips: track.clips.map(c => {
        if (!c.transition || !(touchedIds.has(c.id) || touchedIds.has(c.transition.to))) return c
        const next = nextClipOf(track, c.id)
        if (!next) { const { transition, ...rest } = c; return rest }
        return next.id === c.transition.to ? c : { ...c, transition: { ...c.transition, to: next.id } }
      })
    }
  })
}

/** Seconds a set of ranges takes out (overlaps counted once). */
export function cutLength(ranges) {
  const list = (ranges || []).filter(r => r[1] > r[0]).sort((p, q) => p[0] - q[0])
  let total = 0
  let end = -Infinity
  for (const [x, y] of list) {
    if (y <= end) continue
    total += y - Math.max(x, end)
    end = y
  }
  return total
}
