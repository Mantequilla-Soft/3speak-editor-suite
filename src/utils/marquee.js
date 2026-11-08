// Box select on the timeline: which clips a dragged box touches.
// Boxes and clip rects are { x, y, w, h } in the same coordinates.

export function boxesTouch(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
}

export function clipIdsInBox(box, rects) {
  return rects.filter(r => boxesTouch(box, r)).map(r => r.id)
}

// A box from two corner points, whichever way it was dragged
export function boxFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

// Shift/Ctrl/Cmd-click: add a clip to the selection, or take it out
export function toggleInSelection(current, id) {
  return current.includes(id) ? current.filter(x => x !== id) : [...current, id]
}

/**
 * Shift-click: every clip between the anchor (the clip selected before) and
 * the clicked one. `tracks` in the order they are shown; the range takes the
 * tracks from the anchor's to the clicked one's, and on them every clip that
 * overlaps the time from the earlier clip's start to the later clip's end.
 * Without an anchor (or a stale one) it is just the clicked clip.
 */
export function clipIdsInRange(tracks, anchorId, clickedId) {
  const at = (id) => {
    for (let ti = 0; ti < tracks.length; ti++) {
      const clip = tracks[ti].clips.find(c => c.id === id)
      if (clip) return { ti, clip }
    }
    return null
  }
  const b = at(clickedId)
  if (!b) return []
  const a = anchorId && anchorId !== clickedId ? at(anchorId) : null
  if (!a) return [clickedId]
  const startOf = (c) => c.timelinePosition || 0
  const endOf = (c) => startOf(c) + Math.max(0, (c.endTime || 0) - (c.startTime || 0))
  const from = Math.min(startOf(a.clip), startOf(b.clip))
  const to = Math.max(endOf(a.clip), endOf(b.clip))
  const EPS = 1e-6 // touching end to start is not overlapping
  const ids = []
  for (let ti = Math.min(a.ti, b.ti); ti <= Math.max(a.ti, b.ti); ti++) {
    for (const c of tracks[ti].clips) {
      if (startOf(c) < to - EPS && endOf(c) > from + EPS) ids.push(c.id)
    }
  }
  // the two ends are always in, even a zero-length one
  for (const id of [anchorId, clickedId]) if (!ids.includes(id)) ids.push(id)
  return ids
}
