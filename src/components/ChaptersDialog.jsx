import { useEffect, useRef, useState } from 'react'
import { X, Plus, Trash2, Crosshair, Copy, Check } from './icons'
import { chapterTime, chaptersText, MAX_CHAPTERS, MAX_CHAPTER_TITLE } from '../utils/chapters'
import { useT } from '../i18n'

/**
 * The episode's chapters: add one at the playhead, name them, jump to them.
 * They stay with the recording through cuts (utils/chapters.js), go into the
 * MP3 and, with "Use this audio", into the post's description.
 * `resolved`: [{ id, title, at }] where they are now; `spans`: what is exported;
 * `focusId`: a chapter just added (its name field gets the focus);
 * `suggestions`: the chapter ideas (ChapterSuggestions), shown under the list.
 */
export default function ChaptersDialog({ resolved, spans, playheadPosition, focusId, onAdd, onRename, onMove, onRemove, onSeek, onClose, suggestions = null }) {
  const { t, tRich } = useT()
  const listRef = useRef(null)
  const [copied, setCopied] = useState(false)
  const exported = new Set(spans.map(s => s.start))

  useEffect(() => {
    if (!focusId) return
    const input = [...(listRef.current?.querySelectorAll('input') || [])].find(i => i.dataset.id === focusId)
    input?.select()
  }, [focusId, resolved.length])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(chaptersText(spans))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  return (
    <div className="remix-picker-overlay" onClick={onClose}>
      <div className="remix-picker audio-template audio-chapters" role="dialog" aria-modal="true" aria-labelledby="audio-chapters-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="audio-chapters-title">{t('chapters.title')}</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title={t('common.close')}><X size={16} /></button>
        </div>
        <p className="audio-template-intro">{tRich('chapters.intro', null, { kbd: <kbd /> })}</p>

        {resolved.length === 0 ? (
          <p className="audio-template-hint">{t('chapters.empty')}</p>
        ) : (
          <ol className="audio-chapters-list" ref={listRef}>
            {resolved.map((ch, i) => (
              <li key={ch.id} className={exported.has(ch.at) ? '' : 'skipped'}>
                <button className="audio-chapters-time" onClick={() => onSeek(ch.at)} title={t('chapters.goThere')}>{chapterTime(ch.at)}</button>
                <input
                  value={ch.title}
                  maxLength={MAX_CHAPTER_TITLE}
                  data-id={ch.id}
                  aria-label={t('chapters.nameLabel', { n: i + 1 })}
                  onChange={(e) => onRename(ch.id, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                />
                <button className="audio-chapters-icon" onClick={() => onMove(ch.id, playheadPosition)} title={t('chapters.moveHere')} aria-label={t('chapters.moveLabel', { n: i + 1 })}><Crosshair size={14} /></button>
                <button className="audio-chapters-icon" onClick={() => onRemove(ch.id)} title={t('common.remove')} aria-label={t('chapters.removeLabel', { n: i + 1 })}><Trash2 size={14} /></button>
              </li>
            ))}
          </ol>
        )}
        {resolved.length > spans.length && (
          <p className="audio-template-hint">{t('chapters.leftOut')}</p>
        )}
        {spans.length > 0 && spans[0].start > 0.5 && (
          <p className="audio-template-hint">{t('chapters.tipZero')}</p>
        )}

        {suggestions}

        <div className="silence-cut-actions audio-template-actions">
          <button className="silence-cut-apply" onClick={() => onAdd(playheadPosition)} disabled={resolved.length >= MAX_CHAPTERS}>
            <Plus size={14} /> {t('chapters.addAt', { time: chapterTime(playheadPosition) })}
          </button>
          <span className="audio-template-spacer" />
          {spans.length > 0 && (
            <button className="silence-cut-apply" onClick={copy} title={t('chapters.copyTitle')}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t('chapters.copied') : t('chapters.copy')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
