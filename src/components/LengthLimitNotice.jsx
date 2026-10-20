import { X } from 'lucide-react'
import { MAX_TIMELINE_SECONDS, MAX_TIMELINE_TEXT, formatLength } from '../utils/limits'

/**
 * Shown after an import leaves the timeline longer than a short may be.
 * The footage stays whole; rendering waits until the creator trims it down.
 */
function LengthLimitNotice({ length, onClose }) {
  return (
    <div className="remix-picker-overlay" onClick={onClose}>
      <div
        className="remix-picker length-notice"
        role="dialog"
        aria-modal="true"
        aria-labelledby="length-notice-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="length-notice-title">Your timeline is {formatLength(length)} long</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>
        <p className="length-notice-text">
          A short can be at most {MAX_TIMELINE_TEXT}. You can keep editing the full footage,
          but Render stays off until the timeline ends at the marked {formatLength(MAX_TIMELINE_SECONDS)} line.
          Trim, split or delete clips to get there.
        </p>
        <button className="length-notice-ok" onClick={onClose} autoFocus>Got it</button>
      </div>
    </div>
  )
}

export default LengthLimitNotice
