import { useEffect, useMemo, useState } from 'react'
import { X, Wand2, Play, Pause, Loader2 } from './icons'
import { findFillers, findPauses, fillerCutRanges, fillerTable } from '../utils/fillers'
import { cutLength } from '../utils/ripple'
import { transcriptTime } from '../utils/transcript'
import './WordTools.css'

const SETTINGS_KEY = 'filler-settings'
const DEFAULTS = { fillers: true, pauses: true, minPause: 1.5, keepPause: 0.5 }
const CONTEXT = 3 // words shown on each side of a filler

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') } } catch { return DEFAULTS }
}

let languageNames = null
const languageName = (code) => {
  try {
    languageNames = languageNames || new Intl.DisplayNames(['en'], { type: 'language' })
    return languageNames.of(code) || code
  } catch { return code }
}

/**
 * Remove fillers and long pauses: finds "um", "uh", "you know" and their kind
 * in the show's language (utils/fillers.js, from the transcript), and the
 * pauses longer than the length chosen, in a review list: play each one,
 * untick what should stay. "Cut" removes the fillers and shortens the pauses
 * to the length chosen, on every track at once (one undo step).
 * `tr`: useTranscript; `player`: useRangePlayback; onApply(ranges, what).
 */
export default function FillerReviewDialog({ tr, player, onApply, onClose }) {
  const [settings, setSettings] = useState(loadSettings)
  const [kept, setKept] = useState(() => new Set()) // unticked item ids
  const { words, job, status } = tr
  const running = job?.status === 'running'

  useEffect(() => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch {} }, [settings])
  useEffect(() => () => player.stop(), []) // eslint-disable-line react-hooks/exhaustive-deps

  const language = tr.language || 'en'
  const known = fillerTable(language).known
  const fillers = useMemo(() => (settings.fillers ? findFillers(words, language) : []), [words, language, settings.fillers])
  const pauses = useMemo(() => (settings.pauses ? findPauses(words, settings.minPause).filter(p => p.end - p.start > settings.keepPause + 0.1) : []), [words, settings.pauses, settings.minPause, settings.keepPause])
  const items = useMemo(() => [...fillers, ...pauses].sort((a, b) => a.start - b.start), [fillers, pauses])
  const ticked = items.filter(it => !kept.has(it.id))
  const ranges = fillerCutRanges(words, ticked, { keepPause: settings.keepPause })
  const saves = cutLength(ranges)
  const nFill = ticked.filter(i => i.kind === 'filler').length
  const nPause = ticked.length - nFill

  const toggle = (id) => setKept(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const setAll = (kind, on) => setKept(s => {
    const n = new Set(s)
    for (const it of items) if (it.kind === kind) { if (on) n.delete(it.id); else n.add(it.id) }
    return n
  })
  const set = (key) => (e) => setSettings(s => ({ ...s, [key]: Number(e.target.value) }))

  const context = (it) => {
    const before = words.slice(Math.max(0, it.from - CONTEXT), it.from).filter(w => w.speakerIndex === words[it.from].speakerIndex).map(w => w.text).join(' ')
    const after = words.slice(it.to + 1, it.to + 1 + CONTEXT).filter(w => w.speakerIndex === words[it.from].speakerIndex).map(w => w.text).join(' ')
    return <>{before && <span className="filler-context">…{before} </span>}<strong>{it.text}</strong>{after && <span className="filler-context"> {after}…</span>}</>
  }

  return (
    <div className="remix-picker-overlay" onClick={onClose}>
      <div className="remix-picker silence-cut filler-review" role="dialog" aria-modal="true" aria-labelledby="filler-review-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="filler-review-title">Remove fillers and pauses</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close"><X size={16} /></button>
        </div>

        {!words.length ? (
          <div className="filler-empty">
            <p className="silence-cut-mode-hint">This works from the transcript: it finds um, uh, you know and their kind in the show&apos;s language, and the long pauses.</p>
            {running ? (
              <div className="captions-progress" role="status" aria-live="polite">
                <div className="captions-progress-bar"><div style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div>
                <span><Loader2 size={13} className="encoding-notice-spin" /> {job.phase || 'Listening...'}</span>
              </div>
            ) : status?.available ? (
              <button className="silence-cut-apply" onClick={() => tr.transcribe()} disabled={tr.missingSeconds <= 0}><Wand2 size={14} /> Transcribe the show first</button>
            ) : (
              <p className="captions-error" role="status">{status === null ? 'Checking the server...' : 'Transcripts are not available on this editor server right now.'}</p>
            )}
            {job?.status === 'failed' && <p className="captions-error" role="alert">{job.error}</p>}
          </div>
        ) : (
          <>
            <p className="silence-cut-mode-hint">
              Fillers in {languageName(language)}{known ? '' : ' (only um, uh and the like: no list for this language yet)'}. Listen to each, untick what should stay.
              {running ? ' The rest of the show is still being transcribed.' : ''}
            </p>
            <div className="silence-cut-controls filler-controls">
              <label className="beat-sync-toggle"><input type="checkbox" checked={settings.fillers} onChange={e => setSettings(s => ({ ...s, fillers: e.target.checked }))} /><span>Filler words</span></label>
              <label className="beat-sync-toggle"><input type="checkbox" checked={settings.pauses} onChange={e => setSettings(s => ({ ...s, pauses: e.target.checked }))} /><span>Long pauses</span></label>
              <label>
                <span>Pause longer than <strong>{settings.minPause.toFixed(1)}s</strong></span>
                <input type="range" min={0.5} max={5} step={0.1} value={settings.minPause} onChange={set('minPause')} disabled={!settings.pauses} />
              </label>
              <label title="What is left of a long pause after the cut">
                <span>Shorten pauses to <strong>{settings.keepPause.toFixed(1)}s</strong></span>
                <input type="range" min={0.1} max={2} step={0.1} value={settings.keepPause} onChange={set('keepPause')} />
              </label>
            </div>

            <div className="filler-bulk">
              <span className="silence-cut-summary">{items.length ? `${nFill} filler${nFill === 1 ? '' : 's'}, ${nPause} pause${nPause === 1 ? '' : 's'} ticked · cuts ${saves.toFixed(1)}s` : 'Nothing found with these settings.'}</span>
              {fillers.length > 0 && <button className="audiogram-link" onClick={() => setAll('filler', fillers.some(f => kept.has(f.id)))}>{fillers.some(f => kept.has(f.id)) ? 'Tick all fillers' : 'Untick all fillers'}</button>}
              {pauses.length > 0 && <button className="audiogram-link" onClick={() => setAll('pause', pauses.some(p => kept.has(p.id)))}>{pauses.some(p => kept.has(p.id)) ? 'Tick all pauses' : 'Untick all pauses'}</button>}
            </div>

            <ul className="filler-list" aria-label="What would be cut">
              {items.map(it => {
                const on = !kept.has(it.id)
                const key = it.id
                const isPlaying = player.playing?.key === key
                return (
                  <li key={it.id} className={`filler-item${on ? '' : ' kept'}`}>
                    <input type="checkbox" checked={on} onChange={() => toggle(it.id)} aria-label={`${on ? 'Keep' : 'Cut'} ${it.kind === 'pause' ? 'this pause' : it.text}`} />
                    <button className="transcript-time" onClick={() => player.play(it.start - 1.5, it.end + 1.5, key)} title={isPlaying ? 'Stop' : 'Listen (with a second around it)'} aria-label={isPlaying ? 'Stop' : `Listen at ${transcriptTime(it.start)}`}>
                      {isPlaying ? <Pause size={12} /> : <Play size={12} />} {transcriptTime(it.start)}
                    </button>
                    {it.kind === 'pause' ? (
                      <span className="filler-what"><span className="filler-chip">Pause</span> {(it.end - it.start).toFixed(1)}s → {settings.keepPause.toFixed(1)}s</span>
                    ) : (
                      <span className="filler-what"><span className={`filler-chip${it.sure ? '' : ' maybe'}`} title={it.sure ? 'A hesitation sound' : 'A filler here (set off by pauses or commas): listen first'}>{it.sure ? 'Filler' : 'Maybe'}</span> {context(it)}</span>
                    )}
                    <span className="filler-speaker">{it.speaker}</span>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        <div className="silence-cut-actions">
          <button className="silence-cut-cancel" onClick={onClose}>Cancel</button>
          <button className="silence-cut-apply" disabled={!ranges.length} onClick={() => { player.stop(); onApply(ranges, `${nFill} fillers, ${nPause} pauses`); onClose() }}>
            <Wand2 size={14} /> {ranges.length ? `Cut ${ticked.length} (${saves.toFixed(1)}s)` : 'Cut'}
          </button>
        </div>
      </div>
    </div>
  )
}
