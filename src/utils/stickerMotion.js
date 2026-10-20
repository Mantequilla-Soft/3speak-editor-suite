// Motion of a sticker (image or text clip), shared by the preview, the browser
// export and the backend render. Kept byte-identical in src/utils/ and
// backend/src/utils/ (node scripts/check-static-mask-sync.mjs checks it).
//
// clip.motion: { effects: [{ type, speed, amount, direction }], pivotX, pivotY }
//   effects stack: shifts and turns add up, sizes and opacities multiply
//   type      loops:     'pulse' | 'wobble' | 'bob' | 'sway' | 'spin'
//             entrances: 'pop' (pop in) | 'slideIn' | 'fadeIn'
//             exits:     'popOut' | 'slideOut' | 'fadeOut'
//   speed     loops: cycles per second (spin: turns per second);
//             entrances / exits: how fast (1 = about half a second)
//   amount    0..100, how strong (spin and fades ignore it)
//   direction slides: 'left' | 'right' | 'top' | 'bottom' (where it comes
//             from / goes to)
//   hidden    true: kept (with its settings) but not applied anywhere, to
//             try things out
//   pivotX / pivotY  -1..1 across the sticker's own box (0 = centre, -1 =
//             left / top edge, 1 = right / bottom edge): what it turns and
//             scales around (see pivotPoint). Shifts do not depend on it.
// Time t = seconds since the clip starts on the timeline; exits run up to
// the clip's end (its length `duration`).
// Shifts are fractions of the frame HEIGHT (times the clip's zoom), so they
// look the same at any preview or output size.
// An older single-effect clip.motion { type, speed, amount } still works.

export const EFFECTS = [
  { id: 'pulse', label: 'Pulse', group: 'loop', amount: 'Amplitude' },
  { id: 'wobble', label: 'Wobble', group: 'loop', amount: 'Amplitude' },
  { id: 'bob', label: 'Bob', group: 'loop', amount: 'Amplitude' },
  { id: 'sway', label: 'Sway', group: 'loop', amount: 'Amplitude' },
  { id: 'spin', label: 'Spin', group: 'loop' },
  { id: 'pop', label: 'Pop in', group: 'in', amount: 'Bounce' },
  { id: 'slideIn', label: 'Slide in', group: 'in', amount: 'Distance', direction: true },
  { id: 'fadeIn', label: 'Fade in', group: 'in' },
  { id: 'popOut', label: 'Pop out', group: 'out', amount: 'Bounce' },
  { id: 'slideOut', label: 'Slide out', group: 'out', amount: 'Distance', direction: true },
  { id: 'fadeOut', label: 'Fade out', group: 'out' }
]
export const DIRECTIONS = ['left', 'right', 'top', 'bottom']
export const EFFECT_DEFAULTS = { speed: 1, amount: 50, direction: 'left' }
// Kept for code that knows the first version
export const MOTIONS = EFFECTS
export const MOTION_DEFAULTS = EFFECT_DEFAULTS

const PULSE = 0.25 // amount 100 = +-25% size
const WOBBLE = 25 // amount 100 = +-25 degrees
const SHIFT = 0.06 // amount 100 = +-6% of the frame height
const EDGE_TIME = 0.5 // seconds an entrance / exit takes at speed 1
const SLIDE_MIN = 0.2 // slide distance at amount 0 (frame heights) ...
const SLIDE_MAX = 1.0 // ... and at 100: from well outside the frame

const DIR = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function normalizeEffect(e) {
  if (!e || !EFFECTS.some(x => x.id === e.type)) return null
  return {
    type: e.type,
    speed: clamp(Number(e.speed) || EFFECT_DEFAULTS.speed, 0.1, 4),
    amount: clamp(Number(e.amount ?? EFFECT_DEFAULTS.amount), 0, 100),
    direction: DIR[e.direction] ? e.direction : EFFECT_DEFAULTS.direction,
    ...(e.hidden ? { hidden: true } : {})
  }
}

/** Effects that apply (not hidden) */
export const activeEffects = (motion) => (normalizeMotion(motion)?.effects || []).filter(e => !e.hidden)

