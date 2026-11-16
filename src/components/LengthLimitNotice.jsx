import { X } from './icons'
import { MAX_TIMELINE_SECONDS, atMostText, formatLength } from '../utils/limits'
import { isAudioMode } from '../utils/editorMode'
import { useT } from '../i18n'

/**
 * Shown after an import leaves the timeline longer than a short may be.
 * The footage stays whole; rendering waits until the creator trims it down.
 */
function LengthLimitNotice({ length, onClose }) {
  const { t } = useT()
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
          <h3 id="length-notice-title">{t('notices.length.title', { length: formatLength(length) })}</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        <p className="length-notice-text">
          {t(isAudioMode ? 'notices.length.bodyAudio' : 'notices.length.body', { atMost: atMostText(), limitAt: formatLength(MAX_TIMELINE_SECONDS) })}
        </p>
        <button className="length-notice-ok" onClick={onClose} autoFocus>{t('common.gotIt')}</button>
      </div>
    </div>
  )
}

export default LengthLimitNotice
