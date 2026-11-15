// Captions on audiograms: the auto captions' looks (utils/captions.js:
// karaoke, pop, subtitles) as one more part of the audiogram, a box the person
// moves and widens in the studio like the other parts. Shared by the studio's
// preview (src/) and the render (backend/src/), kept byte-identical in
// src/utils/ and backend/src/utils/ (tests/audiogramCaptions.test.js checks),
// so the video shows the lines, breaks and highlights the preview showed.
//
// look: { on, preset, font, size, color, highlight, uppercase, wordsPerPage, boxes: { [format]: { x, y, w } } }
//   size   font size, % of the video's height (as for Shorts captions)
//   box    where the caption block is: its left, top and width in pixels of the
//          video; its height is two lines of the font (captionBox)
// words (sent with each audiogram): [{ text, start, end }] seconds from the start of the piece.
// The captions are drawn over everything else, but never over the 3Speak
// logo: a box that would cover it is moved clear of it (clearOfLogo).

import { normalizeCaptions, normalizeCaptionStyle, captionEvents, CAPTION_FONTS } from './captions.js'

export const AUDIOGRAM_CAPTION_SIZE = { min: 2.5, max: 8 }
export const MAX_PIECE_WORDS = 1500
const MIN_W = 240
const GAP = 16 // px kept between the captions and the logo

export const DEFAULT_AUDIOGRAM_CAPTIONS = Object.freeze({
  on: false,
  preset: 'karaoke',
  font: 'Poppins',
  size: 4,
  color: '#ffffff',
  highlight: '#e32933',
  uppercase: true,
  wordsPerPage: 3,
  boxes: Object.freeze({})
})

const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d)

/** The caption block's height in px: two lines of the font at its size. */
export function captionBlockHeight(look, size) {
  const font = CAPTION_FONTS[look.font] || CAPTION_FONTS.Poppins
  return Math.round(2 * (look.size / 100) * size.h * font.line)
}

/** A first place for the captions: under the waveform when there is room above the Shorts buttons, else over its middle. */
export function defaultCaptionBox(layers, size, look = DEFAULT_AUDIOGRAM_CAPTIONS) {
  const h = captionBlockHeight(look, size)
  const wave = layers?.wave
  const w = Math.round(size.w - 160)
  const x = Math.round((size.w - w) / 2)
  if (!wave || wave.on === false) return { x, y: Math.round(size.h * 0.62), w }
  const below = wave.y + wave.h + 24
  if (below + h <= size.h * 0.85) return { x, y: Math.round(below), w }
  return { x, y: Math.round(wave.y + wave.h / 2 - h / 2), w }
}

/** A box kept usable: at least MIN_W wide, at least 100 px of it across the frame, its two lines inside the frame. */
export function clampCaptionBox(box, look, size) {
  const h = captionBlockHeight(look, size)
  const w = num(box?.w, MIN_W, size.w, size.w - 160)
  return {
    x: num(box?.x, -w + 100, size.w - 100, Math.round((size.w - w) / 2)),
    y: num(box?.y, 0, Math.max(0, size.h - h), Math.round(size.h * 0.62)),
    w
  }
}

/** The look as sent or saved, checked; anything missing or wrong is the default. */
export function cleanAudiogramCaptionLook(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  // words at a time: the preset's own default when none was chosen
  const style = normalizeCaptionStyle({ ...DEFAULT_AUDIOGRAM_CAPTIONS, ...s, wordsPerPage: s.wordsPerPage, emoji: false })
  const look = {
    on: s.on === true,
    preset: style.preset,
    font: style.font,
    size: Math.min(AUDIOGRAM_CAPTION_SIZE.max, Math.max(AUDIOGRAM_CAPTION_SIZE.min, Math.round(style.size * 10) / 10)),
    color: style.color,
    highlight: style.highlight,
    uppercase: style.uppercase,
    wordsPerPage: style.wordsPerPage,
    boxes: {}
  }
  const boxes = s.boxes && typeof s.boxes === 'object' ? s.boxes : {}
  for (const f of Object.keys(boxes).slice(0, 4)) {
    const b = boxes[f]
    if (/^[a-z]{1,20}$/.test(f) && b && typeof b === 'object') look.boxes[f] = { x: num(b.x, -4000, 4000, 0), y: num(b.y, -4000, 4000, 0), w: num(b.w, MIN_W, 4000, MIN_W) }
  }
  return look
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * The captions' box for a format: the one placed, else the first place,
 * inside the frame, and not over the logo (moved below it, or above it when
 * there is no room below). `layers`: the audiogram's parts (for the logo and
 * the waveform). Returns { x, y, w, h }.
 */
