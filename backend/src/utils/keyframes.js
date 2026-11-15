// Keyframes: a clip's position, scale, rotation, opacity and volume changing
// over time. Shared by the preview and the backend render, kept byte-identical
// in src/utils/ and backend/src/utils/ (node scripts/check-static-mask-sync.mjs
// checks it), so both draw the same frame at the same moment.
//
// clip.keyframes: { x?, y?, scale?, rotation?, opacity?, volume?: [{ t, v, ease?, tag? }] }
//   t     clip time (the axis of startTime / endTime, see clipSpeed.js), so a
//         keyframe stays on its moment of the media when the clip is trimmed,
//         split or sped up
//   v     the value at t, in the clip's own units: x / y = positionX / positionY
//         (preview pixels), scale = zoom (%), rotation (degrees), opacity (%),
//         volume (%)
//   ease  'linear' (default) or 'ease' (eases in and out): how it moves on to
//         the NEXT keyframe
//   tag   who made it ('punch' = automatic punch-ins, 'kenburns'), so a preset
//         can be taken off again; otherwise an ordinary keyframe
// Before its first keyframe a property holds the first value, after the last
// the last one. A property with keyframes ignores the clip's own value.
//
// How it is drawn: the clip is laid out as usual from its REFERENCE values
// (keyframeBase: an animated position / rotation at 0, scale at its smallest
// keyframe, opacity and volume at 100), and that whole layer is then moved,
// turned and scaled around a pivot (the clip's centre; text: its box) by the
// difference to the values at that moment (relativeAt). The preview does it
// with a CSS transform, the render with ffmpeg's perspective filter.

export const KEYFRAME_PROPS = [
  { id: 'x', field: 'positionX', def: 0, label: 'Position X', unit: 'px', min: -1000, max: 1000, step: 1 },
  { id: 'y', field: 'positionY', def: 0, label: 'Position Y', unit: 'px', min: -1000, max: 1000, step: 1 },
  { id: 'scale', field: 'zoom', def: 100, label: 'Scale', unit: '%', min: 11, max: 500, step: 1 }, // the render reads a zoom of 10 or less as a factor
  { id: 'rotation', field: 'rotation', def: 0, label: 'Rotation', unit: '°', min: -360, max: 360, step: 1 },
  { id: 'opacity', field: 'opacity', def: 100, label: 'Opacity', unit: '%', min: 0, max: 100, step: 1 },
  { id: 'volume', field: 'volume', def: 100, label: 'Volume', unit: '%', min: 0, max: 200, step: 1 }
]
export const VISUAL_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity']
const PROP = Object.fromEntries(KEYFRAME_PROPS.map(p => [p.id, p]))
export const MAX_KEYFRAMES = 400 // per property

const fin = (v) => typeof v === 'number' && Number.isFinite(v)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const round = (v, d = 4) => Number(v.toFixed(d))

/** Which properties a clip of this type can animate */
export function propsFor(type) {
  if (type === 'audio') return ['volume']
  if (type === 'video') return [...VISUAL_PROPS, 'volume']
  if (type === 'image' || type === 'text') return VISUAL_PROPS
  return []
}

function normalizeList(prop, list) {
  if (!Array.isArray(list)) return []
  const p = PROP[prop]
  const out = []
  for (const k of list) {
    if (!k || !fin(+k.t) || !fin(+k.v)) continue
    const item = { t: round(+k.t), v: round(clamp(+k.v, p.min, p.max), 3) }
    if (k.ease === 'ease') item.ease = 'ease'
    if (typeof k.tag === 'string' && /^[a-z]{1,16}$/.test(k.tag)) item.tag = k.tag
    out.push(item)
  }
  out.sort((a, b) => a.t - b.t)
  // One keyframe per moment (the later one in the list wins)
  const dedup = []
  for (const k of out) {
    if (dedup.length && Math.abs(dedup[dedup.length - 1].t - k.t) < 1e-4) dedup[dedup.length - 1] = k
    else dedup.push(k)
  }
  return dedup.slice(0, MAX_KEYFRAMES)
}

// Clips are read many times a frame; their keyframes object does not change
// in place (edits make a new one), so its cleaned form is kept. Callers must
// not change what they get back.
const cleaned = new WeakMap()

/** { prop: [...] } with only valid, sorted keyframes, or null when there are none */
export function normalizeKeyframes(kf) {
  if (!kf || typeof kf !== 'object') return null
  if (cleaned.has(kf)) return cleaned.get(kf)
  const out = {}
  for (const p of KEYFRAME_PROPS) {
    const list = normalizeList(p.id, kf[p.id])
    if (list.length) out[p.id] = list
  }
  const result = Object.keys(out).length ? out : null
  cleaned.set(kf, result)
  return result
}

