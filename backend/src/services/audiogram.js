import { cleanLayers, defaultLayers, DEFAULT_LINE, SIZES, CIRCLE_SHAPES, IMAGE_LAYOUTS, LOGO_STYLES } from './audiogramPage.js'

/**
 * Audiogram: a short video of a piece of an episode for sharing (3Speak Shorts,
 * feeds, Reels) in the look of the 3Speak shorts. The still parts (background,
 * logo, cover, title, line) come from the page in services/audiogramPage.js,
 * the waveform moves between the layers under it and the ones over it.
 * Vertical (1080x1920, the shape of a Short). MP4, H.264 + AAC, 30 fps, up
 * to 2 minutes (the Shorts limit).
 *
 * The look (`style`) is the person's: the last one they made becomes their
 * audiogram template (routes/templates.js, kind "audiogram").
 */

export const AUDIOGRAM_MAX_SECONDS = 120
export const AUDIOGRAM_MIN_SECONDS = 3
const FPS = 30

export const AUDIOGRAM_FORMATS = SIZES
export const WAVE_TYPES = ['bars', 'centered', 'line', 'dots', 'circle', 'ring']
export const CIRCLE_WAVES = ['circle', 'ring']
export { IMAGE_LAYOUTS }
export const MAX_LINE = 120

export const DEFAULT_STYLE = Object.freeze({
  format: 'vertical',
  duration: 30,
  wave: Object.freeze({ type: 'bars', color: '#e32933' }),
  background: Object.freeze({ image: null, imageLayout: 'card' }),
  line: DEFAULT_LINE,
  logo: 'full'
})

const HEX = /^#[0-9a-f]{6}$/i
const UPLOAD_PATH = /^\/api\/upload\/files\/[A-Za-z0-9_.-]+$/

/**
 * A picture we may use: one of our uploads (its path, or its URL on a backend
 * over http(s)), or a picture on the web over https (a playlist cover). Else null.
 */
export function cleanImageUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 1000) return null
  try {
    const u = new URL(value, 'http://local')
    if (u.username || u.password) return null
    if (u.host === 'local') return UPLOAD_PATH.test(u.pathname) && !u.search ? u.pathname : null
    if (u.protocol === 'https:') return u.href
    if (u.protocol === 'http:' && UPLOAD_PATH.test(u.pathname)) return u.href
  } catch {}
  return null
}

/** Our own upload's path from a (possibly absolute) image URL, else null. */
export function uploadPathOf(url) {
  try {
    const u = new URL(url, 'http://local')
    return UPLOAD_PATH.test(u.pathname) ? u.pathname : null
  } catch {
    return null
  }
}

const pick = (v, list, fallback) => (list.includes(v) ? v : fallback)
const colour = (v, fallback) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback)

/**
 * The look, checked: anything missing or wrong falls back to the default.
 * `layouts` holds the arrangement per shape ({ vertical }: layers).
 */
export function cleanAudiogramStyle(input = {}) {
  const s = input && typeof input === 'object' ? input : {}
  const w = s.wave && typeof s.wave === 'object' ? s.wave : {}
  const b = s.background && typeof s.background === 'object' ? s.background : {}
  const d = DEFAULT_STYLE
  const duration = Number(s.duration)
  const image = cleanImageUrl(b.image)
  const logo = LOGO_STYLES[s.logo] ? s.logo : d.logo
  const layouts = {}
  for (const f of Object.keys(SIZES)) {
    layouts[f] = s.layouts?.[f] ? cleanLayers(s.layouts[f], f, !!image, logo) : defaultLayers(f, !!image, logo)
  }
  return {
    format: SIZES[s.format] ? s.format : d.format,
    duration: Number.isFinite(duration) ? Math.min(AUDIOGRAM_MAX_SECONDS, Math.max(AUDIOGRAM_MIN_SECONDS, Math.round(duration))) : d.duration,
    wave: { type: pick(w.type, WAVE_TYPES, d.wave.type), color: colour(w.color, d.wave.color) },
    background: { image, imageLayout: pick(b.imageLayout, IMAGE_LAYOUTS, d.background.imageLayout) },
    line: typeof s.line === 'string' ? s.line.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE) : d.line,
    logo,
    layouts
  }
}