export function captionBox(look, format, size, layers) {
  const base = look.boxes?.[format] || defaultCaptionBox(layers, size, look)
  let box = { ...clampCaptionBox(base, look, size), h: captionBlockHeight(look, size) }
  const logo = layers?.logo
  if (logo && overlaps(box, logo)) {
    const below = logo.y + logo.h + GAP
    const above = logo.y - GAP - box.h
    const y = below + box.h <= size.h && (above < 0 || Math.abs(below - box.y) <= Math.abs(above - box.y)) ? below : Math.max(0, above)
    box = { ...box, y: Math.round(y) }
  }
  return box
}

/** The captions.js style for the look (its own size; position comes from the box). */
export const captionStyleOf = (look) => ({ preset: look.preset, font: look.font, size: look.size, color: look.color, highlight: look.highlight, uppercase: look.uppercase, wordsPerPage: look.wordsPerPage, emoji: false, y: 50 })

// captions.js breaks lines to 88 % of the frame width: a frame that makes that the box's width
const lineFrame = (box, size) => ({ width: box.w / 0.88, height: size.h })

/** The piece's words, cleaned and inside the piece (seconds from its start), as captions.js wants them. */
export function pieceCaptions(words, duration, language = null) {
  const list = (Array.isArray(words) ? words : []).slice(0, MAX_PIECE_WORDS).filter(w => w && +w.end > 0 && +w.start < duration)
    .map(w => ({ text: w.text, start: Math.max(0, +w.start), end: Math.min(duration, +w.end) }))
  return normalizeCaptions({ words: list, language })
}

/** What shows when, as captionEvents gives it, broken to the box's width. */
export function audiogramCaptionEvents(captions, look, box, size) {
  const c = normalizeCaptions(captions)
  if (!c) return []
  return captionEvents({ ...c, style: captionStyleOf(look) }, lineFrame(box, size))
}

// '#rrggbb' -> ASS colours (as in captions.js)
const bgr = (hex) => { const h = hex.replace('#', '').toUpperCase(); return `${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}` }
const assColor = (hex, alpha = 0) => `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${bgr(hex)}`
const tagColor = (hex) => `&H${bgr(hex)}&`
const assTime = (t) => {
  const cs = Math.max(0, Math.round(t * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}
const assText = (t) => t.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')')

/**
 * The captions as an ASS file for the audiogram (libass, ffmpeg's `ass`
 * filter): the same events as the preview, centred in the box. The metrics
 * are captions.js's (CAPTION_FONTS), so lines sit where the browser puts them.
 */
export function audiogramCaptionsAss(captions, look, box, size) {
  const font = CAPTION_FONTS[look.font] || CAPTION_FONTS.Poppins
  const fontPx = (look.size / 100) * size.h
  const plain = look.preset === 'plain'
  const assSize = Math.round(fontPx * font.line * 100) / 100
  const outline = plain ? Math.round(fontPx * 0.22) : Math.round(fontPx * 0.09 * 10) / 10
  const primary = assColor(look.color)
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${size.w}`,
    `PlayResY: ${size.h}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${look.font},${assSize},${primary},${primary},${plain ? assColor('#000000', 0x50) : assColor('#000000')},${assColor('#000000', 0x80)},${font.weight >= 700 ? -1 : 0},0,0,0,100,100,0,0,${plain ? 3 : 1},${outline},0,5,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  const x = Math.round(box.x + box.w / 2)
  const y = Math.round(box.y + box.h / 2 + font.shift * fontPx)
  const hl = tagColor(look.highlight)
  const normal = tagColor(look.color)
  const lines = audiogramCaptionEvents(captions, look, box, size).map(e => {
    const body = e.lines.map(line => line.map(w => (w.active ? `{\\c${hl}}${assText(w.text)}{\\c${normal}}` : assText(w.text))).join(' ')).join('\\N')
    const pop = e.pop ? '\\fscx70\\fscy70\\t(0,120,\\fscx100\\fscy100)' : ''
    return `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Cap,,0,0,0,,{\\an5\\pos(${x},${y})${pop}}${body}`
  })
  return [...head, ...lines].join('\n') + '\n'
}
