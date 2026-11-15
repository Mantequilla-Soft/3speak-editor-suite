import { useRef, useLayoutEffect, useState } from 'react'
import { Music, AudioLines, Film } from '../components/icons'
import { useT } from '../i18n'
import { sfxName } from './engine'

// The ad's timeline: scenes (drag the right edge to change a scene's length), music, sound effects
// (drag to move, click to select), playhead (click or drag anywhere to seek).
export default function AdTimeline({ info, scenes, meta, time, selected, onSelect, onSeek, onDuration, music, sfx, selectedSfx, onSelectSfx, onMoveSfx }) {
  const { t, formatNumber } = useT()
  const n1 = v => formatNumber(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const n2 = v => formatNumber(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
      <div className="aw-tl-ruler">{ticks.map(s => <span key={s} style={{ left: X(s) }}>{t('adwizard.timeline.tick', { s })}</span>)}</div>
      <div className="aw-tl-row" title={t('adwizard.timeline.scenes')}>
        <Film size={13} className="aw-tl-ic" />
        {(info?.scenes || []).map((s, i) => (
          <div key={i} className={`aw-tl-block${i === selected ? ' sel' : ''}`} style={{ left: X(s.start), width: Math.max(8, (s.end - s.start) * pps) }}
            onPointerDown={e => { e.stopPropagation(); onSelect(i) }} title={t('adwizard.timeline.blockTitle', { type: s.type, length: n1(s.end - s.start) })}>
            <span>{i + 1}. {s.type}</span>
            <i className="aw-tl-handle" onPointerDown={e => dragEdge(e, i)} title={t('adwizard.timeline.dragLength')} />
          </div>))}
      </div>
      <div className="aw-tl-row" title={t('adwizard.timeline.music')}>
        <Music size={13} className="aw-tl-ic" />
        {music?.url && <div className="aw-tl-music" style={{ left: X(0), width: dur * pps }}>
          <i className="aw-tl-fade in" style={{ width: (music.fadeIn || 0) * pps }} />
          <span>{music.volume != null
            ? t('adwizard.timeline.musicVolume', { title: music.title || t('adwizard.timeline.music'), volume: formatNumber(music.volume / 100, { style: 'percent', maximumFractionDigits: 0 }) })
            : (music.title || t('adwizard.timeline.music'))}</span>
          <i className="aw-tl-fade out" style={{ width: (music.fadeOut || 0) * pps }} />
        </div>}
      </div>
      <div className="aw-tl-row aw-tl-sfxrow" title={t('adwizard.timeline.effects')}>
        <AudioLines size={13} className="aw-tl-ic" />
        {sfx.map(s => <i key={s.key || s.id} className={`aw-tl-sfx${s.auto ? ' auto' : ''}${(selectedSfx && (selectedSfx === s.key || selectedSfx === s.id)) ? ' sel' : ''}`}
          style={{ left: X(s.at) }} onPointerDown={e => dragSfx(e, s)} title={t('adwizard.timeline.sfxTitle', { name: sfxName(s), at: n2(s.at) })} />)}
      </div>
      <div className="aw-tl-head" style={{ left: X(time) }} />
    </div>
  )
}
