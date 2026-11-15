import fs from 'fs/promises'
import path from 'path'
import { pieceCaptions, captionBox, audiogramCaptionsAss } from '../utils/audiogramCaptions.js'
import { hasAssFilter } from './stt.js'

// Captions on an audiogram (utils/audiogramCaptions.js decides what shows
// where and when, the studio's preview draws the same): an ASS file burnt in
// with libass over the finished picture.

const FONTS_DIR = process.env.CAPTION_FONTS_DIR || '/usr/share/fonts/google'

const quoted = (p) => {
  if (/['\n]/.test(p)) throw new Error(`Unusable path for a filter: ${p}`)
  return `'${p}'`
}

/**
 * The words of the piece as captions, or null: the look is on and there are
 * words. `body` is the request's `captions` ({ words, language }).
 */
export function audiogramCaptionsOf(style, body, duration) {
  if (!style?.captions?.on || !body || typeof body !== 'object') return null
  return pieceCaptions(body.words, duration, typeof body.language === 'string' ? body.language : null)
}

/**
 * Writes the ASS file into jobDir and resolves the filter that draws it, or
 * null (no captions, or this ffmpeg has no libass: the audiogram is made
 * without them, and the log says so).
 */
export async function audiogramCaptionsFilter({ captions, style, format, size, layers, jobDir }) {
  if (!captions) return null
  if (!(await hasAssFilter())) {
    console.warn('[audiogram] this ffmpeg has no libass (ass filter): making the audiogram without captions')
    return null
  }
  const box = captionBox(style.captions, format, size, layers)
  const assPath = path.join(jobDir, 'captions.ass')
  await fs.writeFile(assPath, audiogramCaptionsAss(captions, style.captions, box, size), 'utf8')
  const fontsDir = await fs.access(FONTS_DIR).then(() => FONTS_DIR, () => null)
  return `ass=filename=${quoted(assPath)}${fontsDir ? `:fontsdir=${quoted(fontsDir)}` : ''}`
}
