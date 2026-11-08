import { useEffect, useRef, useState } from 'react'
import { X, Film, Download, Loader2 } from 'lucide-react'
import { api, getBackendUrl } from '../utils/backendSelector'
import { authFetch } from '../utils/editorAuth'
import { chapterTime } from '../utils/chapters'

const LENGTHS = [15, 30, 60]
const FORMATS = [
  { id: 'square', label: 'Square', hint: 'Feeds' },
  { id: 'vertical', label: 'Vertical', hint: 'Shorts, Reels, Stories' }
]

/**
 * Audiogram: a short video of a piece of the exported episode (title, moving
 * waveform, 3speak.tv) to share as a teaser. Made on the editor backend
 * (POST /api/audiogram) from the export, so it needs one first.
 */
export default function AudiogramDialog({ outputUrl, length, playheadPosition, title, chapters, onClose }) {
  // 15 / 30 / 60 s, and the whole episode when it is a minute or less
  const whole = Math.floor(length * 10) / 10
  const lengths = [...LENGTHS.filter(l => l < whole).map(l => ({ v: l, label: `${l}s` })), ...(whole <= 60 ? [{ v: whole, label: `All (${Math.round(whole)}s)` }] : [])]
  const [seconds, setSeconds] = useState(() => Math.min(30, whole))
  const [start, setStart] = useState(() => Math.max(0, Math.min(playheadPosition, length - 3)))
  const [format, setFormat] = useState('square')
  const [text, setText] = useState(title || '')
  const [job, setJob] = useState(null) // { status, progress, phase, outputUrl, error }
  const pollRef = useRef(null)
  useEffect(() => () => clearInterval(pollRef.current), [])

  // Where it can start: the playhead, the beginning, each chapter (moved back
  // where the clip would run past the end)
  const clampStart = (t) => Math.round(Math.max(0, Math.min(t, length - seconds)) * 1000) / 1000
  const fits = clampStart(start)
  const choices = []
  const addChoice = (t, label) => {
    const v = clampStart(t)
    if (!choices.some(c => Math.abs(c.v - v) < 0.5)) choices.push({ v, label })
  }
  addChoice(playheadPosition, `${chapterTime(playheadPosition)} (playhead)`)
  addChoice(0, '0:00 (the start)')
  for (const c of chapters || []) addChoice(c.at, `${chapterTime(c.at)} ${c.title}`)
  const selected = (choices.find(c => Math.abs(c.v - fits) < 0.5) || choices[0]).v
  const make = async () => {
    clearInterval(pollRef.current)
    setJob({ status: 'processing', progress: 0, phase: 'Starting...' })
    try {
      const res = await authFetch(api('/api/audiogram'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: outputUrl, start: selected, duration: Math.min(seconds, whole), format, title: text })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      pollRef.current = setInterval(async () => {
        try {
          const st = await (await fetch(api(`/api/audiogram/${data.jobId}`))).json()
          if (st.status === 'completed') {
            clearInterval(pollRef.current)
            setJob({ ...st, outputUrl: new URL(st.outputUrl, getBackendUrl() || window.location.origin).href })
          } else if (st.status === 'failed' || st.error) {
            clearInterval(pollRef.current)
            setJob({ status: 'failed', error: st.error || 'failed' })
          } else {
            setJob(st)
          }
        } catch {}
      }, 1000)
    } catch (err) {
      setJob({ status: 'failed', error: err?.code === 'sign-in' ? 'Sign in on 3Speak to make an audiogram.' : err.message })
    }
  }

  const busy = job?.status === 'processing'
  return (
    <div className="remix-picker-overlay" onClick={busy ? undefined : onClose}>
      <div className="remix-picker audio-template audiogram" role="dialog" aria-modal="true" aria-labelledby="audiogram-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="audiogram-title">Audiogram</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close"><X size={16} /></button>
        </div>
        <p className="audio-template-intro">
          A short video of your episode with a moving waveform, to share as a teaser on 3Speak Shorts or anywhere else.
        </p>

        <div className="audiogram-fields">
          <label className="audiogram-field">
            <span>Title on the video</span>
            <input value={text} maxLength={120} onChange={(e) => setText(e.target.value)} aria-label="Title on the video" />
          </label>
          <label className="audiogram-field">
            <span>Starts at</span>
            <select value={String(selected)} onChange={(e) => setStart(+e.target.value)} aria-label="Starts at">
              {choices.map(c => <option key={c.v} value={String(c.v)}>{c.label}</option>)}
            </select>
          </label>
          <div className="audiogram-field">
            <span>Length</span>
            <div className="noise-levels" role="radiogroup" aria-label="Length">
              {lengths.map(({ v, label }) => (
                <button key={v} role="radio" aria-checked={seconds === v} className={seconds === v ? 'active' : ''} onClick={() => setSeconds(v)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="audiogram-field">
            <span>Shape</span>
            <div className="noise-levels" role="radiogroup" aria-label="Shape">
              {FORMATS.map(f => (
                <button key={f.id} role="radio" aria-checked={format === f.id} className={format === f.id ? 'active' : ''} title={f.hint} onClick={() => setFormat(f.id)}>{f.label}</button>
              ))}
            </div>
          </div>
        </div>

        {job?.status === 'completed' && job.outputUrl && (
          <video className={`audiogram-preview ${format}`} src={job.outputUrl} controls playsInline />
        )}
        {busy && (
          <div className="compact-render-progress" role="status">
            <div className="compact-render-progress-bar"><div className="compact-render-progress-fill" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div>
            <span className="compact-render-progress-text">{job.phase || 'Working...'}</span>
          </div>
        )}
        {job?.status === 'failed' && <p className="audio-template-error" role="alert">The audiogram could not be made: {job.error}</p>}

        <div className="silence-cut-actions audio-template-actions">
          <button className="silence-cut-apply" onClick={make} disabled={busy || length < 3}>
            {busy ? <Loader2 size={14} className="encoding-notice-spin" /> : <Film size={14} />} {job?.status === 'completed' ? 'Make it again' : 'Make audiogram'}
          </button>
          <span className="audio-template-spacer" />
          {job?.status === 'completed' && job.outputUrl && (
            <a className="silence-cut-apply" href={job.outputUrl} download target="_blank" rel="noopener noreferrer"><Download size={14} /> Download</a>
          )}
        </div>
      </div>
    </div>
  )
}
