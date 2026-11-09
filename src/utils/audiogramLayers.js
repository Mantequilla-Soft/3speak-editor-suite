// Audiograms: the arrangement of their parts (logo, cover, title, line,
// waveform) as boxes in pixels of the video, which the person moves, resizes
// and stacks in the preview. The backend draws the same boxes
// (backend/src/services/audiogramPage.js) and checks them again.

export const SIZES = { vertical: { w: 1080, h: 1920 }, square: { w: 1080, h: 1080 } }
export const LAYERS = [
  { id: 'logo', name: '3Speak logo' },
  { id: 'cover', name: 'Picture' },
  { id: 'title', name: 'Title' },
  { id: 'line', name: 'Line' },
  { id: 'wave', name: 'Waveform' }
]
export const MIN_BOX = 16
export const AUDIOGRAM_MIN_SECONDS = 3
export const AUDIOGRAM_MAX_SECONDS = 120
export const SNAP_PX = 14

const round = (n) => Math.round(n)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

/** A box kept usable: at least MIN_BOX, at least MIN_BOX of it in the frame. */
export function clampBox(b, size) {
  const w = clamp(round(b.w), MIN_BOX, size.w)
  const h = clamp(round(b.h), MIN_BOX, size.h)
  return { ...b, w, h, x: clamp(round(b.x), -w + MIN_BOX, size.w - MIN_BOX), y: clamp(round(b.y), -h + MIN_BOX, size.h - MIN_BOX) }
}

/**
 * The layer moved by (dx, dy). Its middle snaps to the frame's middle line
 * when close (`snap` false: no snapping). Returns { layers, guide } (guide:
 * 'x' when it snapped).
 */
export function moveLayer(layers, id, dx, dy, size, snap = true) {
  const l = layers[id]
  let x = l.x + dx
  let guide = null
  if (snap && Math.abs(x + l.w / 2 - size.w / 2) <= SNAP_PX) { x = size.w / 2 - l.w / 2; guide = 'x' }
  return { layers: { ...layers, [id]: clampBox({ ...l, x, y: l.y + dy }, size) }, guide }
}

/**
 * The layer resized from a corner ('nw' | 'ne' | 'sw' | 'se') by (dx, dy);
 * `keepAspect`: the shape stays (Shift, and always for the picture card).
 */
export function resizeLayer(layers, id, corner, dx, dy, size, keepAspect = false) {
  const l = layers[id]
  const west = corner.includes('w')
  const north = corner.includes('n')
  let w = Math.max(MIN_BOX, l.w + (west ? -dx : dx))
  let h = Math.max(MIN_BOX, l.h + (north ? -dy : dy))
  if (keepAspect) {
    const k = Math.max(w / l.w, h / l.h)
    w = Math.max(MIN_BOX, l.w * k)
    h = Math.max(MIN_BOX, l.h * k)
  }
  const x = west ? l.x + l.w - w : l.x
  const y = north ? l.y + l.h - h : l.y
  return { ...layers, [id]: clampBox({ ...l, x, y, w, h }, size) }
}

/** Front to back: the layer ids by z (ties: the later in LAYERS is in front). */
export function stackOrder(layers) {
  const index = (id) => LAYERS.findIndex(l => l.id === id)
  return Object.keys(layers).sort((a, b) => (layers[b].z - layers[a].z) || (index(b) - index(a)))
}

/** One step forward (dir 1) or back (dir -1); every layer gets its own z (0, 1, 2, ...). */
export function restack(layers, id, dir) {
  const order = stackOrder(layers).reverse() // back to front
  const i = order.indexOf(id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= order.length) return layers
  ;[order[i], order[j]] = [order[j], order[i]]
  const out = { ...layers }
  order.forEach((k, z) => { out[k] = { ...out[k], z } })
  return out
}

export const toggleLayer = (layers, id) => ({ ...layers, [id]: { ...layers[id], on: layers[id].on === false } })

const sameBoxes = (a, b) => Object.keys(b).every(k => a?.[k] && ['x', 'y', 'w', 'h', 'z'].every(p => a[k][p] === b[k][p]))

/**
 * A picture came in (or went): with one, the picture card shows; an untouched
 * first arrangement becomes the one made for a picture. Without one the card
 * is simply not drawn (its box stays for later).
 */
export function withPicture(layouts, { hasImage, plainDefaults, coverDefaults }) {
  if (!hasImage) return layouts
  const out = {}
  for (const f of Object.keys(layouts)) {
    const l = layouts[f]
    if (plainDefaults?.[f] && coverDefaults?.[f] && sameBoxes(l, plainDefaults[f])) out[f] = coverDefaults[f]
    else out[f] = { ...l, cover: { ...l.cover, on: true } }
  }
  return out
}

/** The piece to use: the one picked (kept inside the episode, 3 s to 2 min), else 30 s from the playhead. */
export function pieceOf(range, length, playhead = 0) {
  const end = Math.max(0, length)
  if (range && range.end - range.start >= AUDIOGRAM_MIN_SECONDS) {
    const start = clamp(range.start, 0, Math.max(0, end - AUDIOGRAM_MIN_SECONDS))
    return { start, end: Math.min(end, start + AUDIOGRAM_MAX_SECONDS, Math.max(range.end, start + AUDIOGRAM_MIN_SECONDS)) }
  }
  const start = clamp(playhead, 0, Math.max(0, end - Math.min(30, end)))
  return { start, end: Math.min(end, start + 30) }
}

/** Can this audiogram go out as a Short? Vertical and at most 2 minutes. */
export const canBeShort = (a) => a.format === 'vertical' && a.duration <= AUDIOGRAM_MAX_SECONDS

/** What goes to 3Speak with "Use this audio": the audiograms marked to post. */
export function audiogramsToPost(list) {
  return (list || []).filter(a => a.post && canBeShort(a) && a.url).map(a => ({
    url: a.url,
    description: String(a.description || '').trim().slice(0, 500),
    title: a.title || '',
    duration: a.duration,
    width: 1080,
    height: 1920
  }))
}
