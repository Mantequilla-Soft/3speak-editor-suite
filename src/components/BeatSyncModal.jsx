import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Music2 } from 'lucide-react'
import { detectBeats } from '../utils/beatDetect'

const EVERY = [1, 2, 4, 8]

/**
 * "Beat sync" for a music / audio clip: finds its beats (utils/beatDetect.js),
 * then can show them on the timeline (clips snap to them) and lay the video
 * clips on the beat, each N beats long. `source` is the clip's File or URL.
 */
function BeatSyncModal({ clip, source, unavailable, onSetBeats, onFitClips, onClose }) {
  const [detected, setDetected] = useState(null)
  const [error, setError] = useState(unavailable || null)
  // Tempo correction for a doubled / halved read: 0.5, 1 or 2
  const [factor, setFactor] = useState(1)
  const [every, setEvery] = useState(2)
  const [showBeats, setShowBeats] = useState(clip.showBeats !== false)
  const canvasRef = useRef(null)

  useEffect(() => {
    if (unavailable || !source) return
    const controller = new AbortController()
    detectBeats(source, { signal: controller.signal, hintBpm: clip.bpm || 0 })
      .then(r => {
        if (controller.signal.aborted) return
        if (!r) setError('This clip is too short to find a tempo.')
        else setDetected(r)
      })
      .catch(err => {
        if (err.name === 'AbortError') return
        setError(err.message === 'too-large'
          ? 'This file is too big to analyse in the browser (over 300 MB).'
          : 'Could not read the audio of this clip.')
      })
    return () => controller.abort()
  }, [source, unavailable, clip.bpm])

  // Beats after the tempo correction (media seconds)
  const beats = useMemo(() => {
    if (!detected) return null
    const b = detected.beats
    if (factor === 0.5) return b.filter((_, i) => i % 2 === 0)
    if (factor === 2) {
      const out = []
      for (let i = 0; i < b.length; i++) {
        out.push(b[i])
        const next = b[i + 1] ?? b[i] + detected.period
        out.push(Number(((b[i] + next) / 2).toFixed(3)))
      }
      return out
    }
    return b
  }, [detected, factor])
  const bpm = detected ? Math.round(detected.bpm * factor) : null

  // In the clip, on the timeline
  const clipBeats = useMemo(() => (beats || []).filter(b => b >= clip.startTime && b < clip.endTime), [beats, clip.startTime, clip.endTime])
  const timelineBeats = useMemo(() => clipBeats.map(b => (clip.timelinePosition || 0) + (b - clip.startTime)), [clipBeats, clip.timelinePosition, clip.startTime])

  // Beat strip: every beat a short tick, every Nth (a clip boundary) a tall one
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !clipBeats.length) return
    const width = canvas.parentElement.clientWidth
    const height = 44
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const g = canvas.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)
    const css = getComputedStyle(canvas)
    const accent = css.getPropertyValue('--accent-primary').trim() || '#e53935'
    const muted = css.getPropertyValue('--text-secondary').trim() || '#888'
    const span = Math.max(0.001, clip.endTime - clip.startTime)
    clipBeats.forEach((b, i) => {
      const x = Math.round(((b - clip.startTime) / span) * width)
      const major = i % every === 0
      g.fillStyle = major ? accent : muted
      g.globalAlpha = major ? 1 : 0.5
      g.fillRect(x, major ? 4 : 22, major ? 2 : 1, major ? height - 8 : height - 26)
    })
    g.globalAlpha = 1
  }, [clipBeats, every, clip.startTime, clip.endTime])

  const save = (show) => onSetBeats({ beats: { bpm, times: beats }, showBeats: show })

  return (
    <div className="remix-picker-overlay" onClick={onClose}>
      <div className="remix-picker silence-cut beat-sync" role="dialog" aria-modal="true" aria-labelledby="beat-sync-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="beat-sync-title">Beat sync</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>

        {error ? (
          <p className="silence-cut-status">{error}</p>
        ) : !detected ? (
          <p className="silence-cut-status">Finding the beat…</p>
        ) : (
          <>
            <div className="beat-sync-tempo">
              <Music2 size={16} />
              <strong>{bpm} BPM</strong>
              <span>{clipBeats.length} beats in this clip</span>
              <span className="beat-sync-fix">
                <button onClick={() => setFactor(f => (f === 2 ? 1 : 0.5))} disabled={factor === 0.5} title="The beat is twice too fast">½×</button>
                <button onClick={() => setFactor(f => (f === 0.5 ? 1 : 2))} disabled={factor === 2} title="The beat is twice too slow">2×</button>
              </span>
            </div>
            <div className="silence-cut-preview beat-sync-strip"><canvas ref={canvasRef} /></div>

            <div className="silence-cut-controls">
              <div>
                <span className="beat-sync-label">A clip lasts</span>
                <div className="silence-cut-modes" role="radiogroup" aria-label="Beats per clip">
                  {EVERY.map(n => (
                    <button key={n} role="radio" aria-checked={every === n} className={every === n ? 'active' : ''} onClick={() => setEvery(n)}>
                      {n} beat{n === 1 ? '' : 's'}
                    </button>
                  ))}
                </div>
              </div>
              <label className="beat-sync-toggle">
                <input type="checkbox" checked={showBeats} onChange={e => { setShowBeats(e.target.checked); save(e.target.checked) }} />
                <span>Show the beats on the timeline (clips snap to them)</span>
              </label>
            </div>

            <div className="silence-cut-actions">
              <button className="silence-cut-cancel" onClick={() => { save(showBeats); onClose() }}>Done</button>
              <button
                className="silence-cut-apply"
                disabled={timelineBeats.length < 2}
                onClick={() => { save(showBeats); onFitClips(timelineBeats, every); onClose() }}
                title="Lay the clips of the video track on the beat, in order"
              >
                Fit video clips to the beat
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default BeatSyncModal
