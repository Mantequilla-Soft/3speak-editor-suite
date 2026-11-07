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
