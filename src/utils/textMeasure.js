// Where each word of a text clip's lines sits, measured in the browser at the
// clip's font (preview px, from each line's left edge), so the render can
// place the words of a word by word entrance exactly (backend utils/textFx.js).
import { splitWords } from './textAnim'

export function measureWordLayout(clip, doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || !Array.isArray(clip.wrappedLines) || !clip.wrappedLines.length) return null
  const line = doc.createElement('span')
  line.style.cssText = `font-size:${clip.fontSize || 48}px;font-family:'${clip.fontFamily || 'Roboto'}',sans-serif;font-weight:${clip.fontWeight || 'normal'};white-space:pre;position:absolute;left:-9999px;top:-9999px`
  doc.body.appendChild(line)
  try {
    return {
      lines: clip.wrappedLines.map(text => {
        line.textContent = ''
        const spans = []
        splitWords(text).forEach((word, i) => {
          if (i) line.appendChild(doc.createTextNode(' '))
          const s = doc.createElement('span')
          s.textContent = word
          line.appendChild(s)
          spans.push(s)
        })
        const box = line.getBoundingClientRect()
        const r = (v) => Math.round(v * 100) / 100
        return {
          width: r(box.width),
          words: spans.map(s => { const b = s.getBoundingClientRect(); return { x: r(b.left - box.left), w: r(b.width) } })
        }
      })
    }
  } finally {
    doc.body.removeChild(line)
  }
}
