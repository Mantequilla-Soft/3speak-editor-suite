// Colour adjustments of a clip, shared by the preview (an SVG filter), the
// browser export (the same SVG filter via ctx.filter) and the backend render
// (ffmpeg lutrgb + colorchannelmixer). Kept byte-identical in
// src/utils/clipColor.js and backend/src/utils/clipColor.js
// (node scripts/check-static-mask-sync.mjs checks both shared files).
//
// clip.color: { brightness, contrast, midtones, saturation, warmth, tint },
// each -100..100, 0 = unchanged. All maths is on 0..1 sRGB values:
//   per channel  v' = A * v^gamma + O      (midtones, contrast, brightness,
//                                           warmth and tint as channel gains)
//   then         the CSS/SVG "saturate" matrix
// Both the SVG filter (feComponentTransfer gamma + feColorMatrix saturate,
// color-interpolation-filters sRGB) and ffmpeg compute exactly this.

export const COLOR_DEFAULTS = { brightness: 0, contrast: 0, midtones: 0, saturation: 0, warmth: 0, tint: 0 }
export const COLOR_KEYS = Object.keys(COLOR_DEFAULTS)

// Clamped values, or null when nothing is changed
export function normalizeColor(color) {
  if (!color || typeof color !== 'object') return null
  const out = {}
  let any = false
  for (const key of COLOR_KEYS) {
    const v = Math.round(Math.max(-100, Math.min(100, Number(color[key]) || 0)))
    out[key] = v
    if (v !== 0) any = true
  }
  return any ? out : null
}

export function colorParams(color) {
  const c = normalizeColor(color)
  if (!c) return null
  const contrast = 1 + (c.contrast / 100) * 0.8 // 0.2 .. 1.8 around mid grey
  const offset = (c.brightness / 100) * 0.3 // -0.3 .. +0.3
  const gamma = Math.pow(2, -c.midtones / 100) // 2 .. 0.5; < 1 lifts the midtones
  const warm = (c.warmth / 100) * 0.15
  const tint = (c.tint / 100) * 0.12 // + magenta, - green
  const gain = { r: 1 + warm, g: 1 - tint, b: 1 - warm }
  const O = 0.5 - 0.5 * contrast + offset
  const channels = {}
  for (const ch of ['r', 'g', 'b']) channels[ch] = { A: contrast * gain[ch], O }
  return { gamma, channels, saturation: 1 + c.saturation / 100 }
}

// The saturate matrix of the Filter Effects spec (same as CSS saturate())
export function saturateMatrix(s) {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s
  ]
}

const num = (v) => Number(v.toFixed(5))

// ffmpeg filters for a clip's colour (no commas inside an expression, so the
// chain drops straight into a filtergraph), or '' when unchanged. lutrgb
// clips its results to 0..255, like the SVG filter clamps to 0..1.
export function ffmpegColorFilter(color) {
  const p = colorParams(color)
  if (!p) return ''
  const expr = ({ A, O }) => `${num(A)}*exp(${num(p.gamma)}*log(val/maxval))*maxval+${num(O)}*maxval`
  const parts = [`lutrgb=r='${expr(p.channels.r)}':g='${expr(p.channels.g)}':b='${expr(p.channels.b)}'`]
  if (p.saturation !== 1) {
    const [rr, rg, rb, gr, gg, gb, br, bg, bb] = saturateMatrix(p.saturation).map(num)
    parts.push(`colorchannelmixer=rr=${rr}:rg=${rg}:rb=${rb}:gr=${gr}:gg=${gg}:gb=${gb}:br=${br}:bg=${bg}:bb=${bb}`)
  }
  return parts.join(',')
}