/** { effects, pivotX, pivotY } or null when nothing moves */
export function normalizeMotion(m) {
  if (!m) return null
  const list = Array.isArray(m.effects) ? m.effects : (m.type ? [m] : [])
  const effects = list.map(normalizeEffect).filter(Boolean)
  if (!effects.length) return null
  return { effects, pivotX: clamp(Number(m.pivotX) || 0, -1, 1), pivotY: clamp(Number(m.pivotY) || 0, -1, 1) }
}

/**
 * The pivot in the same units as the sticker's centre: centre (cx, cy) plus
 * pivotX / pivotY times half the sticker's width / height.
 */
export function pivotPoint(motion, cx, cy, width, height) {
  const m = normalizeMotion(motion)
  if (!m) return { x: cx, y: cy }
  return { x: cx + (m.pivotX * width) / 2, y: cy + (m.pivotY * height) / 2 }
}

// Easing of entrances / exits, p = 0..1
const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3)
const easeInCubic = (p) => p * p * p
const backOut = (p, c1) => 1 + (c1 + 1) * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)

/** Combined { dx, dy } (frame heights), rot (degrees, clockwise), scale, opacity at t */
export function motionAt(motion, t, duration = Infinity) {
  const out = { dx: 0, dy: 0, rot: 0, scale: 1, opacity: 1 }
  const m = normalizeMotion(motion)
  if (!m) return out
  const tt = Math.max(0, t)
  const left = Math.max(0, duration - tt) // time to the clip's end
  for (const e of m.effects) {
    if (e.hidden) continue
    const a = e.amount / 100
    const wave = Math.sin(2 * Math.PI * e.speed * tt)
    const d = EDGE_TIME / e.speed
    const pIn = clamp(tt / d, 0, 1) // 0 -> 1 over the entrance
    const pOut = clamp(1 - left / d, 0, 1) // 0 -> 1 over the exit
    const c1 = 1.70158 * (a * 2) // overshoot, amount 50 = the classic back easing
    const dist = SLIDE_MIN + (SLIDE_MAX - SLIDE_MIN) * a
    const [ux, uy] = DIR[e.direction]
    if (e.type === 'pulse') out.scale *= 1 + PULSE * a * wave
    else if (e.type === 'wobble') out.rot += WOBBLE * a * wave
    else if (e.type === 'bob') out.dy += -SHIFT * a * wave
    else if (e.type === 'sway') out.dx += SHIFT * a * wave
    else if (e.type === 'spin') out.rot += 360 * e.speed * tt
    else if (e.type === 'pop') out.scale *= pIn >= 1 ? 1 : backOut(pIn, c1)
    else if (e.type === 'popOut') out.scale *= pOut <= 0 ? 1 : backOut(1 - pOut, c1)
    else if (e.type === 'slideIn') {
      const k = (1 - easeOutCubic(pIn)) * dist
      out.dx += ux * k
      out.dy += uy * k
    } else if (e.type === 'slideOut') {
      const k = easeInCubic(pOut) * dist
      out.dx += ux * k
      out.dy += uy * k
    } else if (e.type === 'fadeIn') out.opacity *= pIn
    else if (e.type === 'fadeOut') out.opacity *= 1 - pOut
  }
  return out
}