/** The keyframes of one property ([] when it is not animated) */
export const keyframesOf = (clip, prop) => normalizeKeyframes(clip?.keyframes)?.[prop] || []
export const isAnimated = (clip, prop) => keyframesOf(clip, prop).length > 0
export const hasVisualKeyframes = (clip) => VISUAL_PROPS.some(p => isAnimated(clip, p))
export const hasVolumeKeyframes = (clip) => isAnimated(clip, 'volume')

/** The clip's own (static) value of a property */
export function staticValue(clip, prop) {
  const p = PROP[prop]
  const v = clip?.[p.field]
  if (prop === 'scale') return fin(+v) && +v > 0 ? +v : 100
  if (prop === 'opacity' || prop === 'volume') return v === undefined || v === null || !fin(+v) ? 100 : +v
  return fin(+v) ? +v : 0
}

// Ease in and out (cubic), p = 0..1
export const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(2 - 2 * p, 3) / 2)

/** Value of a keyframe list at clip time t */
export function valueAt(list, t) {
  if (!list.length) return undefined
  if (t <= list[0].t) return list[0].v
  const last = list[list.length - 1]
  if (t >= last.t) return last.v
  let i = 0
  while (i + 1 < list.length && list[i + 1].t <= t) i++
  const a = list[i], b = list[i + 1]
  const p = (t - a.t) / (b.t - a.t)
  return a.v + (b.v - a.v) * (a.ease === 'ease' ? easeInOut(p) : p)
}

/** A property's value at clip time t (keyframes, else the clip's own value) */
export function propAt(clip, prop, t) {
  const list = keyframesOf(clip, prop)
  return list.length ? valueAt(list, t) : staticValue(clip, prop)
}

/**
 * The clip with the reference values it is laid out from (see the top):
 * the same object when nothing is animated.
 */
export function keyframeBase(clip) {
  const kf = normalizeKeyframes(clip?.keyframes)
  if (!kf) return clip
  const base = { ...clip }
  if (kf.x) base.positionX = 0
  if (kf.y) base.positionY = 0
  if (kf.rotation) base.rotation = 0
  if (kf.scale) base.zoom = Math.min(...kf.scale.map(k => k.v))
  if (kf.opacity) base.opacity = 100
  if (kf.volume) base.volume = 100
  return base
}

/**
 * How the reference layer is moved at clip time t: { dx, dy } (output pixels:
 * preview pixels times `s`), rot (degrees, clockwise), k (scale factor),
 * opacity (0..1 multiplier), gain (0..2 multiplier of the sound).
 */
export function relativeAt(clip, t, s = 1) {
  const base = keyframeBase(clip)
  const zr = staticValue(base, 'scale') / 100
  const z = propAt(clip, 'scale', t) / 100
  const x = propAt(clip, 'x', t), y = propAt(clip, 'y', t)
  return {
    dx: (z * x - zr * staticValue(base, 'x')) * s,
    dy: (z * y - zr * staticValue(base, 'y')) * s,
    rot: propAt(clip, 'rotation', t) - staticValue(base, 'rotation'),
    k: z / zr,
    opacity: isAnimated(clip, 'opacity') ? clamp(propAt(clip, 'opacity', t) / 100, 0, 1) : 1,
    gain: isAnimated(clip, 'volume') ? Math.max(0, propAt(clip, 'volume', t) / 100) : 1
  }
}

/**
 * The pivot of a video or image layer (its centre on the frame): output
 * pixels for a w x h frame, positions scaled by s (preview -> output).
 */
export function layerPivot(clip, w, h, s = 1) {
  const base = keyframeBase(clip)
  const zr = staticValue(base, 'scale') / 100
  return { x: w / 2 + zr * staticValue(base, 'x') * s, y: h / 2 + zr * staticValue(base, 'y') * s }
}

/**
 * Preview: the CSS transform to put IN FRONT of a layer's own transform at
 * clip time t. `pivot` = the pivot's offset (px) from the element's transform
 * origin. '' when nothing visual is animated.
 */
export function cssKeyframeTransform(clip, t, pivot = { x: 0, y: 0 }, s = 1) {
  if (!hasVisualKeyframes(clip)) return ''
  const r = relativeAt(clip, t, s)
  const f = (n) => Number(n.toFixed(3))
  return `translate(${f(pivot.x + r.dx)}px, ${f(pivot.y + r.dy)}px) rotate(${f(r.rot)}deg) scale(${Number(r.k.toFixed(5))}) translate(${f(-pivot.x)}px, ${f(-pivot.y)}px)`
}

// ffmpeg ----------------------------------------------------------------------
const num = (v) => Number(Number(v).toFixed(6))

/**
 * A keyframe list as an ffmpeg expression of clip time C: a sum of segments,
 * each switched on only between its two keyframes (ffmpeg's parser refuses
 * nesting deeper than about a hundred, so no chain of ifs).
 */