/** Checked options: { start, duration, format, title, style } or an error message. */
export function cleanAudiogramOptions(body = {}) {
  const start = Number(body.start)
  const duration = Number(body.duration)
  const style = cleanAudiogramStyle(body.style)
  const format = SIZES[body.format] ? body.format : style.format
  if (!Number.isFinite(start) || start < 0) return { error: 'start must be 0 or more seconds' }
  if (!Number.isFinite(duration) || duration < AUDIOGRAM_MIN_SECONDS || duration > AUDIOGRAM_MAX_SECONDS) {
    return { error: `duration must be ${AUDIOGRAM_MIN_SECONDS} to ${AUDIOGRAM_MAX_SECONDS} seconds` }
  }
  const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return { start: Math.round(start * 1000) / 1000, duration: Math.round(duration * 1000) / 1000, format, title, style: { ...style, format } }
}

/** What the page draws (applyAudiogram's state), the picture as given (a data: URI by then). */
export function pageState({ format, title, style, image }) {
  const f = SIZES[format] ? format : 'vertical'
  return {
    width: SIZES[f].w,
    height: SIZES[f].h,
    layers: style.layouts[f],
    title,
    line: style.line,
    image: image || null,
    imageLayout: style.background.imageLayout,
    wave: style.wave,
    logo: style.logo
  }
}

const hex = (c) => `0x${c.slice(1)}`
const RING_STEP = 4 // px of radius per row of the ring's strip: the line's thickness

/**
 * A round waveform's band: radii in px for a circle `side` wide, the strip
 * ffmpeg draws it from (`cols` x `rows`), px of radius per strip row (`step`).
 */
export function circleGeometry(type, side) {
  const g = CIRCLE_SHAPES[type] || CIRCLE_SHAPES.circle
  const outer = Math.floor(side / 2)
  const inner = Math.round(outer * g.inner)
  const step = type === 'ring' ? RING_STEP : 1
  return { outer, inner, cols: g.cols, gap: g.gap, step, rows: Math.max(4, Math.floor((outer - inner) / step)) }
}

/**
 * The maps that bend the straight strip into the circle (ffmpeg remap): two
 * 16-bit PGM pictures, side x side, giving for each pixel the strip's column
 * and row (65535: nothing there, transparent). The strip goes once from the
 * top round to the bottom on each side (mirrored, so it closes without a
 * seam); row 0 is the outside.
 */
export function circleMaps(type, side) {
  const g = circleGeometry(type, side)
  const xs = Buffer.alloc(side * side * 2)
  const ys = Buffer.alloc(side * side * 2)
  const c = (side - 1) / 2
  for (let py = 0; py < side; py++) {
    for (let px = 0; px < side; px++) {
      const dx = px - c
      const dy = py - c
      const r = Math.hypot(dx, dy)
      let mx = 65535
      let my = 65535
      if (r >= g.inner && r < g.outer) {
        const th = Math.abs(Math.atan2(dx, -dy)) // 0 at the top, PI at the bottom, both sides
        const pos = (th / Math.PI) * g.cols
        const col = Math.min(g.cols - 1, Math.floor(pos))
        const f = pos - col
        if (!g.gap || (f >= g.gap / 2 && f <= 1 - g.gap / 2)) {
          mx = col
          my = Math.min(g.rows - 1, Math.floor((g.outer - r) / g.step))
        }
      }
      const i = (py * side + px) * 2
      xs.writeUInt16BE(mx, i)
      ys.writeUInt16BE(my, i)
    }
  }
  const head = Buffer.from(`P5\n${side} ${side}\n65535\n`)
  return { x: Buffer.concat([head, xs]), y: Buffer.concat([head, ys]) }
}

// The loudness, as plus only (each column of showwaves averages its samples, so
// plus and minus would cancel out)
const LOUDNESS = 'aeval=abs(val(0)):c=mono,aformat=sample_fmts=s16:channel_layouts=mono'

/**
 * The moving waveform of a type, w x h, in a colour, on transparent. For the
 * round ones (w = h = the circle) this is the straight strip that circleMaps
 * bends round.
 */
