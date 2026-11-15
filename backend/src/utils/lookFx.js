// A clip's look effects (blur, vignette, sharpen; utils/clipLook.js) as the
// ffmpeg filters that follow its transform, sized like the preview draws them.
// The preview filters the clip's element: the whole canvas for a freely placed
// clip (the picture contain-fit in it), the box for a remix layout clip; its
// CSS zoom scales the result. ffmpeg filters the picture itself, at output size
// and already zoomed.
import { fxParams, ffmpegFxFilter } from './clipLook.js'

const layoutBox = (clip) => {
  const l = clip.layout
  return l && [l.x, l.y, l.w, l.h].every(v => Number.isFinite(+v)) && l.w > 0 && l.h > 0 ? l : null
}

const zoomOf = (clip) => {
  if (!clip.zoom || clip.zoom === 1 || clip.zoom === 100) return 1
  return Math.max(0.1, Math.min(5.0, clip.zoom > 10 ? clip.zoom / 100 : clip.zoom))
}

/**
 * { frameH, zoom, vignetteScale } for ffmpegFxFilter. src: the source's display
 * size ({ width, height }) or null (then the picture is taken to fill the canvas).
 */
export function fxGeometry(clip, w, h, src = null) {
  const box = layoutBox(clip)
  if (box) return { frameH: box.h * h, zoom: 1, vignetteScale: 1 }
  let vignetteScale = 1
  if (src?.width > 0 && src?.height > 0) {
    // the contain-fit picture's half diagonal over the canvas's (zoom scales both)
    const sw = src.width * (clip.cropWidth || 100) / 100
    const sh = src.height * (clip.cropHeight || 100) / 100
    const k = Math.min(w / sw, h / sh)
    vignetteScale = Math.min(1, Math.hypot(sw * k, sh * k) / Math.hypot(w, h))
  }
  return { frameH: h, zoom: zoomOf(clip), vignetteScale }
}

/**
 * The effects filter for a clip ('' when it has none). probe(file) gives the
 * source's display size; only asked for when there is a vignette.
 */
export async function clipFxFilter(clip, inputFile, w, h, { alpha = false, tag = 'lk', probe = null } = {}) {
  const fx = fxParams(clip.look)
  if (!fx) return ''
  const src = fx.vignette > 0 && inputFile && probe ? await probe(inputFile).catch(() => null) : null
  return ffmpegFxFilter(clip.look, { ...fxGeometry(clip, w, h, src), alpha, tag })
}
