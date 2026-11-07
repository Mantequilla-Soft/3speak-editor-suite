// Cut silences on a GROUP of clips that play together: two people recorded on
// their own tracks (host and guest). A pause is only cut where EVERYONE is
// quiet, and the same stretch of time comes out of every clip of the group, so
// the voices stay in sync. Works on timeline time, not on any one file's time.

const FLOOR_DB = -90
const len = (c) => Math.max(0, c.endTime - c.startTime)
const pos = (c) => c.timelinePosition || 0

/** Where a group sits on the timeline: from its first start to its last end. */
export function groupSpan(clips) {
  let from = Infinity
  let to = 0
  for (const c of clips) {
    from = Math.min(from, pos(c))
    to = Math.max(to, pos(c) + len(c))
  }
  return from === Infinity ? { from: 0, to: 0 } : { from, to }
}

/**
 * One loudness curve for the group, in TIMELINE seconds (index w = time w*step):
 * at each moment the loudest member there (a pause is silence for everyone).
 * entries: [{ clip, loudness: { db, step } }] (each member's own file loudness).
 * Moments no member covers count as silence. Same shape as loadLoudness gives,
 * so planCuts works on it with from/to = the group span.
 */
export function combineLoudness(entries) {
  const step = entries.find(e => e.loudness)?.loudness.step || 0.02
  const { to } = groupSpan(entries.map(e => e.clip))
  const db = new Float32Array(Math.ceil(to / step) + 1).fill(FLOOR_DB)
  for (const { clip, loudness } of entries) {
    if (!loudness) continue
    const p = pos(clip)
    const end = p + len(clip)
    for (let w = Math.max(0, Math.floor(p / step)); w * step < end; w++) {
      const t = w * step
      if (t < p) continue
      const src = clip.startTime + (t - p)
      const v = loudness.db[Math.min(loudness.db.length - 1, Math.floor(src / loudness.step))]
      if (v > db[w]) db[w] = v
    }
  }
  return { db, step, duration: to }
}

/**
 * Apply the kept stretches (`keep`, timeline seconds, in order) to every clip
 * of the group. Each clip is split into its share of every kept stretch. With
 * closeGaps the stretches are packed from the group's start and whatever comes
 * after the group on the timeline moves left by what was cut.
 * The pieces of one stretch share a new group (move one voice, the other comes
 * along); fades stay at the outer ends. Returns { tracks, copies: [[newId, fromId]] }.
 */
export function applyGroupCut(tracks, memberIds, keep, { closeGaps = true, newId, newGroupId }) {
  const ids = new Set(memberIds)
  const members = tracks.flatMap(t => t.clips).filter(c => ids.has(c.id))
  if (!members.length || !keep?.length) return { tracks, copies: [] }
  const { from: T0, to: T1 } = groupSpan(members)
  const keptTotal = keep.reduce((s, p) => s + (p.end - p.start), 0)
  const removed = closeGaps ? Math.max(0, (T1 - T0) - keptTotal) : 0

  // Timeline time inside the group -> where it lands once the cuts are closed
  const packed = (t) => {
    let at = T0
    for (const p of keep) {
      if (t <= p.start) return at
      if (t < p.end) return at + (t - p.start)
      at += p.end - p.start
    }
    return at
  }
  const groups = keep.map(() => newGroupId())
  const copies = []

  const next = tracks.map(track => ({
    ...track,
    clips: track.clips.flatMap(c => {
      if (ids.has(c.id)) {
        const p0 = pos(c)
        const p1 = p0 + len(c)
        const base = (c.name || '').replace(/^Part \d+ · /, '')
        const pieces = []
        keep.forEach((p, k) => {
          const a = Math.max(p.start, p0)
          const b = Math.min(p.end, p1)
          if (b - a < 0.02) return
          pieces.push({ a, b, k })
        })
        return pieces.map(({ a, b, k }, i) => {
          const id = i === 0 ? c.id : newId()
          if (i > 0) copies.push([id, c.id])
          return {
            ...c,
            id,
            name: pieces.length > 1 ? `Part ${i + 1} · ${base}` : c.name,
            startTime: c.startTime + (a - p0),
            endTime: c.startTime + (b - p0),
            timelinePosition: closeGaps ? packed(a) : a,
            groupId: groups[k],
            fadeIn: i === 0 && a <= p0 + 0.001 ? c.fadeIn : 0,
            fadeOut: i === pieces.length - 1 && b >= p1 - 0.001 ? c.fadeOut : 0
          }
        })
      }
      if (removed && pos(c) >= T1 - 0.001) return [{ ...c, timelinePosition: pos(c) - removed }]
      return [c]
    })
  }))
  return { tracks: next, copies }
}

/**
 * The voices playing at the same time as `clipId` on the OTHER voice tracks
 * (not music, not template parts), plus the clip's own group: what "Group with
 * other voices" puts in one group.
 */
export function overlappingVoices(tracks, clipId) {
  const owner = tracks.find(t => t.clips.some(c => c.id === clipId))
  const clip = owner?.clips.find(c => c.id === clipId)
  if (!clip || owner.type !== 'audio' || owner.music || clip.templateRole) return []
  const a = pos(clip)
  const b = a + len(clip)
  const out = new Set([clip.id])
  for (const t of tracks) {
    if (t.type !== 'audio' || t.music) continue
    for (const c of t.clips) {
      if (c.templateRole) continue
      const sameGroup = clip.groupId && c.groupId === clip.groupId
      const overlaps = t.id !== owner.id && pos(c) < b - 0.001 && pos(c) + len(c) > a + 0.001
      if (sameGroup || overlaps) out.add(c.id)
    }
  }
  return [...out]
}
