/**
 * Layout boxes for remix modes.
 *
 * A clip with a `layout` is placed in a box given as fractions (0-1) of the
 * output canvas and cover-fitted into it. Unlike positionX/Y (preview pixels)
 * this is resolution independent, so the preview, the canvas export and the
 * backend render all agree. zoom / crop / position are ignored on such clips.
 */

// Overlay box is 3:4 on the 9:16 canvas: (0.36 * 9) / (0.27 * 16) = 0.75
export const OVERLAY_BOX = { x: 0.61, y: 0.70, w: 0.36, h: 0.27 }

export const REMIX_LAYOUTS = {
  // Stitch fills the frame so a landscape webcam isn't letterboxed
  stitch: { source: null, recording: { x: 0, y: 0, w: 1, h: 1 } },
  overlay: { source: null, recording: OVERLAY_BOX },
  tileTop: { source: { x: 0, y: 0.5, w: 1, h: 0.5 }, recording: { x: 0, y: 0, w: 1, h: 0.5 } },
  tileBottom: { source: { x: 0, y: 0, w: 1, h: 0.5 }, recording: { x: 0, y: 0.5, w: 1, h: 0.5 } }
}

export function hasLayout(clip) {
  const l = clip?.layout
  return !!l && [l.x, l.y, l.w, l.h].every(v => typeof v === 'number' && isFinite(v)) && l.w > 0 && l.h > 0
}

// Keeps extra fields (panX / panY) untouched
export function clampLayout(l) {
  const w = Math.min(1, Math.max(0.05, l.w))
  const h = Math.min(1, Math.max(0.05, l.h))
  return {
    ...l,
    x: Math.min(1 - w, Math.max(0, l.x)),
    y: Math.min(1 - h, Math.max(0, l.y)),
    w,
    h
  }
}

/** Resize a box around its center, keeping its aspect ratio. */
export function scaleLayout(l, factor) {
  const w = l.w * factor
  const h = l.h * factor
  if (w > 1 || h > 1 || w < 0.1 || h < 0.1) return l
  return clampLayout({ ...l, x: l.x + (l.w - w) / 2, y: l.y + (l.h - h) / 2, w, h })
}

/**
 * Pan = which part of the cover-fitted media shows in the box, 0-1 per axis
 * (0 = left/top edge, 0.5 = centered, 1 = right/bottom edge), same meaning as
 * CSS object-position percentages.
 */
export function layoutPan(l) {
  const clamp01 = (v, d) => (typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : d)
  return { panX: clamp01(l?.panX, 0.5), panY: clamp01(l?.panY, 0.5) }
}

export const LAYOUT_ZOOM_MIN = 1
export const LAYOUT_ZOOM_MAX = 4

/** Zoom of the media inside its box, on top of the cover fit (1 = just covers the box). */
export function layoutZoom(l) {
  const z = l?.zoom
  return typeof z === 'number' && isFinite(z) ? Math.min(LAYOUT_ZOOM_MAX, Math.max(LAYOUT_ZOOM_MIN, z)) : 1
}

/** Source rect (in media pixels) that cover-fits media of srcW x srcH into a boxW x boxH box. */
export function coverSourceRect(srcW, srcH, boxW, boxH, panX = 0.5, panY = 0.5, zoom = 1) {
  const scale = Math.max(boxW / srcW, boxH / srcH) * zoom
  const sw = boxW / scale
  const sh = boxH / scale
  return { sx: (srcW - sw) * panX, sy: (srcH - sh) * panY, sw, sh }
}