export function waveFilter(type, w, h, color) {
  const c = hex(color)
  if (type === 'circle') {
    // bars standing out from the inner ring: the top half of centred bars
    const g = circleGeometry(type, w)
    return `${LOUDNESS},showwaves=s=${g.cols}x${g.rows * 2}:mode=cline:rate=${FPS}:colors=${c}:scale=sqrt:draw=full,crop=${g.cols}:${g.rows}:0:0,format=rgba`
  }
  if (type === 'ring') {
    const g = circleGeometry(type, w)
    // a wavy line: the sound without its highs, so it swings instead of buzzing
    return `lowpass=f=420,lowpass=f=420,showwaves=s=${g.cols}x${g.rows}:mode=p2p:rate=${FPS}:colors=${c}:scale=sqrt:draw=full,format=rgba`
  }
  if (type === 'bars') {
    // Bars: a narrow centred waveform of the loudness, blown up without
    // smoothing, with a cut between the columns. (showfreqs never finishes on
    // some builds.)
    const n = Math.max(12, Math.round(w / 24))
    const step = Math.max(4, Math.floor(w / n))
    return `${LOUDNESS},` +
      `showwaves=s=${n}x${h}:mode=cline:rate=${FPS}:colors=${c}:scale=sqrt:draw=full,scale=${n * step}:${h}:flags=neighbor,` +
      `format=rgba,drawgrid=w=${step}:h=${h + 2}:t=${Math.max(2, Math.round(step / 4))}:c=0x000000@1,colorkey=0x000000:0.02:0,pad=${w}:${h}:(ow-iw)/2:0:color=0x00000000`
  }
  const mode = type === 'line' ? 'line' : type === 'dots' ? 'p2p' : 'cline'
  return `showwaves=s=${w}x${h}:mode=${mode}:rate=${FPS}:colors=${c}:scale=sqrt:draw=full,format=rgba`
}

/**
 * ffmpeg arguments: the audio from `start` for `duration` (input 0), the still
 * under the waveform (input 1), the waveform at `box` { cx, cy, w, h, r } (its
 * middle, size, degrees; or none), the still over it (input 2, transparent
 * PNG, or none), faded in and out. A round waveform needs `maps` { x, y }
 * (files of circleMaps).
 */
export function audiogramArgs({ input, below, above = null, box, maps = null, output, start, duration, style = DEFAULT_STYLE }) {
  const st = cleanAudiogramStyle(style)
  const fade = Math.min(0.5, duration / 4).toFixed(3)
  const out = (duration - +fade).toFixed(3)
  const round = CIRCLE_WAVES.includes(st.wave.type)
  const mapsIn = 2 + (above ? 1 : 0)
  const parts = [`[1:v]fps=${FPS},format=yuv420p[bg]`]
  let v = 'bg'
  if (box && (!round || maps)) {
    parts.push('[0:a]asplit=2[aw][ao]')
    if (round) {
      parts.push(
        `[aw]aformat=channel_layouts=mono,${waveFilter(st.wave.type, box.w, box.h, st.wave.color)}[strip]`,
        `[strip][${mapsIn}:v][${mapsIn + 1}:v]remap=fill=black@0,format=rgba[w0]`
      )
    } else {
      parts.push(`[aw]aformat=channel_layouts=mono,${waveFilter(st.wave.type, box.w, box.h, st.wave.color)}[w0]`)
    }
    let w = 'w0'
    if (box.r) {
      const a = ((box.r * Math.PI) / 180).toFixed(5)
      parts.push(`[w0]rotate=a=${a}:ow=rotw(${a}):oh=roth(${a}):c=none[w1]`)
      w = 'w1'
    }
    parts.push(`[bg][${w}]overlay=x=${box.cx}-overlay_w/2:y=${box.cy}-overlay_h/2:shortest=1[bw]`)
    v = 'bw'
  } else {
    parts.push('[0:a]anull[ao]')
  }
  if (above) {
    parts.push(`[2:v]fps=${FPS},format=rgba[top]`, `[${v}][top]overlay=x=0:y=0:shortest=1[bt]`)
    v = 'bt'
  }
  parts.push(
    `[${v}]fade=t=in:st=0:d=${fade},fade=t=out:st=${out}:d=${fade},format=yuv420p[v]`,
    `[ao]afade=t=in:st=0:d=${fade},afade=t=out:st=${out}:d=${fade}[a]`
  )
  const still = (file) => ['-loop', '1', '-framerate', String(FPS), '-t', String(duration), '-i', file]
  return [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(start), '-t', String(duration), '-i', input,
    ...still(below),
    ...(above ? still(above) : []),
    ...(box && round && maps ? ['-i', maps.x, '-i', maps.y] : []),
    '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-movflags', '+faststart', '-t', String(duration), '-y', output
  ]
}
