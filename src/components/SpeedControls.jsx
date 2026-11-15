import { useState } from 'react'
import { Gauge, Pause } from './icons'
import { SPEED_STEPS, RAMP_PRESETS, MIN_SPEED, MAX_SPEED, timeMap } from '../utils/clipSpeed'
import { setClipSpeed, setClipRamp, insertFreezeFrame, retimeMapper, clipTimeAtPlayhead } from '../utils/motionEdits'
import './ClipMotion.css'

const FREEZE_LENGTHS = [0.5, 1, 2, 3]
const fmt = (s) => `${Number(s.toFixed(2))}x`
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`

/**
 * Speed of a video clip (and its linked sound): constant 0.25x to 4x, a speed
 * ramp preset, or a freeze frame at the playhead. Every change is one undo
 * step through applyTracks; the clips after it on its tracks move with its
 * new length. `kit` = { tracks, applyTracks, fileStoreRef, retimeCaptions }.
 */
function SpeedControls({ clip, playheadPosition, kit, onUpdateClip }) {
  const [freezeLength, setFreezeLength] = useState(1)
  if (!kit?.applyTracks || clip.type !== 'video') return null
  const m = timeMap(clip)

  // A still: how long it stands
  if (m.kind === 'freeze') {
    const length = clip.endTime - clip.startTime
    return (
      <div className="prop-group">
        <div className="prop-group-label">Speed</div>
        <div className="property-group">
          <label><Pause size={12} /> Still frame</label>
          <span className="motion-hint">Holds the frame at {fmtTime(m.at)} of the video. Trim it on the timeline or pick a length:</span>
          <div className="motion-chips">
            {FREEZE_LENGTHS.map(s => (
              <button key={s} className={`motion-chip${Math.abs(length - s) < 0.01 ? ' active' : ''}`} onClick={() => onUpdateClip({ endTime: clip.startTime + s })}>
                {s} s
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
    const after = next.flatMap(t => t.clips).find(c => c.id === clip.id)
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
    kit.retimeCaptions?.((t) => (t >= r.at ? t + r.seconds : t))
  }
  // Slider on a log scale: 0.25x .. 1x .. 4x take the same room
  const toSlider = (s) => Math.round(Math.log2(s) * 100)
  const fromSlider = (v) => Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number((2 ** (v / 100)).toFixed(2))))

  return (
    <div className="prop-group">
      <div className="prop-group-label">Speed</div>

      <div className="property-group">
        <label><Gauge size={12} /> Speed</label>
        <div className="motion-chips" role="radiogroup" aria-label="Speed">
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
              onChange={(e) => setSpeed(fromSlider(+e.target.value))} aria-label="Speed" />
            <span>{fmt(current)}</span>
          </div>
        )}
      </div>

      <div className="property-group">
        <label>Speed ramp</label>
        <div className="motion-chips" role="radiogroup" aria-label="Speed ramp">
          <button role="radio" aria-checked={!ramp} className={`motion-chip${!ramp ? ' active' : ''}`} onClick={() => ramp && setRamp('off')}>Off</button>
          {RAMP_PRESETS.map(p => (
            <button key={p.id} role="radio" aria-checked={ramp === p.id} className={`motion-chip${ramp === p.id ? ' active' : ''}`} onClick={() => setRamp(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        {ramp && <span className="motion-hint">The preview follows the ramp closely, the render is exact. The sound keeps its pitch.</span>}
      </div>

      <div className="property-group">
        <label><Pause size={12} /> Freeze frame</label>
        <div className="motion-row">
          <div className="motion-chips" role="radiogroup" aria-label="Freeze length">
            {FREEZE_LENGTHS.map(s => (
              <button key={s} role="radio" aria-checked={freezeLength === s} className={`motion-chip${freezeLength === s ? ' active' : ''}`} onClick={() => setFreezeLength(s)}>
                {s} s
              </button>
            ))}
          </div>
          <button className="mute-btn" onClick={freeze} disabled={!onClip} title={onClip ? 'Hold the frame under the playhead' : 'Move the playhead onto this clip first'}>
            Freeze at playhead
          </button>
        </div>
      </div>
    </div>
  )
}

export default SpeedControls
