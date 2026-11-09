import { cleanLayers, defaultLayers, DEFAULT_LINE, SIZES } from './audiogramPage.js'

/**
 * Audiogram: a short video of a piece of an episode for sharing (3Speak Shorts,
 * feeds, Reels) in the look of the 3Speak shorts. The still parts (background,
 * logo, cover, title, line) come from the page in services/audiogramPage.js,
 * the waveform moves between the layers under it and the ones over it.
 * Vertical (1080x1920, the one that can go out as a Short) or square
 * (1080x1080). MP4, H.264 + AAC, 30 fps, up to 2 minutes (the Shorts limit).
 *
 * The look (`style`) is the person's: the last one they made becomes their
 * audiogram template (routes/templates.js, kind "audiogram").
 */

export const AUDIOGRAM_MAX_SECONDS = 120
export const AUDIOGRAM_MIN_SECONDS = 3
const FPS = 30

export const AUDIOGRAM_FORMATS = SIZES
export const WAVE_TYPES = ['bars', 'centered', 'line', 'dots']
export const IMAGE_LAYOUTS = ['blur', 'fill']
export const MAX_LINE = 120

export const DEFAULT_STYLE = Object.freeze({
  format: 'vertical',
  duration: 30,
  wave: Object.freeze({ type: 'bars', color: '#e32933' }),
  background: Object.freeze({ image: null, imageLayout: 'blur' }),
  line: DEFAULT_LINE
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
 * `layouts` holds the arrangement per shape ({ vertical, square }: layers).
 */
export function cleanAudiogramStyle(input = {}) {
  const s = input && typeof input === 'object' ? input : {}
  const w = s.wave && typeof s.wave === 'object' ? s.wave : {}
  const b = s.background && typeof s.background === 'object' ? s.background : {}
  const d = DEFAULT_STYLE
  const duration = Number(s.duration)
  const image = cleanImageUrl(b.image)
  const layouts = {}
  for (const f of Object.keys(SIZES)) {
    layouts[f] = s.layouts?.[f] ? cleanLayers(s.layouts[f], f, !!image) : defaultLayers(f, !!image)
  }
  return {
    format: SIZES[s.format] ? s.format : d.format,
    duration: Number.isFinite(duration) ? Math.min(AUDIOGRAM_MAX_SECONDS, Math.max(AUDIOGRAM_MIN_SECONDS, Math.round(duration))) : d.duration,
    wave: { type: pick(w.type, WAVE_TYPES, d.wave.type), color: colour(w.color, d.wave.color) },
    background: { image, imageLayout: pick(b.imageLayout, IMAGE_LAYOUTS, d.background.imageLayout) },
    line: typeof s.line === 'string' ? s.line.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE) : d.line,
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
  const size = SIZES[format] || SIZES.vertical
  return {
    width: size.w,
    height: size.h,
    layers: style.layouts[format],
    title,
    line: style.line,
    image: image || null,
    imageLayout: style.background.imageLayout,
    wave: style.wave
  }
}

const hex = (c) => `0x${c.slice(1)}`

// The moving waveform of a type, w x h, in a colour, on transparent
export function waveFilter(type, w, h, color) {
  const c = hex(color)
  if (type === 'bars') {
    // Bars: a narrow centred waveform of the loudness, blown up without
    // smoothing, with a cut between the columns. (Each column averages its
    // samples, so their size, or plus and minus cancel out. showfreqs never
    // finishes on some builds.)
    const n = Math.max(12, Math.round(w / 24))
    const step = Math.max(4, Math.floor(w / n))
    return 'aeval=abs(val(0)):c=mono,aformat=sample_fmts=s16:channel_layouts=mono,' +
      `showwaves=s=${n}x${h}:mode=cline:rate=${FPS}:colors=${c}:scale=sqrt:draw=full,scale=${n * step}:${h}:flags=neighbor,` +
      `format=rgba,drawgrid=w=${step}:h=${h + 2}:t=${Math.max(2, Math.round(step / 4))}:c=0x000000@1,colorkey=0x000000:0.02:0,pad=${w}:${h}:(ow-iw)/2:0:color=0x00000000`
  }
  const mode = type === 'line' ? 'line' : type === 'dots' ? 'p2p' : 'cline'
  return `showwaves=s=${w}x${h}:mode=${mode}:rate=${FPS}:colors=${c}:scale=sqrt:draw=full,format=rgba`
}

/**
 * ffmpeg arguments: the audio from `start` for `duration` (input 0), the still
 * under the waveform (input 1), the waveform in `box` { x, y, w, h } (or none),
 * the still over it (input 2, transparent PNG, or none), faded in and out.
 */
export function audiogramArgs({ input, below, above = null, box, output, start, duration, style = DEFAULT_STYLE }) {
  const st = cleanAudiogramStyle(style)
  const fade = Math.min(0.5, duration / 4).toFixed(3)
  const out = (duration - +fade).toFixed(3)
  const parts = [`[1:v]fps=${FPS},format=yuv420p[bg]`]
  let v = 'bg'
  if (box) {
    parts.push(
      '[0:a]asplit=2[aw][ao]',
      `[aw]aformat=channel_layouts=mono,${waveFilter(st.wave.type, box.w, box.h, st.wave.color)}[wave]`,
      `[bg][wave]overlay=x=${box.x}:y=${box.y}:shortest=1[bw]`
    )
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
    '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-movflags', '+faststart', '-t', String(duration), '-y', output
  ]
}
