import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Wand2, X } from './icons'
import { CAPTION_FONTS, CAPTION_COLORS, CAPTION_PRESETS, captionAt } from '../utils/captions'
import { audiogramCaptionEvents, clampCaptionBox, pieceCaptions, AUDIOGRAM_CAPTION_SIZE } from '../utils/audiogramCaptions'
import { useT } from '../i18n'
import './WordTools.css'

// labels: t(`audiogram.captions.preset.${p}`) (karaoke, pop, plain)
const WORDS_PER_PAGE = { karaoke: [2, 3, 4, 5], pop: [1, 2, 3] }
// The audiogram's own red and white first, then the captions' colours
const COLORS = ['#e32933', ...CAPTION_COLORS.filter(c => c !== '#e53935')]
// A sample sentence in the look, in the interface language
const sampleWords = (sentence) => sentence.split(' ').map((text, i) => ({ text, start: i * 0.45, end: i * 0.45 + 0.4 }))
const LOOP = 12 // seconds of the piece the preview plays round

/**
 * The captions part in the audiogram preview: the box (drag to move, pull a
 * side to make it wider or narrower) with the captions in it as the video
 * shows them, playing round the first seconds of the piece. Without words
 * yet, a sample sentence in the look.
 */
export function AudiogramCaptionsLayer({ look, box, size, scale, words, selected, onSelect, onBox }) {
  const { t, lang } = useT()
  const captions = useMemo(() => pieceCaptions(words?.length ? words : sampleWords(t('audiogram.captions.sample')), Infinity), [words, lang]) // eslint-disable-line react-hooks/exhaustive-deps
  const events = useMemo(() => audiogramCaptionEvents(captions, look, box, size), [captions, look, box, size])
  const [clock, setClock] = useState(0)
  const end = Math.min(LOOP, events.length ? events[events.length - 1].end : 0)
  useEffect(() => {
    if (!(end > 0)) return undefined
    const started = performance.now()
    const id = setInterval(() => setClock(((performance.now() - started) / 1000) % end), 80)
    return () => clearInterval(id)
  }, [end])
  const event = captionAt(events, clock) || events[0]
  const font = CAPTION_FONTS[look.font] || CAPTION_FONTS.Poppins
  const fontPx = (look.size / 100) * size.h * scale

  const startDrag = (e, edge = null) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    onSelect()
    const sx = e.clientX
    const sy = e.clientY
    const base = box
    const onMove = (ev) => {
      const dx = (ev.clientX - sx) / scale
      const dy = (ev.clientY - sy) / scale
      let next
      if (edge === 'e') next = { x: base.x, y: base.y, w: base.w + dx * 2 }
      else if (edge === 'w') next = { x: base.x, y: base.y, w: base.w - dx * 2 }
      else next = { x: base.x + dx, y: base.y + dy, w: base.w }
      // widened or narrowed around its middle; snapped to the frame's middle when close
      if (edge) next.x = base.x + base.w / 2 - next.w / 2
      else if (Math.abs(next.x + next.w / 2 - size.w / 2) <= 14) next.x = size.w / 2 - next.w / 2
      onBox(clampCaptionBox(next, look, size))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className={`audiogram-box audiogram-captions-box${selected ? ' selected' : ''}`}
      data-layer="captions"
      title={selected ? t('audiogram.captions.dragSelected') : t('audiogram.captions.drag')}
      style={{ left: box.x * scale, top: box.y * scale, width: box.w * scale, height: box.h * scale, zIndex: 29 }}
      onPointerDown={(e) => startDrag(e)}
    >
      {event && (
        <div
          className={`captions-overlay-block audiogram-captions-text${look.preset === 'plain' ? ' plain' : ''}`}
          aria-hidden="true"
          style={{ top: '50%', fontFamily: `'${look.font}', sans-serif`, fontWeight: font.weight, fontSize: `${fontPx}px`, lineHeight: font.line, color: look.color, '--caption-outline': `${0.18}em` }}
        >
          {event.lines.map((line, i) => (
            <div className="captions-overlay-line" key={i}>
              <span>{line.map((w, j) => <span key={j} style={w.active ? { color: look.highlight } : undefined}>{j ? ' ' : ''}{w.text}</span>)}</span>
            </div>
          ))}
        </div>
      )}
      {selected && <span className="audiogram-box-name">{t('audiogram.captions.label')}</span>}
      {selected && ['w', 'e'].map(edge => (
        <span key={edge} className={`audiogram-captions-edge ${edge}`} data-edge={edge} onPointerDown={(e) => startDrag(e, edge)} />
      ))}
    </div>
  )
}

/**
 * The Captions field of the audiogram studio: on or off, the words of the
 * piece (speech to text, then fixable by hand), and the look.
 * `ag`: useAudiogramCaptions; `look`: the captions look; onChange(patch).
 */
