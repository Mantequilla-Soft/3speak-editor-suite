import { useState } from 'react'
import { Gauge, Pause } from './icons'
import { SPEED_STEPS, RAMP_PRESETS, MIN_SPEED, MAX_SPEED, timeMap } from '../utils/clipSpeed'
import { setClipSpeed, setClipRamp, insertFreezeFrame, retimeMapper, clipTimeAtPlayhead } from '../utils/motionEdits'
import { useT } from '../i18n'
import './ClipMotion.css'

const FREEZE_LENGTHS = [0.5, 1, 2, 3]
const fmt = (s) => `${Number(s.toFixed(2))}x`
const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

/**
 * Speed of a video clip (and its linked sound): constant 0.25x to 4x, a speed
 * ramp preset, or a freeze frame at the playhead. Every change is one undo
 * step through applyTracks; the clips after it on its tracks move with its
 * new length. `kit` = { tracks, applyTracks, fileStoreRef, retimeCaptions }.
 */
function SpeedControls({ clip, playheadPosition, kit, onUpdateClip }) {
  const { t } = useT()
  const [freezeLength, setFreezeLength] = useState(1)
  if (!kit?.applyTracks || clip.type !== 'video') return null
  const m = timeMap(clip)

  // A still: how long it stands
  if (m.kind === 'freeze') {
    const length = clip.endTime - clip.startTime
    return (
      <div className="prop-group">
        <div className="prop-group-label">{t('motion.speed.title')}</div>
        <div className="property-group">
          <label><Pause size={12} /> {t('motion.speed.stillFrame')}</label>
          <span className="motion-hint">{t('motion.speed.holds', { time: fmtTime(m.at) })}</span>
          <div className="motion-chips">
            {FREEZE_LENGTHS.map(s => (
              <button key={s} className={`motion-chip${Math.abs(length - s) < 0.01 ? ' active' : ''}`} onClick={() => onUpdateClip({ endTime: clip.startTime + s })}>
                {t('motion.speed.seconds', { value: s })}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const current = m.kind === 'speed' ? m.speed : 1
  const ramp = m.kind === 'ramp' ? (m.preset || 'custom') : null
  // Apply to the timeline, and keep the caption words on what is said
  const apply = (next) => {
    if (next === kit.tracks) return
    const after = next.flatMap(tr => tr.clips).find(c => c.id === clip.id)
    kit.applyTracks(() => next)
    if (after) kit.retimeCaptions?.(retimeMapper(clip, after))
  }
  const setSpeed = (s) => apply(setClipSpeed(kit.tracks, clip.id, s))
  const setRamp = (id) => apply(setClipRamp(kit.tracks, clip.id, id))
  const onClip = clipTimeAtPlayhead(clip, playheadPosition) !== null
  const freeze = () => {
    const r = insertFreezeFrame(kit.tracks, clip.id, playheadPosition, freezeLength)
    if (!r) return
    for (const [id, from] of r.copies) {
      const file = kit.fileStoreRef?.current.get(from)
      if (file) kit.fileStoreRef.current.set(id, file)
    }
    kit.applyTracks(() => r.tracks)
    kit.retimeCaptions?.((ct) => (ct >= r.at ? ct + r.seconds : ct))
  }
  // Slider on a log scale: 0.25x .. 1x .. 4x take the same room
  const toSlider = (s) => Math.round(Math.log2(s) * 100)
  const fromSlider = (v) => Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number((2 ** (v / 100)).toFixed(2))))

  return (
    <div className="prop-group">
      <div className="prop-group-label">{t('motion.speed.title')}</div>

      <div className="property-group">
        <label><Gauge size={12} /> {t('motion.speed.speed')}</label>
        <div className="motion-chips" role="radiogroup" aria-label={t('motion.speed.speed')}>
          {SPEED_STEPS.map(s => (
            <button key={s} role="radio" aria-checked={!ramp && Math.abs(current - s) < 0.001}
              className={`motion-chip${!ramp && Math.abs(current - s) < 0.001 ? ' active' : ''}`} onClick={() => setSpeed(s)}>
              {fmt(s)}
            </button>
          ))}
        </div>
        {!ramp && (
          <div className="property-slider">
            <input type="range" min={toSlider(MIN_SPEED)} max={toSlider(MAX_SPEED)} step="1" value={toSlider(current)}
              onChange={(e) => setSpeed(fromSlider(+e.target.value))} aria-label={t('motion.speed.speed')} />
            <span>{fmt(current)}</span>
          </div>
        )}
      </div>

      <div className="property-group">
        <label>{t('motion.speed.ramp')}</label>
        <div className="motion-chips" role="radiogroup" aria-label={t('motion.speed.ramp')}>
          <button role="radio" aria-checked={!ramp} className={`motion-chip${!ramp ? ' active' : ''}`} onClick={() => ramp && setRamp('off')}>{t('common.off')}</button>
          {RAMP_PRESETS.map(p => (
            <button key={p.id} role="radio" aria-checked={ramp === p.id} className={`motion-chip${ramp === p.id ? ' active' : ''}`} onClick={() => setRamp(p.id)}>
              {t(`motion.speed.ramps.${p.id}`)}
            </button>
          ))}
        </div>
        {ramp && <span className="motion-hint">{t('motion.speed.rampHint')}</span>}
      </div>

      <div className="property-group">
        <label><Pause size={12} /> {t('motion.speed.freeze')}</label>
        <div className="motion-row">
          <div className="motion-chips" role="radiogroup" aria-label={t('motion.speed.freezeLength')}>
            {FREEZE_LENGTHS.map(s => (
              <button key={s} role="radio" aria-checked={freezeLength === s} className={`motion-chip${freezeLength === s ? ' active' : ''}`} onClick={() => setFreezeLength(s)}>
                {t('motion.speed.seconds', { value: s })}
              </button>
            ))}
          </div>
          <button className="mute-btn" onClick={freeze} disabled={!onClip} title={onClip ? t('motion.speed.freezeTitle') : t('motion.speed.freezeMoveFirst')}>
            {t('motion.speed.freezeAt')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default SpeedControls