export function listExpr(list, C) {
  const first = list[0], last = list[list.length - 1]
  const terms = [`lte(${C},${num(first.t)})*${num(first.v)}`]
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i], b = list[i + 1]
    const p = `((${C}-${num(a.t)})/${num(b.t - a.t)})`
    const e = a.ease === 'ease' ? `if(lt(${p},0.5),4*pow(${p},3),1-pow(2-2*${p},3)/2)` : p
    const seg = b.v === a.v ? `${num(a.v)}` : `(${num(a.v)}+${num(b.v - a.v)}*${e})`
    terms.push(`gt(${C},${num(a.t)})*lte(${C},${num(b.t)})*${seg}`)
  }
  terms.push(`gt(${C},${num(last.t)})*${num(last.v)}`)
  return terms.join('+')
}

const propExpr = (clip, prop, C) => {
  const list = keyframesOf(clip, prop)
  return list.length ? `(${listExpr(list, C)})` : `${num(staticValue(clip, prop))}`
}

/**
 * ffmpeg filter that moves a full-frame w x h layer (rgba) by the clip's
 * keyframes around (cx, cy), its pivot in output pixels: one perspective filter
 * with per-frame corners ((`in` - 1) / fps = seconds since the clip starts).
 * Positions are scaled by s (preview -> output). '' when only the opacity (or
 * nothing visual) is animated.
 */
export function ffmpegKeyframeTransform(clip, { w, h, fps, cx, cy, s = 1 }) {
  if (!['x', 'y', 'scale', 'rotation'].some(p => isAnimated(clip, p))) return ''
  const base = keyframeBase(clip)
  const zr = staticValue(base, 'scale') / 100
  const xr = staticValue(base, 'x'), yr = staticValue(base, 'y'), rr = staticValue(base, 'rotation')
  // perspective counts frames from 1 (`in` is 1 on the first frame)
  const C = `(${num(clip.startTime || 0)}+(in-1)/${num(fps)})`
  // Each corner expression computes the values once (st/ld are per expression)
  const head = [
    `st(1,${propExpr(clip, 'scale', C)}/100)`,
    `st(2,(ld(1)*${propExpr(clip, 'x', C)}-${num(zr * xr)})*${num(s)})`,
    `st(3,(ld(1)*${propExpr(clip, 'y', C)}-${num(zr * yr)})*${num(s)})`,
    `st(4,(${propExpr(clip, 'rotation', C)}-${num(rr)})*PI/180)`,
    `st(5,ld(1)/${num(zr)})`
  ].join(';')
  const X = (x, y) => `${head};${num(cx)}+ld(2)+ld(5)*((${num(x - cx)})*cos(ld(4))-(${num(y - cy)})*sin(ld(4)))`
  const Y = (x, y) => `${head};${num(cy)}+ld(3)+ld(5)*((${num(x - cx)})*sin(ld(4))+(${num(y - cy)})*cos(ld(4)))`
  const corners = [[0, 0], [w, 0], [0, h], [w, h]]
  return `format=rgba,perspective=${corners.map(([x, y], i) => `x${i}='${X(x, y)}':y${i}='${Y(x, y)}'`).join(':')}:sense=destination:eval=frame:interpolation=linear`
}

/**
 * Filtergraph pieces that multiply a w x h rgba layer's alpha by the animated
 * opacity: a tiny grey clip carries the opacity per frame (geq on 2x2 pixels,
 * cheap), stretched to the frame and multiplied into the alpha. `inLabel` and
 * `outLabel` are pad names without brackets, `tag` keeps the labels unique.
 * [] when the opacity is not animated.
 */
export function ffmpegOpacityGraph(clip, { w, h, fps, duration, inLabel, outLabel, tag }) {
  if (!isAnimated(clip, 'opacity')) return []
  const C = `(${num(clip.startTime || 0)}+N/${num(fps)})`
  const op = `clip(${propExpr(clip, 'opacity', C)}/100,0,1)`
  return [
    `color=c=white:s=2x2:r=${num(fps)}:d=${num(duration + 1)},format=gray,geq=lum='255*${op}',scale=${w}:${h}:flags=neighbor[kop${tag}]`,
    `[${inLabel}]format=rgba,split[kl${tag}][km${tag}]`,
    `[kl${tag}]alphaextract[ka${tag}]`,
    `[ka${tag}][kop${tag}]blend=all_mode=multiply:shortest=1[kb${tag}]`,
    `[km${tag}][kb${tag}]alphamerge[${outLabel}]`
  ]
}

/** ffmpeg volume filter for animated volume (t = seconds since the clip starts), '' when not animated */
export function ffmpegVolumeFilter(clip) {
  if (!isAnimated(clip, 'volume')) return ''
  const C = `(${num(clip.startTime || 0)}+t)`
  return `volume=eval=frame:volume='max(0,${propExpr(clip, 'volume', C)}/100)'`
}
