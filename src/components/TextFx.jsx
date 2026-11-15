import { normalizeTextStroke, normalizeTextAnim, wordState } from '../utils/textAnim'
import './TextFx.css'

// CSS for a text clip's outline: a stroke twice as wide, painted under the
// letters, so the outside part shows (ffmpeg's drawtext border)
export function textStrokeStyle(clip) {
  const s = normalizeTextStroke(clip.textStroke)
  if (!s) return {}
  return { WebkitTextStroke: `${s.width * 2}px ${s.color}`, paintOrder: 'stroke fill' }
}

const wordCss = (st) => ({
  display: 'inline-block',
  opacity: st.opacity,
  transform: st.dx || st.dy || st.scale !== 1 ? `translate(${st.dx.toFixed(3)}em, ${st.dy.toFixed(3)}em) scale(${st.scale.toFixed(4)})` : undefined
})

// The text box of a clip with a word entrance holds the animated words over
// a hidden plain copy of the text (that copy keeps the box's size and wrap)
export function animatedBoxStyle(clip) {
  return normalizeTextAnim(clip.textAnim) ? { position: 'relative', display: 'inline-block' } : {}
}

/**
 * A text clip's text: plain, or, for a word by word entrance, the plain text
 * kept invisible (it sizes and wraps the box exactly as before) with one span
 * per word over it, registered so the playback loop moves them every frame.
 */
export function AnimatedText({ clip, time, start, registry }) {
  const text = clip.text || 'Text'
  const anim = normalizeTextAnim(clip.textAnim)
  if (!anim) return text
  registry[clip.id] = { anim, start }
  let i = -1
  const words = text.split(/(\s+)/).map((part, k) => {
    if (!part) return null
    if (/^\s+$/.test(part)) return part
    i++
    return (
      <span key={k} data-word={`${clip.id}:${i}`} style={wordCss(wordState(anim, i, time - start))}>
        {part}
      </span>
    )
  })
  return (
    <>
      <span style={{ visibility: 'hidden' }}>{text}</span>
      <span className="text-word-layer" aria-hidden="true">{words}</span>
    </>
  )
}

// Every frame while playing: the words of the text clips coming in
export function applyWordFrames(container, t, registry) {
  container?.querySelectorAll('[data-word]').forEach(el => {
    const at = el.dataset.word.lastIndexOf(':')
    const id = el.dataset.word.slice(0, at), i = el.dataset.word.slice(at + 1)
    const r = registry[id]
    if (!r) return
    const css = wordCss(wordState(r.anim, +i, t - r.start))
    el.style.opacity = String(css.opacity)
    el.style.transform = css.transform || ''
  })
}
