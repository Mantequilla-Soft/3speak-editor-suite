// Text clips: an outline (stroke) and word by word entrances. Shared by the
// preview (components/TextFx.jsx, CSS) and the backend render (drawtext per
// word), kept byte-identical in src/utils/textAnim.js and
// backend/src/utils/textAnim.js (scripts/check-static-mask-sync.mjs).
//
// clip.textStroke = { color, width }: width in preview pixels (like fontSize),
//   drawn outside the letters (CSS: a stroke twice as wide under the fill;
//   ffmpeg: drawtext's border).
// clip.textAnim = { type, stagger, duration }: each word comes in `stagger`
//   seconds after the one before, its entrance lasting `duration`.
//   pop: grows in with a little overshoot; fadeUp: fades in rising a little;
//   typewriter: appears at once; slide: fades in from the left.

export const TEXT_ANIMS = [
  { id: 'pop', label: 'Pop' },
  { id: 'fadeUp', label: 'Fade up' },
  { id: 'typewriter', label: 'Typewriter' },
  { id: 'slide', label: 'Slide' }
]
const ANIM_IDS = new Set(TEXT_ANIMS.map(a => a.id))
export const STAGGER_RANGE = [0.03, 0.6]
export const STROKE_MAX = 12
const DEFAULTS = { stagger: 0.12, duration: 0.35 }
const RISE = 0.5 // fadeUp: starts this many em lower
const SLIDE = 0.6 // slide: starts this many em to the left
const POP_FROM = 0.4, POP_PEAK = 1.12, POP_PEAK_AT = 0.6

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const r3 = (v) => Math.round(v * 1000) / 1000
const HEX = /^#[0-9a-fA-F]{6}$/

export function normalizeTextStroke(s) {
  if (!s || typeof s !== 'object') return null
  const width = r3(clamp(Number(s.width) || 0, 0, STROKE_MAX))
  if (!width) return null
  return { color: HEX.test(s.color) ? s.color.toLowerCase() : '#000000', width }
}

export function normalizeTextAnim(a) {
  if (!a || typeof a !== 'object' || !ANIM_IDS.has(a.type)) return null
  const n = (v, d, lo, hi) => r3(clamp(Number.isFinite(+v) && v !== null && v !== '' ? +v : d, lo, hi))
  return {
    type: a.type,
    stagger: n(a.stagger, DEFAULTS.stagger, STAGGER_RANGE[0], STAGGER_RANGE[1]),
    duration: a.type === 'typewriter' ? 0 : n(a.duration, DEFAULTS.duration, 0.1, 1)
  }
}

// The words of a text in reading order (whitespace dropped)
export const splitWords = (text) => String(text || '').split(/\s+/).filter(Boolean)

const easeOut = (p) => 1 - Math.pow(1 - p, 3)

/**
 * Word i at t seconds into the clip: { opacity, dx, dy (em), scale }.
 */
export function wordState(anim, i, t) {
  const a = normalizeTextAnim(anim)
  if (!a) return { opacity: 1, dx: 0, dy: 0, scale: 1 }
  const start = i * a.stagger
  if (a.type === 'typewriter') return { opacity: t >= start ? 1 : 0, dx: 0, dy: 0, scale: 1 }
  const p = clamp((t - start) / a.duration, 0, 1)
  if (a.type === 'pop') {
    const scale = p < POP_PEAK_AT ? POP_FROM + (POP_PEAK - POP_FROM) * (p / POP_PEAK_AT) : POP_PEAK - (POP_PEAK - 1) * ((p - POP_PEAK_AT) / (1 - POP_PEAK_AT))
    return { opacity: clamp(p / 0.3, 0, 1), dx: 0, dy: 0, scale }
  }
  const e = easeOut(p)
  if (a.type === 'fadeUp') return { opacity: p, dx: 0, dy: RISE * (1 - e), scale: 1 }
  return { opacity: p, dx: -SLIDE * (1 - e), dy: 0, scale: 1 }
}

// When the last word has fully arrived (seconds into the clip)
export function animEnd(anim, words) {
  const a = normalizeTextAnim(anim)
  return a ? Math.max(0, words - 1) * a.stagger + a.duration : 0
}

const n = (v) => Number(Number(v).toFixed(4))

/**
 * The same as ffmpeg expressions of t (seconds into the clip) for word i:
 * { alpha, dx, dy, scale } (dx / dy in em, scale a factor), for drawtext.
 */
export function ffmpegWordExprs(anim, i) {
  const a = normalizeTextAnim(anim)
  if (!a) return { alpha: '1', dx: '0', dy: '0', scale: '1' }
  const start = n(i * a.stagger)
  if (a.type === 'typewriter') return { alpha: `gte(t,${start})`, dx: '0', dy: '0', scale: '1' }
  const P = `min(1,max(0,(t-${start})/${n(a.duration)}))`
  const E = `(1-pow(1-${P},3))`
  if (a.type === 'pop') {
    const up = `${POP_FROM}+${n(POP_PEAK - POP_FROM)}*${P}/${POP_PEAK_AT}`
    const down = `${POP_PEAK}-${n(POP_PEAK - 1)}*(${P}-${POP_PEAK_AT})/${n(1 - POP_PEAK_AT)}`
    return { alpha: `min(1,${P}/0.3)`, dx: '0', dy: '0', scale: `if(lt(${P},${POP_PEAK_AT}),${up},${down})` }
  }
  if (a.type === 'fadeUp') return { alpha: P, dx: '0', dy: `${RISE}*(1-${E})`, scale: '1' }
  return { alpha: P, dx: `-${SLIDE}*(1-${E})`, dy: '0', scale: '1' }
}
