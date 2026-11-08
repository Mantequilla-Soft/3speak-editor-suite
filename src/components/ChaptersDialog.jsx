import { useEffect, useRef, useState } from 'react'
import { X, Plus, Trash2, Crosshair, Copy, Check } from 'lucide-react'
import { chapterTime, chaptersText, MAX_CHAPTERS, MAX_CHAPTER_TITLE } from '../utils/chapters'

/**
 * The episode's chapters: add one at the playhead, name them, jump to them.
 * They stay with the recording through cuts (utils/chapters.js), go into the
 * MP3 and, with "Use this audio", into the post's description.
 * `resolved`: [{ id, title, at }] where they are now; `spans`: what is exported;
 * `focusId`: a chapter just added (its name field gets the focus).
 */
export default function ChaptersDialog({ resolved, spans, playheadPosition, focusId, onAdd, onRename, onMove, onRemove, onSeek, onClose }) {
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
          <h3 id="audio-chapters-title">Chapters</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close"><X size={16} /></button>
        </div>
        <p className="audio-template-intro">
          Mark where each part of the episode starts. Podcast apps show them, and 3Speak lists them in the description.
          They stay with your recording when you cut it. Shortcut: <kbd>M</kbd> adds one at the playhead.
        </p>

        {resolved.length === 0 ? (
          <p className="audio-template-hint">No chapters yet. Move the playhead to where a part starts and add one.</p>
        ) : (
          <ol className="audio-chapters-list" ref={listRef}>
            {resolved.map((ch, i) => (
              <li key={ch.id} className={exported.has(ch.at) ? '' : 'skipped'}>
                <button className="audio-chapters-time" onClick={() => onSeek(ch.at)} title="Go there">{chapterTime(ch.at)}</button>
                <input
                  value={ch.title}
                  maxLength={MAX_CHAPTER_TITLE}
                  data-id={ch.id}
                  aria-label={`Chapter ${i + 1} name`}
                  onChange={(e) => onRename(ch.id, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                />
                <button className="audio-chapters-icon" onClick={() => onMove(ch.id, playheadPosition)} title="Move it to the playhead" aria-label={`Move chapter ${i + 1} to the playhead`}><Crosshair size={14} /></button>
                <button className="audio-chapters-icon" onClick={() => onRemove(ch.id)} title="Remove" aria-label={`Remove chapter ${i + 1}`}><Trash2 size={14} /></button>
              </li>
            ))}
          </ol>
        )}
        {resolved.length > spans.length && (
          <p className="audio-template-hint">Chapters less than a second apart, or at the very end, are left out of the export.</p>
        )}
        {spans.length > 0 && spans[0].start > 0.5 && (
          <p className="audio-template-hint">Tip: many apps expect the first chapter at 0:00.</p>
        )}

        <div className="silence-cut-actions audio-template-actions">
          <button className="silence-cut-apply" onClick={() => onAdd(playheadPosition)} disabled={resolved.length >= MAX_CHAPTERS}>
            <Plus size={14} /> Add at {chapterTime(playheadPosition)}
          </button>
          <span className="audio-template-spacer" />
          {spans.length > 0 && (
            <button className="silence-cut-apply" onClick={copy} title="Copy the list (for a description)">
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy list'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
