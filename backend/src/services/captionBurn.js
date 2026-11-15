import fs from 'fs/promises'
import path from 'path'
import { normalizeCaptions, buildAss, emojiOverlays, toVtt, toSrt, subtitleCues } from '../utils/captions.js'
import { hasAssFilter } from './stt.js'

// Auto captions in a render (utils/captions.js decides what shows when; the
// preview draws the same): burnt into the picture with libass (ffmpeg's `ass`
// filter, the fonts the editor uses), emoji accents as image overlays, and the
// words as WebVTT / SRT files next to the video for 3Speak.

const FONTS_DIR = process.env.CAPTION_FONTS_DIR || '/usr/share/fonts/google'
const MAX_EMOJIS = 16 // different emojis in one render
const MAX_EMOJI_OVERLAYS = 80
const EMOJI_CP = /^[0-9a-f]{4,5}$/

export const emojiKey = (cp) => `__emoji_${cp}`

// A path inside a quoted filter option: no quotes, so nothing can break out
const quoted = (p) => {
  if (/['\n]/.test(p)) throw new Error(`Unusable path for a filter: ${p}`)
  return `'${p}'`
}

/** Burnt-in captions of a timeline, or null (none, burn switched off, an audio render). */
export function burnCaptionsOf(timeline) {
  if (!timeline || timeline.output === 'audio') return null
  const c = normalizeCaptions(timeline.captions)
  return c && timeline.captions.burn !== false ? c : null
}

/** The emoji images a render needs: [{ cp, url }] from timeline.captions.emojiUrls, only the ones on screen. */
export function emojiDownloads(timeline) {
  const c = burnCaptionsOf(timeline)
  const urls = timeline?.captions?.emojiUrls
  if (!c || !c.style.emoji || !urls || typeof urls !== 'object') return []
  const frame = { width: timeline.outputWidth || 854, height: timeline.outputHeight || 480 }
  const used = [...new Set(emojiOverlays(c, frame).map(o => o.emoji))].slice(0, MAX_EMOJIS)
  return used
    .filter(cp => EMOJI_CP.test(cp) && typeof urls[cp] === 'string' && /^(https?:\/\/|\/)/.test(urls[cp]))
    .map(cp => ({ cp, url: urls[cp] }))
}

/**
 * The extra inputs and filters that draw the captions over the composite.
 * `firstInput` = index the first emoji image gets. Resolves null when there is
 * nothing to burn (or this ffmpeg has no libass: then the render goes on
 * without, and says so in the log).
 * Returns { inputArgs, filters(inLabel, outLabel) -> [filter strings] }.
 */
export async function captionBurn(timeline, frame, jobDir, downloadedFiles, firstInput) {
  const c = burnCaptionsOf(timeline)
  if (!c) return null
  if (!(await hasAssFilter())) {
    console.warn('[captions] this ffmpeg has no libass (ass filter): rendering without burnt-in captions')
    return null
  }
  const assPath = path.join(jobDir, 'captions.ass')
  await fs.writeFile(assPath, buildAss(c, frame), 'utf8')
  const fontsDir = await fs.access(FONTS_DIR).then(() => FONTS_DIR, () => null)

  const overlays = emojiOverlays(c, frame).slice(0, MAX_EMOJI_OVERLAYS)
  const images = [...new Set(overlays.map(o => o.emoji))].filter(cp => downloadedFiles.has(emojiKey(cp)))
  const inputArgs = images.flatMap(cp => ['-loop', '1', '-i', downloadedFiles.get(emojiKey(cp))])

  const filters = (inLabel, outLabel) => {
    const parts = [`[${inLabel}]ass=filename=${quoted(assPath)}${fontsDir ? `:fontsdir=${quoted(fontsDir)}` : ''}[cap0]`]
    const uses = images.map(cp => overlays.filter(o => o.emoji === cp))
    const steps = uses.reduce((n, u) => n + u.length, 0)
    if (!steps) {
      parts[0] = parts[0].replace(/\[cap0\]$/, `[${outLabel}]`)
      return parts
    }
    images.forEach((cp, k) => {
      const list = uses[k]
      const labels = list.map((_, j) => `[em${k}_${j}]`).join('')
      parts.push(`[${firstInput + k}:v]scale=${list[0].size}:${list[0].size},format=rgba${list.length > 1 ? `,split=${list.length}` : ''}${labels}`)
    })
    let prev = 'cap0'
    let n = 0
    images.forEach((cp, k) => {
      uses[k].forEach((o, j) => {
        n++
        const out = n === steps ? outLabel : `cap${n}`
        parts.push(`[${prev}][em${k}_${j}]overlay=${o.x}:${o.y}:enable='between(t,${o.start},${o.end})':eof_action=pass:format=auto[${out}]`)
        prev = out
      })
    })
    return parts
  }
  return { inputArgs, filters }
}

/**
 * The captions' words as subtitle files in `dir` (<name>.vtt, <name>.srt), for
 * any video render with captions (burnt in or not). Resolves
 * { language, vtt, srt, cues, burnedIn } (file names) or null. `burnedIn`: the
 * words are also in the picture (burn on and this ffmpeg can draw them), so
 * 3Speak keeps its own CC off for them by default.
 */
export async function writeSubtitleFiles(timeline, dir, name) {
  if (!timeline || timeline.output === 'audio') return null
  const c = normalizeCaptions(timeline.captions)
  if (!c) return null
  const vtt = `${name}.vtt`
  const srt = `${name}.srt`
  await fs.writeFile(path.join(dir, vtt), toVtt(c), 'utf8')
  await fs.writeFile(path.join(dir, srt), toSrt(c), 'utf8')
  const burnedIn = !!burnCaptionsOf(timeline) && (await hasAssFilter())
  return { language: c.language, vtt, srt, cues: subtitleCues(c), burnedIn }
}