export function AudiogramCaptionsField({ look, onChange, ag, disabled }) {
  const { t } = useT()
  const [fixing, setFixing] = useState(false)
  const autoRef = useRef(null)
  const available = ag.status?.available === true
  const running = ag.job?.status === 'running'

  // Switched on (or a new piece) without its words yet: listen at once (once per piece; then the button)
  const autoKey = look.on && available && !ag.ready ? ag.pieceKey : null
  useEffect(() => {
    if (!autoKey || running || autoRef.current === autoKey) return
    autoRef.current = autoKey
    ag.transcribe()
  }, [autoKey, running]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="audiogram-field audiogram-captions-field" data-testid="audiogram-captions">
      <span>{t('audiogram.captions.label')}</span>
      <label className="beat-sync-toggle">
        <input type="checkbox" checked={look.on} onChange={(e) => onChange({ on: e.target.checked })} disabled={disabled || (!available && !look.on)} />
        <span>{t('audiogram.captions.show')}</span>
      </label>
      {ag.status === null && <small className="audiogram-note"><Loader2 size={12} className="encoding-notice-spin" /> {t('audiogram.captions.checking')}</small>}
      {ag.status && !available && <small className="audiogram-note">{t('audiogram.captions.unavailable')}</small>}
      {look.on && available && (
        <>
          {running ? (
            <div className="captions-progress" role="status" aria-live="polite">
              <div className="captions-progress-bar"><div style={{ width: `${Math.round((ag.job.progress || 0) * 100)}%` }} /></div>
              <span><Loader2 size={13} className="encoding-notice-spin" /> {ag.job.phase || t('audiogram.captions.listening')}</span>
              <button className="silence-cut-cancel" onClick={ag.cancel}>{t('common.cancel')}</button>
            </div>
          ) : !ag.ready ? (
            <button className="silence-cut-apply audiogram-pick" onClick={() => ag.transcribe()} disabled={disabled}><Wand2 size={14} /> {t('audiogram.captions.getWords')}</button>
          ) : (
            <small className="audiogram-note">
              {ag.words.length ? t('audiogram.captions.wordCount', { count: ag.words.length }) : t('audiogram.captions.noSpeech')}{' '}
              {ag.words.length > 0 && <button type="button" className="audiogram-link" onClick={() => setFixing(f => !f)} aria-expanded={fixing}>{fixing ? t('audiogram.captions.doneFixing') : t('audiogram.captions.fix')}</button>}
            </small>
          )}
          {ag.job?.status === 'failed' && <p className="captions-error" role="alert">{ag.job.error}</p>}
          {fixing && ag.words.length > 0 && (
            <ol className="captions-words audiogram-captions-words">
              {ag.words.map((w, i) => (
                <li key={`${w.start}`}>
                  <input className="text-input captions-word-text" value={w.text} onChange={(e) => ag.setWordText(i, e.target.value)} onBlur={(e) => { if (!e.target.value.trim()) ag.setWordText(i, null) }} aria-label={t('audiogram.captions.word', { n: i + 1 })} />
                  <button className="captions-word-remove" onClick={() => ag.setWordText(i, null)} title={t('audiogram.captions.removeWord')} aria-label={t('audiogram.captions.removeWordLabel', { word: w.text })}><X size={12} /></button>
                </li>
              ))}
            </ol>
          )}

          <div className="noise-levels" role="radiogroup" aria-label={t('audiogram.captions.style')}>
            {CAPTION_PRESETS.map(p => (
              <button key={p} role="radio" aria-checked={look.preset === p} className={look.preset === p ? 'active' : ''} onClick={() => onChange({ preset: p, wordsPerPage: p === 'pop' ? 1 : 3 })}>{t(`audiogram.captions.preset.${p}`)}</button>
            ))}
          </div>
          {WORDS_PER_PAGE[look.preset] && (
            <div className="noise-levels" role="radiogroup" aria-label={t('audiogram.captions.wordsAtATime')}>
              {WORDS_PER_PAGE[look.preset].map(n => (
                <button key={n} role="radio" aria-checked={look.wordsPerPage === n} className={look.wordsPerPage === n ? 'active' : ''} onClick={() => onChange({ wordsPerPage: n })} title={t('audiogram.captions.perPage', { count: n })}>{n}</button>
              ))}
            </div>
          )}
          <div className="audiogram-captions-row">
            <select className="font-select" value={look.font} onChange={(e) => onChange({ font: e.target.value })} aria-label={t('audiogram.captions.font')}>
              {Object.keys(CAPTION_FONTS).map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
            </select>
            <input type="range" min={AUDIOGRAM_CAPTION_SIZE.min} max={AUDIOGRAM_CAPTION_SIZE.max} step="0.5" value={look.size} onChange={(e) => onChange({ size: parseFloat(e.target.value) })} aria-label={t('audiogram.captions.size')} />
          </div>
          <div className="audiogram-colors" role="radiogroup" aria-label={t('audiogram.captions.textColour')}>
            {COLORS.map(c => (
              <button key={c} role="radio" aria-checked={look.color === c} aria-label={t('audiogram.captions.textColourSwatch', { colour: c })} className={`audiogram-swatch${look.color === c ? ' active' : ''}`} style={{ background: c }} onClick={() => onChange({ color: c })} />
            ))}
          </div>
          {look.preset === 'karaoke' && (
            <div className="audiogram-colors" role="radiogroup" aria-label={t('audiogram.captions.highlightColour')}>
              <small className="audiogram-note">{t('audiogram.captions.highlight')}</small>
              {COLORS.map(c => (
                <button key={c} role="radio" aria-checked={look.highlight === c} aria-label={t('audiogram.captions.highlightSwatch', { colour: c })} className={`audiogram-swatch${look.highlight === c ? ' active' : ''}`} style={{ background: c }} onClick={() => onChange({ highlight: c })} />
              ))}
            </div>
          )}
          <label className="beat-sync-toggle">
            <input type="checkbox" checked={look.uppercase} onChange={(e) => onChange({ uppercase: e.target.checked })} />
            <span>{t('audiogram.captions.capitals')}</span>
          </label>
        </>
      )}
    </div>
  )
}
