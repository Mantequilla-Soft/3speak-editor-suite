// Text outline and word by word entrances in the render (services/ffmpeg.js,
// text clips). The maths is utils/textAnim.js, shared with the preview.
import fs from 'fs/promises'
import { normalizeTextStroke, normalizeTextAnim, splitWords, ffmpegWordExprs } from './textAnim.js'

// drawtext options for the outline ('' without one); scale: preview px -> output px
export function strokeOption(clip, scale) {
  const s = normalizeTextStroke(clip.textStroke)
  if (!s) return ''
  return `:borderw=${Math.max(1, Math.round(s.width * scale))}:bordercolor=${s.color}`
}

// Where each word of each line sits, in preview px from the line's left edge:
// the editor measured it (clip.wordLayout); without that (or when it does not
// fit the lines), an estimate from the characters.
export function wordPositions(clip, lines, fontSizePreview, charRatio = 0.55) {
  const measured = clip.wordLayout?.lines
  return lines.map((line, li) => {
    const words = splitWords(line)
    const m = measured?.[li]
    if (m && Array.isArray(m.words) && m.words.length === words.length && Number.isFinite(+m.width)) {
      return { width: +m.width, words: words.map((text, i) => ({ text, x: +m.words[i].x || 0, w: +m.words[i].w || 0 })) }
    }
    const cw = fontSizePreview * charRatio
    let x = 0
    const out = []
    for (const text of words) {
      out.push({ text, x, w: text.length * cw })
      x += (text.length + 1) * cw
    }
    return { width: Math.max(0, x - cw), words: out }
  })
}

/**
 * Per-word drawtext filters for a text clip with a word animation, or null
 * (then the clip draws its lines as before). Words are centred where the
 * editor measured them and move / grow / fade with ffmpegWordExprs.
 * o: { lines, lineY(i), fontSize (output px), scale (preview px -> output px,
 * zoom included), w, padding, posX (output px), hAlign, font, fontColor,
 * shadow (drawtext options), stroke (options), basePath (for the word files) }
 */
export async function wordDrawtexts(clip, o) {
  const anim = normalizeTextAnim(clip.textAnim)
  if (!anim) return null
  const layout = wordPositions(clip, o.lines, clip.fontSize || 48)
  const out = []
  let index = 0
  for (let li = 0; li < o.lines.length; li++) {
    const line = layout[li]
    const lineW = line.width * o.scale
    const left = o.hAlign === 'left'
      ? o.padding + o.posX
      : o.hAlign === 'right' ? o.w - o.padding - lineW + o.posX : (o.w - lineW) / 2 + o.posX
    for (const word of line.words) {
      const file = `${o.basePath}_w${index}.txt`
      await fs.writeFile(file, word.text, 'utf-8')
      const e = ffmpegWordExprs(anim, index)
      const cx = left + (word.x + word.w / 2) * o.scale
      const size = e.scale === '1' ? `${o.fontSize}` : `'${o.fontSize}*(${e.scale})'`
      // grows around its middle (about 0.6 em below the line's top)
      const y = e.scale === '1' ? `${o.lineY(li)}+(${e.dy})*${o.fontSize}` : `${o.lineY(li)}+${o.fontSize}*0.6*(1-(${e.scale}))`
      out.push(`drawtext=textfile='${file.replace(/:/g, '\\:')}':fontfile='${o.font}':fontsize=${size}:fontcolor=${o.fontColor}` +
        `:x='${cx.toFixed(2)}-text_w/2+(${e.dx})*${o.fontSize}':y='${y}':alpha='${e.alpha}'${o.shadow}${o.stroke}`)
      index++
    }
  }
  return out.length ? out : null
}
