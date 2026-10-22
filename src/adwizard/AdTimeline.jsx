import { useRef, useLayoutEffect, useState } from 'react'
import { Music, AudioLines, Film } from 'lucide-react'

// The ad's timeline: scenes (drag the right edge to change a scene's length), music, sound effects
// (drag to move, click to select), playhead (click or drag anywhere to seek).
export default function AdTimeline({ info, scenes, meta, time, selected, onSelect, onSeek, onDuration, music, sfx, selectedSfx, onSelectSfx, onMoveSfx }) {
  const boxRef = useRef(null)
  const [w, setW] = useState(600)
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el); setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const dur = Math.max(info?.duration || 0, 1)
  const pps = (w - 24) / dur
  const X = t => 12 + t * pps
  const T = clientX => { const r = boxRef.current.getBoundingClientRect(); return Math.max(0, Math.min(dur, (clientX - r.left - 12) / pps)) }

  const dragSeek = e => {
    if (e.target.closest('.aw-tl-block, .aw-tl-sfx, .aw-tl-handle')) return
    onSeek(T(e.clientX))
    const move = ev => onSeek(T(ev.clientX))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const dragEdge = (e, i) => {
    e.stopPropagation()
    const startX = e.clientX, d0 = scenes[i].duration, min = meta?.TYPES[scenes[i].type]?.dur[0] || 1
    const move = ev => onDuration(i, Math.max(min, Math.min(15, +(d0 + (ev.clientX - startX) / pps).toFixed(2))))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const dragSfx = (e, s) => {
    e.stopPropagation()
    onSelectSfx(s)
    const startX = e.clientX, a0 = s.at
    let moved = false
    const move = ev => { if (Math.abs(ev.clientX - startX) > 3) moved = true; if (moved) onMoveSfx(s, Math.max(0, Math.min(dur, +(a0 + (ev.clientX - startX) / pps).toFixed(3)))) }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  const ticks = []
  const step = dur > 40 ? 5 : dur > 15 ? 2 : 1
  for (let t = 0; t <= dur + 0.001; t += step) ticks.push(t)

  return (
    <div className="aw-tl" ref={boxRef} onPointerDown={dragSeek}>
      <div className="aw-tl-ruler">{ticks.map(t => <span key={t} style={{ left: X(t) }}>{t}s</span>)}</div>
      <div className="aw-tl-row" title="Scenes">
        <Film size={13} className="aw-tl-ic" />
        {(info?.scenes || []).map((s, i) => (
          <div key={i} className={`aw-tl-block${i === selected ? ' sel' : ''}`} style={{ left: X(s.start), width: Math.max(8, (s.end - s.start) * pps) }}
            onPointerDown={e => { e.stopPropagation(); onSelect(i) }} title={`${s.type}: ${(s.end - s.start).toFixed(1)}s`}>
            <span>{i + 1}. {s.type}</span>
            <i className="aw-tl-handle" onPointerDown={e => dragEdge(e, i)} title="Drag to change the length" />
          </div>))}
      </div>
      <div className="aw-tl-row" title="Music">
        <Music size={13} className="aw-tl-ic" />
        {music?.url && <div className="aw-tl-music" style={{ left: X(0), width: dur * pps }}>
          <i className="aw-tl-fade in" style={{ width: (music.fadeIn || 0) * pps }} />
          <span>{music.title || 'Music'}{music.volume != null ? ` · ${music.volume}%` : ''}</span>
          <i className="aw-tl-fade out" style={{ width: (music.fadeOut || 0) * pps }} />
        </div>}
      </div>
      <div className="aw-tl-row aw-tl-sfxrow" title="Sound effects">
        <AudioLines size={13} className="aw-tl-ic" />
        {sfx.map(s => <i key={s.key || s.id} className={`aw-tl-sfx${s.auto ? ' auto' : ''}${(selectedSfx && (selectedSfx === s.key || selectedSfx === s.id)) ? ' sel' : ''}`}
          style={{ left: X(s.at) }} onPointerDown={e => dragSfx(e, s)} title={`${s.name || s.kind} at ${s.at.toFixed(2)}s`} />)}
      </div>
      <div className="aw-tl-head" style={{ left: X(time) }} />
    </div>
  )
}
