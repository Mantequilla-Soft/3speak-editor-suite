import { memo } from 'react'
import { allKeyframeTimes } from '../utils/motionEdits'
import { speedLabel } from '../utils/clipSpeed'
import './ClipMotion.css'

/**
 * On a timeline clip: a small badge for its speed ('2x', 'Ramp', 'Still')
 * and, while the clip is selected, a diamond at each keyframe.
 */
function KeyframeMarks({ clip, pixelsPerSecond, selected }) {
  const label = speedLabel(clip)
  const times = selected ? allKeyframeTimes(clip).filter(t => t >= clip.startTime - 1e-3 && t <= clip.endTime + 1e-3) : []
  if (!label && !times.length) return null
  return (
    <>
      {label && <span className="clip-speed-badge" title={label === 'Still' ? 'Still frame' : `Speed ${label}`}>{label}</span>}
      {times.length > 0 && (
        <div className="clip-keyframe-strip" aria-hidden="true">
          {times.map(t => (
            <span key={t} className="clip-keyframe-diamond" style={{ left: `${(t - clip.startTime) * pixelsPerSecond}px` }} />
          ))}
        </div>
      )}
    </>
  )
}

export default memo(KeyframeMarks)
