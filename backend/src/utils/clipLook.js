// Looks of a video / image clip: one-tap presets on top of the colour
// adjustments (clipColor.js), a teal and orange split tone, and the effects
// blur, vignette and sharpen. Shared by the preview (an SVG filter, see
// components/ClipColorFilters.jsx) and the backend render (ffmpeg). Kept
// byte-identical in src/utils/clipLook.js and backend/src/utils/clipLook.js
// (node scripts/check-static-mask-sync.mjs checks both).
//
// clip.color: the colour sliders (clipColor.js). A preset sets them, so the
//   user can adjust from there.
// clip.look: { split, blur, vignette, sharpen }
//   split     -100..100  + = teal shadows and orange highlights, - = the reverse
//   blur      0..100     Gaussian blur, sigma up to BLUR_MAX of the frame height
//   vignette  0..100     darker corners: v * cos(a * d)^4, d = distance from the
//                        centre / half the diagonal (ffmpeg's vignette filter)
//   sharpen   0..100     3x3 sharpen kernel (centre 1 + 4k, sides -k)
import { colorParams, saturateMatrix, normalizeColor, COLOR_DEFAULTS } from './clipColor.js'

export const LOOK_DEFAULTS = { split: 0, blur: 0, vignette: 0, sharpen: 0 }
export const LOOK_KEYS = Object.keys(LOOK_DEFAULTS)
export const BLUR_MAX = 0.02 // sigma at 100, as a fraction of the frame height
export const VIGNETTE_MAX = Math.PI / 2.2 // vignette angle at 100
export const SHARPEN_MAX = 1 // kernel side weight at 100
const SPLIT_OFFSET = 0.05 // shadows shift at 100 (0..1 units)
const SPLIT_GAIN = 0.1 // highlights shift at 100

const clampInt = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, Number(v) || 0)))

// Clamped values, or null when the look changes nothing
export function normalizeLook(look) {
  if (!look || typeof look !== 'object') return null
  const out = {}
  let any = false
  for (const key of LOOK_KEYS) {
    const v = clampInt(look[key], key === 'split' ? -100 : 0, 100)
    out[key] = v
    if (v !== 0) any = true
  }
  return any ? out : null
}

// One-tap presets: colour slider values plus split tone and vignette. Blur and
// sharpen stay as the user set them.
export const LOOK_PRESETS = [
  { id: 'original', label: 'Original', color: {}, look: {} },
  { id: 'warm', label: 'Warm', color: { warmth: 35, saturation: 10, brightness: 3 }, look: {} },
  { id: 'cool', label: 'Cool', color: { warmth: -35, tint: -4, saturation: 6 }, look: {} },
  { id: 'vivid', label: 'Vivid', color: { saturation: 45, contrast: 18, midtones: 5 }, look: {} },
  { id: 'matte', label: 'Matte', color: { contrast: -25, brightness: 20, saturation: -15 }, look: {} },
  { id: 'bw', label: 'B&W', color: { saturation: -100, contrast: 12 }, look: {} },
  { id: 'vintage', label: 'Vintage', color: { warmth: 25, tint: 6, saturation: -25, contrast: -15, brightness: 10 }, look: { vignette: 35 } },
  { id: 'tealorange', label: 'Teal & Orange', color: { saturation: 15, contrast: 10 }, look: { split: 60 } },
  { id: 'fade', label: 'Fade', color: { contrast: -35, brightness: 25, saturation: -20 }, look: {} },
  { id: 'noir', label: 'Noir', color: { saturation: -100, contrast: 45, midtones: -15 }, look: { vignette: 45 } },
  { id: 'sunset', label: 'Sunset', color: { warmth: 50, tint: 12, saturation: 20, midtones: 8 }, look: { split: 15 } }
]
const PRESET_LOOK_KEYS = ['split', 'vignette']

// The values a preset gives a clip: { color, look } (normalised, null = none),
// keeping the clip's own blur and sharpen
export function applyPreset(id, currentLook = null) {
  const p = LOOK_PRESETS.find(x => x.id === id)
  if (!p) return null
  const keep = normalizeLook(currentLook) || LOOK_DEFAULTS
  return {
    color: normalizeColor({ ...COLOR_DEFAULTS, ...p.color }),
    look: normalizeLook({ ...LOOK_DEFAULTS, blur: keep.blur, sharpen: keep.sharpen, ...p.look })
  }
}

// The preset a clip's colour and look match exactly, or null (adjusted by hand)
export function matchPreset(color, look) {
  const c = { ...COLOR_DEFAULTS, ...(normalizeColor(color) || {}) }
  const l = { ...LOOK_DEFAULTS, ...(normalizeLook(look) || {}) }
  for (const p of LOOK_PRESETS) {
    const pc = { ...COLOR_DEFAULTS, ...p.color }
    const pl = { ...LOOK_DEFAULTS, ...p.look }
    if (Object.keys(pc).every(k => pc[k] === c[k]) && PRESET_LOOK_KEYS.every(k => pl[k] === l[k])) return p.id
  }
  return null
}

