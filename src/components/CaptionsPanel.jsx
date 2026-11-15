import { useMemo, useState } from 'react'
import { Loader2, Trash2, RotateCcw, X, Wand2 } from './icons'
import { CAPTION_FONTS, CAPTION_COLORS, CAPTION_PRESETS, normalizeCaptionStyle, suggestEmojis } from '../utils/captions'
import { emojiUrl } from '../utils/captionSources'

const PRESET_LABELS = { karaoke: 'Karaoke', pop: 'Pop', plain: 'Subtitles' }
const PRESET_HINTS = {
  karaoke: 'A few words at a time, the word being said in the highlight colour',
  pop: 'One word (or a few) at a time, popping in',
  plain: 'Classic subtitle lines on a dark box'
}
const WORDS_PER_PAGE = { karaoke: [2, 3, 4, 5], pop: [1, 2, 3] }
// Emojis offered by hand (the sticker library's Noto emojis)
const EMOJI_CHOICES = ['1f525', '2764', '1f602', '1f60d', '1f929', '1f62e', '1f914', '1f44f', '1f64c', '1f4af', '2728', '1f389', '1f680', '1f4a1', '1f4b0', '1f3c6', '1f44d', '1f440']

let languageNames = null
function languageName(code) {
  if (code === 'auto') return 'Detect automatically'
  try {
    languageNames = languageNames || new Intl.DisplayNames(['en'], { type: 'language' })
    return languageNames.of(code) || code
  } catch { return code }
}
const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`

/**
 * The Captions panel of the Shorts editor: "Auto captions" (speech to text on
 * the backend), then the look (style, words at a time, font, size, position,
 * colours, emoji accents) with the preview showing it live over the canvas,
 * and the words themselves to fix what was misheard.
 * captions: null | { words, language, style, burn }; status / job: useAutoCaptions.
 */
function CaptionsPanel({ captions, onChange, status, job, onTranscribe, onCancel, onSeek, playheadPosition = 0 }) {
  const [language, setLanguage] = useState(captions?.language || 'auto')
  const [emojiFor, setEmojiFor] = useState(null) // index of the word whose emoji picker is open
  const style = useMemo(() => normalizeCaptionStyle(captions?.style), [captions?.style])
  const words = captions?.words || []
  const running = job?.status === 'running'
  const available = status?.available === true

  const setStyle = (patch) => onChange({ ...captions, style: { ...style, ...patch } })
  const setWord = (i, patch) => onChange({ ...captions, words: words.map((w, k) => (k === i ? { ...w, ...patch } : w)) })
  const removeWord = (i) => onChange({ ...captions, words: words.filter((_, k) => k !== i) })
  const activeIndex = words.findIndex(w => playheadPosition >= w.start && playheadPosition < Math.max(w.end, w.start + 0.05))

  const languagePicker = (
    <div className="property-group">
      <label htmlFor="captions-language">Spoken language</label>
      <select id="captions-language" className="font-select" value={language} onChange={e => setLanguage(e.target.value)} disabled={running}>
        {(status?.languages || ['auto']).map(l => <option key={l} value={l}>{languageName(l)}</option>)}
      </select>
    </div>
  )

  const progress = running && (
    <div className="captions-progress" role="status" aria-live="polite">
      <div className="captions-progress-bar"><div style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div>
      <span><Loader2 size={13} className="encoding-notice-spin" /> {job.phase || 'Listening...'}</span>
      <button className="silence-cut-cancel" onClick={onCancel}>Cancel</button>
    </div>
  )
  const failed = job?.status === 'failed' && <p className="captions-error" role="alert">{job.error}</p>

  if (!words.length) {
    return (
      <div className="captions-panel">
        <div className="prop-group">
          <div className="prop-group-label">Auto captions</div>
          <p className="captions-text">Turn what is said into captions that follow every word, burnt into your Short and sent to 3Speak as subtitles too.</p>
          {status === null ? (
            <p className="captions-text"><Loader2 size={13} className="encoding-notice-spin" /> Checking the server...</p>
          ) : !available ? (
            <p className="captions-error" role="status">Auto captions are not available on this editor server right now. Your Short renders as usual without them.</p>
          ) : (
            <>
              {languagePicker}
              {progress || (
                <button className="silence-cut-apply captions-go" onClick={() => onTranscribe(language)}>
                  <Wand2 size={16} /> Auto captions
                </button>
              )}
              {failed}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="captions-panel">
      <div className="prop-group">
        <div className="prop-group-label">Style</div>
        <div className="silence-cut-modes captions-presets" role="radiogroup" aria-label="Caption style">
          {CAPTION_PRESETS.map(p => (
            <button key={p} role="radio" aria-checked={style.preset === p} className={style.preset === p ? 'active' : ''} title={PRESET_HINTS[p]}
              onClick={() => setStyle({ preset: p, wordsPerPage: p === 'pop' ? 1 : 3 })}>
              {PRESET_LABELS[p]}
            </button>
          ))}
        </div>
        {WORDS_PER_PAGE[style.preset] && (
          <div className="property-group">
            <label>Words at a time</label>
            <div className="silence-cut-modes" role="radiogroup" aria-label="Words at a time">
              {WORDS_PER_PAGE[style.preset].map(n => (
                <button key={n} role="radio" aria-checked={style.wordsPerPage === n} className={style.wordsPerPage === n ? 'active' : ''} onClick={() => setStyle({ wordsPerPage: n })}>{n}</button>
              ))}
            </div>
          </div>
        )}
        <div className="property-group">
          <label htmlFor="captions-font">Font</label>
          <select id="captions-font" className="font-select" value={style.font} onChange={e => setStyle({ font: e.target.value })}>
            {Object.keys(CAPTION_FONTS).map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </select>
        </div>
        <div className="property-group">
          <label>Size</label>
          <div className="property-slider">
            <input type="range" min="2.5" max="9" step="0.5" value={style.size} onChange={e => setStyle({ size: parseFloat(e.target.value) })} aria-label="Caption size" />
            <span>{style.size.toFixed(1)}</span>
          </div>
        </div>
        <div className="property-group">
          <label>Position</label>
          <div className="property-slider">
            <input type="range" min="8" max="92" step="1" value={style.y} onChange={e => setStyle({ y: parseInt(e.target.value, 10) })} aria-label="Caption height in the picture" />
            <span>{style.y < 34 ? 'Top' : style.y > 66 ? 'Low' : 'Middle'}</span>
          </div>
        </div>
        <div className="property-group">
          <label>Text colour</label>
          <div className="captions-swatches" role="radiogroup" aria-label="Text colour">
            {CAPTION_COLORS.map(c => (
              <button key={c} role="radio" aria-checked={style.color === c} className={`captions-swatch${style.color === c ? ' active' : ''}`} style={{ background: c }} onClick={() => setStyle({ color: c })} title={c} />
            ))}
          </div>
        </div>
        {style.preset === 'karaoke' && (
          <div className="property-group">
            <label>Highlight</label>
            <div className="captions-swatches" role="radiogroup" aria-label="Highlight colour">
              {CAPTION_COLORS.map(c => (
                <button key={c} role="radio" aria-checked={style.highlight === c} className={`captions-swatch${style.highlight === c ? ' active' : ''}`} style={{ background: c }} onClick={() => setStyle({ highlight: c })} title={c} />
              ))}
            </div>
          </div>
        )}
        <label className="beat-sync-toggle">
          <input type="checkbox" checked={style.uppercase} onChange={e => setStyle({ uppercase: e.target.checked })} />
          <span>Capital letters</span>
        </label>
        <label className="beat-sync-toggle">
          <input type="checkbox" checked={style.emoji} onChange={e => onChange({ ...captions, words: e.target.checked ? suggestEmojis(words) : words, style: { ...style, emoji: e.target.checked } })} />
          <span>Emoji accents (above words like &quot;fire&quot; or &quot;love&quot;)</span>
        </label>
        <label className="beat-sync-toggle">
          <input type="checkbox" checked={captions.burn !== false} onChange={e => onChange({ ...captions, burn: e.target.checked })} />
          <span>Show in the video (off: only as subtitles on 3Speak)</span>
        </label>
      </div>

      <div className="prop-group">
        <div className="prop-group-label">Words ({words.length})</div>
        <p className="captions-text">Fix what was misheard; clear a word to drop it. Moved or cut clips? Run Auto captions again.</p>
        <ol className="captions-words">
          {words.map((w, i) => (
            <li key={i} className={i === activeIndex ? 'active' : ''}>
              <button className="captions-word-time" onClick={() => onSeek?.(w.start)} title="Go there">{clock(w.start)}</button>
              <input
                className="text-input captions-word-text"
                value={w.text}
                onChange={e => setWord(i, { text: e.target.value })}
                onBlur={e => { if (!e.target.value.trim()) removeWord(i) }}
                aria-label={`Word ${i + 1}`}
              />
              {style.emoji && (
                <button className="captions-word-emoji" onClick={() => setEmojiFor(emojiFor === i ? null : i)} title={w.emoji ? 'Change or remove its emoji' : 'Add an emoji'} aria-expanded={emojiFor === i}>
                  {w.emoji ? <img src={emojiUrl(w.emoji)} alt="" /> : <span>+</span>}
                </button>
              )}
              <button className="captions-word-remove" onClick={() => removeWord(i)} title="Remove this word" aria-label={`Remove ${w.text}`}><X size={12} /></button>
              {emojiFor === i && (
                <div className="captions-emoji-choices">
                  {EMOJI_CHOICES.map(cp => (
                    <button key={cp} className={w.emoji === cp ? 'active' : ''} onClick={() => { setWord(i, { emoji: cp }); setEmojiFor(null) }}><img src={emojiUrl(cp)} alt="" /></button>
                  ))}
                  <button className="captions-emoji-none" onClick={() => { setWord(i, { emoji: '' }); setEmojiFor(null) }}>None</button>
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div className="prop-group">
        {available && languagePicker}
        {progress || (
          <div className="captions-actions">
            <button className="silence-cut-cancel" onClick={() => onTranscribe(language)} disabled={!available} title="Listen again (replaces the words)">
              <RotateCcw size={13} /> Again
            </button>
            <button className="silence-cut-apply captions-remove" onClick={() => onChange(null)}>
              <Trash2 size={13} /> Remove captions
            </button>
          </div>
        )}
        {failed}
      </div>
    </div>
  )
}

export default CaptionsPanel
