import { useEffect, useMemo, useRef, useState } from 'react'
import { Mic } from './icons'
import { getPeaks, peaksForRange } from '../utils/peakCache'
import { formatLength } from '../utils/limits'
import { duckGainAt } from '../utils/duck'

// The audio editor's preview: the whole show at a glance, one lane per track,
// each clip drawn with its waveform, the playhead, click or drag to jump.
// Playback itself stays with GlobalPreview (its <audio> elements and loop).

const LANE_GAP = 6
const BAR_PX = 3

// A CSS custom property as a colour the canvas can use. The v2 tokens are
// var() and color-mix() chains, so let the browser resolve it to rgb() first.
function cssVar(el, name, fallback) {
  const v = el ? getComputedStyle(el).getPropertyValue(name).trim() : ''
  if (!v) return fallback
  const probe = document.createElement('span')
  probe.style.display = 'none'
  probe.style.color = v
  el.appendChild(probe)
  const rgb = getComputedStyle(probe).color
  probe.remove()
  return rgb || fallback
}

export default function AudioStage({ tracks, playheadPosition, totalDuration, onSeek, nowPlaying, emptyActions, duck = null, chapters = null }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [envelopes, setEnvelopes] = useState({}) // url -> peaks envelope | null
  const draggingRef = useRef(false)

  const lanes = useMemo(() => (tracks || []).filter(t => t.type === 'audio'), [tracks])
  const hasClips = lanes.some(t => t.clips.length)

  // Waveforms come from the shared peak cache (decoded once per file)
  useEffect(() => {
    let cancelled = false
    const seen = new Set()
    for (const t of lanes) {
      for (const c of t.clips) {
        if (!c.url || seen.has(c.url) || envelopes[c.url]) continue
        seen.add(c.url)
        getPeaks(c.url, { analysisUrl: c.serverUrl || null }).then(env => {
          if (!cancelled && env) setEnvelopes(prev => (prev[c.url] ? prev : { ...prev, [c.url]: env }))
        })
      }
    }
    return () => { cancelled = true }
  }, [lanes]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [hasClips])

  const span = Math.max(1, totalDuration)
  // The chapter the playhead is in
  const currentChapter = (chapters || []).filter(c => c.at <= playheadPosition + 0.001).at(-1) || null

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.w || !size.h) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    const g = canvas.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, size.w, size.h)
    const root = wrapRef.current
    const voiceColor = cssVar(root, '--audio-stage-voice', '#22d3ee')
    const musicColor = cssVar(root, '--audio-stage-music', '#a3a3a3')
    const templateColor = cssVar(root, '--audio-stage-template', '#f1f1f1')
    const laneBg = cssVar(root, '--audio-stage-lane', 'rgba(148,163,184,0.10)')
    const count = Math.max(1, lanes.length)
    const laneH = (size.h - LANE_GAP * (count + 1)) / count
    const x = (t) => (t / span) * size.w

    lanes.forEach((track, i) => {
      const top = LANE_GAP + i * (laneH + LANE_GAP)
      g.fillStyle = laneBg
      g.fillRect(0, top, size.w, laneH)
      const mid = top + laneH / 2
      for (const c of track.clips) {
        const start = c.timelinePosition || 0
        const len = c.endTime - c.startTime
        const x0 = x(start)
        const w = Math.max(1, x(start + len) - x0)
        const color = c.templateRole ? templateColor : (track.music ? musicColor : voiceColor)
        const dim = track.muted || c.audioEnabled === false
        g.globalAlpha = dim ? 0.25 : 0.22
        g.fillStyle = color
        g.fillRect(x0, top + 2, w, laneH - 4)
        g.globalAlpha = dim ? 0.35 : 0.9
        const env = envelopes[c.url]
        const bars = Math.max(1, Math.floor(w / BAR_PX))
        const heights = env ? peaksForRange(env, c.startTime, c.endTime, bars) : null
        const vol = Math.min(2, Math.max(0, (Number.isFinite(+c.volume) ? +c.volume : 100) / 100))
        // Auto-duck shows: a ducked clip's bars go down where its source plays
        const ducked = duck?.[c.id] || null
        const barSec = (len / bars)
        for (let b = 0; b < bars; b++) {
          // peaksForRange gives 10..90 (timeline bar heights); back to 0..1
          const level = heights ? Math.max(0, (heights[b] - 10) / 80) : 0.15
          const d = ducked ? duckGainAt(ducked, start + (b + 0.5) * barSec) : 1
          const h = Math.max(1, Math.min(laneH - 6, level * vol * d * (laneH - 6)))
          g.fillRect(x0 + b * BAR_PX, mid - h / 2, Math.max(1, BAR_PX - 1), h)
        }
      }
    })
    g.globalAlpha = 1
  }, [lanes, envelopes, size, span, duck])

  const seekAt = (clientX) => {
    const rect = wrapRef.current.getBoundingClientRect()
    onSeek(Math.min(span, Math.max(0, ((clientX - rect.left) / rect.width) * span)))
  }

  if (!hasClips) {
    return (
      <div className="audio-stage audio-stage-empty">
        <Mic size={28} className="audio-stage-empty-icon" />
        <p>Add a recording, record one, or pick music to start.</p>
        {emptyActions}
      </div>
    )
  }

  return (
    <div className="audio-stage">
      <div className="audio-stage-now">
        <span className="audio-stage-time">{formatLength(playheadPosition)}</span>
        <span className="audio-stage-total">/ {formatLength(totalDuration)}</span>
        {nowPlaying && <span className="audio-stage-clip" title={nowPlaying}>{nowPlaying}</span>}
        {currentChapter && <span className="audio-stage-chapter-now" title="Chapter">{currentChapter.title}</span>}
      </div>
      <div
        className="audio-stage-overview"
        ref={wrapRef}
        role="slider"
        tabIndex={0}
        aria-label="Position in the show"
        aria-valuemin={0}
        aria-valuemax={Math.round(totalDuration)}
        aria-valuenow={Math.round(playheadPosition)}
        aria-valuetext={`${formatLength(playheadPosition)} of ${formatLength(totalDuration)}`}
        onPointerDown={(e) => { draggingRef.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); seekAt(e.clientX) }}
        onPointerMove={(e) => { if (draggingRef.current) seekAt(e.clientX) }}
        onPointerUp={() => { draggingRef.current = false }}
        onPointerCancel={() => { draggingRef.current = false }}
      >
        <canvas ref={canvasRef} />
        {(chapters || []).map(ch => (
          <div key={ch.id} className="audio-stage-chapter" style={{ left: `${(ch.at / span) * 100}%` }}>
            <span>{ch.title}</span>
          </div>
        ))}
        <div className="audio-stage-playhead" style={{ left: `${(playheadPosition / span) * 100}%` }} />
      </div>
      <div className="audio-stage-legend">
        {lanes.map(t => (
          <span key={t.id} className={`audio-stage-lane-name${t.music ? ' music' : ''}${t.muted ? ' muted' : ''}`}>{t.name}</span>
        ))}
      </div>
    </div>
  )
}
