import { memo } from 'react'
import { allKeyframeTimes } from '../utils/motionEdits'
import { speedLabel, timeMap } from '../utils/clipSpeed'
import { useT } from '../i18n'
import './ClipMotion.css'

/**
 * On a timeline clip: a small badge for its speed ('2x', 'Ramp', 'Still')
 * and, while the clip is selected, a diamond at each keyframe.
 */
function KeyframeMarks({ clip, pixelsPerSecond, selected }) {
  const { t } = useT()
  // speedLabel is shared with the render (English): Still and Ramp in the interface language
  const kind = timeMap(clip).kind
  const speed = speedLabel(clip)
  const label = kind === 'freeze' ? t('motion.badge.still') : kind === 'ramp' ? t('motion.badge.ramp') : speed
  const times = selected ? allKeyframeTimes(clip).filter(kt => kt >= clip.startTime - 1e-3 && kt <= clip.endTime + 1e-3) : []
  if (!label && !times.length) return null
  return (
    <>
      {label && <span className="clip-speed-badge" title={kind === 'freeze' ? t('motion.badge.stillTitle') : kind === 'ramp' ? t('motion.badge.rampTitle') : t('motion.badge.speedTitle', { speed: label })}>{label}</span>}
      {times.length > 0 && (
        <div className="clip-keyframe-strip" aria-hidden="true">
          {times.map(kt => (
            <span key={kt} className="clip-keyframe-diamond" style={{ left: `${(kt - clip.startTime) * pixelsPerSecond}px` }} />
          ))}
        </div>
      )}
    </>
  )
}

export default memo(KeyframeMarks)