const IDENTITY = { gamma: 1, channels: { r: { A: 1, O: 0 }, g: { A: 1, O: 0 }, b: { A: 1, O: 0 } }, saturation: 1 }

// The colour maths (clipColor.js: v' = A * v^gamma + O per channel, then
// saturate) with the split tone folded into the channels' A and O. null when
// neither changes anything.
export function gradeParams(color, look) {
  const base = colorParams(color)
  const split = normalizeLook(look)?.split || 0
  if (!split) return base
  const p = base || IDENTITY
  const s = split / 100
  const ch = (c, dO, dA) => ({ A: c.A + dA, O: c.O + dO })
  return {
    gamma: p.gamma,
    saturation: p.saturation,
    channels: {
      r: ch(p.channels.r, -SPLIT_OFFSET * s, SPLIT_GAIN * s),
      g: ch(p.channels.g, SPLIT_OFFSET * 0.4 * s, 0),
      b: ch(p.channels.b, SPLIT_OFFSET * s, -SPLIT_GAIN * s)
    }
  }
}

const num = (v) => Number(v.toFixed(5))

// ffmpeg colour grade (lutrgb + colorchannelmixer), '' when unchanged. Without
// a split tone this is exactly clipColor.js's ffmpegColorFilter.
export function ffmpegGradeFilter(color, look) {
  const p = gradeParams(color, look)
  if (!p) return ''
  const expr = ({ A, O }) => `${num(A)}*exp(${num(p.gamma)}*log(val/maxval))*maxval+${num(O)}*maxval`
  const parts = [`lutrgb=r='${expr(p.channels.r)}':g='${expr(p.channels.g)}':b='${expr(p.channels.b)}'`]
  if (p.saturation !== 1) {
    const [rr, rg, rb, gr, gg, gb, br, bg, bb] = saturateMatrix(p.saturation).map(num)
    parts.push(`colorchannelmixer=rr=${rr}:rg=${rg}:rb=${rb}:gr=${gr}:gg=${gg}:gb=${gb}:br=${br}:bg=${bg}:bb=${bb}`)
  }
  return parts.join(',')
}

// The effects as numbers: blur sigma (fraction of the frame height), vignette
// angle (radians), sharpen side weight. null when there are none.
export function fxParams(look) {
  const l = normalizeLook(look)
  if (!l || !(l.blur || l.vignette || l.sharpen)) return null
  return {
    blur: (l.blur / 100) * BLUR_MAX,
    vignette: (l.vignette / 100) * VIGNETTE_MAX,
    sharpen: (l.sharpen / 100) * SHARPEN_MAX
  }
}

// vignette factor at a normalised distance d (0 centre, 1 corner)
export const vignetteFactor = (angle, d) => {
  const c = Math.cos(angle * Math.min(1, Math.max(0, d)))
  return c * c * c * c
}

/**
 * ffmpeg effects after the clip's transform (picture at output size), '' when
 * none. frameH: output height; zoom: the clip's zoom (the preview blurs before
 * its CSS scale); vignetteScale: the picture's half diagonal over the preview
 * element's (the preview's vignette spans the whole element, the canvas, while
 * ffmpeg's spans the picture it is applied to). alpha: the layer has
 * transparency to keep (images, keyed clips). tag: unique label suffix.
 */
export function ffmpegFxFilter(look, { frameH, zoom = 1, vignetteScale = 1, alpha = false, tag = 'lk' } = {}) {
  const fx = fxParams(look)
  if (!fx) return ''
  const parts = []
  if (fx.sharpen > 0) {
    const k = Math.round(fx.sharpen * 100)
    const m = `0 -${k} 0 -${k} ${100 + 4 * k} -${k} 0 -${k} 0`
    parts.push(`format=${alpha ? 'gbrap' : 'gbrp'}`,
      `convolution=0m='${m}':1m='${m}':2m='${m}':0rdiv=0.01:1rdiv=0.01:2rdiv=0.01`)
  }
  if (fx.blur > 0) {
    const sigma = num(Math.max(0.3, fx.blur * frameH * zoom))
    parts.push(`gblur=sigma=${sigma}`)
  }
  if (fx.vignette > 0) {
    const a = num(Math.min(Math.PI / 2, fx.vignette * vignetteScale))
    if (alpha) {
      return `${[...parts, 'format=rgba', `split[${tag}a][${tag}b]`].join(',')};[${tag}a]alphaextract[${tag}m];` +
        `[${tag}b]format=rgb24,vignette=angle=${a}:eval=init[${tag}v];[${tag}v][${tag}m]alphamerge`
    }
    parts.push('format=rgb24', `vignette=angle=${a}:eval=init`)
  }
  return parts.join(',')
}

