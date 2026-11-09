// Flags: the creator's own markers on the timeline ("look at this again",
// "the good take starts here"). Never exported, unlike chapters. Each flag keeps
// its number (1, 2, 3, ... in the order they were set) and the colour of that
// number. Like chapters, a flag is pinned to the moment of the recording under
// it (utils/chapters.js anchors), so cuts and moves take it along; a flag over
// no recording stays at its timeline time.
import { anchorAt, anchorPosition } from './chapters'

export const MAX_FLAGS = 100
// Flag 1, 2, 3, ... (then the colours come round again)
export const FLAG_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#eab308']
export const flagColor = (n) => FLAG_COLORS[(Math.max(1, n) - 1) % FLAG_COLORS.length]

const round3 = (t) => Math.round(Math.max(0, +t || 0) * 1000) / 1000
const newId = () => `fl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

/** A new flag at `at`: the next number. Unchanged list when the limit is reached. */
export function addFlag(flags, tracks, at, id = newId()) {
  const list = flags || []
  if (list.length >= MAX_FLAGS) return list
  const n = list.reduce((m, f) => Math.max(m, f.n || 0), 0) + 1
  return [...list, { id, n, at: round3(at), anchor: anchorAt(tracks, round3(at)) }]
}

/** The flag moved to `at` (pinned again to what is there now). */
export const moveFlag = (flags, tracks, id, at) => (flags || []).map(f => (f.id === id ? { ...f, at: round3(at), anchor: anchorAt(tracks, round3(at)) } : f))

export const removeFlag = (flags, id) => (flags || []).filter(f => f.id !== id)

/** Where the flags are now, by time: [{ id, n, at, color }]. */
export function resolveFlags(tracks, flags, end = Infinity) {
  return (flags || []).map(f => {
    const p = anchorPosition(tracks, f.anchor)
    const at = Math.min(Math.max(0, p ?? (+f.at || 0)), Math.max(0, end))
    return { id: f.id, n: f.n, at: round3(at), color: flagColor(f.n) }
  }).sort((a, b) => a.at - b.at)
}

/** Flags from a saved draft: well-formed ones only. */
export function cleanFlags(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter(f => f && typeof f.id === 'string' && Number.isInteger(f.n) && f.n > 0 && Number.isFinite(+f.at))
    .slice(0, MAX_FLAGS)
    .map(f => ({ id: f.id, n: f.n, at: round3(f.at), anchor: f.anchor?.libraryId ? { libraryId: String(f.anchor.libraryId), t: +f.anchor.t || 0 } : null }))
}
