// Audiograms: the arrangement of their parts (logo, cover, title, line,
// waveform) as boxes in pixels of the video, which the person moves, resizes,
// turns and stacks in the preview. The backend draws the same boxes
// (backend/src/services/audiogramPage.js) and checks them again.
//
// The 3Speak logo always shows: it can not be hidden, stays whole in the
// frame, at least LOGO_MIN big, and in front of the other parts.

// Vertical only: the shape of a Short
export const SIZES = { vertical: { w: 1080, h: 1920 } }
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
export const LOGO_MIN = { w: 240, h: 40 }
export const ROUND_WAVES = ['circle', 'ring']

const round = (n) => Math.round(n)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

/**
 * A box kept usable: at least MIN_BOX, at least MIN_BOX of it in the frame.
 * The logo's (`id` 'logo'): at least LOGO_MIN, all of it in the frame.
 */
export function clampBox(b, size, id = null) {
  if (id === 'logo') {
    const w = clamp(round(b.w), LOGO_MIN.w, size.w)
    const h = clamp(round(b.h), LOGO_MIN.h, size.h)
    return { ...b, w, h, x: clamp(round(b.x), 0, size.w - w), y: clamp(round(b.y), 0, size.h - h), on: true }
  }
  const w = clamp(round(b.w), MIN_BOX, size.w)
  const h = clamp(round(b.h), MIN_BOX, size.h)
  return { ...b, w, h, x: clamp(round(b.x), -w + MIN_BOX, size.w - MIN_BOX), y: clamp(round(b.y), -h + MIN_BOX, size.h - MIN_BOX) }
}

const rad = (deg) => (deg * Math.PI) / 180
// A point of a box (px, py from its top left, unturned) where it is in the frame, the box turned r degrees around its middle
function framePoint(b, px, py) {
  const a = rad(b.r || 0)
  const dx = px - b.w / 2
  const dy = py - b.h / 2
  return { x: b.x + b.w / 2 + dx * Math.cos(a) - dy * Math.sin(a), y: b.y + b.h / 2 + dx * Math.sin(a) + dy * Math.cos(a) }
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
  return { layers: { ...layers, [id]: clampBox({ ...l, x, y: l.y + dy }, size, id) }, guide }
}

/**
 * The layer resized from a corner ('nw' | 'ne' | 'sw' | 'se') by (dx, dy) on
 * the screen; `keepAspect`: the shape stays (Shift, and always for the picture
 * card and the logo). A turned layer grows along its own sides and its
 * opposite corner stays where it is.
 */
export function resizeLayer(layers, id, corner, dx, dy, size, keepAspect = false) {
  const l = layers[id]
  const a = rad(l.r || 0)
  // the pull along the layer's own sides
  const lx = dx * Math.cos(a) + dy * Math.sin(a)
  const ly = -dx * Math.sin(a) + dy * Math.cos(a)
  const west = corner.includes('w')
  const north = corner.includes('n')
  let w = Math.max(MIN_BOX, l.w + (west ? -lx : lx))
  let h = Math.max(MIN_BOX, l.h + (north ? -ly : ly))
  if (keepAspect) {
    const k = Math.max(w / l.w, h / l.h)
    w = Math.max(MIN_BOX, l.w * k)
    h = Math.max(MIN_BOX, l.h * k)
  }
  // the opposite corner stays put in the frame
  const fixed = framePoint(l, west ? l.w : 0, north ? l.h : 0)
  const moved = framePoint({ ...l, w, h, x: 0, y: 0 }, west ? w : 0, north ? h : 0)
  return { ...layers, [id]: clampBox({ ...l, w, h, x: fixed.x - moved.x, y: fixed.y - moved.y }, size, id) }
}

/**
 * The layer turned to `deg` (-180..180). Near a quarter turn it snaps to it;
 * with `step` (Shift: 15) to that many degrees.
 */
export function rotateLayer(layers, id, deg, step = 0) {
  let r = ((deg + 180) % 360 + 360) % 360 - 180
  if (step) r = Math.round(r / step) * step
  else if (Math.abs(r - Math.round(r / 90) * 90) <= 3) r = Math.round(r / 90) * 90
  r = Math.round(r)
  if (r === -180) r = 180
  return { ...layers, [id]: { ...layers[id], r } }
}

/** The waveform's box made square around its middle (a round waveform fills a square). */
export function squareWave(layers, size) {
  const l = layers.wave
  const side = Math.round(Math.min(size.w - 80, Math.max(320, Math.max(l.w, l.h) * 0.7)))
  return { ...layers, wave: clampBox({ ...l, x: l.x + l.w / 2 - side / 2, y: l.y + l.h / 2 - side / 2, w: side, h: side }, size) }
}

/** Front to back: the logo first, then the layer ids by z (ties: the later in LAYERS is in front). */
export function stackOrder(layers) {
  const index = (id) => LAYERS.findIndex(l => l.id === id)
  return Object.keys(layers).sort((a, b) => ((b === 'logo') - (a === 'logo')) || (layers[b].z - layers[a].z) || (index(b) - index(a)))
}

/**
 * One step forward (dir 1) or back (dir -1); every layer gets its own z (0, 1,
 * 2, ...). The logo stays in front: it does not move, nothing passes it.
 */
export function restack(layers, id, dir) {
  if (id === 'logo') return layers
  const order = stackOrder(layers).reverse().filter(k => k !== 'logo') // back to front
  const i = order.indexOf(id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= order.length) return layers
  ;[order[i], order[j]] = [order[j], order[i]]
  if (layers.logo) order.push('logo')
  const out = { ...layers }
  order.forEach((k, z) => { out[k] = { ...out[k], z } })
  return out
}

/** Shows or hides a part (not the logo: it always shows). */
export const toggleLayer = (layers, id) => (id === 'logo' ? layers : { ...layers, [id]: { ...layers[id], on: layers[id].on === false } })

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