// The colour grade as SVG filter primitives (feComponentTransfer gamma per
// channel, then the saturate matrix), [] when unchanged
export function svgGradePrimitives(color, look) {
  const p = gradeParams(color, look)
  if (!p) return []
  const func = (tag, ch) => ({ tag, attrs: { type: 'gamma', amplitude: String(p.channels[ch].A), exponent: String(p.gamma), offset: String(p.channels[ch].O) } })
  const out = [{ tag: 'feComponentTransfer', attrs: {}, children: [func('feFuncR', 'r'), func('feFuncG', 'g'), func('feFuncB', 'b')] }]
  if (p.saturation !== 1) {
    const m = saturateMatrix(p.saturation)
    out.push({ tag: 'feColorMatrix', attrs: { type: 'matrix', values: `${m[0]} ${m[1]} ${m[2]} 0 0  ${m[3]} ${m[4]} ${m[5]} 0 0  ${m[6]} ${m[7]} ${m[8]} 0 0  0 0 0 1 0` } })
  }
  return out
}

// Whole <filter> as markup (tests, and pages outside React)
export function svgFilterMarkup(id, color, look, aspect) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const el = ({ tag, attrs, children }) => `<${tag}${Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>${(children || []).map(el).join('')}</${tag}>`
  const prims = [...svgGradePrimitives(color, look), ...svgFxPrimitives(look, aspect)]
  return `<filter id="${id}" color-interpolation-filters="sRGB" x="0" y="0" width="1" height="1" primitiveUnits="objectBoundingBox">${prims.map(el).join('')}</filter>`
}

/**
 * The preview's SVG filter primitives for a clip's look, as plain data
 * ({ tag, attrs, children? }), after the colour grade. `aspect`: width / height
 * of the element the filter is on. Units are fractions of that element
 * (primitiveUnits objectBoundingBox), so the effect scales with the preview.
 */
export function svgFxPrimitives(look, aspect = 9 / 16) {
  const fx = fxParams(look)
  if (!fx) return []
  // named start: the previous result (the colour grade, or the source)
  const out = [{ tag: 'feOffset', attrs: { dx: '0', dy: '0', result: 'lk_in' } }]
  let last = 'lk_in'
  const from = () => ({ in: last })
  if (fx.sharpen > 0) {
    const k = num(fx.sharpen)
    out.push({ tag: 'feConvolveMatrix', attrs: { ...from(), order: '3', kernelMatrix: `0 ${-k} 0 ${-k} ${num(1 + 4 * k)} ${-k} 0 ${-k} 0`, divisor: '1', preserveAlpha: 'true', edgeMode: 'duplicate', result: 'lk_sharp' } })
    last = 'lk_sharp'
  }
  if (fx.blur > 0) {
    // sigma as a fraction of the height (x: of the width), then: full alpha
    // where the picture is, so the edges do not go see-through
    out.push({ tag: 'feGaussianBlur', attrs: { ...from(), stdDeviation: `${num(fx.blur * (1 / aspect))} ${num(fx.blur)}`, result: 'lk_blur0' } })
    out.push({ tag: 'feComponentTransfer', attrs: { in: 'lk_blur0', result: 'lk_blur1' }, children: [{ tag: 'feFuncA', attrs: { type: 'discrete', tableValues: '0 1 1 1 1 1 1 1 1 1' } }] })
    out.push({ tag: 'feComposite', attrs: { in: 'lk_blur1', in2: 'SourceAlpha', operator: 'in', result: 'lk_blur' } })
    last = 'lk_blur'
  }
  if (fx.vignette > 0) {
    out.push({ tag: 'feImage', attrs: { href: vignetteImage(fx.vignette, aspect), x: '0', y: '0', width: '1', height: '1', preserveAspectRatio: 'none', result: 'lk_vmask' } })
    out.push({ tag: 'feComposite', attrs: { ...from(), in2: 'lk_vmask', operator: 'arithmetic', k1: '1', k2: '0', k3: '0', k4: '0', result: 'lk_vig' } })
    last = 'lk_vig'
  }
  return out
}

// A data: SVG of the vignette mask: a circle around the centre reaching the
// corners, grey = cos(a * d)^4 in 16 steps (linear between them)
export function vignetteImage(angle, aspect = 9 / 16) {
  const W = 1000
  const H = Math.round(W / aspect)
  const r = Math.hypot(W, H) / 2
  const N = 16
  const stops = []
  for (let i = 0; i <= N; i++) {
    const g = Math.round(vignetteFactor(angle, i / N) * 255)
    stops.push(`<stop offset='${num(i / N)}' stop-color='rgb(${g},${g},${g})'/>`)
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}' preserveAspectRatio='none'>` +
    `<defs><radialGradient id='v' gradientUnits='userSpaceOnUse' cx='${W / 2}' cy='${H / 2}' r='${num(r)}'>${stops.join('')}</radialGradient></defs>` +
    `<rect width='${W}' height='${H}' fill='url(#v)'/></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
