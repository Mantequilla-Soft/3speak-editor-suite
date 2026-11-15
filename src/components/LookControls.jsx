import { useEffect, useMemo, useState } from 'react'
import { LOOK_PRESETS, LOOK_DEFAULTS, applyPreset, matchPreset, normalizeLook } from '../utils/clipLook'
import { grabVideoFrame } from '../utils/chromaKey'
import { LookFilter } from './ClipColorFilters'
import { RotateCcw } from './icons'
import { useT } from '../i18n'
import './LookControls.css'

const EFFECT_SLIDERS = [
  { key: 'blur', min: 0 },
  { key: 'vignette', min: 0 },
  { key: 'sharpen', min: 0 },
  { key: 'split', min: -100 }
]
const THUMB = 120 // px, long side of the frame grabbed for the preset strip

// The clip's picture now (the playhead's frame when it is over the clip), small
const mediaTimeOf = (clip, playhead) => {
  const pos = clip.timelinePosition || 0
  const inClip = playhead >= pos && playhead < pos + (clip.endTime - clip.startTime)
  return inClip ? clip.startTime + (playhead - pos) : clip.startTime + Math.min(0.5, (clip.endTime - clip.startTime) / 2)
}

function useClipFrame(clip, playhead) {
  const [frame, setFrame] = useState(null) // { url, aspect }
  const time = clip.type === 'video' ? Math.round(mediaTimeOf(clip, playhead) * 2) / 2 : 0
  useEffect(() => {
    let cancelled = false
    if (clip.type === 'image') {
      const img = new Image()
      img.onload = () => { if (!cancelled) setFrame({ url: clip.url, aspect: img.naturalWidth / (img.naturalHeight || 1) }) }
      img.src = clip.url
      return () => { cancelled = true }
    }
    // A video frame, once the playhead has rested for a moment
    const id = setTimeout(() => {
      grabVideoFrame(clip.url, time, THUMB)
        .then(canvas => { if (!cancelled) setFrame({ url: canvas.toDataURL('image/jpeg', 0.8), aspect: canvas.width / (canvas.height || 1) }) })
        .catch(() => { if (!cancelled) setFrame(null) })
    }, 500)
    return () => { cancelled = true; clearTimeout(id) }
  }, [clip.type, clip.url, time])
  return frame
}

/**
 * Looks of a video / image clip (utils/clipLook.js): one tap on a preset sets
 * the colour sliders below (and a split tone or vignette), to adjust from
 * there; blur, vignette, sharpen and the teal and orange split tone as sliders.
 * The strip shows each preset on the clip's own frame.
 */
function LookControls({ clip, onUpdateClip, playheadPosition = 0 }) {
  const { t } = useT()
  const look = { ...LOOK_DEFAULTS, ...(normalizeLook(clip.look) || {}) }
  const active = matchPreset(clip.color, clip.look)
  const frame = useClipFrame(clip, playheadPosition)
  const idBase = `look-${clip.id}`
  const thumbs = useMemo(() => LOOK_PRESETS.map(p => ({ ...p, values: applyPreset(p.id) })), [])

  const set = (key, value) => onUpdateClip({ look: normalizeLook({ ...look, [key]: value }) })
  const pick = (id) => onUpdateClip(applyPreset(id, clip.look))
  const changed = !!normalizeLook(clip.look)

  return (
    <div className="prop-group">
      <div className="prop-group-label color-group-label">
        <span>{t('look.title')}</span>
        {changed && (
          <button className="prop-reset-btn" onClick={() => onUpdateClip({ look: null })} title={t('look.noEffects')}>
            <RotateCcw size={10} />
          </button>
        )}
      </div>
      {frame && (
        <svg width="0" height="0" className="look-thumb-defs" aria-hidden="true" focusable="false">
          <defs>
            {thumbs.map(p => (
              <LookFilter key={p.id} id={`${idBase}-${p.id}`} color={p.values.color} look={p.values.look} aspect={frame.aspect} />
            ))}
          </defs>
        </svg>
      )}
      <div className="look-strip" role="radiogroup" aria-label={t('look.presetsLabel')}>
        {thumbs.map(p => (
          <button
            key={p.id}
            role="radio"
            aria-checked={active === p.id}
            className={`look-chip${active === p.id ? ' active' : ''}`}
            onClick={() => pick(p.id)}
            title={t(`look.presets.${p.id}`)}
          >
            <span className="look-chip-frame">
              {frame
                ? <img src={frame.url} alt="" draggable={false} style={{ filter: `url(#${idBase}-${p.id})` }} />
                : <span className="look-chip-blank" />}
            </span>
            <span className="look-chip-label">{t(`look.presets.${p.id}`)}</span>
          </button>
        ))}
      </div>
      {EFFECT_SLIDERS.map(({ key, min }) => {
        const label = t(`look.sliders.${key}`)
        return (
        <div className="property-group color-slider" key={key}>
          <label>{label}</label>
          <div className="property-slider">
            <input
              type="range"
              min={min}
              max="100"
              value={look[key]}
              onChange={(e) => set(key, parseInt(e.target.value))}
              onDoubleClick={() => set(key, 0)}
              title={t('look.doubleClickReset')}
              aria-label={label}
            />
            <span>{min < 0 && look[key] > 0 ? `+${look[key]}` : look[key]}</span>
          </div>
        </div>
        )
      })}
    </div>
  )
}

export default LookControls
