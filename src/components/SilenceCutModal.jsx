import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, Wand2, Play, Pause } from 'lucide-react'
import { loadLoudness, planCuts, planSceneCuts, suggestThreshold } from '../utils/silenceDetect'
import { api } from '../utils/backendSelector'
import { authFetch } from '../utils/editorAuth'
import { formatLength } from '../utils/limits'

const SETTINGS_KEY = 'autocut-settings'
const DEFAULTS = { cutAt: 'pauses', mode: 'split', thresholdDb: -40, minSilence: 0.6, minPart: 3, keepStartMs: 150, keepEndMs: 150, sensitivity: 70 }
const SCENE_MAX = 40 // top of the scene-score graph (hard cuts score ~20-40)
// Sensitivity 0..100 -> scene score a change needs to count as a cut
const sceneThreshold = (sensitivity) => 52 - sensitivity / 2
const DB_MIN = -70 // bottom of the preview graph

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }
  } catch {
    return DEFAULTS
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch { /* private window: settings just are not remembered */ }
}

const clock = (t) => {
  const s = Math.max(0, Math.floor(t))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const seconds = (s) => (s < 10 ? s.toFixed(1) : String(Math.round(s))) + 's'

/**
 * "Auto cut" popup: finds the pauses (or the scene changes) in a clip and shows where it would cut,
 * live, while the sliders move. "Edit for me" hands the parts to onApply.
 * `source` is the clip's File/Blob or URL; `unavailable` is a reason it cannot be read.
 * Play / scrub use the clip's own (playable) URL; in "cut pauses out" mode the
 * playback skips what would be cut, so the result can be heard first.
 */
function SilenceCutModal({ clip, source, unavailable, onApply, onClose }) {
  const [loudness, setLoudness] = useState(null)
  const [error, setError] = useState(unavailable || null)
  const [settings, setSettings] = useState(loadSettings)
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const [width, setWidth] = useState(0)

  const from = clip.startTime
  const to = clip.endTime
  const isVideo = clip.type === 'video'

  // Playback: position in source media seconds
  const mediaRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(from)
  const scrubbingRef = useRef(false)

  useEffect(() => {
    if (unavailable || !source) return
    const controller = new AbortController()
    loadLoudness(source, { signal: controller.signal })
      .then(l => { if (!controller.signal.aborted) setLoudness(l) })
      .catch(err => {
        if (controller.signal.aborted) return
        setError(err.message === 'too-large'
          ? 'This file is too big to analyse in the browser (over 300 MB). Trim it or use a smaller file.'
          : 'Could not read the audio of this clip.')
      })
    return () => controller.abort()
  }, [source, unavailable])

  useEffect(() => { saveSettings(settings) }, [settings])

  // Scene changes come from the backend (one ffmpeg pass over the uploaded file)
  // (audio clips have no picture: always pauses there, whatever was used last)
  const scenesMode = settings.cutAt === 'scenes' && clip.type === 'video'
  const [sceneScores, setSceneScores] = useState(null)
  const [sceneError, setSceneError] = useState(null)
  const uploaded = !!clip.serverUrl && /\/api\/upload\/files\//.test(clip.serverUrl)
  useEffect(() => {
    if (!scenesMode || sceneScores || !isVideo) return
    if (!uploaded) { setSceneError('Scene changes can be found once this clip has finished uploading.'); return }
    const controller = new AbortController()
    setSceneError(null)
    authFetch(api('/api/clip/scenes'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: clip.serverUrl }),
      signal: controller.signal
    })
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then(d => setSceneScores(d.scores || []))
      .catch(err => { if (err.name !== 'AbortError') setSceneError('Could not look for scene changes.') })
    return () => controller.abort()
  }, [scenesMode, sceneScores, uploaded, clip.serverUrl, isVideo])

  const ready = scenesMode ? !!sceneScores : !!loudness
  const plan = useMemo(() => {
    if (scenesMode) {
      return sceneScores
        ? planSceneCuts(sceneScores, { from, to, threshold: sceneThreshold(settings.sensitivity), minPart: settings.minPart })
        : null
    }
    return loudness ? planCuts(loudness, { from, to, ...settings }) : null
  }, [scenesMode, sceneScores, loudness, from, to, settings])

  const partsRef = useRef([])
  partsRef.current = plan ? plan.parts : null

  // Where playback should be: inside the clip and, when pauses are cut, inside a kept part
  const keptTime = useCallback((t) => {
    const parts = partsRef.current
    if (!parts) return t < to ? t : null
    for (const p of parts) {
      if (t < p.start) return p.start
      if (t < p.end - 0.02) return t
    }
    return null
  }, [to])

  const seek = useCallback((t) => {
    const clamped = Math.min(to, Math.max(from, t))
    setTime(clamped)
    if (mediaRef.current) mediaRef.current.currentTime = clamped
  }, [from, to])

  const togglePlay = useCallback(() => {
    const el = mediaRef.current
    if (!el) return
    if (!el.paused) { el.pause(); return }
    let start = keptTime(el.currentTime < from || el.currentTime >= to - 0.05 ? from : el.currentTime)
    if (start == null) start = keptTime(from) ?? from
    el.currentTime = start
    el.play().catch(() => setPlaying(false))
  }, [from, to, keptTime])

  // Follow playback, skip cut parts, stop at the clip's end
  useEffect(() => {
    if (!playing) return
    let raf
    const tick = () => {
      const el = mediaRef.current
      if (!el) return
      if (!scrubbingRef.current) {
        const next = keptTime(el.currentTime)
        if (next == null) {
          el.pause()
          el.currentTime = to
        } else if (next - el.currentTime > 0.05) {
          el.currentTime = next
        }
        setTime(el.currentTime)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, keptTime, to])

  // Space plays / pauses (App's own shortcuts are off while this popup is open)
  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === ' ' || e.code === 'Space') && e.target.tagName !== 'BUTTON') {
        e.preventDefault()
        togglePlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay])

  // Click or drag on the graph to scrub
  const timeAt = (e) => {
    const rect = wrapRef.current.getBoundingClientRect()
    return from + Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * (to - from)
  }
  const onScrubStart = (e) => {
    if (!ready) return
    scrubbingRef.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    seek(timeAt(e))
  }
  const onScrubMove = (e) => { if (scrubbingRef.current) seek(timeAt(e)) }
  const onScrubEnd = () => { scrubbingRef.current = false }

  // Canvas follows the popup width
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !plan || !width || (!scenesMode && !loudness)) return
    const height = 120
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
    const text = css.getPropertyValue('--text-primary').trim() || '#222'
    const top = 18 // room for part numbers
    const graphH = height - top
    const span = Math.max(0.001, to - from)
    const x = (t) => ((t - from) / span) * width
    const y = (d) => top + graphH * (1 - (Math.max(DB_MIN, d) - DB_MIN) / -DB_MIN)

    if (scenesMode) {
      // Scene-change scores as bars, the sensitivity line, and the cuts
      const ys = (score) => top + graphH * (1 - Math.min(1, score / SCENE_MAX))
      g.fillStyle = muted
      for (const [t, score] of sceneScores) {
        if (t < from || t > to) continue
        g.fillRect(Math.round(x(t)), ys(score), 2, top + graphH - ys(score))
      }
      g.strokeStyle = accent
      g.setLineDash([4, 3])
      g.beginPath()
      g.moveTo(0, ys(sceneThreshold(settings.sensitivity)) + 0.5)
      g.lineTo(width, ys(sceneThreshold(settings.sensitivity)) + 0.5)
      g.stroke()
      g.setLineDash([])
      g.fillStyle = accent
      for (const t of plan.cuts) g.fillRect(Math.round(x(t)) - 1, top, 2, graphH)
      g.fillStyle = text
      g.font = '11px system-ui, sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'top'
      plan.parts.forEach((p, i) => {
        if (x(p.end) - x(p.start) >= 14) g.fillText(String(i + 1), (x(p.start) + x(p.end)) / 2, 3)
      })
      return
    }

    // Pauses found (muted), then what gets cut out (accent)
    g.fillStyle = muted
    g.globalAlpha = 0.15
    for (const s of plan.silences) g.fillRect(x(s.start), top, Math.max(1, x(s.end) - x(s.start)), graphH)
    g.fillStyle = accent
    g.globalAlpha = 0.22
    let cursor = from
    for (const p of plan.parts) {
      if (p.start > cursor) g.fillRect(x(cursor), top, x(p.start) - x(cursor), graphH)
      cursor = p.end
    }
    if (cursor < to) g.fillRect(x(cursor), top, x(to) - x(cursor), graphH)
    g.globalAlpha = 1

    // Loudness, one bar per pixel column
    g.fillStyle = muted
    const { db, step } = loudness
    for (let px = 0; px < width; px++) {
      const t0 = from + (px / width) * span
      const t1 = from + ((px + 1) / width) * span
      let peak = DB_MIN
      for (let w = Math.floor(t0 / step); w <= Math.min(db.length - 1, Math.floor(t1 / step)); w++) {
        if (db[w] > peak) peak = db[w]
      }
      g.fillRect(px, y(peak), 1, top + graphH - y(peak))
    }

    // Threshold line
    g.strokeStyle = accent
    g.setLineDash([4, 3])
    g.beginPath()
    g.moveTo(0, y(settings.thresholdDb) + 0.5)
    g.lineTo(width, y(settings.thresholdDb) + 0.5)
    g.stroke()
    g.setLineDash([])

    // Cut lines (split mode) and part numbers
    g.fillStyle = text
    g.font = '11px system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'top'
    plan.parts.forEach((p, i) => {
      const mid = (x(p.start) + x(p.end)) / 2
      if (x(p.end) - x(p.start) >= 14) g.fillText(String(i + 1), mid, 3)
    })
  }, [loudness, plan, scenesMode, sceneScores, settings.mode, settings.thresholdDb, settings.sensitivity, width, from, to])

  const set = (key) => (e) => setSettings(s => ({ ...s, [key]: Number(e.target.value) }))
  const kept = plan ? plan.parts.reduce((sum, p) => sum + (p.end - p.start), 0) : 0
  const canApply = plan && plan.parts.length > 0 && (plan.parts.length > 1 || kept < (to - from) - 0.05)

  let summary = ''
  if (plan && scenesMode) {
    summary = canApply
      ? `${plan.parts.length} parts at ${plan.cuts.length} scene change${plan.cuts.length === 1 ? '' : 's'}. Nothing is removed.`
      : 'No scene changes found with these settings.'
  } else if (plan) {
    summary = canApply
      ? `${plan.parts.length} part${plan.parts.length === 1 ? '' : 's'}, cuts ${seconds((to - from) - kept)}. New length ${formatLength(kept)} (was ${formatLength(to - from)}).`
      : 'No pauses found with these settings.'
  }

  return (
    <div className="remix-picker-overlay" onClick={onClose}>
      <div
        className="remix-picker silence-cut"
        role="dialog"
        aria-modal="true"
        aria-labelledby="silence-cut-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="silence-cut-title">Auto cut</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>

        {isVideo && (
          <div className="silence-cut-modes silence-cut-at" role="radiogroup" aria-label="Where to cut">
            <button
              role="radio"
              aria-checked={!scenesMode}
              className={!scenesMode ? 'active' : ''}
              onClick={() => setSettings(s => ({ ...s, cutAt: 'pauses' }))}
            >
              Pauses
            </button>
            <button
              role="radio"
              aria-checked={scenesMode}
              className={scenesMode ? 'active' : ''}
              onClick={() => setSettings(s => ({ ...s, cutAt: 'scenes' }))}
            >
              Scene changes
            </button>
          </div>
        )}

        {!scenesMode && (<>
        <div className="silence-cut-modes" role="radiogroup" aria-label="What to do at each pause">
          <button
            role="radio"
            aria-checked={settings.mode === 'split'}
            className={settings.mode === 'split' ? 'active' : ''}
            onClick={() => setSettings(s => ({ ...s, mode: 'split' }))}
          >
            Split at pauses
          </button>
          <button
            role="radio"
            aria-checked={settings.mode === 'remove'}
            className={settings.mode === 'remove' ? 'active' : ''}
            onClick={() => setSettings(s => ({ ...s, mode: 'remove' }))}
          >
            Cut pauses out
          </button>
        </div>
        <p className="silence-cut-mode-hint">
          {settings.mode === 'split'
            ? `Splits into parts of at least ${settings.minPart.toFixed(1)}s and cuts the pause out at each split. Shorter pauses inside a part stay.`
            : 'Cuts out every pause; each piece of speech becomes its own part.'}
        </p>
        </>)}
        {scenesMode && (
          <p className="silence-cut-mode-hint">
            Splits where the picture changes (a new shot or angle), into parts of at least {settings.minPart.toFixed(1)}s. Nothing is removed.
          </p>
        )}

        {isVideo ? (
          <video
            ref={mediaRef}
            className="silence-cut-video"
            src={clip.url}
            preload="auto"
            playsInline
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onLoadedMetadata={(e) => { e.currentTarget.currentTime = from }}
          />
        ) : (
          <audio
            ref={mediaRef}
            src={clip.url}
            preload="auto"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onLoadedMetadata={(e) => { e.currentTarget.currentTime = from }}
          />
        )}

        <div
          className={`silence-cut-preview${ready ? ' scrubbable' : ''}`}
          ref={wrapRef}
          onPointerDown={onScrubStart}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubEnd}
          onPointerCancel={onScrubEnd}
        >
          {(scenesMode ? sceneError : error) ? (
            <p className="silence-cut-status">{scenesMode ? sceneError : error}</p>
          ) : !ready ? (
            <p className="silence-cut-status">{scenesMode ? 'Looking for scene changes…' : 'Reading the audio…'}</p>
          ) : (
            <>
              <canvas ref={canvasRef} />
              <div className="silence-cut-playhead" style={{ left: `${((time - from) / Math.max(0.001, to - from)) * 100}%` }} />
            </>
          )}
        </div>

        <div className="silence-cut-transport">
          <button
            className="silence-cut-play"
            onClick={togglePlay}
            disabled={!ready}
            title={playing ? 'Pause (Space)' : 'Play the result, skipping what gets cut (Space)'}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <span className="silence-cut-time">{clock(time - from)} / {clock(to - from)}</span>
          {plan && <span className="silence-cut-summary">{summary}</span>}
        </div>

        {scenesMode ? (
          <div className="silence-cut-controls">
            <label title="Higher finds softer changes too (camera moves, lighting); lower only hard cuts">
              <span>Sensitivity <strong>{settings.sensitivity}</strong></span>
              <input type="range" min={0} max={100} step={1} value={settings.sensitivity} onChange={set('sensitivity')} disabled={!ready} />
            </label>
            <label>
              <span>Shortest part <strong>{settings.minPart.toFixed(1)}s</strong></span>
              <input type="range" min={0.5} max={30} step={0.5} value={settings.minPart} onChange={set('minPart')} disabled={!ready} />
            </label>
          </div>
        ) : (
        <div className="silence-cut-controls">
          <label>
            <span>Silence below <strong>{settings.thresholdDb} dB</strong></span>
            <span className="silence-cut-row">
              <input type="range" min={-70} max={-20} step={1} value={settings.thresholdDb} onChange={set('thresholdDb')} disabled={!loudness} />
              <button
                className="silence-cut-auto"
                disabled={!loudness}
                onClick={() => setSettings(s => ({ ...s, thresholdDb: suggestThreshold(loudness, from, to) }))}
                title="Set just above this clip's background noise"
              >
                Auto
              </button>
            </span>
          </label>
          <label>
            <span>Pause at least <strong>{settings.minSilence.toFixed(1)}s</strong></span>
            <input type="range" min={0.2} max={3} step={0.1} value={settings.minSilence} onChange={set('minSilence')} disabled={!loudness} />
          </label>
          {settings.mode === 'split' && (
            <label>
              <span>Shortest part <strong>{settings.minPart.toFixed(1)}s</strong></span>
              <input type="range" min={0.5} max={30} step={0.5} value={settings.minPart} onChange={set('minPart')} disabled={!loudness} />
            </label>
          )}
          <label title="How much of the pause stays after the words before a cut">
            <span>Keep at pause start <strong>{settings.keepStartMs} ms</strong></span>
            <input type="range" min={0} max={1000} step={10} value={settings.keepStartMs} onChange={set('keepStartMs')} disabled={!loudness} />
          </label>
          <label title="How much of the pause stays before the words after a cut">
            <span>Keep at pause end <strong>{settings.keepEndMs} ms</strong></span>
            <input type="range" min={0} max={1000} step={10} value={settings.keepEndMs} onChange={set('keepEndMs')} disabled={!loudness} />
          </label>
        </div>
        )}

        <div className="silence-cut-actions">
          <button className="silence-cut-cancel" onClick={onClose}>Cancel</button>
          <button
            className="silence-cut-apply"
            disabled={!canApply}
            onClick={() => onApply(plan.parts, { closeGaps: true })}
          >
            <Wand2 size={14} /> Edit for me
          </button>
        </div>
      </div>
    </div>
  )
}

export default SilenceCutModal