// The same formulas as ffmpeg expressions of T (seconds); values inlined
const num = (v) => Number(Number(v).toFixed(6))
function expressions(m, duration) {
  const dx = [], dy = [], rot = [], scale = []
  const fades = [] // ffmpeg fade filters (alpha)
  for (const e of m.effects) {
    if (e.hidden) continue
    const a = e.amount / 100
    const wave = `sin(2*PI*${num(e.speed)}*T)`
    const d = num(EDGE_TIME / e.speed)
    const pIn = `min(1,T/${d})`
    const pOut = `max(0,1-(${num(duration)}-T)/${d})`
    const c1 = num(1.70158 * a * 2)
    const back = (p) => `(1+${num(c1 + 1)}*pow(${p}-1,3)+${c1}*pow(${p}-1,2))`
    const dist = num(SLIDE_MIN + (SLIDE_MAX - SLIDE_MIN) * a)
    const [ux, uy] = DIR[e.direction]
    if (e.type === 'pulse') scale.push(`(1+${num(PULSE * a)}*${wave})`)
    else if (e.type === 'wobble') rot.push(`(${num(WOBBLE * a)}*${wave})`)
    else if (e.type === 'bob') dy.push(`(${num(-SHIFT * a)}*${wave})`)
    else if (e.type === 'sway') dx.push(`(${num(SHIFT * a)}*${wave})`)
    else if (e.type === 'spin') rot.push(`(${num(360 * e.speed)}*T)`)
    else if (e.type === 'pop') scale.push(`if(gte(T,${d}),1,${back(pIn)})`)
    else if (e.type === 'popOut') scale.push(`if(lte(${pOut},0),1,${back(`(1-${pOut})`)})`)
    else if (e.type === 'slideIn' || e.type === 'slideOut') {
      const k = e.type === 'slideIn' ? `((1-(1-pow(1-${pIn},3)))*${dist})` : `(pow(${pOut},3)*${dist})`
      if (ux) dx.push(`(${ux}*${k})`)
      if (uy) dy.push(`(${uy}*${k})`)
    } else if (e.type === 'fadeIn') fades.push(`fade=t=in:st=0:d=${d}:alpha=1`)
    else if (e.type === 'fadeOut') fades.push(`fade=t=out:st=${num(Math.max(0, duration - d))}:d=${d}:alpha=1`)
  }
  const sum = (xs) => (xs.length ? `(${xs.join('+')})` : '0')
  const product = (xs) => (xs.length ? `(${xs.join('*')})` : '1')
  return { dx: sum(dx), dy: sum(dy), rot: sum(rot), scale: product(scale), fades }
}

/**
 * ffmpeg filters that move a full-frame transparent layer (w x h) by the
 * sticker's motion around (cx, cy), the pivot in output pixels (pivotPoint):
 * one perspective filter (the frame's corners go where the shift / turn /
 * scale puts them, per frame; T = frame number `in` / fps), then any fades on
 * the alpha. '' when nothing moves.
 */
export function ffmpegMotionFilter(motion, { w, h, fps, cx, cy, zoom = 1, duration }) {
  const m = normalizeMotion(motion)
  // Nothing applies (no effects, or all hidden): the layer stays as it is
  if (!m || !m.effects.some(x => !x.hidden)) return ''
  const e = expressions(m, duration)
  const parts = ['format=rgba']
  const still = e.dx === '0' && e.dy === '0' && e.rot === '0' && e.scale === '1'
  if (!still) {
    const T = `(in/${num(fps)})`
    const sub = (s) => s.replace(/T/g, T)
    const S = sub(e.scale)
    const R = `(${sub(e.rot)}*PI/180)`
    const DX = `(${sub(e.dx)}*${num(h * zoom)})`
    const DY = `(${sub(e.dy)}*${num(h * zoom)})`
    const X = (x, y) => `${num(cx)}+${DX}+${S}*((${x}-${num(cx)})*cos(${R})-(${y}-${num(cy)})*sin(${R}))`
    const Y = (x, y) => `${num(cy)}+${DY}+${S}*((${x}-${num(cx)})*sin(${R})+(${y}-${num(cy)})*cos(${R}))`
    const corners = [[0, 0], [w, 0], [0, h], [w, h]]
    parts.push(`perspective=${corners.map(([x, y], i) => `x${i}='${X(x, y)}':y${i}='${Y(x, y)}'`).join(':')}:sense=destination:eval=frame:interpolation=linear`)
  }
  parts.push(...e.fades)
  return parts.join(',')
}

/**
 * Preview: { transform, opacity } at t. The transform is appended after the
 * clip's own (the element turns around its centre); `pivot` is the pivot's
 * offset from that centre: { x, y, unit } (unit 'px', or '%' of the element).
 */
export function motionStyle(motion, t, duration, frameHeightPx, pivot = null) {
  const v = motionAt(motion, t, duration)
  const shift = `translate(${(v.dx * frameHeightPx).toFixed(2)}px, ${(v.dy * frameHeightPx).toFixed(2)}px)`
  const turn = `rotate(${v.rot.toFixed(3)}deg) scale(${v.scale.toFixed(4)})`
  let transform = `${shift} ${turn}`
  if (pivot && (pivot.x || pivot.y)) {
    const u = pivot.unit || 'px'
    const f = (n) => Number(n.toFixed(3))
    transform = `${shift} translate(${f(pivot.x)}${u}, ${f(pivot.y)}${u}) ${turn} translate(${f(-pivot.x)}${u}, ${f(-pivot.y)}${u})`
  }
  return { transform, opacity: v.opacity }
}
